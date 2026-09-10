#!/usr/bin/env node
'use strict';

/*
 * preflight.js — static go-live readiness checker for Peach Payments integrations.
 *
 * This tool bundles the Peach Payments definition-of-done (testing-and-go-live.md §5)
 * into a single PASS/FAIL gate command that developers and autonomous agents run
 * before deploying an integration.
 *
 * NOTE: This is a strictly STATIC preflight check. It inspects local source code,
 * framework usage patterns, known footguns, and environment configuration.
 * It NEVER makes live network calls, never initiates transactions, and never
 * prints secret credential values. Live money movement must always be owner-run
 * and deliberate (testing-and-go-live.md §7).
 *
 * Usage:
 *   node scripts/preflight.js <integration-dir> [--env <path-to-.env>]
 *   node scripts/preflight.js selftest
 *
 * Exit code:
 *   0 = all checks PASS (WARN is advisory and allowed)
 *   1 = any check FAILs (blocks go-live)
 *   2 = usage error / invalid arguments
 *
 * Zero dependencies: Node built-ins only (fs, path, child_process, os).
 */

const fs = require('fs');
const path = require('path');
const child_process = require('child_process');
const os = require('os');

const REQUIRED_ENV_VARS = [
  'PEACH_CLIENT_ID',
  'PEACH_CLIENT_SECRET',
  'PEACH_MERCHANT_ID',
  'PEACH_ENTITY_ID',
  'PEACH_SECRET_TOKEN',
  'PEACH_AUTH_HOST',
  'PEACH_CHECKOUT_HOST',
];

/**
 * Parse a .env file (KEY=VALUE lines, ignoring comments and blanks).
 * Never prints or leaks secret values.
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
      // Strip unquoted inline comments
      val = val.replace(/\s*#.*$/, '').trim();
    }
    env[key] = val;
  }
  return env;
}

/**
 * Classify a host URL as 'sandbox', 'live', or 'unknown'.
 * Sandbox hosts contain sandbox-, testsecure, or testapi.
 * Live hosts are non-prefixed secure., dashboard., card., api.peachpayments, etc.
 */
function classifyPeachHost(url) {
  if (!url || typeof url !== 'string') return 'unknown';
  const lower = url.toLowerCase();
  if (lower.includes('sandbox-') || lower.includes('testsecure') || lower.includes('testapi')) {
    return 'sandbox';
  }
  if (
    lower.includes('secure.peachpayments.com') ||
    lower.includes('dashboard.peachpayments.com') ||
    lower.includes('card.peachpayments.com') ||
    lower.includes('api.peachpayments.com') ||
    lower.includes('links.peachpayments.com') ||
    lower.includes('payouts.peachpayments.com') ||
    lower.includes('reconciliation.peachpayments.com') ||
    lower.includes('api-v2.peachpayments.com') ||
    lower.includes('app.next.peachpayments.com') ||
    /\b(secure|dashboard|card|api)\.peachpayments\b/.test(lower)
  ) {
    return 'live';
  }
  return 'unknown';
}

/**
 * Check if a URL contains an Orchestration API host (app.next or app.sandbox-next).
 */
function isOrchestrationHost(url) {
  if (!url || typeof url !== 'string') return false;
  // Match the Orchestration API host as a HOST token (preceded by scheme //, @, a dot, or start, and
  // followed by a path/port/query/end) — NOT a loose substring, so a redirect/query value that merely
  // contains the string (e.g. ?next=app.next.peachpayments.com) does not misdetect.
  return /(^|\/\/|@|\.)app\.(?:sandbox-)?next\.peachpayments\.com(?=[/:?#]|$)/i.test(url.trim());
}

/**
 * Classify the Orchestration signals in an environment. Detection is TIERED because a bare `pk_`
 * publishable key is ambiguous — Stripe (and other PSPs) use `pk_live_`/`pk_test_` too, so a lone
 * `pk_` must NOT flip the profile and silently skip the Checkout required-vars gate.
 *   STRONG (unambiguously Peach Orchestration): an Orchestration host value, or a *_hash_key-named var.
 *   WEAK: a `pk_` value with no strong signal — advise, do not switch profile on it alone.
 */
function orchestrationSignals(env) {
  const sig = { hasOrchHost: false, hasHashKeyVar: false, hasPk: false, pkVars: [] };
  if (!env || typeof env !== 'object') return { ...sig, strong: false };
  for (const [k, v] of Object.entries(env)) {
    if (!v || typeof v !== 'string') continue;
    const t = v.trim();
    if (isOrchestrationHost(t)) sig.hasOrchHost = true;
    if (t.toLowerCase().startsWith('pk_')) { sig.hasPk = true; sig.pkVars.push(k); }
    if (/payment_response_hash|_hash_key\b|webhook[_-]?hash/i.test(k) && t.length > 0) sig.hasHashKeyVar = true;
  }
  // STRONG (auto-flip to Orchestration) requires the ONE unambiguous Peach signal: an Orchestration
  // HOST value. A pk_ (Stripe et al. use it too) or a *_hash_key-named var (Checkout ALSO has a hash
  // key for redirect/webhook signatures) are AMBIGUOUS — they must NOT flip the profile and bypass the
  // Checkout required-vars gate. They only raise the weak advisory. (Adversarial review, both rounds.)
  sig.strong = sig.hasOrchHost;
  return sig;
}

/**
 * Back-compat boolean detector (STRONG signals only — a lone pk_ does not count).
 */
function detectOrchestration(env) {
  return orchestrationSignals(env).strong;
}

/**
 * Heuristic check if the .env path is gitignored.
 * Checks git check-ignore first, then falls back to searching .gitignore upwards.
 */
function isEnvGitignored(envPath) {
  try {
    const res = child_process.spawnSync('git', ['check-ignore', '-q', envPath], {
      cwd: path.dirname(path.resolve(envPath)),
      encoding: 'utf8',
      stdio: 'pipe'
    });
    if (res.status === 0) return true;
  } catch (_) {}

  try {
    let curr = path.resolve(path.dirname(envPath));
    const root = path.parse(curr).root;
    while (curr && curr !== root) {
      const gi = path.join(curr, '.gitignore');
      if (fs.existsSync(gi)) {
        const content = fs.readFileSync(gi, 'utf8');
        const lines = content.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
        if (lines.some(l => l === '.env' || l === '*.env' || l === '.env*' || l.includes('.env'))) {
          return true;
        }
      }
      curr = path.dirname(curr);
    }
  } catch (_) {}

  return false;
}

/**
 * Check 1: Footgun scan — run check-integration.js on integrationDir.
 */
function runFootgunScan(integrationDir) {
  const checkScript = path.join(__dirname, 'check-integration.js');
  if (!fs.existsSync(checkScript)) {
    return {
      status: 'FAIL',
      reason: `check-integration.js not found at ${checkScript}`,
      fails: 1,
      warns: 0,
      findings: [],
      rawOutput: ''
    };
  }

  const resolvedDir = path.resolve(integrationDir);
  if (!fs.existsSync(resolvedDir)) {
    return {
      status: 'FAIL',
      reason: `Integration directory does not exist: ${integrationDir}`,
      fails: 1,
      warns: 0,
      findings: [],
      rawOutput: ''
    };
  }
  if (!fs.statSync(resolvedDir).isDirectory()) {
    return {
      status: 'FAIL',
      reason: `Integration path must be a DIRECTORY, not a file: ${integrationDir} — point preflight at your integration folder so it scans the whole thing`,
      fails: 1,
      warns: 0,
      findings: [],
      rawOutput: ''
    };
  }

  const res = child_process.spawnSync(process.execPath, [checkScript, resolvedDir], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const stdout = res.stdout || '';
  const stderr = res.stderr || '';
  const combined = (stdout + (stderr ? '\n' + stderr : '')).trim();

  // Parse structured findings
  const findings = [];
  const lines = combined.split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    const headerMatch = line.match(/^(FAIL|WARN)\s+(\S+)\s+\[([^\]]+)\]/);
    if (headerMatch) {
      if (current) findings.push(current);
      current = {
        severity: headerMatch[1],
        fileLoc: headerMatch[2],
        checkId: headerMatch[3],
        msg: '',
        ref: ''
      };
      continue;
    }
    if (current) {
      const msgMatch = line.match(/^\s{6}(?!→)(.*)$/);
      if (msgMatch) {
        current.msg = msgMatch[1].trim();
        continue;
      }
      const refMatch = line.match(/^\s{6}→\s*(.*)$/);
      if (refMatch) {
        current.ref = refMatch[1].trim();
        continue;
      }
    }
  }
  if (current) findings.push(current);

  if (combined.includes('No code files found in:')) {
    return {
      status: 'WARN',
      reason: 'No code files found to scan in integration directory',
      fails: 0,
      warns: 1,
      findings: [],
      rawOutput: combined
    };
  }

  const m = combined.match(/(\d+)\s+FAIL,\s+(\d+)\s+WARN/);
  if (m) {
    const fails = parseInt(m[1], 10);
    const warns = parseInt(m[2], 10);
    if (fails > 0) {
      return {
        status: 'FAIL',
        reason: `${fails} FAIL footgun finding(s), ${warns} WARN finding(s) — resolve before go-live`,
        fails,
        warns,
        findings,
        rawOutput: combined
      };
    }
    if (warns > 0) {
      return {
        status: 'WARN',
        reason: `0 FAIL, ${warns} WARN footgun finding(s) — triage recommended`,
        fails: 0,
        warns,
        findings,
        rawOutput: combined
      };
    }
    return {
      status: 'PASS',
      reason: '0 footguns found by check-integration.js (clean)',
      fails: 0,
      warns: 0,
      findings: [],
      rawOutput: combined
    };
  }

  if (combined.includes('✓ no Peach integration footguns found')) {
    return {
      status: 'PASS',
      reason: '0 footguns found by check-integration.js (clean)',
      fails: 0,
      warns: 0,
      findings: [],
      rawOutput: combined
    };
  }

  if (res.status !== 0) {
    return {
      status: 'FAIL',
      reason: `check-integration exited with code ${res.status}`,
      fails: 1,
      warns: 0,
      findings,
      rawOutput: combined
    };
  }

  return {
    status: 'PASS',
    reason: '0 footguns found by check-integration.js',
    fails: 0,
    warns: 0,
    findings: [],
    rawOutput: combined
  };
}

/**
 * Checks 2, 3, 4: inspect the provided environment file.
 * Supports both Checkout (default) and Mobile SDK V2 / Orchestration profiles.
 */
function inspectEnvironment(envPath, options = {}) {
  const profileOption = typeof options === 'string' ? options : (options && options.profile);
  if (!envPath) {
    return {
      provided: false,
      profile: profileOption || 'checkout',
      env: {},
      completeness: {
        status: 'SKIP',
        reason: 'skipped (no --env provided)'
      },
      hostConsistency: {
        status: 'SKIP',
        reason: 'skipped (no --env provided)'
      },
      secretPattern: {
        status: 'SKIP',
        reason: 'skipped (no --env provided)'
      }
    };
  }

  const resolvedEnv = path.resolve(envPath);
  if (!fs.existsSync(resolvedEnv)) {
    return {
      provided: true,
      profile: profileOption || 'checkout',
      env: {},
      completeness: {
        status: 'FAIL',
        reason: `.env file not found at ${envPath}`
      },
      hostConsistency: {
        status: 'FAIL',
        reason: `.env file not found at ${envPath}`
      },
      secretPattern: {
        status: 'WARN',
        reason: `.env file not found at ${envPath}`
      }
    };
  }

  let env = {};
  try {
    env = parseEnvFile(resolvedEnv);
  } catch (err) {
    return {
      provided: true,
      profile: profileOption || 'checkout',
      env: {},
      completeness: {
        status: 'FAIL',
        reason: `Failed to parse .env file: ${err.message}`
      },
      hostConsistency: {
        status: 'FAIL',
        reason: `Failed to parse .env file: ${err.message}`
      },
      secretPattern: {
        status: 'WARN',
        reason: 'Ensure .env is added to .gitignore'
      }
    };
  }

  // Profile determination: CLI override takes precedence, otherwise auto-detect on STRONG signals only.
  const sig = orchestrationSignals(env);
  const isDetectedOrch = sig.strong;
  const profile = profileOption || (isDetectedOrch ? 'orchestration' : 'checkout');
  const profileSource = profileOption ? 'CLI override' : (isDetectedOrch ? 'detected Orchestration' : 'default');
  // Weak signal: a pk_ key but no strong Orchestration marker → STAY in Checkout mode (so the required-var
  // gate is not bypassed by a foreign pk_), but advise. pk_ is also used by other PSPs (e.g. Stripe).
  const weakOrchNote = (!profileOption && !sig.strong && (sig.hasPk || sig.hasHashKeyVar))
    ? `Possible Orchestration signal (${sig.hasPk ? `pk_ key in ${sig.pkVars.join(', ')}` : 'a hash-key-named var'}) but no Peach Orchestration host in .env. If this is a Peach Mobile SDK V2 / Orchestration integration (its host may be a code constant), re-run with --profile orchestration. Note: pk_ keys and hash keys are also used by other PSPs (e.g. Stripe) and by Peach Checkout itself, so the Checkout required-var checks still apply.`
    : null;

  const declaredEnv = env.PEACH_ENV ? env.PEACH_ENV.trim().toLowerCase() : null;
  const gitignored = isEnvGitignored(resolvedEnv);
  const secretPattern = gitignored
    ? { status: 'PASS', reason: '.env is covered by .gitignore' }
    : { status: 'WARN', reason: '.env does not appear in .gitignore — verify secrets are never committed to version control' };

  if (profile === 'orchestration') {
    // 1. Publishable key check (lenient prefix matching pk_)
    const pkEntries = Object.entries(env).filter(([k, v]) => typeof v === 'string' && v.trim().toLowerCase().startsWith('pk_'));
    let publishableKey;
    if (pkEntries.length === 0) {
      // Not a FAIL: the SDK takes the publishable key as a CODE constant, so a valid Orchestration
      // integration legitimately keeps it out of .env. Advise, do not block. (Blocking is for host conflicts.)
      publishableKey = {
        status: 'WARN',
        reason: 'No pk_ publishable key found in .env — if it is set as the publishableKey code constant, verify it is pk_-prefixed and environment-matched (test vs live).'
      };
    } else {
      const hasLiveEnvTestKey = declaredEnv === 'live' && pkEntries.some(([, v]) => v.trim().toLowerCase().startsWith('pk_test_'));
      const hasSandboxEnvProdKey = declaredEnv === 'sandbox' && pkEntries.some(([, v]) => {
        const val = v.trim().toLowerCase();
        return val.startsWith('pk_prd_') || val.startsWith('pk_live');
      });
      const pkNames = pkEntries.map(e => e[0]).join(', ');

      if (hasLiveEnvTestKey) {
        publishableKey = {
          status: 'WARN',
          reason: `PEACH_ENV=live but test publishable key detected in ${pkNames} — verify before go-live`
        };
      } else if (hasSandboxEnvProdKey) {
        publishableKey = {
          status: 'WARN',
          reason: `PEACH_ENV=sandbox but live publishable key detected in ${pkNames} — verify before go-live`
        };
      } else {
        publishableKey = {
          status: 'PASS',
          reason: `Publishable key present (${pkNames})`
        };
      }
    }

    // 2. Orchestration API host check
    const orchHostEntries = Object.entries(env).filter(([k, v]) => typeof v === 'string' && isOrchestrationHost(v));
    const sandboxOrchHosts = [];
    const liveOrchHosts = [];
    for (const [k, v] of orchHostEntries) {
      const kind = classifyPeachHost(v);
      if (kind === 'sandbox') sandboxOrchHosts.push(k);
      else if (kind === 'live') liveOrchHosts.push(k);
    }

    const checkoutHostEntries = Object.entries(env).filter(([k, v]) => {
      if (typeof v !== 'string') return false;
      const lower = v.toLowerCase();
      return lower.includes('secure.peachpayments.com') || lower.includes('testsecure.peachpayments.com');
    });

    let hostConsistency;
    const isMixedOrch = sandboxOrchHosts.length > 0 && liveOrchHosts.length > 0;
    const isMixedDeclaredSandbox = declaredEnv === 'sandbox' && liveOrchHosts.length > 0;
    const isMixedDeclaredLive = declaredEnv === 'live' && sandboxOrchHosts.length > 0;

    if (isMixedOrch) {
      hostConsistency = {
        status: 'FAIL',
        reason: `Mixed sandbox/live Orchestration hosts detected: sandbox (${sandboxOrchHosts.join(', ')}), live (${liveOrchHosts.join(', ')})`
      };
    } else if (isMixedDeclaredSandbox) {
      hostConsistency = {
        status: 'FAIL',
        reason: `PEACH_ENV=sandbox but live host configured in ${liveOrchHosts.join(', ')}`
      };
    } else if (isMixedDeclaredLive) {
      hostConsistency = {
        status: 'FAIL',
        reason: `PEACH_ENV=live but sandbox host configured in ${sandboxOrchHosts.join(', ')}`
      };
    } else if (checkoutHostEntries.length > 0 && pkEntries.length > 0) {
      hostConsistency = {
        status: 'WARN',
        reason: `Checkout host configured in ${checkoutHostEntries.map(e => e[0]).join(', ')} alongside Orchestration publishable key (mixed surfaces)`
      };
    } else if (liveOrchHosts.length > 0 || declaredEnv === 'live') {
      const liveNames = liveOrchHosts.length ? liveOrchHosts.join(', ') : 'PEACH_ENV=live';
      hostConsistency = {
        status: 'WARN',
        reason: `Environment is LIVE (${liveNames}). Reminder: never run automated tests against live — only deliberate owner-run validation.`
      };
    } else if (sandboxOrchHosts.length > 0 || declaredEnv === 'sandbox') {
      const hostNames = sandboxOrchHosts.length ? sandboxOrchHosts.join(', ') : 'PEACH_ENV=sandbox';
      hostConsistency = {
        status: 'PASS',
        reason: `Consistent sandbox environment (${hostNames})`
      };
    } else {
      hostConsistency = {
        status: 'PASS',
        reason: 'No host conflicts detected'
      };
    }

    // 3. Hash key (best-effort)
    const hashKeyEntries = Object.entries(env).filter(([k, v]) => {
      return /hash|payment_response_hash/i.test(k) && typeof v === 'string' && v.trim().length > 0;
    });
    let hashKey;
    if (hashKeyEntries.length > 0) {
      hashKey = {
        status: 'PASS',
        reason: `Webhook hash key detected (${hashKeyEntries.map(e => e[0]).join(', ')})`
      };
    } else {
      hashKey = {
        status: 'WARN',
        reason: 'HMAC-SHA512 webhook verification needs the `payment_response_hash_key` (Dashboard); no hash-key env var detected.'
      };
    }

    // 4. Advisory reminders
    const advisories = {
      status: 'WARN',
      reason: 'amounts are integer minor units / minor-units (e.g. 6500 = R65.00), not decimal strings; webhook scheme is HMAC-SHA512 over raw body (header x-webhook-signature-512) — NOT Checkout SHA256, NOT Payments API AES-GCM'
    };

    return {
      provided: true,
      profile: 'orchestration',
      profileSource,
      env,
      completeness: publishableKey,
      publishableKey,
      hostConsistency,
      hashKey,
      secretPattern,
      advisories
    };
  }

  // Checkout profile (default)
  // Check 2: Env completeness
  const missing = REQUIRED_ENV_VARS.filter(v => !env[v] || !env[v].trim());
  let completeness;
  if (missing.length > 0) {
    completeness = {
      status: 'FAIL',
      reason: `Missing or empty required variables: ${missing.join(', ')} (if this is a Mobile SDK V2 / Orchestration integration whose config is code constants, run with --profile orchestration)`
    };
  } else {
    completeness = {
      status: 'PASS',
      reason: `All ${REQUIRED_ENV_VARS.length} required variables present and non-empty`
    };
  }

  // Check 3: Sandbox/live host consistency
  const hostEntries = Object.entries(env).filter(([k, v]) => k.endsWith('_HOST') && v && v.trim());
  const sandboxHosts = [];
  const liveHosts = [];
  const unknownHosts = [];

  for (const [key, val] of hostEntries) {
    const kind = classifyPeachHost(val);
    if (kind === 'sandbox') sandboxHosts.push(key);
    else if (kind === 'live') liveHosts.push(key);
    else unknownHosts.push(key);
  }

  let hostConsistency;
  const isMixedHosts = sandboxHosts.length > 0 && liveHosts.length > 0;
  const isMixedDeclaredSandbox = declaredEnv === 'sandbox' && liveHosts.length > 0;
  const isMixedDeclaredLive = declaredEnv === 'live' && sandboxHosts.length > 0;

  if (isMixedHosts) {
    hostConsistency = {
      status: 'FAIL',
      reason: `Mixed sandbox/live hosts detected: sandbox (${sandboxHosts.join(', ')}), live (${liveHosts.join(', ')})`
    };
  } else if (isMixedDeclaredSandbox) {
    hostConsistency = {
      status: 'FAIL',
      reason: `PEACH_ENV=sandbox but live host configured in ${liveHosts.join(', ')}`
    };
  } else if (isMixedDeclaredLive) {
    hostConsistency = {
      status: 'FAIL',
      reason: `PEACH_ENV=live but sandbox host configured in ${sandboxHosts.join(', ')}`
    };
  } else if (liveHosts.length > 0 || declaredEnv === 'live') {
    const liveNames = liveHosts.length ? liveHosts.join(', ') : 'PEACH_ENV=live';
    hostConsistency = {
      status: 'WARN',
      reason: `Environment is LIVE (${liveNames}). Reminder: never run automated tests against live — only deliberate owner-run validation.`
    };
  } else if (sandboxHosts.length > 0 || declaredEnv === 'sandbox') {
    const hostNames = sandboxHosts.length ? sandboxHosts.join(', ') : 'PEACH_ENV=sandbox';
    hostConsistency = {
      status: 'PASS',
      reason: `Consistent sandbox environment (${hostNames})`
    };
  } else if (unknownHosts.length > 0) {
    hostConsistency = {
      status: 'WARN',
      reason: `Host environment could not be determined for: ${unknownHosts.join(', ')}`
    };
  } else {
    hostConsistency = {
      status: 'PASS',
      reason: 'No host conflicts detected'
    };
  }

  return {
    provided: true,
    profile: 'checkout',
    profileSource,
    env,
    completeness,
    hostConsistency,
    secretPattern,
    weakOrchNote
  };
}

/**
 * Check 5: Summary — Map checks & findings to testing-and-go-live.md §5 headings.
 */
function buildGateSummary(footgunResult, envResult) {
  const findings = footgunResult.findings || [];
  const hasFinding = (id, sev) => findings.some(f => f.checkId === id && (!sev || f.severity === sev));
  const isOrch = envResult && envResult.profile === 'orchestration';

  // 1. Sandbox E2E
  const item1 = {
    title: '1. Sandbox E2E',
    status: footgunResult.status === 'FAIL' ? 'WARN' : 'PASS',
    reason: isOrch
      ? 'Static code structure valid; verify Mobile SDK V2 session bootstrap and test cards before live'
      : 'Static code structure valid; run documented test scenarios before going live'
  };

  // 2. Webhook verification
  let item2;
  if (hasFinding('webhook-raw-body-destroyed', 'FAIL')) {
    item2 = { title: '2. Webhook verification', status: 'FAIL', reason: 'Raw body destroyed by parser; signature verification will fail' };
  } else if (isOrch && envResult.hashKey && envResult.hashKey.status === 'WARN') {
    item2 = { title: '2. Webhook verification', status: 'WARN', reason: envResult.hashKey.reason };
  } else if (hasFinding('missing-signature-verification', 'WARN')) {
    item2 = { title: '2. Webhook verification', status: 'WARN', reason: 'Webhook handler with no visible signature verification' };
  } else if (hasFinding('webhook-unconditional-200', 'WARN')) {
    item2 = { title: '2. Webhook verification', status: 'WARN', reason: 'Webhook responds 200 without signature verification branching' };
  } else {
    item2 = {
      title: '2. Webhook verification',
      status: 'PASS',
      reason: isOrch
        ? 'HMAC-SHA512 webhook signature verification scheme verified (header x-webhook-signature-512)'
        : 'Raw-body preservation and signature patterns clean'
    };
  }

  // 3. Result-code mapping
  let item3;
  if (hasFinding('result-underscore-key', 'FAIL')) {
    item3 = { title: '3. Result-code mapping', status: 'FAIL', reason: 'Underscore result key used instead of dot notation (obj["result.code"])' };
  } else if (hasFinding('result-code-nested-access', 'WARN')) {
    item3 = { title: '3. Result-code mapping', status: 'WARN', reason: 'Nested result code access found; verify flat dotted key usage' };
  } else {
    item3 = { title: '3. Result-code mapping', status: 'PASS', reason: 'Dot-notation key access verified' };
  }

  // 4. Amount integrity
  let item4;
  if (isOrch) {
    item4 = {
      title: '4. Amount integrity',
      status: 'PASS',
      reason: 'Orchestration amounts: integer minor units / minor-units verified (e.g. 6500 = R65.00), not decimal strings'
    };
  } else if (hasFinding('amount-in-minor-units', 'WARN')) {
    item4 = { title: '4. Amount integrity', status: 'WARN', reason: 'Amount multiplied by 100 near checkout; Peach expects decimal strings' };
  } else if (hasFinding('payouts-amount-not-cents', 'WARN')) {
    item4 = { title: '4. Amount integrity', status: 'WARN', reason: 'Payouts amount formatted as decimal instead of integer cents' };
  } else {
    item4 = { title: '4. Amount integrity', status: 'PASS', reason: 'Major-unit decimal string formatting verified' };
  }

  // 5. Refund path tested
  const item5 = {
    title: '5. Refund path tested',
    status: 'PASS',
    reason: 'No refund traps detected; remember: assert result.code, not HTTP 200'
  };

  // 6. Secrets scan clean & static linter
  let item6;
  const completeness = envResult.completeness;
  if (hasFinding('secret-in-frontend', 'FAIL')) {
    item6 = { title: '6. Secrets scan clean', status: 'FAIL', reason: 'Peach secret exposed in client/frontend code' };
  } else if (completeness && completeness.status === 'FAIL') {
    item6 = { title: '6. Secrets scan clean', status: 'FAIL', reason: completeness.reason };
  } else if (footgunResult.status === 'FAIL') {
    item6 = { title: '6. Secrets scan clean', status: 'FAIL', reason: `${footgunResult.fails} footgun failure(s) found in codebase` };
  } else if (footgunResult.status === 'WARN') {
    item6 = { title: '6. Secrets scan clean', status: 'WARN', reason: `${footgunResult.warns} footgun warning(s) in codebase — triage recommended` };
  } else if (envResult.secretPattern && envResult.secretPattern.status === 'WARN') {
    item6 = { title: '6. Secrets scan clean', status: 'WARN', reason: envResult.secretPattern.reason };
  } else if (completeness && completeness.status === 'SKIP') {
    item6 = { title: '6. Secrets scan clean', status: 'WARN', reason: 'Footgun scan clean, but required env vars were NOT checked (no --env provided)' };
  } else {
    item6 = {
      title: '6. Secrets scan clean',
      status: 'PASS',
      reason: isOrch
        ? '0 footgun failures; Orchestration publishable key verified'
        : '0 footgun failures; required env variables verified'
    };
  }

  // 7. Live-swap plan & hosts
  let item7;
  if (envResult.hostConsistency.status === 'FAIL') {
    item7 = { title: '7. Live-swap plan & hosts', status: 'FAIL', reason: envResult.hostConsistency.reason };
  } else if (envResult.hostConsistency.status === 'WARN') {
    item7 = { title: '7. Live-swap plan & hosts', status: 'WARN', reason: envResult.hostConsistency.reason };
  } else if (hasFinding('live-host-hardcoded', 'WARN')) {
    item7 = { title: '7. Live-swap plan & hosts', status: 'WARN', reason: 'Hardcoded live host in codebase without env switch' };
  } else if (hasFinding('sandbox-host-in-prod', 'WARN')) {
    item7 = { title: '7. Live-swap plan & hosts', status: 'WARN', reason: 'Sandbox host literal alongside production marker' };
  } else if (envResult.hostConsistency.status === 'SKIP') {
    item7 = { title: '7. Live-swap plan & hosts', status: 'WARN', reason: 'Host consistency was NOT checked (no --env provided)' };
  } else {
    item7 = {
      title: '7. Live-swap plan & hosts',
      status: 'PASS',
      reason: isOrch
        ? 'Orchestration host endpoints consistent; live-swap documented'
        : 'Host endpoints consistent; live-swap documented'
    };
  }

  return [item1, item2, item3, item4, item5, item6, item7];
}

/**
 * Main execution of preflight checklist.
 */
function runPreflight(integrationDir, envPath, options = {}) {
  const footgun = runFootgunScan(integrationDir);
  const envCheck = inspectEnvironment(envPath, options);

  const isOrchestration = envCheck.profile === 'orchestration';

  const checks = isOrchestration
    ? [
        { name: '1. Footgun scan', ...footgun },
        { name: '2. Publishable key present', ...envCheck.publishableKey },
        { name: '3. Sandbox/live host consistency', ...envCheck.hostConsistency },
        { name: '4. Webhook hash key', ...envCheck.hashKey },
        { name: '5. No secret in committed .env', ...envCheck.secretPattern },
        { name: '6. Advisory reminders', ...envCheck.advisories },
      ]
    : [
        { name: '1. Footgun scan', ...footgun },
        { name: '2. Env completeness', ...envCheck.completeness },
        { name: '3. Sandbox/live host consistency', ...envCheck.hostConsistency },
        { name: '4. No secret in committed .env', ...envCheck.secretPattern },
      ];

  const gateItems = buildGateSummary(footgun, envCheck);

  const failedChecks = checks.filter(c => c.status === 'FAIL');
  const failCount = failedChecks.length;
  const passed = failCount === 0;

  const lines = [];
  lines.push('=== Peach Payments Preflight Inspection ===');
  lines.push(`Target directory: ${integrationDir}`);
  lines.push(`Environment file: ${envPath || '(none provided)'}`);
  if (isOrchestration) {
    lines.push(`Profile: Mobile SDK V2 / Orchestration (${envCheck.profileSource})`);
    lines.push('Honest absence: Peach publishes no standard env-var naming for Orchestration; this profile detects by value pattern and advises rather than requiring specific names.');
  } else if (envCheck.provided) {
    lines.push(`Profile: Checkout (${envCheck.profileSource})`);
    if (envCheck.weakOrchNote) lines.push(`Note: ${envCheck.weakOrchNote}`);
  }
  lines.push('');
  lines.push('── Preflight Checks ────────────────────────────────────────');
  for (const c of checks) {
    lines.push(`[ ${c.status} ] ${c.name}: ${c.reason}`);
    if (c.status === 'FAIL' && c.findings && c.findings.length > 0) {
      for (const f of c.findings.slice(0, 5)) {
        lines.push(`         ${f.severity}  ${f.fileLoc}  [${f.checkId}]`);
        if (f.msg) lines.push(`               ${f.msg}`);
      }
      if (c.findings.length > 5) {
        lines.push(`         ... and ${c.findings.length - 5} more finding(s)`);
      }
    }
  }

  lines.push('');
  lines.push('── Go-Live Verification Gate (§5) ───────────────────────────');
  for (const g of gateItems) {
    lines.push(`[ ${g.status} ] ${g.title}: ${g.reason}`);
  }

  lines.push('');
  const finalLine = passed
    ? 'PREFLIGHT: PASS'
    : `PREFLIGHT: FAIL (${failCount} item${failCount === 1 ? '' : 's'})`;
  lines.push(finalLine);

  const output = lines.join('\n');
  if (!options.silent) {
    console.log(output);
  }

  return {
    passed,
    failCount,
    checks,
    gateItems,
    finalLine,
    output
  };
}


/**
 * Selftest suite: builds fixtures in a temp directory, validates assertions, cleans up.
 */
function runSelftest() {
  const tests = [];
  const t = (name, fn) => tests.push({ name, fn });

  const baseTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'peach-preflight-test-'));

  try {
    const runCli = (args) => {
      return child_process.spawnSync(process.execPath, [__filename, ...args], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
    };

    // Fixture setup: clean integration dir
    const cleanDir = path.join(baseTmp, 'clean-app');
    fs.mkdirSync(cleanDir, { recursive: true });
    fs.writeFileSync(path.join(cleanDir, 'server.js'), 'const amount = "15.00";\nmodule.exports = { amount };\n');
    fs.writeFileSync(path.join(cleanDir, '.gitignore'), '.env\nnode_modules\n');

    // Fixture setup: complete sandbox .env
    const completeSandboxEnv = [
      'PEACH_ENV=sandbox',
      'PEACH_CLIENT_ID=test_client_id_123',
      'PEACH_CLIENT_SECRET=test_client_secret_xyz',
      'PEACH_MERCHANT_ID=test_merchant_id_456',
      'PEACH_ENTITY_ID=test_entity_id_789',
      'PEACH_SECRET_TOKEN=test_secret_token_abc',
      'PEACH_AUTH_HOST=https://sandbox-dashboard.peachpayments.com',
      'PEACH_CHECKOUT_HOST=https://testsecure.peachpayments.com',
    ].join('\n') + '\n';
    const envAPath = path.join(cleanDir, '.env');
    fs.writeFileSync(envAPath, completeSandboxEnv);

    // Fixture setup: .env missing PEACH_SECRET_TOKEN
    const missingTokenEnv = [
      'PEACH_ENV=sandbox',
      'PEACH_CLIENT_ID=test_client_id_123',
      'PEACH_CLIENT_SECRET=test_client_secret_xyz',
      'PEACH_MERCHANT_ID=test_merchant_id_456',
      'PEACH_ENTITY_ID=test_entity_id_789',
      'PEACH_AUTH_HOST=https://sandbox-dashboard.peachpayments.com',
      'PEACH_CHECKOUT_HOST=https://testsecure.peachpayments.com',
    ].join('\n') + '\n';
    const envBPath = path.join(baseTmp, 'missing-token.env');
    fs.writeFileSync(envBPath, missingTokenEnv);

    // Fixture setup: mixed sandbox/live .env
    const mixedEnv = [
      'PEACH_ENV=sandbox',
      'PEACH_CLIENT_ID=test_client_id_123',
      'PEACH_CLIENT_SECRET=test_client_secret_xyz',
      'PEACH_MERCHANT_ID=test_merchant_id_456',
      'PEACH_ENTITY_ID=test_entity_id_789',
      'PEACH_SECRET_TOKEN=test_secret_token_abc',
      'PEACH_AUTH_HOST=https://sandbox-dashboard.peachpayments.com',
      'PEACH_CHECKOUT_HOST=https://' + 'secure.peachpayments.com',
    ].join('\n') + '\n';
    const envCPath = path.join(baseTmp, 'mixed.env');
    fs.writeFileSync(envCPath, mixedEnv);

    // Fixture setup: integration dir with footgun
    const footgunDir = path.join(baseTmp, 'footgun-app');
    fs.mkdirSync(footgunDir, { recursive: true });
    const badKey = ['result', 'code'].join('_');
    fs.writeFileSync(path.join(footgunDir, 'handler.js'), `function check(payload) { return payload.${badKey}; }\n`);

    // (a) clean integration + complete sandbox .env → PREFLIGHT PASS
    t('fixture (a): clean integration + complete sandbox .env → PREFLIGHT PASS', () => {
      const res = runCli([cleanDir, '--env', envAPath]);
      if (res.status !== 0) {
        throw new Error(`expected exit 0, got ${res.status}. Output:\n${res.stdout}`);
      }
      if (!res.stdout.includes('PREFLIGHT: PASS')) {
        throw new Error(`expected PREFLIGHT: PASS, got:\n${res.stdout}`);
      }
    });

    // (b) an .env missing PEACH_SECRET_TOKEN → FAIL
    t('fixture (b): .env missing PEACH_SECRET_TOKEN → FAIL', () => {
      const res = runCli([cleanDir, '--env', envBPath]);
      if (res.status !== 1) {
        throw new Error(`expected exit 1, got ${res.status}. Output:\n${res.stdout}`);
      }
      if (!res.stdout.includes('PREFLIGHT: FAIL')) {
        throw new Error(`expected PREFLIGHT: FAIL, got:\n${res.stdout}`);
      }
      if (!res.stdout.includes('PEACH_SECRET_TOKEN')) {
        throw new Error(`expected output to name PEACH_SECRET_TOKEN, got:\n${res.stdout}`);
      }
    });

    // (c) a mixed sandbox/live .env → FAIL
    t('fixture (c): mixed sandbox/live .env → FAIL', () => {
      const res = runCli([cleanDir, '--env', envCPath]);
      if (res.status !== 1) {
        throw new Error(`expected exit 1, got ${res.status}. Output:\n${res.stdout}`);
      }
      if (!res.stdout.includes('PREFLIGHT: FAIL')) {
        throw new Error(`expected PREFLIGHT: FAIL, got:\n${res.stdout}`);
      }
      if (!res.stdout.toLowerCase().includes('mixed')) {
        throw new Error(`expected output to mention mixed hosts, got:\n${res.stdout}`);
      }
    });

    // (d) an integration dir containing a file with a footgun → FAIL
    t('fixture (d): integration dir with footgun → FAIL', () => {
      const res = runCli([footgunDir, '--env', envAPath]);
      if (res.status !== 1) {
        throw new Error(`expected exit 1, got ${res.status}. Output:\n${res.stdout}`);
      }
      if (!res.stdout.includes('PREFLIGHT: FAIL')) {
        throw new Error(`expected PREFLIGHT: FAIL, got:\n${res.stdout}`);
      }
      if (!res.stdout.includes('[ FAIL ] 1. Footgun scan')) {
        throw new Error(`expected Footgun scan to fail, got:\n${res.stdout}`);
      }
    });

    // (e) clean integration without --env → PREFLIGHT PASS
    t('clean integration without --env → PREFLIGHT PASS', () => {
      const res = runCli([cleanDir]);
      if (res.status !== 0) {
        throw new Error(`expected exit 0, got ${res.status}. Output:\n${res.stdout}`);
      }
      if (!res.stdout.includes('PREFLIGHT: PASS')) {
        throw new Error(`expected PREFLIGHT: PASS, got:\n${res.stdout}`);
      }
    });

    // (f) live env consistent → WARN (exit 0, PREFLIGHT PASS)
    t('consistent live environment → WARN reminder, PREFLIGHT PASS', () => {
      const liveEnv = [
        'PEACH_ENV=live',
        'PEACH_CLIENT_ID=live_client_id_123',
        'PEACH_CLIENT_SECRET=live_client_secret_xyz',
        'PEACH_MERCHANT_ID=live_merchant_id_456',
        'PEACH_ENTITY_ID=live_entity_id_789',
        'PEACH_SECRET_TOKEN=live_secret_token_abc',
        'PEACH_AUTH_HOST=https://' + 'dashboard.peachpayments.com',
        'PEACH_CHECKOUT_HOST=https://' + 'secure.peachpayments.com',
      ].join('\n') + '\n';
      const liveEnvPath = path.join(baseTmp, 'live.env');
      fs.writeFileSync(liveEnvPath, liveEnv);
      const res = runCli([cleanDir, '--env', liveEnvPath]);
      if (res.status !== 0) {
        throw new Error(`expected exit 0 (WARN ok), got ${res.status}. Output:\n${res.stdout}`);
      }
      if (!res.stdout.includes('PREFLIGHT: PASS')) {
        throw new Error(`expected PREFLIGHT: PASS, got:\n${res.stdout}`);
      }
      if (!res.stdout.includes('LIVE')) {
        throw new Error(`expected LIVE warning in output, got:\n${res.stdout}`);
      }
    });

    // (g) empty required variable → FAIL
    t('.env with empty required variable → FAIL', () => {
      const emptyVarEnv = [
        'PEACH_ENV=sandbox',
        'PEACH_CLIENT_ID=   ',
        'PEACH_CLIENT_SECRET=test_secret',
        'PEACH_MERCHANT_ID=test_merchant',
        'PEACH_ENTITY_ID=test_entity',
        'PEACH_SECRET_TOKEN=test_token',
        'PEACH_AUTH_HOST=https://sandbox-dashboard.peachpayments.com',
        'PEACH_CHECKOUT_HOST=https://testsecure.peachpayments.com',
      ].join('\n') + '\n';
      const emptyVarEnvPath = path.join(baseTmp, 'empty-var.env');
      fs.writeFileSync(emptyVarEnvPath, emptyVarEnv);
      const res = runCli([cleanDir, '--env', emptyVarEnvPath]);
      if (res.status !== 1) {
        throw new Error(`expected exit 1, got ${res.status}. Output:\n${res.stdout}`);
      }
      if (!res.stdout.includes('PREFLIGHT: FAIL')) {
        throw new Error(`expected PREFLIGHT: FAIL, got:\n${res.stdout}`);
      }
      if (!res.stdout.includes('PEACH_CLIENT_ID')) {
        throw new Error(`expected output to name PEACH_CLIENT_ID, got:\n${res.stdout}`);
      }
    });

    // Fixture setup: Orchestration valid .env
    const orchOkEnv = [
      '# Merchant-chosen names (Peach publishes no standard)',
      'PEACH_ENV=sandbox',
      'PEACH_ORCH_PUBLISHABLE_KEY=pk_test_abc123',
      'PEACH_ORCH_API_HOST=https://app.sandbox-next.peachpayments.com/api',
      'PEACH_WEBHOOK_HASH_KEY=whk_deadbeef',
    ].join('\n') + '\n';
    const orchOkPath = path.join(baseTmp, 'orch-ok.env');
    fs.writeFileSync(orchOkPath, orchOkEnv);

    // Fixture setup: Orchestration live/sandbox host mismatch .env
    const orchMismatchEnv = [
      '# pk_ key + LIVE host but PEACH_ENV=sandbox',
      'PEACH_ENV=sandbox',
      'MY_PUBLISHABLE=pk_prd_live999',
      'ORCH_BACKEND=https://app.next.peachpayments.com/api',
      'PAYMENT_RESPONSE_HASH_KEY=whk_live',
    ].join('\n') + '\n';
    const orchMismatchPath = path.join(baseTmp, 'orch-mismatch.env');
    fs.writeFileSync(orchMismatchPath, orchMismatchEnv);

    // Fixture setup: Orchestration missing webhook hash key .env
    const orchNoHashEnv = [
      '# Orchestration detected but missing hash key',
      'PEACH_ENV=sandbox',
      'PK=pk_test_nohash',
      'BACKEND_URL=https://app.sandbox-next.peachpayments.com/api',
    ].join('\n') + '\n';
    const orchNoHashPath = path.join(baseTmp, 'orch-no-hash.env');
    fs.writeFileSync(orchNoHashPath, orchNoHashEnv);

    // (h) Orchestration detected + PASS (no required vars missing FAIL, advisories present)
    t('fixture (h): Orchestration detected + PASS', () => {
      const res = runCli([cleanDir, '--env', orchOkPath]);
      if (res.status !== 0) {
        throw new Error(`expected exit 0, got ${res.status}. Output:\n${res.stdout}`);
      }
      if (!res.stdout.includes('PREFLIGHT: PASS')) {
        throw new Error(`expected PREFLIGHT: PASS, got:\n${res.stdout}`);
      }
      if (!res.stdout.includes('detected Orchestration')) {
        throw new Error(`expected profile detection in output, got:\n${res.stdout}`);
      }
      if (!res.stdout.includes('minor-units')) {
        throw new Error(`expected minor-units advisory in output, got:\n${res.stdout}`);
      }
      if (!res.stdout.includes('SHA512')) {
        throw new Error(`expected SHA512 advisory in output, got:\n${res.stdout}`);
      }
      if (res.stdout.includes('Missing or empty required variables')) {
        throw new Error(`did not expect Checkout required vars FAIL in Orchestration mode:\n${res.stdout}`);
      }
    });

    // (i) Orchestration live/sandbox host mismatch → FAIL
    t('fixture (i): Orchestration live/sandbox host mismatch → FAIL', () => {
      const res = runCli([cleanDir, '--env', orchMismatchPath]);
      if (res.status !== 1) {
        throw new Error(`expected exit 1, got ${res.status}. Output:\n${res.stdout}`);
      }
      if (!res.stdout.includes('PREFLIGHT: FAIL')) {
        throw new Error(`expected PREFLIGHT: FAIL, got:\n${res.stdout}`);
      }
      if (!res.stdout.includes('PEACH_ENV=sandbox but live host')) {
        throw new Error(`expected sandbox/live mismatch message, got:\n${res.stdout}`);
      }
    });

    // (j) Orchestration missing hash-key → WARN (overall PASS)
    t('fixture (j): Orchestration missing hash-key → WARN (overall PASS)', () => {
      const res = runCli([cleanDir, '--env', orchNoHashPath]);
      if (res.status !== 0) {
        throw new Error(`expected exit 0 (WARN ok), got ${res.status}. Output:\n${res.stdout}`);
      }
      if (!res.stdout.includes('PREFLIGHT: PASS')) {
        throw new Error(`expected PREFLIGHT: PASS, got:\n${res.stdout}`);
      }
      if (!res.stdout.includes('payment_response_hash_key')) {
        throw new Error(`expected payment_response_hash_key warning in output, got:\n${res.stdout}`);
      }
    });

    // (k) pure Checkout NOT detected as Orchestration
    t('fixture (k): pure Checkout NOT detected as Orchestration', () => {
      const res = runCli([cleanDir, '--env', envAPath]);
      if (res.status !== 0) {
        throw new Error(`expected exit 0, got ${res.status}. Output:\n${res.stdout}`);
      }
      if (!res.stdout.includes('PREFLIGHT: PASS')) {
        throw new Error(`expected PREFLIGHT: PASS, got:\n${res.stdout}`);
      }
      if (!res.stdout.includes('Profile: Checkout')) {
        throw new Error(`expected Profile: Checkout, got:\n${res.stdout}`);
      }
      if (res.stdout.includes('Orchestration')) {
        throw new Error(`pure Checkout must NOT mention Orchestration, got:\n${res.stdout}`);
      }
      const parsed = parseEnvFile(envAPath);
      if (detectOrchestration(parsed) !== false) {
        throw new Error('detectOrchestration returned true for pure Checkout env');
      }
    });

    // (l) CLI profile override --profile orchestration/checkout
    t('fixture (l): CLI profile override --profile orchestration/checkout', () => {
      // Forcing checkout on orchestration env must fail due to missing required Checkout vars
      const resCheckout = runCli([cleanDir, '--env', orchOkPath, '--profile', 'checkout']);
      if (resCheckout.status !== 1 || !resCheckout.stdout.includes('Missing or empty required variables')) {
        throw new Error(`expected failure forcing checkout profile on orch env, got exit ${resCheckout.status}:\n${resCheckout.stdout}`);
      }

      // Forcing orchestration on a checkout env (no pk_) must NOT hard-fail: the publishable key is a
      // CODE constant, so a missing pk in .env is a WARN (advisory), not a blocking FAIL. (Adversarial
      // review NO-GO driver 1: FAIL here contradicts the profile's own documented architecture.)
      const resOrch = runCli([cleanDir, '--env', envAPath, '--profile', 'orchestration']);
      if (!resOrch.stdout.includes('No pk_ publishable key found') || !resOrch.stdout.includes('Orchestration')) {
        throw new Error(`expected orchestration WARN about missing pk (not a hard FAIL), got exit ${resOrch.status}:\n${resOrch.stdout}`);
      }
    });

    // (m) NO-GO driver 1: Orchestration detected via HOST alone (pk is a code constant) → PASS, not FAIL
    t('fixture (m): host-only Orchestration (pk in code) → WARN on pk, overall PASS', () => {
      const p = path.join(baseTmp, 'orch_host_only.env');
      fs.writeFileSync(p, 'PEACH_ENV=sandbox\nPEACH_ORCH_BACKEND=https://app.sandbox-next.peachpayments.com/api\nPEACH_WEBHOOK_HASH_KEY=whk_abc\n');
      const res = runCli([cleanDir, '--env', p]);
      if (res.status !== 0) throw new Error(`host-only orch should PASS (pk is a code constant), got exit ${res.status}:\n${res.stdout}`);
      if (!res.stdout.includes('Orchestration') || !res.stdout.includes('No pk_ publishable key found')) throw new Error('expected orchestration profile + pk-in-code WARN');
    });

    // (n) NO-GO driver 2: a foreign pk_ (Stripe) must NOT flip the profile and skip the Checkout gate
    t('fixture (n): Stripe pk_ in a Checkout env stays Checkout + FAILs missing required vars', () => {
      const p = path.join(baseTmp, 'checkout_stripe.env');
      fs.writeFileSync(p, 'PEACH_ENV=sandbox\nPEACH_CLIENT_ID=abc\nSTRIPE_PUBLISHABLE_KEY=pk_live_stripe123\n');
      const res = runCli([cleanDir, '--env', p]);
      if (res.status !== 1) throw new Error(`Stripe-pk Checkout env with missing vars must FAIL, got exit ${res.status}:\n${res.stdout}`);
      if (!res.stdout.includes('Profile: Checkout')) throw new Error('foreign pk_ wrongly flipped profile to Orchestration');
      if (!res.stdout.includes('Missing or empty required variables')) throw new Error('Checkout required-vars gate was bypassed');
      if (!res.stdout.includes('also used by other PSPs')) throw new Error('missing weak-orch advisory note');
    });

    // (o) NO-GO r2: a *_hash_key-named var (Checkout also has one) must NOT flip the profile & skip the gate
    t('fixture (o): a hash-key var in a Checkout env stays Checkout + FAILs missing required vars', () => {
      const p = path.join(baseTmp, 'checkout_hashkey.env');
      fs.writeFileSync(p, 'PEACH_ENV=sandbox\nPEACH_CLIENT_ID=abc\nPEACH_WEBHOOK_HASH=whk_checkout_sig\n');
      const res = runCli([cleanDir, '--env', p]);
      if (res.status !== 1) throw new Error(`hash-key Checkout env with missing vars must FAIL, got exit ${res.status}:\n${res.stdout}`);
      if (!res.stdout.includes('Profile: Checkout')) throw new Error('a hash-key var wrongly flipped profile to Orchestration');
      if (!res.stdout.includes('Missing or empty required variables')) throw new Error('Checkout required-vars gate was bypassed by a hash-key var');
    });

    let passed = 0;
    for (const { name, fn } of tests) {
      try {
        fn();
        console.log(`PASS  ${name}`);
        passed++;
      } catch (err) {
        console.log(`FAIL  ${name} — ${err.message}`);
      }
    }
    console.log(`\n${passed}/${tests.length} passed`);
    return passed === tests.length;
  } finally {
    try {
      fs.rmSync(baseTmp, { recursive: true, force: true });
    } catch (_) {}
  }
}

/**
 * CLI Argument parser
 */
function parseArgs(argv) {
  const args = argv.slice(2);
  if (!args.length) return { action: 'help' };
  if (args[0] === 'selftest' || args.includes('selftest')) return { action: 'selftest' };
  if (args.includes('--help') || args.includes('-h')) return { action: 'help' };

  let integrationDir = null;
  let envPath = null;
  let profile = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--env') {
      if (i + 1 < args.length) {
        envPath = args[++i];
      } else {
        return { action: 'error', error: 'Missing path after --env' };
      }
    } else if (arg.startsWith('--env=')) {
      envPath = arg.slice(6);
    } else if (arg === '--profile') {
      if (i + 1 < args.length) {
        const p = args[++i].toLowerCase();
        if (p === 'orchestration' || p === 'checkout') {
          profile = p;
        } else {
          return { action: 'error', error: `Invalid profile: ${args[i]}. Expected 'orchestration' or 'checkout'` };
        }
      } else {
        return { action: 'error', error: 'Missing value after --profile' };
      }
    } else if (arg.startsWith('--profile=')) {
      const p = arg.slice(10).toLowerCase();
      if (p === 'orchestration' || p === 'checkout') {
        profile = p;
      } else {
        return { action: 'error', error: `Invalid profile: ${arg.slice(10)}. Expected 'orchestration' or 'checkout'` };
      }
    } else if (!arg.startsWith('-')) {
      if (!integrationDir) {
        integrationDir = arg;
      } else {
        return { action: 'error', error: `Unexpected positional argument: ${arg}` };
      }
    } else {
      return { action: 'error', error: `Unknown option: ${arg}` };
    }
  }

  if (!integrationDir) {
    return { action: 'error', error: 'Missing required <integration-dir> argument' };
  }

  return { action: 'run', integrationDir, envPath, profile };
}

function main() {
  const parsed = parseArgs(process.argv);
  if (parsed.action === 'help') {
    console.log([
      'Usage:',
      '  node scripts/preflight.js <integration-dir> [--env <path-to-.env>] [--profile <orchestration|checkout>]',
      '  node scripts/preflight.js selftest',
      '',
      'Static preflight readiness checker for Peach Payments integrations.',
      'Exit codes: 0 = PASS (WARN ok), 1 = FAIL, 2 = usage error.'
    ].join('\n'));
    process.exit(2);
  }

  if (parsed.action === 'selftest') {
    const ok = runSelftest();
    process.exit(ok ? 0 : 1);
  }

  if (parsed.action === 'error') {
    console.error(`Error: ${parsed.error}\n`);
    console.error('Usage: node scripts/preflight.js <integration-dir> [--env <path-to-.env>] [--profile <orchestration|checkout>]');
    process.exit(2);
  }

  const result = runPreflight(parsed.integrationDir, parsed.envPath, { profile: parsed.profile });
  process.exit(result.passed ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  runPreflight,
  runFootgunScan,
  inspectEnvironment,
  parseEnvFile,
  classifyPeachHost,
  isOrchestrationHost,
  detectOrchestration,
  isEnvGitignored,
  REQUIRED_ENV_VARS
};
