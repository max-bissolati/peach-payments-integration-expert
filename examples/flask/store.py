"""
Shared in-memory demo state (idempotency + per-checkout created amount).

DEMO in-memory: replace with a DURABLE idempotency store (DB) in production —
Peach retries up to 30 days, and a restart must not allow a re-fulfil.
Store the created amount in your DB keyed by checkout_id and read it back
inside a DB transaction during fulfillment. Kept in its own module so
unrelated routes can import shared state without pulling in payment-gateway
or signature-verification logic.

MULTI-WORKER WARNING: this set lives in ONE process. Under gunicorn/uWSGI with
more than one worker, each worker has its own copy, so this does NOT prevent
double-fulfilment across workers. For real traffic run a single worker, or
(better) claim the checkout in a shared store/DB transaction before fulfilling.
"""

# In-memory deduplication set tracking fulfilled checkout IDs
processed_checkouts: set[str] = set()

# In-memory mapping of checkout_id -> created amount string (e.g. "10.00")
created_amounts: dict[str, str] = {}
