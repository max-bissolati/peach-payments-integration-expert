"""
Peach Payments webhook signature verification.
Supports:
- Scheme A (Checkout default): Classic form-urlencoded body signature with secret token.
  Canonical: all parameters sorted by key (excluding signature), concatenated key+value with no separators.
- Scheme B: Dashboard header scheme (x-webhook-signature) with webhook secret.
  Canonical: f"{timestamp}.{webhook_id}.{url}.{raw_body}"
  Replay protection: rejects stale timestamps > 5 minutes BEFORE computing HMAC.

FAILS CLOSED: With no secret configured, verification always returns valid: False.
"""

import hashlib
import hmac
import json
import time
import urllib.parse
from typing import Any


def get_header(headers: dict[str, Any] | None, name: str) -> str | None:
    """Case-insensitive header lookup."""
    if not headers:
        return None
    target = name.lower()
    for k, v in headers.items():
        if k.lower() == target:
            return str(v)
    return None


def classic_canonical_message(params: list[tuple[str, str]]) -> str:
    """
    Scheme A canonical string construction:
    Sort all parameters alphabetically by key (excluding 'signature'),
    concatenate key + value with no separators.
    Empty values ARE part of the canonical string.
    """
    entries = [(k, v) for k, v in params if k != "signature"]
    entries.sort(key=lambda x: x[0])
    return "".join(f"{k}{v}" for k, v in entries)


def _flatten_params(obj: Any, prefix: str = "", out: list[tuple[str, str]] | None = None) -> list[tuple[str, str]]:
    """Flatten nested dict/list to bracketed form-encoded parameter pairs."""
    if out is None:
        out = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            key = f"{prefix}[{k}]" if prefix else str(k)
            _flatten_params(v, key, out)
    elif isinstance(obj, list):
        for item in obj:
            _flatten_params(item, prefix, out)
    else:
        out.append((prefix, "" if obj is None else str(obj)))
    return out


def verify_webhook_signature(
    raw_body: str,
    headers: dict[str, Any] | None = None,
    secret_token: str | None = None,
    webhook_secret: str | None = None,
    configured_url: str | None = None,
    max_age_ms: int = 300000,
) -> dict[str, Any]:
    """
    Verifies Peach Payments webhook signatures.
    Fails closed if no secret is configured.
    """
    if not secret_token and not webhook_secret:
        return {"valid": False, "reason": "no_secret_configured"}

    headers = headers or {}
    raw_body = raw_body or ""

    # Parse parameters for Scheme A check
    params: list[tuple[str, str]] = []
    body_sig: str | None = None

    stripped_body = raw_body.strip()
    if stripped_body.startswith("{"):
        try:
            data = json.loads(stripped_body)
            if isinstance(data, dict):
                body_sig = data.get("signature")
                params = _flatten_params(data)
        except Exception:
            params = []
    else:
        params = urllib.parse.parse_qsl(raw_body, keep_blank_values=True)
        for k, v in params:
            if k == "signature":
                body_sig = v
                break

    # 1. Scheme A check (Checkout default: signature in body)
    if body_sig and secret_token:
        message = classic_canonical_message(params)
        expected = hmac.new(
            secret_token.encode("utf-8"),
            message.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        if hmac.compare_digest(expected.lower(), body_sig.lower()):
            return {"valid": True, "scheme": "classic-body"}

    # 2. Scheme B check (Header scheme: x-webhook-signature)
    header_sig = get_header(headers, "x-webhook-signature")
    timestamp = get_header(headers, "x-webhook-timestamp")
    webhook_id = get_header(headers, "x-webhook-id")

    if header_sig and webhook_secret:
        # Replay protection: reject stale timestamp BEFORE HMAC comparison
        raw_ts = str(timestamp or "").strip()
        if not raw_ts:
            return {"valid": False, "reason": "stale_timestamp"}
        try:
            ts = float(raw_ts)
        except ValueError:
            return {"valid": False, "reason": "stale_timestamp"}

        # Convert unix seconds (10 digits) to milliseconds
        if len(raw_ts) == 10:
            ts *= 1000

        now_ms = time.time() * 1000
        if abs(now_ms - ts) > max_age_ms:
            return {"valid": False, "reason": "stale_timestamp"}

        message = f"{timestamp or ''}.{webhook_id or ''}.{configured_url or ''}.{raw_body}"
        expected = hmac.new(
            webhook_secret.encode("utf-8"),
            message.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        if hmac.compare_digest(expected.lower(), header_sig.lower()):
            return {"valid": True, "scheme": "header-signature"}

    if body_sig or header_sig:
        return {"valid": False, "reason": "signature_mismatch"}

    return {"valid": False, "reason": "missing_signature"}
