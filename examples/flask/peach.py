"""
Server-side Peach Payments Checkout V2 client library.
Zero external dependencies (uses standard library urllib).

Enforces:
- Server-side OAuth token retrieval with dynamic expires_in caching (60s early refresh)
- 401 mid-flight single retry
- BOTH Origin (no trailing slash) and Referer (with trailing slash) headers on create
- Major-unit decimal strings for amounts ("10.00"), never cents
- Flat dotted-key status query
"""

import json
import os
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any

_cached_token: str | None = None
_token_expires_at: float = 0.0


def _request_json(
    url: str,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    payload: dict[str, Any] | None = None,
) -> tuple[int, dict[str, Any]]:
    """Helper executing HTTP requests using standard library urllib."""
    req_headers = {"Accept": "application/json"}
    if headers:
        req_headers.update(headers)

    body_bytes = None
    if payload is not None:
        body_bytes = json.dumps(payload).encode("utf-8")
        req_headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=body_bytes, headers=req_headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            resp_bytes = resp.read()
            data = json.loads(resp_bytes.decode("utf-8")) if resp_bytes else {}
            return resp.status, data
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        try:
            err_data = json.loads(err_body)
        except Exception:
            err_data = {"error": err_body}
        return e.code, err_data


def get_access_token(force_refresh: bool = False) -> str:
    """
    Server-side OAuth token retrieval with dynamic caching.
    Caches token based on Peach's returned expires_in value (sandbox observed at 14400s / 4h).
    Refreshes ~60s before expiration. Does NOT hardcode a fixed token lifetime.
    """
    global _cached_token, _token_expires_at
    now = time.time()
    if not force_refresh and _cached_token and now < _token_expires_at - 60:
        return _cached_token

    auth_host = os.environ.get("PEACH_AUTH_HOST", "https://sandbox-dashboard.peachpayments.com").rstrip("/")
    client_id = os.environ.get("PEACH_CLIENT_ID")
    client_secret = os.environ.get("PEACH_CLIENT_SECRET")
    merchant_id = os.environ.get("PEACH_MERCHANT_ID")

    if not client_id or not client_secret or not merchant_id:
        raise RuntimeError("Missing required Peach credentials: PEACH_CLIENT_ID, PEACH_CLIENT_SECRET, PEACH_MERCHANT_ID")

    status, data = _request_json(
        f"{auth_host}/api/oauth/token",
        method="POST",
        payload={
            "clientId": client_id,
            "clientSecret": client_secret,
            "merchantId": merchant_id,
        },
    )

    if status >= 400 or "access_token" not in data:
        raise RuntimeError(f"Failed to obtain Peach access token (HTTP {status}): {data}")

    _cached_token = data["access_token"]
    expires_in_val = data.get("expires_in")
    expires_in_sec = int(expires_in_val) if expires_in_val is not None else 14400
    _token_expires_at = time.time() + expires_in_sec

    return _cached_token


def create_checkout_session(
    amount: str = "10.00",
    currency: str = "ZAR",
    order_id: str | None = None,
    shopper_result_url: str | None = None,
) -> dict[str, Any]:
    """
    Creates a Checkout V2 session on Peach Payments.
    Enforces:
    - BOTH Origin (no trailing slash) and Referer (with trailing slash) headers.
    - Major-unit decimal string amount ("10.00"), never cents.
    - Server-side execution only.
    - 401 mid-flight retry once.
    """
    checkout_host = os.environ.get("PEACH_CHECKOUT_HOST", "https://testsecure.peachpayments.com").rstrip("/")
    entity_id = os.environ.get("PEACH_ENTITY_ID")

    if not entity_id:
        raise RuntimeError("Missing required PEACH_ENTITY_ID in environment")

    app_url = os.environ.get("APP_URL", "http://localhost:5000").rstrip("/")
    # Verified requirement: BOTH Origin (NO trailing slash) and Referer (WITH trailing slash)
    origin_header = app_url
    referer_header = f"{app_url}/"

    merchant_tx_id = "TX" + secrets.token_hex(6).upper()
    nonce = str(uuid.uuid4())
    result_url = (shopper_result_url or f"{app_url}/").lower()

    payload = {
        "authentication.entityId": entity_id,
        "merchantTransactionId": merchant_tx_id,
        "amount": amount,
        "currency": currency,
        "nonce": nonce,
        "shopperResultUrl": result_url,
        "defaultPaymentMethod": "CARD",
        "forceDefaultMethod": True,
        "paymentType": "DB",
        "customer": {
            "givenName": "Jane",
            "surname": "Doe",
            "email": "jane.doe@example.com",
        },
        "customParameters": {
            "orderId": order_id or f"ORD-{int(time.time() * 1000)}",
            "createdAmount": amount,
        },
    }

    token = get_access_token()
    headers = {
        "Authorization": f"Bearer {token}",
        "Origin": origin_header,
        "Referer": referer_header,
    }

    status, data = _request_json(
        f"{checkout_host}/v2/checkout",
        method="POST",
        headers=headers,
        payload=payload,
    )

    # On 401 mid-flight: clear token, re-auth once, retry once
    if status == 401:
        token = get_access_token(force_refresh=True)
        headers["Authorization"] = f"Bearer {token}"
        status, data = _request_json(
            f"{checkout_host}/v2/checkout",
            method="POST",
            headers=headers,
            payload=payload,
        )

    if status >= 400:
        raise RuntimeError(f"Failed to create checkout (HTTP {status}): {data}")

    return data


def get_checkout_status(checkout_id: str) -> dict[str, Any]:
    """
    Fetches status of a Checkout V2 session.
    Response is a FLAT object with dotted string keys: obj["result.code"], obj["amount"], etc.
    """
    checkout_host = os.environ.get("PEACH_CHECKOUT_HOST", "https://testsecure.peachpayments.com").rstrip("/")
    token = get_access_token()
    headers = {"Authorization": f"Bearer {token}"}

    encoded_id = urllib.parse.quote(checkout_id, safe="")
    status, data = _request_json(
        f"{checkout_host}/v2/checkout/{encoded_id}/status",
        method="GET",
        headers=headers,
    )

    # On 401 mid-flight: clear token, re-auth once, retry once
    if status == 401:
        token = get_access_token(force_refresh=True)
        headers["Authorization"] = f"Bearer {token}"
        status, data = _request_json(
            f"{checkout_host}/v2/checkout/{encoded_id}/status",
            method="GET",
            headers=headers,
        )

    if status >= 400:
        raise RuntimeError(f"Failed to fetch checkout status (HTTP {status}): {data}")

    return data


# Aliases
getCheckoutStatus = get_checkout_status
createCheckoutSession = create_checkout_session
