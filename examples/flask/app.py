"""
Peach Payments Checkout V2 — Flask Reference Integration.
Demonstrates:
- Server-side OAuth token retrieval & Checkout V2 session creation
- Explicit Origin (no trailing slash) and Referer (with trailing slash) headers
- Major-unit decimal string amounts ("10.00"), never cents
- Flat dotted-key status query and result code mapping
- Raw body webhook verification (Scheme A classic body and Scheme B header scheme)
- Webhook wake-up doctrine: never fulfill on webhook body alone; re-query /status and verify amount
- In-memory idempotency deduplication (use durable DB in production)
"""

import json
import os
import time
import urllib.parse
from decimal import Decimal, InvalidOperation
from typing import Any

from flask import Flask, jsonify, render_template, request

from peach import create_checkout_session, get_checkout_status, getCheckoutStatus
from result_codes import is_success_result_code, map_result_code
from store import created_amounts, processed_checkouts
from verify_webhook import verify_webhook_signature

# Load .env if python-dotenv is present
try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass

app = Flask(__name__)


def fulfill_order(checkout_id: str, status_data: dict[str, Any]) -> None:
    """Fulfilment stub: safe to run only after signature, terminal status, and amount verification."""
    amount = status_data.get("amount")
    currency = status_data.get("currency")
    tx_id = status_data.get("id")
    print(f"[FULFILLED] Order confirmed for checkout {checkout_id} | TxID: {tx_id} | Amount: {amount} {currency}")


@app.route("/")
def index():
    """Serves checkout frontend page."""
    return render_template("index.html")


# ─────────────────────────────────────────────────────────────────────────────
# 1. Create Checkout Endpoint
# Initiates server-side OAuth and creates Checkout V2 session.
# ─────────────────────────────────────────────────────────────────────────────
@app.route("/api/checkout", methods=["POST"])
def create_checkout():
    try:
        # Checkout amounts are major-unit decimal strings ("10.00"), never cents
        amount = "10.00"
        currency = os.environ.get("PEACH_CURRENCY", "ZAR")
        order_id = f"ORD-{int(time.time() * 1000)}"

        session = create_checkout_session(
            amount=amount,
            currency=currency,
            order_id=order_id,
        )

        checkout_id = session.get("checkoutId")
        if not checkout_id:
            return jsonify({"error": "Missing checkoutId in Peach session response"}), 500

        # Store created amount keyed by checkout_id for amount integrity checks at fulfillment
        created_amounts[checkout_id] = amount

        # Return browser-safe identifiers only: checkoutId and entityId (semi-public SDK key).
        # NEVER expose client secret, secret token, or OAuth access token to the browser.
        return jsonify(
            {
                "checkoutId": checkout_id,
                "entityId": os.environ.get("PEACH_ENTITY_ID", ""),
                "redirectUrl": session.get("redirectUrl", ""),
                "amount": amount,
                "currency": currency,
            }
        )
    except Exception as err:
        app.logger.error(f"[CHECKOUT CREATE ERROR] {err}")
        return jsonify({"error": str(err)}), 500


# ─────────────────────────────────────────────────────────────────────────────
# 2. Status-Confirm Endpoint
# Client calls this after widget onCompleted event.
# Fetches GET /v2/checkout/{id}/status, parses flat dotted keys, validates amount.
# ─────────────────────────────────────────────────────────────────────────────
@app.route("/api/checkout/<checkout_id>/status", methods=["GET"])
def checkout_status(checkout_id: str):
    try:
        status_data = getCheckoutStatus(checkout_id)
        status_code_val = status_data.get("result.code")
        status_state = map_result_code(status_code_val)
        amount = status_data.get("amount")
        is_captured = is_success_result_code(status_code_val)

        # Enforce amount integrity: confirm amount matches stored created amount
        expected_amount = created_amounts.get(checkout_id)
        amount_matches = False
        if expected_amount is not None and amount is not None:
            try:
                # Compare money as Decimal, never float (float can't represent decimals exactly).
                amount_matches = Decimal(str(amount)) == Decimal(str(expected_amount))
            except (InvalidOperation, ValueError, TypeError):
                amount_matches = False

        if is_captured and amount_matches and checkout_id not in processed_checkouts:
            # Claim-then-fulfil: atomic WITHIN a single process (the check and the add are
            # synchronous, no await between them). It does NOT dedupe across processes — gunicorn
            # -w N>1 gives each worker its own `processed_checkouts` set, so run a single worker or
            # swap in a shared/DB store (see store.py) before taking real traffic.
            processed_checkouts.add(checkout_id)
            fulfill_order(checkout_id, status_data)

        return jsonify(
            {
                "checkoutId": checkout_id,
                "resultCode": status_code_val,
                "status": status_state,
                "amount": amount,
                "currency": status_data.get("currency"),
                "transactionId": status_data.get("id"),
                "paymentBrand": status_data.get("paymentBrand"),
                "fulfilled": is_captured and amount_matches,
            }
        )
    except Exception as err:
        app.logger.error(f"[STATUS CONFIRM ERROR] Checkout {checkout_id}: {err}")
        return jsonify({"error": str(err)}), 500


# ─────────────────────────────────────────────────────────────────────────────
# 3. Webhook Handler
# CRITICAL: Preserve raw body for HMAC-SHA256 signature verification.
# Never fulfill on webhook payload alone: verify signature -> re-fetch /status ->
# check terminal outcome & amount -> dedupe -> fulfill.
# ─────────────────────────────────────────────────────────────────────────────
@app.route("/api/webhook", methods=["POST"])
def webhook():
    # Read raw body bytes as text for signature verification before any parsing
    raw_body = request.get_data(as_text=True)

    # Signature verification: fail closed if invalid or secret missing
    verification = verify_webhook_signature(
        raw_body=raw_body,
        headers=dict(request.headers),
        secret_token=os.environ.get("PEACH_SECRET_TOKEN"),
        webhook_secret=os.environ.get("PEACH_WEBHOOK_SECRET"),
        configured_url=os.environ.get("PEACH_WEBHOOK_URL"),
    )

    if not verification.get("valid"):
        reason = verification.get("reason", "unknown")
        app.logger.error(f"[WEBHOOK REJECTED] Signature verification failed ({reason})")
        return jsonify({"error": "Invalid webhook signature"}), 400

    # Parse parameters from raw_body (JSON if initial ping, else form-urlencoded)
    checkout_id = None
    webhook_code_val = None

    try:
        stripped_body = raw_body.strip()
        if stripped_body.startswith("{"):
            json_data = json.loads(stripped_body)
            checkout_id = json_data.get("checkoutId")
            webhook_code_val = json_data.get("result.code")
        else:
            params = dict(urllib.parse.parse_qsl(raw_body, keep_blank_values=True))
            checkout_id = params.get("checkoutId")
            webhook_code_val = params.get("result.code")
    except Exception as parse_err:
        app.logger.error(f"[WEBHOOK ERROR] Failed to parse webhook payload: {parse_err}")
        return jsonify({"error": "Malformed payload"}), 400

    if not checkout_id:
        return jsonify({"message": "No checkoutId present, acknowledged"}), 200

    # Deduplication by checkout_id
    if checkout_id in processed_checkouts:
        app.logger.info(f"[WEBHOOK DEDUPE] Checkout {checkout_id} already processed, skipping")
        return jsonify({"status": "already_processed"}), 200

    # Principle: A webhook is a wake-up call, not truth.
    # Check if webhook signals terminal success; if not, acknowledge with 200 without fulfilling
    webhook_status = map_result_code(webhook_code_val)
    if webhook_status != "captured":
        app.logger.info(f"[WEBHOOK IGNORED] Non-terminal code: {webhook_code_val} ({webhook_status})")
        return jsonify({"status": "acknowledged_non_terminal"}), 200

    # Re-confirm outcome AND amount via GET /v2/checkout/{id}/status before fulfilling!
    try:
        status_data = getCheckoutStatus(checkout_id)
        confirmed_code = status_data.get("result.code")
        confirmed_status = map_result_code(confirmed_code)
        confirmed_amount = status_data.get("amount")

        # Enforce amount integrity: paid amount must match stored created amount
        expected_amount = created_amounts.get(checkout_id)
        amount_matches = False
        if expected_amount is not None and confirmed_amount is not None:
            try:
                # Compare money as Decimal, never float.
                amount_matches = Decimal(str(confirmed_amount)) == Decimal(str(expected_amount))
            except (InvalidOperation, ValueError, TypeError):
                amount_matches = False

        if confirmed_status == "captured" and amount_matches:
            processed_checkouts.add(checkout_id)
            fulfill_order(checkout_id, status_data)
            return jsonify({"status": "fulfilled"}), 200
        else:
            app.logger.warning(
                f"[WEBHOOK FULFIL REJECTED] Verification mismatch on /status. "
                f"Code: {confirmed_code}, Amount: {confirmed_amount}, Expected: {expected_amount}"
            )
            return jsonify({"status": "verification_failed"}), 200
    except Exception as status_err:
        app.logger.error(f"[WEBHOOK ERROR] Failed to fetch /status for {checkout_id}: {status_err}")
        # Return 500 to request Peach retry
        return jsonify({"error": "Failed to verify status"}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
