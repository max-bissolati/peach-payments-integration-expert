#!/usr/bin/env node
'use strict';

/*
 * smoke-test.js — zero-dependency SANDBOX smoke-test tool for Peach Payments.
 *
 * SAFETY PRINCIPLES:
 *   1. Hard host allowlist: Only approved sandbox hosts may ever be accessed.
 *      Before every network call, target host is asserted against the allowlist;
 *      any live host or unknown host immediately throws and aborts.
 *   2. No money movement: Only performs OAuth token acquisition and checkout
 *      payload validation (/v2/checkout/validate). Never creates real checkouts,
 *      never charges, never captures, never refunds, never pays out.
 *   3. Offline webhook verification: Webhook signature round-trip is tested
 *      purely offline using synthetic test secrets and fixtures.
 *   4. Zero credential leakage: Secret values (client secrets, access tokens,
 *      tokens, webhook secrets) are never printed or logged.
 *
 * CLI USAGE:
 *   node scripts/smoke-test.js [--env <path>]   # LIVE sandbox checks (needs sandbox creds in env)
 *   node scripts/smoke-test.js selftest         # OFFLINE tests only (no network) — CI runs this
 *
 * EXIT CODES:
 *   0 = all checks / selftests passed
 *   1 = one or more checks / selftests failed
 *   2 = CLI usage or input error
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Reuse existing verifier and sample generator
const { generateClassicSample } = require('./webhook-sample');
const { verifyPeachWebhook } = require('./verify-webhook');

const PROG = 'smoke-test.js';

/* ────────────────────────────────────────────────────────────────────────────
 * Safety & Host Allowlist
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * HARD SANDBOX HOST ALLOWLIST
 * Only these hosts are permitted for network operations.
 */
const SANDBOX_HOST_ALLOWLIST = new Set([
  'sandbox-dashboard.peachpayments.com',
  'testsecure.peachpayments.com',
  'testapi.peachpayments.com',
  'testapi-v2.peachpayments.com',
  'sandbox-card.peachpayments.com',
  'sandbox-checkout.peachpayments.com',
  'sandbox-payouts.peachpayments.com',
]);

/**
 * Prohibited live Peach Payments hostnames to explicitly refuse.
 */
const PROHIBITED_LIVE_HOSTS = new Set([
  'secure.peachpayments.com',
  'dashboard.peachpayments.com',
  'api.peachpayments.com',
  'api-v2.peachpayments.com',
  'card.peachpayments.com',
  'checkout.peachpayments.com',
  'payouts.peachpayments.com',
  'reconciliation.peachpayments.com',
  'links.peachpayments.com',
]);

/**
 * Extract lowercase hostname from URL string or URL instance.
 */
function extractHostname(target) {
  if (!target) return '';
  if (target instanceof URL) return target.hostname.toLowerCase();
  const str = String(target).trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(str)) {
    try {
      return new URL(str).hostname.toLowerCase();
    } catch (_) {
      return '';
    }
  }
  return str.split('/')[0].split(':')[0].toLowerCase();
}

/**
 * Identify if a hostname belongs to the prohibited live Peach Payments set.
 */
function isLivePeachHost(hostname) {
  const h = String(hostname || '').trim().toLowerCase();
  if (!h) return false;
  if (PROHIBITED_LIVE_HOSTS.has(h)) return true;

  if (h.endsWith('.peachpayments.com')) {
    const prefix = h.slice(0, -'.peachpayments.com'.length);
    if (!prefix.startsWith('sandbox-') && !prefix.startsWith('test')) {
      return true;
    }
  }
  return false;
}

/**
 * Host guard: asserts that a target URL/host is in the sandbox allowlist.
 * Throws immediately if target is live, unapproved, or malformed.
 */
function assertSandboxHost(target) {
  const hostname = extractHostname(target);
  if (!hostname) {
    throw new Error(`Host assertion failed: target host is empty or invalid ('${target}')`);
  }

  if (isLivePeachHost(hostname)) {
    throw new Error(`SECURITY ALERT: Prohibited LIVE Peach Payments host detected: '${hostname}'. Aborting.`);
  }

  if (!SANDBOX_HOST_ALLOWLIST.has(hostname)) {
    throw new Error(`SECURITY ALERT: Host '${hostname}' is not in the sandbox allowlist. Aborting.`);
  }

  return hostname;
}

/**
 * Inspect a configuration map for any live or unallowlisted hosts.
 * Throws immediately on the first unapproved or live host found.
 */
function guardConfigHosts(config) {
  const cfg = config || {};
  const hostKeys = Object.keys(cfg).filter(
    (k) => k.endsWith('_HOST') || /host/i.test(k)
  );

  for (const key of hostKeys) {
    const val = cfg[key];
    if (val && typeof val === 'string' && val.trim()) {
      assertSandboxHost(val);
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Network Guard & Transport
 * ──────────────────────────────────────────────────────────────────────────── */

let NETWORK_ENABLED = false;
let NETWORK_CALL_COUNT = 0;

function setNetworkEnabled(enabled) {
  NETWORK_ENABLED = Boolean(enabled);
}

function getNetworkCallCount() {
  return NETWORK_CALL_COUNT;
}

function resetNetworkCallCount() {
  NETWORK_CALL_COUNT = 0;
}

/**
 * Safe fetch wrapper that enforces host allowlist check and offline gate.
 */
async function safeFetch(url, options = {}) {
  if (!NETWORK_ENABLED) {
    throw new Error('INTERNAL SAFETY GUARD: Network call blocked in offline mode');
  }

  // Hard assertion before EVERY network call
  assertSandboxHost(url);
  NETWORK_CALL_COUNT++;

  const controller = new AbortController();
  const timeoutMs = options.timeout || 15000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timeoutId);
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Environment Configuration
 * ──────────────────────────────────────────────────────────────────────────── */

const REQUIRED_ENV_VARS = [
  'PEACH_CLIENT_ID',
  'PEACH_CLIENT_SECRET',
  'PEACH_MERCHANT_ID',
  'PEACH_ENTITY_ID',
  'PEACH_AUTH_HOST',
  'PEACH_CHECKOUT_HOST',
];

/**
 * Parse a .env file safely without logging secrets.
 */
function parseEnvFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const env = {};
  const lines = content.split(/\r?\n/);
  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();

    if (val.startsWith('"')) {
      const match = val.match(/^"([^"\\]*(?:\\.[^"\\]*)*)"/);
      val = match ? match[1] : val.slice(1);
    } else if (val.startsWith("'")) {
      const match = val.match(/^'([^']*)'/);
      val = match ? match[1] : val.slice(1);
    } else {
      val = val.replace(/\s*#.*$/, '').trim();
    }
    env[key] = val;
  }
  return env;
}

/**
 * Verify required sandbox credentials and hosts are present.
 */
function checkEnv(config) {
  const cfg = config || {};
  const missing = [];
  const present = [];

  for (const key of REQUIRED_ENV_VARS) {
    const val = cfg[key];
    if (typeof val === 'string' && val.trim().length > 0) {
      present.push(key);
    } else {
      missing.push(key);
    }
  }

  return {
    pass: missing.length === 0,
    present,
    missing,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Smoke-Test Checks (LIVE Mode)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Check 3: Acquire OAuth access token.
 * Never prints or returns the raw token in log output.
 */
async function runOAuthCheck(config) {
  const authHost = (config.PEACH_AUTH_HOST || '').replace(/\/+$/, '');
  const url = `${authHost}/api/oauth/token`;

  const payload = {
    clientId: config.PEACH_CLIENT_ID,
    clientSecret: config.PEACH_CLIENT_SECRET,
    merchantId: config.PEACH_MERCHANT_ID,
  };

  let res;
  try {
    res = await safeFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return {
      pass: false,
      msg: `OAuth request failed: ${err.message}`,
    };
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return {
      pass: false,
      msg: `OAuth call returned HTTP ${res.status}: ${errText.slice(0, 150)}`,
    };
  }

  let data;
  try {
    data = await res.json();
  } catch (e) {
    return {
      pass: false,
      msg: `OAuth response is not valid JSON: ${e.message}`,
    };
  }

  if (!data || typeof data.access_token !== 'string' || !data.access_token) {
    return {
      pass: false,
      msg: 'OAuth response did not contain an access_token',
    };
  }

  return {
    pass: true,
    tokenType: data.token_type || 'Bearer',
    expiresIn: data.expires_in !== undefined ? `${data.expires_in}s` : 'unknown',
    accessToken: data.access_token, // strictly kept in memory, never logged
  };
}

/**
 * Check 4: Checkout validate (validate-only, no money moved).
 * Calls POST /v2/checkout/validate.
 */
async function runValidateCheck(config, accessToken) {
  const checkoutHost = (config.PEACH_CHECKOUT_HOST || '').replace(/\/+$/, '');
  const url = `${checkoutHost}/v2/checkout/validate`;

  const merchantTxId = 'SMK' + crypto.randomBytes(5).toString('hex').toUpperCase();
  const nonce = crypto.randomUUID();
  const shopperResultUrl = 'https://example.com/checkout/result';

  const body = {
    'authentication.entityId': config.PEACH_ENTITY_ID,
    merchantTransactionId: merchantTxId,
    amount: '1.00',
    currency: 'ZAR',
    nonce,
    shopperResultUrl,
  };

  let res;
  try {
    res = await safeFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Origin: 'https://example.com',
        Referer: 'https://example.com/',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      pass: false,
      msg: `Checkout validate request failed: ${err.message}`,
    };
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return {
      pass: false,
      msg: `Checkout validate returned HTTP ${res.status}: ${errText.slice(0, 150)}`,
    };
  }

  let data = {};
  try {
    data = await res.json();
  } catch (_) {
    data = {};
  }

  // Peach returns {"message":"Valid request"} or a status code on validate
  const reportedCode = data['result.code'] || data.resultCode || data.message || 'Valid request';

  return {
    pass: true,
    code: reportedCode,
  };
}

/**
 * Check 5: Webhook signature round-trip (OFFLINE, no network).
 */
function runSignatureRoundTrip() {
  const testSecret = 'smoke_test_secret_token_abc123';

  // 1. Generate valid sample and verify
  const sample = generateClassicSample({ secret: testSecret });
  const validRes = verifyPeachWebhook({
    secretToken: testSecret,
    rawBody: sample.rawBody,
  });

  if (!validRes.valid) {
    return {
      pass: false,
      msg: `Valid sample verification failed: ${validRes.reason || 'unknown'}`,
    };
  }

  // 2. Generate tampered sample and verify rejection
  const tamperedSample = generateClassicSample({ secret: testSecret, tamper: true });
  const tamperedRes = verifyPeachWebhook({
    secretToken: testSecret,
    rawBody: tamperedSample.rawBody,
  });

  if (tamperedRes.valid) {
    return {
      pass: false,
      msg: 'Tampered sample unexpectedly passed verification (expected failure)',
    };
  }

  return {
    pass: true,
    scheme: validRes.scheme,
    tamperReason: tamperedRes.reason,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Runner: Live Mode
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Execute LIVE mode smoke tests against sandbox.
 */
async function runSmokeTest(options = {}) {
  const opts = options || {};
  let config = { ...process.env, ...(opts.config || {}) };

  if (opts.envPath) {
    if (!fs.existsSync(opts.envPath)) {
      if (!opts.silent) {
        console.error(`${PROG}: error: env file not found: ${opts.envPath}`);
      }
      return { passed: false, results: [] };
    }
    const parsed = parseEnvFile(opts.envPath);
    config = { ...config, ...parsed };
  } else if (!opts.config && fs.existsSync(path.resolve('.env'))) {
    // Convenience: load local .env if present and not explicitly configured
    const parsed = parseEnvFile(path.resolve('.env'));
    config = { ...config, ...parsed };
  }

  const log = opts.silent ? () => {} : console.log;
  const results = [];

  log('============================================================');
  log('Peach Payments Sandbox Smoke Test (Zero-Money-Movement)');
  log('============================================================');

  // Check 1: Environment variables
  const envCheck = checkEnv(config);
  if (!envCheck.pass) {
    log(`FAIL  1. Env: Missing required sandbox creds/hosts: ${envCheck.missing.join(', ')}`);
    results.push({ name: '1. Env', status: 'FAIL', reason: `Missing: ${envCheck.missing.join(', ')}` });
  } else {
    log(`PASS  1. Env: Required sandbox credentials and hosts present`);
    log(`      (PEACH_CLIENT_ID, PEACH_CLIENT_SECRET, PEACH_MERCHANT_ID, PEACH_ENTITY_ID, PEACH_AUTH_HOST, PEACH_CHECKOUT_HOST)`);
    results.push({ name: '1. Env', status: 'PASS' });
  }

  // Check 2: Host allowlist self-assert
  let allowlistPassed = false;
  if (!envCheck.pass) {
    log('SKIP  2. Host allowlist: Skipped due to missing environment configuration');
    results.push({ name: '2. Host allowlist', status: 'SKIP' });
  } else {
    try {
      guardConfigHosts(config);
      allowlistPassed = true;
      log('PASS  2. Host allowlist: All configured hosts are in the sandbox allowlist');
      log(`      PEACH_AUTH_HOST:     ${extractHostname(config.PEACH_AUTH_HOST)}`);
      log(`      PEACH_CHECKOUT_HOST: ${extractHostname(config.PEACH_CHECKOUT_HOST)}`);
      results.push({ name: '2. Host allowlist', status: 'PASS' });
    } catch (err) {
      log(`FAIL  2. Host allowlist: ${err.message}`);
      results.push({ name: '2. Host allowlist', status: 'FAIL', reason: err.message });
    }
  }

  // Check 3: OAuth Token (Network call)
  let oauthResult = null;
  if (!envCheck.pass || !allowlistPassed) {
    log('SKIP  3. OAuth token: Skipped (prerequisites failed)');
    results.push({ name: '3. OAuth token', status: 'SKIP' });
  } else {
    setNetworkEnabled(true);
    oauthResult = await runOAuthCheck(config);
    if (oauthResult.pass) {
      log(`PASS  3. OAuth: Acquired sandbox token (token_type: ${oauthResult.tokenType}, expires_in: ${oauthResult.expiresIn})`);
      log('      Token value withheld for security.');
      results.push({ name: '3. OAuth token', status: 'PASS' });
    } else {
      log(`FAIL  3. OAuth: ${oauthResult.msg}`);
      results.push({ name: '3. OAuth token', status: 'FAIL', reason: oauthResult.msg });
    }
  }

  // Check 4: Checkout Validate (Network call, validate-only)
  if (!oauthResult || !oauthResult.pass) {
    log('SKIP  4. Validate: Skipped (OAuth token unavailable)');
    results.push({ name: '4. Validate', status: 'SKIP' });
  } else {
    const validateRes = await runValidateCheck(config, oauthResult.accessToken);
    if (validateRes.pass) {
      log(`PASS  4. Validate: POST /v2/checkout/validate succeeded (reported: ${validateRes.code})`);
      log('      Validate-only endpoint confirmed; zero money movement.');
      results.push({ name: '4. Validate', status: 'PASS' });
    } else {
      log(`FAIL  4. Validate: ${validateRes.msg}`);
      results.push({ name: '4. Validate', status: 'FAIL', reason: validateRes.msg });
    }
  }

  // Check 5: Signature Round-Trip (OFFLINE)
  const sigRes = runSignatureRoundTrip();
  if (sigRes.pass) {
    log(`PASS  5. Signature round-trip: Verified valid sample (${sigRes.scheme}) and rejected tampered sample (${sigRes.tamperReason})`);
    results.push({ name: '5. Signature round-trip', status: 'PASS' });
  } else {
    log(`FAIL  5. Signature round-trip: ${sigRes.msg}`);
    results.push({ name: '5. Signature round-trip', status: 'FAIL', reason: sigRes.msg });
  }

  const passedCount = results.filter((r) => r.status === 'PASS').length;
  const failedCount = results.filter((r) => r.status === 'FAIL').length;
  const skippedCount = results.filter((r) => r.status === 'SKIP').length;
  const overallPass = failedCount === 0 && skippedCount === 0;

  log('------------------------------------------------------------');
  log(`Summary: ${passedCount}/${results.length} checks passed, ${failedCount} failed, ${skippedCount} skipped`);
  log(`SMOKE TEST: ${overallPass ? 'PASS' : 'FAIL'}`);
  log('============================================================');

  return {
    passed: overallPass,
    passedCount,
    failedCount,
    skippedCount,
    results,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Selftest (OFFLINE, CI Mode — Zero Network Calls)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Run comprehensive offline selftests.
 * Strict guarantee: NEVER makes any network calls.
 */
async function runSelftest() {
  setNetworkEnabled(false);
  resetNetworkCallCount();

  const tests = [];
  const t = (name, fn) => tests.push({ name, fn });
  const check = (cond, msg) => {
    if (!cond) throw new Error(msg || 'assertion failed');
  };

  // ── (a) Host allowlist tests ──────────────────────────────────────────────
  t('(a) host-allowlist ACCEPTS each sandbox host (raw and URL)', () => {
    for (const host of SANDBOX_HOST_ALLOWLIST) {
      const h1 = assertSandboxHost(host);
      check(h1 === host, `expected ${host}, got ${h1}`);
      const h2 = assertSandboxHost(`https://${host}/v2/checkout`);
      check(h2 === host, `expected ${host} from URL, got ${h2}`);
    }
  });

  t('(a) host-allowlist REJECTS each live host (raw and URL)', () => {
    for (const liveHost of PROHIBITED_LIVE_HOSTS) {
      let threwRaw = false;
      try {
        assertSandboxHost(liveHost);
      } catch (err) {
        threwRaw = true;
        check(err.message.includes('SECURITY ALERT'), `expected security alert, got: ${err.message}`);
      }
      check(threwRaw, `expected live host '${liveHost}' to throw`);

      let threwUrl = false;
      try {
        assertSandboxHost(`https://${liveHost}/api/oauth/token`);
      } catch (err) {
        threwUrl = true;
        check(err.message.includes('SECURITY ALERT'), `expected security alert, got: ${err.message}`);
      }
      check(threwUrl, `expected live host URL 'https://${liveHost}' to throw`);
    }
  });

  t('(a) host-allowlist REJECTS random and attacker domains', () => {
    const randomHosts = [
      'google.com',
      'example.com',
      'attacker.com',
      'https://malicious.org/test',
      'sandbox-dashboard.peachpayments.com.attacker.com',
      'evil-peachpayments.com',
      '',
    ];
    for (const rh of randomHosts) {
      let threw = false;
      try {
        assertSandboxHost(rh);
      } catch (err) {
        threw = true;
      }
      check(threw, `expected random host '${rh}' to throw`);
    }
  });

  // ── (b) Live host in config guard tests ────────────────────────────────────
  t('(b) live host in PEACH_AUTH_HOST makes config guard abort', () => {
    let threw = false;
    try {
      guardConfigHosts({
        PEACH_AUTH_HOST: 'https://dashboard.peachpayments.com',
        PEACH_CHECKOUT_HOST: 'https://testsecure.peachpayments.com',
      });
    } catch (err) {
      threw = true;
      check(err.message.includes('dashboard.peachpayments.com'), `wrong error: ${err.message}`);
    }
    check(threw, 'guard did not abort on live PEACH_AUTH_HOST');
  });

  t('(b) live host in PEACH_CHECKOUT_HOST makes config guard abort', () => {
    let threw = false;
    try {
      guardConfigHosts({
        PEACH_AUTH_HOST: 'https://sandbox-dashboard.peachpayments.com',
        PEACH_CHECKOUT_HOST: 'https://secure.peachpayments.com',
      });
    } catch (err) {
      threw = true;
      check(err.message.includes('secure.peachpayments.com'), `wrong error: ${err.message}`);
    }
    check(threw, 'guard did not abort on live PEACH_CHECKOUT_HOST');
  });

  t('(b) live host in PEACH_CARD_HOST makes config guard abort', () => {
    let threw = false;
    try {
      guardConfigHosts({
        PEACH_AUTH_HOST: 'https://sandbox-dashboard.peachpayments.com',
        PEACH_CHECKOUT_HOST: 'https://testsecure.peachpayments.com',
        PEACH_CARD_HOST: 'https://card.peachpayments.com',
      });
    } catch (err) {
      threw = true;
      check(err.message.includes('card.peachpayments.com'), `wrong error: ${err.message}`);
    }
    check(threw, 'guard did not abort on live PEACH_CARD_HOST');
  });

  t('(b) live host in PEACH_PAYOUTS_HOST makes config guard abort', () => {
    let threw = false;
    try {
      guardConfigHosts({
        PEACH_AUTH_HOST: 'https://sandbox-dashboard.peachpayments.com',
        PEACH_CHECKOUT_HOST: 'https://testsecure.peachpayments.com',
        PEACH_PAYOUTS_HOST: 'https://payouts.peachpayments.com',
      });
    } catch (err) {
      threw = true;
      check(err.message.includes('payouts.peachpayments.com'), `wrong error: ${err.message}`);
    }
    check(threw, 'guard did not abort on live PEACH_PAYOUTS_HOST');
  });

  t('(b) all-sandbox config passes guard without throwing', () => {
    guardConfigHosts({
      PEACH_AUTH_HOST: 'https://sandbox-dashboard.peachpayments.com',
      PEACH_CHECKOUT_HOST: 'https://testsecure.peachpayments.com',
      PEACH_CARD_HOST: 'https://sandbox-card.peachpayments.com',
      PEACH_PAYOUTS_HOST: 'https://sandbox-payouts.peachpayments.com',
    });
  });

  // ── (c) Signature round-trip tests ────────────────────────────────────────
  t('(c) signature round-trip passes for valid sample and fails for tampered sample', () => {
    const res = runSignatureRoundTrip();
    check(res.pass === true, `signature round-trip failed: ${res.msg}`);
    check(Boolean(res.scheme), 'scheme expected');
    check(res.tamperReason === 'signature_mismatch', `expected signature_mismatch, got ${res.tamperReason}`);
  });

  // ── (d) Missing-creds guard & mock tests ──────────────────────────────────
  t('(d) missing-creds path returns FAIL on empty config without network calls', () => {
    const envRes = checkEnv({});
    check(envRes.pass === false, 'empty config must fail env check');
    check(envRes.missing.length === REQUIRED_ENV_VARS.length, 'all vars must be reported missing');
    for (const reqVar of REQUIRED_ENV_VARS) {
      check(envRes.missing.includes(reqVar), `missing var list must include ${reqVar}`);
    }
  });

  t('(d) missing-creds path returns FAIL on partial config without network calls', () => {
    const envRes = checkEnv({
      PEACH_CLIENT_ID: 'test_client_id',
      PEACH_AUTH_HOST: 'https://sandbox-dashboard.peachpayments.com',
    });
    check(envRes.pass === false, 'partial config must fail env check');
    check(envRes.present.includes('PEACH_CLIENT_ID'), 'present must include PEACH_CLIENT_ID');
    check(envRes.missing.includes('PEACH_CLIENT_SECRET'), 'missing must include PEACH_CLIENT_SECRET');
    check(envRes.missing.includes('PEACH_MERCHANT_ID'), 'missing must include PEACH_MERCHANT_ID');
    check(envRes.missing.includes('PEACH_ENTITY_ID'), 'missing must include PEACH_ENTITY_ID');
    check(envRes.missing.includes('PEACH_CHECKOUT_HOST'), 'missing must include PEACH_CHECKOUT_HOST');
  });

  t('(d) full runner with missing creds reports FAIL and skips network completely', async () => {
    const callsBefore = getNetworkCallCount();
    const result = await runSmokeTest({
      config: { PEACH_CLIENT_ID: 'only_id' },
      silent: true,
    });
    const callsAfter = getNetworkCallCount();

    check(result.passed === false, 'runner must report overall failure when creds missing');
    check(result.failedCount >= 1, 'must have failed checks');
    check(result.skippedCount >= 2, 'must have skipped checks for network stages');
    check(callsBefore === callsAfter, 'zero network calls must be executed when creds are missing');
    check(callsAfter === 0, 'network calls must remain zero');
  });

  // ── Offline network safety assertion ──────────────────────────────────────
  t('offline guard: safeFetch strictly throws when offline mode is active', async () => {
    setNetworkEnabled(false);
    let threw = false;
    try {
      await safeFetch('https://sandbox-dashboard.peachpayments.com');
    } catch (err) {
      threw = true;
      check(err.message.includes('INTERNAL SAFETY GUARD'), `wrong error: ${err.message}`);
    }
    check(threw, 'safeFetch must throw when network is disabled');
    check(getNetworkCallCount() === 0, 'network call counter must remain zero');
  });

  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL  ${name}`);
      console.log(`      ${e.message}`);
    }
  }

  const passedCount = tests.length - failed;
  console.log(`\n${passedCount}/${tests.length} passed`);

  // Final confirmation that network was NEVER touched during selftest
  check(getNetworkCallCount() === 0, 'FATAL: network call detected during selftest');

  return failed === 0;
}

/* ────────────────────────────────────────────────────────────────────────────
 * CLI Argument Parsing & Entry Point
 * ──────────────────────────────────────────────────────────────────────────── */

function printHelp() {
  console.log(`${PROG} — Peach Payments Sandbox Smoke-Test Tool (zero deps, Node >= 18)

PURPOSE
  Proves a Peach Payments integration's basics against the SANDBOX without
  ever charging money, capturing, or touching a live host.

SAFETY
  - HARD host allowlist: sandbox-dashboard, testsecure, testapi, sandbox-card, etc.
  - Live hosts (secure., dashboard., api., card., payouts.) are strictly refused.
  - Zero money movement: only OAuth token and validate-only endpoint are tested.
  - Secrets are never printed or logged.

USAGE
  node scripts/${PROG} [--env <path>]   # LIVE sandbox checks (needs sandbox credentials in env)
  node scripts/${PROG} selftest         # OFFLINE tests only (no network) — CI runs this
  node scripts/${PROG} --help           # Show this help message

OPTIONS
  --env <path>   Path to .env file containing sandbox credentials and hosts
  --help, -h     Display help information

CHECKS (LIVE mode)
  1. Env: verify required credentials/hosts present (skip network if missing)
  2. Host allowlist: verify all configured hosts are in the sandbox allowlist
  3. OAuth: POST {auth host}/api/oauth/token (verifies access_token + expires_in)
  4. Validate: POST {checkout host}/v2/checkout/validate (validate-only, no charge)
  5. Signature round-trip: OFFLINE sample generation & verification (tamper rejection)
`);
}

function parseArgs(argv) {
  const out = { command: null, envPath: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      out.help = true;
    } else if (a === 'selftest') {
      out.command = 'selftest';
    } else if (a === '--env') {
      if (i + 1 < argv.length) {
        out.envPath = argv[++i];
      } else {
        throw new Error('Flag --env requires a path argument');
      }
    } else if (a.startsWith('--env=')) {
      out.envPath = a.slice(6);
    } else if (!a.startsWith('-') && !out.command) {
      out.command = a;
    } else {
      throw new Error(`Unknown argument '${a}'`);
    }
  }
  return out;
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    console.error(`${PROG}: error: ${err.message}`);
    process.exitCode = 2;
    return;
  }

  if (parsed.help) {
    printHelp();
    process.exitCode = 0;
    return;
  }

  if (parsed.command === 'selftest') {
    const ok = await runSelftest();
    process.exitCode = ok ? 0 : 1;
    return;
  }

  if (parsed.command && parsed.command !== 'selftest') {
    console.error(`${PROG}: error: unknown command '${parsed.command}' (expected 'selftest' or options)`);
    process.exitCode = 2;
    return;
  }

  // Live sandbox checks
  const runResult = await runSmokeTest({ envPath: parsed.envPath });
  process.exitCode = runResult.passed ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`${PROG}: unhandled error: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  SANDBOX_HOST_ALLOWLIST,
  PROHIBITED_LIVE_HOSTS,
  extractHostname,
  isLivePeachHost,
  assertSandboxHost,
  guardConfigHosts,
  parseEnvFile,
  checkEnv,
  safeFetch,
  runOAuthCheck,
  runValidateCheck,
  runSignatureRoundTrip,
  runSmokeTest,
  runSelftest,
};
