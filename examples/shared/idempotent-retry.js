#!/usr/bin/env node
'use strict';

/**
 * idempotent-retry.js — Reusable, zero-dependency idempotency and safe retry helper for Peach Payments.
 *
 * CONTEXT & THE DOUBLE-CHARGE PROBLEM:
 * Peach Payments documents NO server-side idempotency keys for money-moving POST operations:
 *   1. Hosted Checkout creation (POST /v2/checkout)
 *   2. Merchant-Initiated Transaction (MIT) debits (POST /v1/registrations/{id}/payments)
 *
 * When a network timeout or connection reset occurs mid-flight, the client cannot know whether Peach
 * received and processed the request. A naive retry can result in duplicate authorizations or double-charging
 * the customer.
 *
 * THE SAFETY CONTRACT:
 *   1. Caller generates an idempotency key (e.g. merchantTransactionId) before the initial POST.
 *   2. If `store.get(key)` already has a completed result -> return it (dedupe; never re-POST).
 *   3. Before each attempt (and especially before a RETRY after a timeout/uncertain error), call
 *      `lookup(key)` — if the remote already has the payment, adopt it and DO NOT re-POST.
 *   4. Perform `attempt(key)` once. On a definite non-retryable failure, surface it immediately.
 *      On a timeout/uncertain error, do NOT blindly re-POST — `lookup(key)` first, then retry only if absent.
 *   5. Single-flight: concurrent calls with the same key must not both POST (await the in-flight promise).
 *   6. Never exceed `maxRetries` real POSTs. Persist the completed result in `store`.
 *   7. Fail closed: if `lookup(key)` fails during a pre-retry check, abort retries to avoid double-charging.
 *
 * PRODUCTION NOTE:
 * The default in-memory store is suitable for single-process testing. In multi-instance production environments,
 * `store` must be backed by a durable store (e.g., PostgreSQL or Redis with distributed locks/leases), and
 * `lookup(key)` must query Peach's status API (e.g., GET /status or query by merchantTransactionId).
 */

/**
 * In-memory key-value store suitable for single-process testing or local deduplication.
 */
class InMemoryStore {
  constructor() {
    this._map = new Map();
  }

  async get(key) {
    return this._map.get(key);
  }

  async set(key, val) {
    this._map.set(key, val);
    return val;
  }

  async has(key) {
    return this._map.has(key);
  }

  async delete(key) {
    return this._map.delete(key);
  }

  async clear() {
    this._map.clear();
  }
}

// Module-level weak map to manage single-flight concurrency per store instance
const storeFlightMaps = new WeakMap();
const fallbackFlightMap = new Map();

function getInFlightMap(store) {
  if (store && (typeof store === 'object' || typeof store === 'function')) {
    let map = storeFlightMaps.get(store);
    if (!map) {
      map = new Map();
      storeFlightMaps.set(store, map);
    }
    return map;
  }
  return fallbackFlightMap;
}

/**
 * Default classifier for network timeouts and uncertain gateway errors.
 */
function defaultIsTimeoutOrUncertain(err) {
  if (!err) return false;

  // Explicit flags take precedence
  if (typeof err.isTimeout === 'boolean') return err.isTimeout;
  if (typeof err.retryable === 'boolean') return err.retryable;

  // HTTP status codes indicating timeout or gateway uncertainty
  const status = err.status || err.statusCode || (err.response && err.response.status);
  if (status) {
    if (status === 408 || status === 502 || status === 503 || status === 504) return true;
    if (status >= 400 && status < 500) return false; // 400, 401, 403, 404, 422 are definite non-retryable failures
  }

  // Node.js system error codes
  const code = err.code || (err.cause && err.cause.code);
  if (code && typeof code === 'string') {
    const uncertainCodes = new Set([
      'ETIMEDOUT',
      'ECONNRESET',
      'ECONNREFUSED',
      'EPIPE',
      'EAI_AGAIN',
      'ENOTFOUND',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_SOCKET',
    ]);
    if (uncertainCodes.has(code)) return true;
  }

  // Error class names
  if (err.name === 'TimeoutError' || err.name === 'AbortError') {
    return true;
  }

  // Message heuristics
  const msg = String(err.message || '');
  if (/timeout|timed? ?out|socket hang up|econnreset|etimedout|network error|connection reset/i.test(msg)) {
    return true;
  }

  return false;
}

/**
 * Helper to wrap an async attempt function with an optional timeout.
 */
async function executeWithTimeout(fn, key, timeoutMs) {
  if (!timeoutMs || timeoutMs <= 0) {
    return await fn(key);
  }

  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`Payment attempt timed out after ${timeoutMs}ms for key "${key}"`);
      err.name = 'TimeoutError';
      err.code = 'ETIMEDOUT';
      err.isTimeout = true;
      err.retryable = true;
      reject(err);
    }, timeoutMs);
    if (timer && typeof timer.unref === 'function') {
      timer.unref();
    }
  });

  try {
    return await Promise.race([fn(key), timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Helper for sleep/backoff between retries.
 */
function sleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executes a money-moving POST safely with deduplication, single-flight locking, and
 * check-before-retry to prevent double charges.
 *
 * @param {Object} options
 * @param {string|number} options.key - Caller's unique idempotency key (e.g. merchantTransactionId). REQUIRED.
 * @param {Function} options.attempt - Async function `attempt(key)` that performs the POST. REQUIRED.
 * @param {Function} options.lookup - Async function `lookup(key)` that checks remote payment status. REQUIRED.
 * @param {Object} [options.store] - Object with async or sync `get(key)` and `set(key, val)`.
 * @param {number} [options.maxRetries=2] - Maximum number of retry attempts after the initial failure.
 * @param {number} [options.maxAttempts] - Optional explicit limit on total real POST attempts.
 * @param {number} [options.timeoutMs] - Optional per-attempt timeout in milliseconds.
 * @param {number} [options.retryDelayMs=0] - Optional delay in milliseconds before retrying.
 * @param {Function} [options.isRetryable] - Optional custom predicate `(err) => boolean`.
 * @returns {Promise<any>} The result of the successful POST or adopted lookup.
 */
async function idempotentMoneyPost({
  key,
  attempt,
  lookup,
  store,
  maxRetries = 2,
  maxAttempts,
  timeoutMs,
  retryDelayMs = 0,
  isRetryable = defaultIsTimeoutOrUncertain,
}) {
  // Validate required parameters
  if (key === undefined || key === null || key === '') {
    throw new TypeError('idempotentMoneyPost: "key" is required (e.g. merchantTransactionId)');
  }
  if (typeof attempt !== 'function') {
    throw new TypeError('idempotentMoneyPost: "attempt" must be an async function');
  }
  if (typeof lookup !== 'function') {
    throw new TypeError('idempotentMoneyPost: "lookup" must be an async function');
  }

  const s = store || new InMemoryStore();
  // Single-flight must dedupe even when NO store is passed. If we keyed the in-flight map off `s`
  // (a fresh per-call InMemoryStore when storeless), each concurrent storeless call would get its own
  // map and BOTH would POST → double charge. So storeless calls share the module-level fallback map.
  const inFlight = store ? getInFlightMap(store) : fallbackFlightMap;

  // Single-flight: If an attempt with this key is already running in this process/store,
  // join the in-flight execution rather than issuing a concurrent POST.
  if (inFlight.has(key)) {
    return await inFlight.get(key);
  }

  // Synchronously register the in-flight promise to eliminate async race windows
  const executionPromise = (async () => {
    // 1. Check local store: If already completed, return immediately (dedupe; never re-POST)
    const cached = await s.get(key);
    if (cached !== undefined && cached !== null) {
      return cached;
    }

    // 2. Pre-flight remote lookup: In case an earlier crashed process already completed the payment
    const remoteExisting = await lookup(key);
    if (remoteExisting !== undefined && remoteExisting !== null) {
      await s.set(key, remoteExisting);
      return remoteExisting;
    }

    // Calculate maximum allowed real POSTs
    const retryCountLimit = typeof maxRetries === 'number' ? Math.max(0, maxRetries) : 2;
    const maxAllowedPosts = typeof maxAttempts === 'number'
      ? Math.max(1, maxAttempts)
      : 1 + retryCountLimit;

    let realPostsCount = 0;
    let lastError = null;

    while (realPostsCount < maxAllowedPosts) {
      // Before each RETRY (realPostsCount > 0), call lookup(key) — if the remote already
      // has the payment, adopt it and DO NOT re-POST.
      if (realPostsCount > 0) {
        if (retryDelayMs > 0) {
          await sleep(retryDelayMs);
        }

        let remoteRecord;
        try {
          remoteRecord = await lookup(key);
        } catch (lookupErr) {
          // CRITICAL SAFETY GUARD: If lookup fails, we cannot know whether the previous attempt
          // succeeded or timed out remotely. Retrying blindly would risk double-charging. Fail closed!
          const failClosedErr = new Error(
            `Remote lookup failed after timeout for key "${key}". Aborting retry to prevent double charge: ${lookupErr.message}`
          );
          failClosedErr.cause = lookupErr;
          failClosedErr.originalError = lastError;
          throw failClosedErr;
        }

        if (remoteRecord !== undefined && remoteRecord !== null) {
          // Remote already has the payment! Adopt it and DO NOT re-POST.
          await s.set(key, remoteRecord);
          return remoteRecord;
        }
      }

      // Perform the real POST attempt
      realPostsCount++;
      try {
        const result = await executeWithTimeout(attempt, key, timeoutMs);
        // Completed successfully! Persist in store and return.
        await s.set(key, result);
        return result;
      } catch (err) {
        lastError = err;

        // On a definite non-retryable failure, surface it immediately
        const canRetry = isRetryable(err);
        if (!canRetry) {
          throw err;
        }

        // Loop continues for retry if realPostsCount < maxAllowedPosts
      }
    }

    // Retries exhausted. Final check: did the final attempt actually complete remotely?
    try {
      const finalLookup = await lookup(key);
      if (finalLookup !== undefined && finalLookup !== null) {
        await s.set(key, finalLookup);
        return finalLookup;
      }
    } catch (_) {
      // Ignore lookup error on final fallback; surface lastError below
    }

    throw lastError || new Error(`Operation failed after ${realPostsCount} attempt(s) for key "${key}"`);
  })();

  inFlight.set(key, executionPromise);
  try {
    return await executionPromise;
  } finally {
    inFlight.delete(key);
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Selftest suite — simulates failure modes with mocks and asserts safety rules
 * ──────────────────────────────────────────────────────────────────────────── */

async function runSelftest() {
  const tests = [];
  function t(name, fn) {
    tests.push({ name, fn });
  }

  function assert(condition, message) {
    if (!condition) {
      throw new Error(message || 'Assertion failed');
    }
  }

  function assertEqual(actual, expected, message) {
    if (actual !== expected) {
      throw new Error(`${message || 'Assertion failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }

  // 1. Timeout on first call, remote succeeded -> helper calls lookup, adopts payment, NO second POST
  t('timeout on first call but succeeded remotely → adopts existing payment, no second POST', async () => {
    let attemptCalls = 0;
    let lookupCalls = 0;
    const store = new InMemoryStore();
    const key = 'ord_timeout_success_1';

    // Mock remote state: payment will exist on remote after attempt is called
    let remoteState = null;

    const attempt = async () => {
      attemptCalls++;
      // Simulate that the request reached Peach and succeeded remotely, but the network
      // connection dropped on response return, causing a client-side timeout.
      remoteState = { id: 'ch_12345', status: 'successful', amount: '150.00' };
      const err = new Error('Gateway timeout reading response');
      err.code = 'ETIMEDOUT';
      throw err;
    };

    const lookup = async () => {
      lookupCalls++;
      return remoteState;
    };

    const result = await idempotentMoneyPost({
      key,
      attempt,
      lookup,
      store,
      maxRetries: 2,
    });

    assertEqual(result.id, 'ch_12345', 'adopted result id');
    assertEqual(result.status, 'successful', 'adopted result status');
    assertEqual(attemptCalls, 1, 'attempt must be called exactly once (no second POST)');
    assert(lookupCalls >= 1, 'lookup must be called to check status before retry');

    // Verify stored result
    const stored = await store.get(key);
    assertEqual(stored.id, 'ch_12345', 'result must be stored in cache');
  });

  // 2. Two CONCURRENT calls with same key -> single-flight ensures attempt is invoked exactly ONCE
  t('two concurrent calls with the same key → attempt is invoked exactly ONCE (single-flight)', async () => {
    let attemptCalls = 0;
    const store = new InMemoryStore();
    const key = 'ord_concurrent_1';

    const attempt = async () => {
      attemptCalls++;
      // Simulate an async POST that takes 25ms
      await sleep(25);
      return { id: 'ch_concurrent_success', status: 'successful' };
    };

    const lookup = async () => null;

    // Launch two calls concurrently with the exact same key
    const [res1, res2] = await Promise.all([
      idempotentMoneyPost({ key, attempt, lookup, store }),
      idempotentMoneyPost({ key, attempt, lookup, store }),
    ]);

    assertEqual(attemptCalls, 1, 'attempt must be called exactly ONCE across concurrent calls');
    assertEqual(res1.id, 'ch_concurrent_success', 'res1 matches');
    assertEqual(res2.id, 'ch_concurrent_success', 'res2 matches');
  });

  t('(MEDIUM) two concurrent calls with NO store param → still exactly ONE POST (storeless single-flight)', async () => {
    let attemptCalls = 0;
    const key = 'ord_storeless_concurrent';
    const attempt = async () => { attemptCalls++; await sleep(25); return { id: 'ch_storeless', status: 'successful' }; };
    const lookup = async () => null;
    // No `store` passed — must still dedupe via the module-level fallback flight map.
    await Promise.all([
      idempotentMoneyPost({ key, attempt, lookup }),
      idempotentMoneyPost({ key, attempt, lookup }),
    ]);
    assertEqual(attemptCalls, 1, 'storeless concurrent calls must NOT double-POST');
  });

  // 3. Repeat call after completion -> returns cached result, attempt not called again
  t('repeat call after completion → returns cached result, attempt not called again', async () => {
    let attemptCalls = 0;
    const store = new InMemoryStore();
    const key = 'ord_repeat_cached_1';

    const attempt = async () => {
      attemptCalls++;
      return { id: 'ch_initial_done', status: 'successful' };
    };

    const lookup = async () => null;

    // First call: executes attempt
    const firstResult = await idempotentMoneyPost({ key, attempt, lookup, store });
    assertEqual(firstResult.id, 'ch_initial_done', 'first call result');
    assertEqual(attemptCalls, 1, 'first call executed attempt once');

    // Second call with the same key and store: must return cached result without calling attempt
    const secondResult = await idempotentMoneyPost({ key, attempt, lookup, store });
    assertEqual(secondResult.id, 'ch_initial_done', 'second call result');
    assertEqual(attemptCalls, 1, 'attempt must NOT be called again on repeat call');
  });

  // 4. Genuinely-absent payment after timeout -> exactly one retry POST, then success
  t('genuinely-absent payment after timeout → exactly one retry POST, then success', async () => {
    let attemptCalls = 0;
    let lookupCalls = 0;
    const store = new InMemoryStore();
    const key = 'ord_absent_retry_1';

    const attempt = async () => {
      attemptCalls++;
      if (attemptCalls === 1) {
        // First POST failed and genuinely never reached the server
        const err = new Error('Connection reset by peer');
        err.code = 'ECONNRESET';
        throw err;
      }
      return { id: 'ch_retry_succeeded', status: 'successful' };
    };

    const lookup = async () => {
      lookupCalls++;
      // Payment genuinely does not exist remotely
      return null;
    };

    const result = await idempotentMoneyPost({
      key,
      attempt,
      lookup,
      store,
      maxRetries: 2,
    });

    assertEqual(result.id, 'ch_retry_succeeded', 'successful retry result');
    assertEqual(attemptCalls, 2, 'attempt called exactly twice (1 initial + 1 retry POST)');
    assert(lookupCalls >= 1, 'lookup was performed before retrying');
  });

  // 5. maxRetries is respected (never more real POSTs than allowed)
  t('maxRetries is respected (never more real POSTs than allowed)', async () => {
    // Sub-case A: maxRetries = 2 -> 1 initial + 2 retries = 3 real POSTs max
    {
      let calls = 0;
      const key = 'ord_exhaust_retries_2';
      const store = new InMemoryStore();

      const attempt = async () => {
        calls++;
        const err = new Error('ETIMEDOUT');
        err.code = 'ETIMEDOUT';
        throw err;
      };

      const lookup = async () => null;

      let threw = false;
      try {
        await idempotentMoneyPost({
          key,
          attempt,
          lookup,
          store,
          maxRetries: 2,
        });
      } catch (err) {
        threw = true;
        assertEqual(err.code, 'ETIMEDOUT', 'surfaces last error');
      }

      assert(threw, 'must throw after retries exhausted');
      assertEqual(calls, 3, 'maxRetries=2 permits at most 3 real POSTs (1 initial + 2 retries)');
    }

    // Sub-case B: maxRetries = 1 -> 1 initial + 1 retry = 2 real POSTs max
    {
      let calls = 0;
      const key = 'ord_exhaust_retries_1';
      const store = new InMemoryStore();

      const attempt = async () => {
        calls++;
        const err = new Error('ETIMEDOUT');
        err.code = 'ETIMEDOUT';
        throw err;
      };

      const lookup = async () => null;

      let threw = false;
      try {
        await idempotentMoneyPost({
          key,
          attempt,
          lookup,
          store,
          maxRetries: 1,
        });
      } catch (err) {
        threw = true;
        assertEqual(err.code, 'ETIMEDOUT', 'surfaces last error');
      }

      assert(threw, 'must throw after retries exhausted');
      assertEqual(calls, 2, 'maxRetries=1 permits at most 2 real POSTs (1 initial + 1 retry)');
    }

    // Sub-case C: maxRetries = 0 -> 1 initial + 0 retries = 1 real POST max
    {
      let calls = 0;
      const key = 'ord_exhaust_retries_0';
      const store = new InMemoryStore();

      const attempt = async () => {
        calls++;
        const err = new Error('ETIMEDOUT');
        err.code = 'ETIMEDOUT';
        throw err;
      };

      const lookup = async () => null;

      let threw = false;
      try {
        await idempotentMoneyPost({
          key,
          attempt,
          lookup,
          store,
          maxRetries: 0,
        });
      } catch (_) {
        threw = true;
      }

      assert(threw, 'must throw when maxRetries=0 fails');
      assertEqual(calls, 1, 'maxRetries=0 permits at most 1 real POST (0 retries)');
    }
  });

  // 6. Definite non-retryable failure (e.g. 400 Bad Request) -> immediately surfaced, 0 retries, no lookup
  t('definite non-retryable failure (400 Bad Request) → immediately surfaced, no retries, no lookup', async () => {
    let attemptCalls = 0;
    let lookupCalls = 0;
    const store = new InMemoryStore();
    const key = 'ord_bad_request_1';

    const attempt = async () => {
      attemptCalls++;
      const err = new Error('Invalid merchantTransactionId format');
      err.status = 400;
      throw err;
    };

    const lookup = async () => {
      lookupCalls++;
      return null;
    };

    let threw = false;
    try {
      await idempotentMoneyPost({ key, attempt, lookup, store, maxRetries: 2 });
    } catch (err) {
      threw = true;
      assertEqual(err.status, 400, 'surfaces HTTP 400 error');
    }

    assert(threw, 'should throw on non-retryable error');
    assertEqual(attemptCalls, 1, 'attempt called exactly once (no retry)');
    assertEqual(lookupCalls, 1, 'pre-flight lookup called; no retry lookups after definite 400');
  });

  // 7. Lookup fails after timeout -> fail closed (abort retry to prevent double charge)
  t('lookup error after timeout → fails closed and aborts retry (anti-double-charge guard)', async () => {
    let attemptCalls = 0;
    const store = new InMemoryStore();
    const key = 'ord_lookup_fail_closed_1';

    const attempt = async () => {
      attemptCalls++;
      const err = new Error('Connection timed out');
      err.code = 'ETIMEDOUT';
      throw err;
    };

    let lookupCount = 0;
    const lookup = async () => {
      lookupCount++;
      if (lookupCount > 1) {
        // Simulate status API being unreachable on pre-retry check
        throw new Error('503 Service Unavailable on status lookup');
      }
      return null; // Pre-flight check: payment absent
    };

    let threw = false;
    try {
      await idempotentMoneyPost({ key, attempt, lookup, store, maxRetries: 2 });
    } catch (err) {
      threw = true;
      assert(/Aborting retry to prevent double charge/i.test(err.message), 'fail closed message');
    }

    assert(threw, 'must fail closed');
    assertEqual(attemptCalls, 1, 'must NOT make a second POST when lookup status is uncertain');
  });

  // 8. Pre-flight lookup adoption: payment already exists remotely before first attempt
  t('pre-flight lookup adoption → adopts existing payment before any POST attempt', async () => {
    let attemptCalls = 0;
    const store = new InMemoryStore();
    const key = 'ord_preflight_found_1';

    const attempt = async () => {
      attemptCalls++;
      return { id: 'ch_new' };
    };

    const lookup = async () => {
      return { id: 'ch_already_exists', status: 'successful' };
    };

    const result = await idempotentMoneyPost({ key, attempt, lookup, store });
    assertEqual(result.id, 'ch_already_exists', 'adopts pre-existing remote payment');
    assertEqual(attemptCalls, 0, 'attempt must NEVER be called if payment exists before POST');

    const stored = await store.get(key);
    assertEqual(stored.id, 'ch_already_exists', 'persisted adopted payment in store');
  });

  // 9. Parameter validation: throws TypeError on missing or invalid inputs
  t('parameter validation → throws TypeError on missing key, attempt, or lookup', async () => {
    let threw1 = false;
    try {
      await idempotentMoneyPost({ attempt: async () => {}, lookup: async () => {} });
    } catch (e) {
      threw1 = e instanceof TypeError;
    }
    assert(threw1, 'requires key');

    let threw2 = false;
    try {
      await idempotentMoneyPost({ key: 'k', lookup: async () => {} });
    } catch (e) {
      threw2 = e instanceof TypeError;
    }
    assert(threw2, 'requires attempt function');

    let threw3 = false;
    try {
      await idempotentMoneyPost({ key: 'k', attempt: async () => {} });
    } catch (e) {
      threw3 = e instanceof TypeError;
    }
    assert(threw3, 'requires lookup function');
  });

  // 10. timeoutMs enforcement wraps long-running attempts
  t('timeoutMs enforces per-attempt timeout and triggers safe lookup-then-retry', async () => {
    let attemptCalls = 0;
    const store = new InMemoryStore();
    const key = 'ord_timeout_ms_test';

    const attempt = async () => {
      attemptCalls++;
      // Simulate hanging attempt longer than timeoutMs
      await sleep(60);
      return { id: 'ch_never_reached' };
    };

    let lookupCount = 0;
    const lookup = async () => {
      lookupCount++;
      if (lookupCount === 1) return null; // Pre-flight check: absent
      return { id: 'ch_saved_by_lookup', status: 'successful' };
    };

    const result = await idempotentMoneyPost({
      key,
      attempt,
      lookup,
      store,
      timeoutMs: 15,
      maxRetries: 1,
    });

    assertEqual(result.id, 'ch_saved_by_lookup', 'adopted result after timeoutMs triggered');
    assertEqual(attemptCalls, 1, 'attempt called once');
  });

  // Run all tests sequentially
  let passed = 0;
  let failed = 0;

  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
      passed++;
    } catch (err) {
      console.error(`FAIL  ${name}`);
      console.error(`      ${err.message}`);
      failed++;
    }
  }

  console.log(`\n${passed}/${tests.length} passed`);
  return failed === 0;
}

/* ────────────────────────────────────────────────────────────────────────────
 * CLI Entry Point
 * ──────────────────────────────────────────────────────────────────────────── */

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === 'selftest' || args.length === 0) {
    runSelftest().then((success) => {
      process.exit(success ? 0 : 1);
    });
  } else {
    console.log('Usage: node idempotent-retry.js selftest');
    process.exit(2);
  }
}

module.exports = {
  idempotentMoneyPost,
  InMemoryStore,
  defaultIsTimeoutOrUncertain,
  runSelftest,
};
