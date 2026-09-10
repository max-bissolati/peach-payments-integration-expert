# Peach Payments Checkout V2 — Plain-PHP Reference Integration

A complete, standalone reference integration of Peach Payments Checkout V2 (Card Flow) in plain PHP.

- **Zero dependencies**: No framework, no Composer, no external packages.
- **Drop-in ready**: Pure PHP 8.0+ (PHP 8.5 tested) compatible with vanilla PHP, WordPress, WooCommerce, and custom CMS stacks.
- **Security-identical**: Mirrors the contracts and security protections of `examples/express` (Node.js) and `examples/flask` (Python).

---

## Core Security & Architectural Doctrines Enforced

1. **Server-Side Credentials Only**:
   OAuth (`clientId`, `clientSecret`, `merchantId`), secret tokens (`PEACH_SECRET_TOKEN`), and webhook secrets (`PEACH_WEBHOOK_SECRET`) remain strictly server-side. Only `PEACH_ENTITY_ID` (semi-public SDK key) is passed to the browser.
2. **Strict Origin and Referer Headers**:
   Checkout V2 session creation (`POST /v2/checkout`) includes both allowlist validation headers:
   - `Origin`: No trailing slash (e.g. `http://localhost:8000`)
   - `Referer`: With trailing slash (e.g. `http://localhost:8000/`)
3. **Major-Unit Decimal Amounts**:
   Amounts are major-unit decimal strings (e.g. `"10.00"`), never cents or multiplied by 100.
4. **Flat Dotted Keys Parsing**:
   Peach status responses and classic webhooks return flat objects with dotted string keys: `$data["result.code"]`, `$data["amount"]`, `$data["id"]`. Nested reads like `$data["result"]["code"]` return `null`.
5. **Fail-Closed Result Code Mapping**:
   Evaluates `result.code` with strict regexes. Intermediate 3DS-step codes (`000.400.101`/`000.400.102`) and chargebacks (`000.100.2xx`) fail closed to `error`.
6. **Raw-Body Webhook Verification**:
   Reads exact unparsed body bytes from `file_get_contents('php://input')`. Never uses `$_POST`, which parses form data and destroys the exact byte representation needed for signature verification. Replay attacks on Scheme B headers are prevented by rejecting timestamps older than 5 minutes before computing HMAC.
7. **Webhook Wake-Up Doctrine**:
   Webhooks trigger a server-side re-query of `GET /v2/checkout/{id}/status` to confirm terminal outcome and amount integrity before fulfillment. Never fulfills based on webhook body data alone.
8. **Dynamic Token Caching**:
   Access tokens are cached dynamically using the returned `expires_in` value (typically 14400s / 4h in sandbox), refreshed ~60 seconds early, with a single 401 retry.

---

## Setup and Running

### 1. Prerequisites
- PHP 8.0+ (PHP 8.5 tested) with `curl` and `bcmath` extensions enabled.

### 2. Configure Environment
Export the environment variables in your shell, or configure them in your server environment:

```bash
export PEACH_ENV=sandbox
export PEACH_CLIENT_ID="your_client_id"
export PEACH_CLIENT_SECRET="your_client_secret"
export PEACH_MERCHANT_ID="your_merchant_id"
export PEACH_ENTITY_ID="your_entity_id"
export PEACH_SECRET_TOKEN="your_secret_token"

# Optional: Webhook header security (if enabled in Peach Dashboard)
export PEACH_WEBHOOK_SECRET="your_webhook_secret"
export PEACH_WEBHOOK_URL="http://localhost:8000/webhook.php"

# Peach Hosts (default to sandbox)
export PEACH_AUTH_HOST="https://sandbox-dashboard.peachpayments.com"
export PEACH_CHECKOUT_HOST="https://testsecure.peachpayments.com"
export PEACH_CARD_HOST="https://sandbox-card.peachpayments.com"

export APP_URL="http://localhost:8000"
export PEACH_CURRENCY="ZAR"
```

A template is provided in `env.example`.

### 3. Start the Local Server
From within the `examples/php` directory:

```bash
php -S localhost:8000
```

Open [http://localhost:8000](http://localhost:8000) in your browser to launch the checkout widget.

### 4. Run the Built-in Self-Test
The suite includes an automated CLI test of signature verification, replay protection, result code mapping, and deduplication:

```bash
php selftest.php
```

---

## Sandbox Test Cards (3D Secure 2)

| Scheme | Card Number | Expiry | CVV | Expected Outcome |
| :--- | :--- | :--- | :--- | :--- |
| **Visa** | `4200000000000091` | Any future date (e.g. `12/28`) | `123` | Frictionless Success (`000.100.110`) |
| **Mastercard** | `5200000000000007` | Any future date (e.g. `12/28`) | `123` | Frictionless Success (`000.100.110`) |

---

## File Structure

- **`peach.php`**: Server-side OAuth bearer token management, dynamic token caching (`expires_in`, 60s early refresh, 401 retry), checkout session creation (`POST /v2/checkout` with `Origin` and `Referer` headers, major-unit decimal strings), and status lookup (`GET /v2/checkout/{id}/status`) via cURL.
- **`verify_webhook.php`**: Cryptographic webhook signature verification. Supports Scheme A (classic body signature with alphabetical key sorting and empty parameter preservation) and Scheme B (header scheme with timestamp freshness check > 5 min). Fails closed when no secret is configured.
- **`result_codes.php`**: Strict fail-closed result code mapping into state categories (`captured`, `review`, `pending`, `requires_more`, `canceled`, `error`).
- **`store.php`**: File/in-memory demo store tracking per-checkout created amounts and idempotency deduplication. (In production, replace with a durable ACID database).
- **`webhook.php`**: Webhook endpoint reading raw body from `php://input`, verifying signature, re-fetching `/status`, enforcing amount integrity, deduplicating, and fulfilling.
- **`create.php`**: Server endpoint that initiates checkout sessions (returning browser-safe `checkoutId` + `entityId`) and provides status check verification.
- **`index.php`**: Minimal client interface rendering the Peach Checkout V2 embedded widget.
- **`selftest.php`**: Standalone CLI test verifying signature validation, tampering rejection, replay protection, and code mapping.
- **`env.example`**: Environment variable template for Peach Payments Checkout V2.
