# Peach Payments Checkout V2 — Flask Reference Integration

A complete, copy-paste-runnable reference integration of Peach Payments Checkout V2 (Card Flow) using Python and Flask. Dependency-light architecture using Python's standard library `urllib` for API requests.

## Core Architectural Principles Demonstrated

1. **Server-Side Credentials**: OAuth (`clientId`, `clientSecret`, `merchantId`), secret tokens, and webhook secrets are strictly server-side. Only `PEACH_ENTITY_ID` (semi-public SDK key) is exposed to the browser.
2. **Strict Origin and Referer Headers**: Checkout V2 session creation includes both allowlist validation headers:
   - `Origin`: No trailing slash (e.g., `http://localhost:5000`)
   - `Referer`: With trailing slash (e.g., `http://localhost:5000/`)
3. **Major-Unit Decimal Amounts**: Amounts are major-unit decimal strings (e.g. `"10.00"`), never multiplied by 100 or sent as cents.
4. **Flat Dotted Keys Parsing**: Peach status responses and classic webhooks return flat objects with dotted string keys: `obj["result.code"]`, `obj["amount"]`, `obj["id"]`.
5. **Fail-Closed Result Code Mapping**: Evaluates `result.code` using strict regexes. 3DS intermediate codes (`000.400.101`/`000.400.102`) and chargeback codes (`000.100.2xx`) fail closed to error.
6. **Raw-Body Webhook Verification**: Preserves raw body bytes with `request.get_data(as_text=True)` to compute canonical HMAC-SHA256 signatures before parsing. Replay attacks on Scheme B header webhooks are prevented by validating timestamp freshness (>5 minutes rejected before HMAC evaluation).
7. **Webhook Wake-Up Call Doctrine**: Webhooks trigger a server-side re-query of `GET /v2/checkout/{id}/status` to confirm terminal success and amount integrity before fulfillment. Never fulfills on webhook body data alone.
8. **Dynamic Token Caching**: Access tokens are cached based on the returned `expires_in` value (typically 14400s / 4h in sandbox), rather than hardcoded lifetimes, and refreshed ~60 seconds before expiration with a single 401 retry.

---

## Setup and Installation

### 1. Prerequisites
- Python 3.10+
- Virtual environment (recommended)

### 2. Install Dependencies
```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### 3. Configure Environment Variables
Copy `env.example` to `.env` and fill in your credentials from the Peach Payments Dashboard:
```bash
cp env.example .env
```

Required variables:
```env
PEACH_ENV=sandbox
PEACH_CLIENT_ID=your_client_id
PEACH_CLIENT_SECRET=your_client_secret
PEACH_MERCHANT_ID=your_merchant_id
PEACH_ENTITY_ID=your_entity_id
PEACH_SECRET_TOKEN=your_secret_token

# Optional: Webhook header security (if enabled in Dashboard)
PEACH_WEBHOOK_SECRET=your_webhook_secret
PEACH_WEBHOOK_URL=http://localhost:5000/api/webhook

# Peach Hosts (defaults to sandbox)
PEACH_AUTH_HOST=https://sandbox-dashboard.peachpayments.com
PEACH_CHECKOUT_HOST=https://testsecure.peachpayments.com
PEACH_CARD_HOST=https://sandbox-card.peachpayments.com

PORT=5000
APP_URL=http://localhost:5000
```

> **Webhook signing note**: Set `PEACH_WEBHOOK_SECRET` (header scheme) so Peach's first JSON config-verification ping verifies; the handler fails closed on any unverified webhook by design. Do not change the handler to act on unsigned pings.

### 4. Start the Server
```bash
python3 app.py
```
Or with the Flask CLI:
```bash
flask --app app run --port 5000
```

Visit [http://localhost:5000](http://localhost:5000) to launch the checkout widget.

---

## Sandbox Test Cards

Use these 3D Secure 2 test cards in the Peach Sandbox:

| Scheme | Card Number | Expiry | CVV | Expected Outcome |
| :--- | :--- | :--- | :--- | :--- |
| **Visa** | `4200000000000091` | Any future date (e.g. `12/28`) | `123` | Frictionless Success (`000.100.110`) |
| **Mastercard** | `5200000000000007` | Any future date (e.g. `12/28`) | `123` | Frictionless Success (`000.100.110`) |

---

## Endpoints

- `POST /api/checkout` — Generates a Checkout V2 session (amount `"10.00"`), stores the created amount in the demo in-memory map, returning `{ checkoutId, entityId, redirectUrl, amount, currency }`.
- `GET /api/checkout/<id>/status` — Re-queries `GET /v2/checkout/{id}/status`, verifies terminal status (`obj["result.code"]`) and matches amount against the stored created amount, and confirms order fulfillment.
- `POST /api/webhook` — Accepts incoming Peach webhooks with raw body signature verification and timestamp replay protection, deduplicates by `checkoutId`, re-fetches status, verifies amount against the stored created amount, and fulfills order.
