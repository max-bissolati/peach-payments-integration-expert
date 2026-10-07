#!/usr/bin/env node
'use strict';

/*
 * doctor.js — Capstone health-check and golden-path guide for the Peach Payments skill.
 *
 * PURPOSE:
 *   One command that:
 *   (A) Verifies the whole skill is healthy (all script selftests, examples lint,
 *       spec JSON validation, reference-doc structure, internal links).
 *   (B) Prints the 5-step golden path and verified tool inventory so an AI agent
 *       knows exactly how to build and verify a Peach Payments integration.
 *
 * RUNTIME:
 *   Node >= 18 plus Python 3 for offline freshness validation; standard libraries only.
 *   No network calls.
 *
 * CLI:
 *   node scripts/doctor.js            # run all health checks + print report; exit 1 if any check FAILs
 *   node scripts/doctor.js --guide    # print ONLY the golden-path + tool inventory (no checks)
 *   node scripts/doctor.js selftest   # a tiny self-test of doctor.js's own helpers
 *
 * EXIT CODES:
 *   0 = all checks passed / guide printed / selftest passed
 *   1 = one or more health checks failed / selftest failed
 *   2 = invalid CLI usage or arguments
 */

const fs = require('fs');
const path = require('path');
const child_process = require('child_process');

const SKILL_ROOT = path.resolve(__dirname, '..');

/* ────────────────────────────────────────────────────────────────────────────
 * Tool Inventory and Golden Path Definitions
 * ──────────────────────────────────────────────────────────────────────────── */

const TOOL_DEFINITIONS = [
  {
    path: 'scripts/refresh-docs-check.sh',
    name: 'refresh-docs-check',
    desc: 'Read-only index drift check; --deep checks tracked bodies including POS (Python 3 + curl)',
  },
  {
    path: 'scripts/check-integration.js',
    name: 'check-integration',
    desc: 'Classic Checkout-focused static linter that catches common footguns; not a POS or Orchestration security gate (raw-body destruction, decimal amounts, dot-keys, client-exposed secrets)',
  },
  {
    path: 'scripts/preflight.js',
    name: 'preflight',
    desc: 'Static go-live readiness checker for documented product profiles; no POS profile (no network)',
  },
  {
    path: 'scripts/smoke-test.js',
    name: 'smoke-test',
    desc: 'Sandbox connectivity and OAuth validation for supported profiles; no POS profile (no money movement)',
  },
  {
    path: 'scripts/webhook-sample.js',
    name: 'webhook-sample',
    desc: 'Generates classic Checkout Scheme A & Scheme B test webhook payloads for local testing (--tamper flag supported)',
  },
  {
    path: 'scripts/verify-webhook.js',
    name: 'verify-webhook',
    desc: 'Verifies classic Checkout webhook signatures (Scheme A/B); not POS webhook authentication or Orchestration SHA-512',
  },
  {
    path: 'scripts/map-result-code.js',
    name: 'map-result-code',
    desc: 'Classifies classic dotted result codes into fail-closed buckets (captured, review, pending, requires_more, canceled, error)',
  },
  {
    path: 'scripts/decode-result.js',
    name: 'decode-result',
    desc: 'Classic dotted result code explainer with category grouping and MerchantAdviceCode dunning guidance',
  },
  {
    path: 'scripts/canonical-string.js',
    name: 'canonical-string',
    desc: 'Builds classic Scheme A canonical strings and signs V1 form-urlencoded refund payloads (flat dotted keys)',
  },
  {
    path: 'reference-data',
    name: 'reference-data/',
    desc: 'Machine-readable specs (hosts.json, payment-methods.json, result-code-families.json) and validate.js',
  },
  {
    path: 'examples',
    name: 'examples/',
    desc: 'Classic Checkout V2 reference integrations ({examples}); use only for that product',
  },
  {
    path: 'templates/env.example',
    name: 'templates/env.example',
    desc: 'Environment template with required keys, sandbox/live hosts, and server-side-only markers',
  },
];

const STRUCTURE_EXCEPTIONS = new Set(['_matrix.md', 'versions.md', 'sharp-edges.md']);

/* ────────────────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Recursively collect all .md files under a directory.
 */
function collectMarkdownFiles(dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(collectMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(fullPath);
    }
  }
  return results.sort();
}

/**
 * Extract summary pass line from script stdout (e.g. "38/38 passed" or "398/398 checks passed").
 */
function extractPassLine(stdout) {
  if (!stdout) return '';
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (/\d+\/\d+\s+(?:checks\s+)?passed/i.test(line)) {
      return line;
    }
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (/passed/i.test(line)) {
      return line;
    }
  }
  return '';
}

/**
 * Parse output from check-integration.js.
 */
function parseCheckIntegrationOutput(stdout, exitCode) {
  if (stdout && stdout.includes('no Peach integration footguns found')) {
    return { fails: exitCode === 0 ? 0 : 1, warns: 0, ok: exitCode === 0 };
  }
  const match = (stdout || '').match(/(\d+)\s+FAIL,\s*(\d+)\s+WARN/i);
  if (match) {
    const fails = parseInt(match[1], 10);
    const warns = parseInt(match[2], 10);
    return { fails, warns, ok: fails === 0 && exitCode === 0 };
  }
  return { fails: exitCode === 0 ? 0 : 1, warns: 0, ok: exitCode === 0 };
}

/**
 * Discover existing example subdirectories (excluding shared and dot-dirs).
 */
function getAvailableExamples(skillRoot) {
  const examplesDir = path.join(skillRoot, 'examples');
  if (!fs.existsSync(examplesDir)) return [];
  const entries = fs.readdirSync(examplesDir, { withFileTypes: true });
  return entries
    .filter(e => e.isDirectory() && e.name !== 'shared' && !e.name.startsWith('.'))
    .map(e => e.name)
    .sort();
}

/**
 * Check if a markdown content string contains required structure headers.
 */
function checkMarkdownHeaders(content) {
  const missing = [];
  if (!/^##\s+When to load/m.test(content)) missing.push('## When to load');
  if (!/^##\s+Traps/m.test(content)) missing.push('## Traps');
  return missing;
}

/**
 * Extract relative .md links from markdown text.
 */
function extractRelativeMdLinks(content) {
  const links = [];
  const linkRegex = /\[([^\]]*)\]\(([^)]+)\)/g;
  let match;
  while ((match = linkRegex.exec(content)) !== null) {
    const target = match[2].trim();
    if (
      target.startsWith('http://') ||
      target.startsWith('https://') ||
      target.startsWith('mailto:') ||
      target.startsWith('#') ||
      target.startsWith('//')
    ) {
      continue;
    }
    const [filePath] = target.split('#');
    if (filePath.endsWith('.md') || filePath.includes('.md')) {
      links.push(target);
    }
  }
  return links;
}

/**
 * Check references markdown structure.
 * Every references doc (except _matrix.md, versions.md, sharp-edges.md)
 * must have ## When to load and ## Traps.
 */
function checkReferenceStructure(skillRoot) {
  const referencesDir = path.join(skillRoot, 'references');
  const files = collectMarkdownFiles(referencesDir);
  const missing = [];
  let checkedCount = 0;

  for (const file of files) {
    const basename = path.basename(file);
    if (STRUCTURE_EXCEPTIONS.has(basename)) continue;
    checkedCount++;

    const content = fs.readFileSync(file, 'utf8');
    const missingHeaders = checkMarkdownHeaders(content);

    if (missingHeaders.length > 0) {
      const relPath = path.relative(skillRoot, file);
      missing.push({ file: relPath, missingHeaders });
    }
  }

  return {
    checkedCount,
    missing,
    ok: missing.length === 0,
  };
}

/**
 * Check that all relative .md links in references markdown files resolve to existing files.
 */
function checkInternalLinks(skillRoot) {
  const referencesDir = path.join(skillRoot, 'references');
  const files = collectMarkdownFiles(referencesDir);

  let totalLinks = 0;
  const brokenLinks = [];

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const links = extractRelativeMdLinks(content);

    for (const target of links) {
      totalLinks++;
      const [filePath] = target.split('#');
      const resolved = path.resolve(path.dirname(file), filePath);
      if (!fs.existsSync(resolved)) {
        const relSource = path.relative(skillRoot, file);
        brokenLinks.push({
          source: relSource,
          target,
          resolved: path.relative(skillRoot, resolved),
        });
      }
    }
  }

  return {
    totalLinks,
    brokenLinks,
    ok: brokenLinks.length === 0,
  };
}

/**
 * Get the verified tool inventory (only paths that exist on disk).
 */
function getToolInventory(skillRoot) {
  const availableExamples = getAvailableExamples(skillRoot);
  const hasSharedRetry = fs.existsSync(path.join(skillRoot, 'examples/shared/idempotent-retry.js'));
  const examplesSummary = availableExamples.join(', ') + (hasSharedRetry ? ', shared/idempotent-retry.js' : '');

  const inventory = [];
  for (const item of TOOL_DEFINITIONS) {
    const fullPath = path.join(skillRoot, item.path);
    if (fs.existsSync(fullPath)) {
      const desc = item.desc.replace('{examples}', examplesSummary);
      inventory.push({
        path: item.path,
        name: item.name,
        desc,
      });
    }
  }
  return inventory;
}

/**
 * Assemble the 5-step golden path.
 */
function getGoldenPath(skillRoot) {
  const examples = getAvailableExamples(skillRoot);
  const examplesList = examples.length > 0 ? `examples/{${examples.join(',')}}` : 'examples/';
  const hasSharedRetry = fs.existsSync(path.join(skillRoot, 'examples/shared/idempotent-retry.js'));
  const retryRef = hasSharedRetry ? ' via examples/shared/idempotent-retry.js' : '';

  return [
    {
      step: 1,
      title: 'Run discovery (references/discovery.md)',
      desc: "Calibrate to the user's level (plain-language mode for non-technical users vs terse technical mode for experienced devs). Determine platform, collection type (one-off / recurring / invoices / payouts), country and currency, payment methods, and UX constraints (online checkout, separate terminal, or app on the terminal).",
    },
    {
      step: 2,
      title: 'Pick the approach',
      desc: `Plugin-first: use official extension if platform is supported (WooCommerce, Shopify, Magento, Wix, Ecwid, etc. per references/plugins/_matrix.md). For new custom online builds, use Orchestration references. For POS, read references/pos-integrations.md and references/pos-expo-sunmi.md. ${examplesList} covers classic Checkout V2 only.`,
    },
    {
      step: 3,
      title: 'Build for the selected product',
      desc: `Use the selected product contract: Orchestration PaymentIntent/client_secret and integer minor units; POS REST uses a server-held merchant key and integer cents; POS Intent uses Android handoff and integer cents. For classic Checkout V2, use OAuth, POST /v2/checkout and result.code. Verify each product's webhook scheme and correlate amount, currency, order and attempt before fulfilment. Classic retry helper${retryRef} must not be copied as a POS retry policy.`,
    },
    {
      step: 4,
      title: 'VERIFY before shipping',
      desc: 'Choose checks matching the product. Existing linter, preflight and smoke tools have limited documented profiles and do not validate POS. Classic result-code tools apply only to dotted codes. For POS, test timeout recovery, duplicate submissions and conflicting events; run the mock app, then physical UAT. For Orchestration, validate its native status and HMAC-SHA512 contracts.',
    },
    {
      step: 5,
      title: 'Go-live (references/testing-and-go-live.md, references/playbooks/go-live.md)',
      desc: 'Complete the product-specific checklist before any authorized live credential/host change or terminal rollout. Verify no secrets or OAuth token calls in client-side code, and follow write-confirmation safety gates for any money movement.',
    },
  ];
}

/**
 * Format the golden path and verified tool inventory.
 */
function formatGuide(skillRoot) {
  const steps = getGoldenPath(skillRoot);
  const inventory = getToolInventory(skillRoot);

  const lines = [];
  lines.push('================================================================================');
  lines.push('PEACH PAYMENTS INTEGRATION — GOLDEN PATH (5 STEPS)');
  lines.push('================================================================================');
  lines.push('');

  for (const s of steps) {
    lines.push(`(${s.step}) ${s.title}`);
    lines.push(`    ${s.desc}`);
    lines.push('');
  }

  lines.push('================================================================================');
  lines.push('TOOL INVENTORY');
  lines.push('================================================================================');
  lines.push('');

  const maxNameLen = Math.max(...inventory.map(i => i.name.length));
  for (const item of inventory) {
    const pad = ' '.repeat(maxNameLen - item.name.length + 2);
    lines.push(`  ${item.name}${pad}${item.desc}`);
  }

  return lines.join('\n');
}

/* ────────────────────────────────────────────────────────────────────────────
 * Health Checks Runner
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Execute all health checks and return structured results.
 */
function runHealthChecks(skillRoot) {
  const issues = [];
  const reports = [];

  // Check 1: Script selftests
  const SELFTEST_SCRIPTS = [
    'scripts/check-integration.js',
    'scripts/verify-webhook.js',
    'scripts/map-result-code.js',
    'scripts/canonical-string.js',
    'scripts/webhook-sample.js',
    'scripts/decode-result.js',
    'scripts/preflight.js',
    'scripts/smoke-test.js',
    'scripts/doctor.js',
  ];

  for (const scriptRel of SELFTEST_SCRIPTS) {
    const fullPath = path.join(skillRoot, scriptRel);
    if (!fs.existsSync(fullPath)) {
      issues.push(`Missing script: ${scriptRel}`);
      reports.push({ pass: false, msg: `FAIL  ${scriptRel} selftest — file not found` });
      continue;
    }

    const res = child_process.spawnSync(process.execPath, [fullPath, 'selftest'], {
      cwd: skillRoot,
      encoding: 'utf8',
    });

    if (res.status === 0) {
      const passLine = extractPassLine(res.stdout) || 'passed';
      reports.push({ pass: true, msg: `PASS  ${scriptRel} selftest (${passLine})` });
    } else {
      issues.push(`Selftest failed for ${scriptRel} (exit code ${res.status})`);
      reports.push({ pass: false, msg: `FAIL  ${scriptRel} selftest (exit ${res.status})` });
    }
  }

  // Validate the shipped manifest as well as synthetic regression fixtures. Never fetch here.
  const baselineCheck = child_process.spawnSync('python3', ['scripts/refresh-docs-check.py', '--validate-baseline'], {
    cwd: skillRoot,
    encoding: 'utf8',
    timeout: 10000,
  });
  if (baselineCheck.status === 0) {
    reports.push({ pass: true, msg: `PASS  documentation baseline (${baselineCheck.stdout.trim()})` });
  } else {
    issues.push('Documentation baseline invalid or Python 3 unavailable');
    reports.push({ pass: false, msg: `FAIL  documentation baseline (${baselineCheck.error?.message || baselineCheck.stdout?.trim() || baselineCheck.stderr?.trim() || 'validation failed'})` });
  }

  // Offline regression checks for documentation freshness. Never fetch here.
  const freshnessTests = child_process.spawnSync('python3', ['scripts/test-refresh-docs-check.py'], {
    cwd: skillRoot,
    encoding: 'utf8',
    timeout: 10000,
  });
  if (freshnessTests.status === 0) {
    reports.push({ pass: true, msg: 'PASS  documentation freshness offline regression tests' });
  } else {
    issues.push('Documentation freshness tests failed or Python 3 unavailable');
    reports.push({ pass: false, msg: `FAIL  documentation freshness tests (${freshnessTests.error?.message || freshnessTests.stderr.trim()})` });
  }

  // Check 2: Examples lint clean
  const checkIntegrationPath = path.join(skillRoot, 'scripts/check-integration.js');
  const examplesPath = path.join(skillRoot, 'examples');
  if (!fs.existsSync(checkIntegrationPath) || !fs.existsSync(examplesPath)) {
    issues.push('Missing check-integration.js or examples/ directory');
    reports.push({ pass: false, msg: 'FAIL  examples lint — missing dependencies' });
  } else {
    const res = child_process.spawnSync(process.execPath, [checkIntegrationPath, 'examples'], {
      cwd: skillRoot,
      encoding: 'utf8',
    });
    const parsed = parseCheckIntegrationOutput(res.stdout, res.status);
    if (parsed.ok) {
      reports.push({ pass: true, msg: `PASS  examples lint clean (0 FAIL, ${parsed.warns} WARN)` });
    } else {
      issues.push(`examples lint failed: ${parsed.fails} FAIL, ${parsed.warns} WARN`);
      reports.push({ pass: false, msg: `FAIL  examples lint (${parsed.fails} FAIL, ${parsed.warns} WARN)` });
    }
  }

  // Check 3: Spec JSON valid
  const validatePath = path.join(skillRoot, 'reference-data/validate.js');
  if (!fs.existsSync(validatePath)) {
    issues.push('Missing reference-data/validate.js');
    reports.push({ pass: false, msg: 'FAIL  reference-data/validate.js — file not found' });
  } else {
    const res = child_process.spawnSync(process.execPath, [validatePath], {
      cwd: skillRoot,
      encoding: 'utf8',
    });
    if (res.status === 0) {
      const passLine = extractPassLine(res.stdout) || 'passed';
      reports.push({ pass: true, msg: `PASS  reference-data/validate.js (${passLine})` });
    } else {
      issues.push(`reference-data/validate.js failed (exit code ${res.status})`);
      reports.push({ pass: false, msg: `FAIL  reference-data/validate.js (exit ${res.status})` });
    }
  }

  // Check 4: Reference-file structure
  const structure = checkReferenceStructure(skillRoot);
  if (structure.ok) {
    reports.push({
      pass: true,
      msg: `PASS  reference-file structure: all ${structure.checkedCount} docs have '## When to load' and '## Traps'`,
    });
  } else {
    for (const m of structure.missing) {
      issues.push(`Reference file missing headers: ${m.file} missing [${m.missingHeaders.join(', ')}]`);
    }
    reports.push({
      pass: false,
      msg: `FAIL  reference-file structure: ${structure.missing.length} file(s) missing required sections`,
    });
  }

  // Check 5: Internal links resolve
  const links = checkInternalLinks(skillRoot);
  if (links.ok) {
    reports.push({
      pass: true,
      msg: `PASS  internal links resolve: ${links.totalLinks}/${links.totalLinks} relative .md links valid`,
    });
  } else {
    for (const b of links.brokenLinks) {
      issues.push(`Broken link in ${b.source}: ${b.target} -> ${b.resolved} not found`);
    }
    reports.push({
      pass: false,
      msg: `FAIL  internal links resolve: ${links.brokenLinks.length} broken link(s) found`,
    });
  }

  return {
    reports,
    issues,
    healthy: issues.length === 0,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Selftest
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Built-in self-test for doctor.js helpers.
 */
function runSelftest() {
  const tests = [];
  const t = (name, fn) => tests.push({ name, fn });

  t('extractPassLine parses N/N passed format', () => {
    const out = 'PASS test 1\nPASS test 2\n\n15/15 passed\n';
    if (extractPassLine(out) !== '15/15 passed') {
      throw new Error('failed to extract standard pass line');
    }
  });

  t('extractPassLine parses checks passed format', () => {
    const out = '398/398 checks passed\n';
    if (extractPassLine(out) !== '398/398 checks passed') {
      throw new Error('failed to extract checks passed line');
    }
  });

  t('parseCheckIntegrationOutput handles clean scan', () => {
    const res = parseCheckIntegrationOutput('✓ no Peach integration footguns found.', 0);
    if (!res.ok || res.fails !== 0 || res.warns !== 0) {
      throw new Error('clean scan should have ok=true, fails=0, warns=0');
    }
  });

  t('parseCheckIntegrationOutput handles warnings without failures', () => {
    const res = parseCheckIntegrationOutput('\n0 FAIL, 3 WARN\n', 0);
    if (!res.ok || res.fails !== 0 || res.warns !== 3) {
      throw new Error('warnings with 0 FAIL should have ok=true, warns=3');
    }
  });

  t('parseCheckIntegrationOutput never lets success text override process failure', () => {
    for (const exitCode of [1, 2, null]) {
      const res = parseCheckIntegrationOutput('no Peach integration footguns found', exitCode);
      if (res.ok || res.fails < 1) {
        throw new Error(`failed process must fail lint health check (exit ${exitCode})`);
      }
    }
  });

  t('parseCheckIntegrationOutput flags failures', () => {
    const res = parseCheckIntegrationOutput('\n2 FAIL, 1 WARN\n', 1);
    if (res.ok || res.fails !== 2 || res.warns !== 1) {
      throw new Error('failures should have ok=false, fails=2');
    }
  });

  t('checkMarkdownHeaders flags missing sections', () => {
    const bad1 = '# Title\nSome content without required sections.';
    const m1 = checkMarkdownHeaders(bad1);
    if (m1.length !== 2) throw new Error('expected 2 missing headers');

    const bad2 = '# Title\n## When to load\ncontext only';
    const m2 = checkMarkdownHeaders(bad2);
    if (m2.length !== 1 || m2[0] !== '## Traps') throw new Error('expected missing Traps');

    const good = '# Title\n## When to load\ncontext\n## Traps\nnone';
    const m3 = checkMarkdownHeaders(good);
    if (m3.length !== 0) throw new Error('good doc should have 0 missing headers');
  });

  t('extractRelativeMdLinks filters external URLs and non-md targets', () => {
    const md = `
      [ext](https://example.com/foo.md)
      [mail](mailto:test@example.com)
      [anchor](#heading)
      [good](plugins/woocommerce.md)
      [with-hash](testing-and-go-live.md#section)
      [not-md](image.png)
    `;
    const links = extractRelativeMdLinks(md);
    if (links.length !== 2) throw new Error(`expected 2 links, got ${links.length}`);
    if (links[0] !== 'plugins/woocommerce.md' || links[1] !== 'testing-and-go-live.md#section') {
      throw new Error('unexpected link extraction result');
    }
  });

  t('getToolInventory returns existing paths with non-empty descriptions', () => {
    const inv = getToolInventory(SKILL_ROOT);
    if (inv.length < 8) throw new Error(`expected at least 8 tool inventory items, got ${inv.length}`);
    for (const item of inv) {
      const full = path.join(SKILL_ROOT, item.path);
      if (!fs.existsSync(full)) throw new Error(`inventory path does not exist on disk: ${item.path}`);
      if (!item.name || !item.desc) throw new Error(`item missing name or description: ${item.path}`);
    }
  });

  t('getGoldenPath contains 5 sequential steps', () => {
    const steps = getGoldenPath(SKILL_ROOT);
    if (steps.length !== 5) throw new Error(`expected 5 steps, got ${steps.length}`);
    for (let i = 0; i < 5; i++) {
      if (steps[i].step !== i + 1) throw new Error(`expected step ${i + 1}`);
      if (!steps[i].title || !steps[i].desc) throw new Error(`step ${i + 1} missing title or desc`);
    }
  });

  t('formatGuide produces formatted output with Golden Path and Tool Inventory headers', () => {
    const text = formatGuide(SKILL_ROOT);
    if (!text.includes('PEACH PAYMENTS INTEGRATION — GOLDEN PATH (5 STEPS)')) {
      throw new Error('missing golden path header in guide');
    }
    if (!text.includes('TOOL INVENTORY')) {
      throw new Error('missing tool inventory header in guide');
    }
    if (!text.includes('(1) Run discovery') || !text.includes('(5) Go-live')) {
      throw new Error('missing golden path steps in guide');
    }
  });

  let passed = 0;
  for (const { name, fn } of tests) {
    try {
      fn();
      console.log(`PASS  ${name}`);
      passed++;
    } catch (e) {
      console.log(`FAIL  ${name} — ${e.message}`);
    }
  }

  console.log(`\n${passed}/${tests.length} passed`);
  return passed === tests.length;
}

/* ────────────────────────────────────────────────────────────────────────────
 * CLI
 * ──────────────────────────────────────────────────────────────────────────── */

function printHelp() {
  console.log(`doctor.js — Peach Payments skill capstone health-check and golden-path guide

USAGE:
  node scripts/doctor.js            # Run all health checks + print report; exit 1 if any FAIL
  node scripts/doctor.js --guide    # Print ONLY the golden-path + tool inventory (no checks)
  node scripts/doctor.js selftest   # Run internal unit tests for doctor.js helpers

OPTIONS:
  --guide          Print golden path and tool inventory without running health checks
  --help, -h       Show this help message

EXIT CODES:
  0 = all checks passed / guide printed / selftest passed
  1 = health checks failed or selftest failed
  2 = usage error or invalid arguments
`);
}

function main() {
  const args = process.argv.slice(2);

  for (const a of args) {
    if (a.startsWith('-') && a !== '--guide' && a !== '--help' && a !== '-h') {
      console.error(`doctor.js: error: unknown option '${a}'`);
      console.error("Run 'node scripts/doctor.js --help' for usage.");
      process.exit(2);
    }
  }

  if (args.includes('--help') || args.includes('-h') || args.includes('help')) {
    printHelp();
    process.exit(0);
  }

  if (args.includes('selftest')) {
    const ok = runSelftest();
    process.exit(ok ? 0 : 1);
  }

  if (args.includes('--guide')) {
    console.log(formatGuide(SKILL_ROOT));
    process.exit(0);
  }

  // Default: run all health checks + print report
  console.log('PEACH PAYMENTS SKILL DOCTOR');
  console.log('Running health checks...\n');

  const health = runHealthChecks(SKILL_ROOT);
  for (const r of health.reports) {
    console.log(r.msg);
  }
  console.log('');

  console.log(formatGuide(SKILL_ROOT));
  console.log('');

  if (health.healthy) {
    console.log('SKILL DOCTOR: HEALTHY');
    process.exit(0);
  } else {
    console.log(`SKILL DOCTOR: ${health.issues.length} issue(s)`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  extractPassLine,
  parseCheckIntegrationOutput,
  checkMarkdownHeaders,
  extractRelativeMdLinks,
  checkReferenceStructure,
  checkInternalLinks,
  getAvailableExamples,
  getToolInventory,
  getGoldenPath,
  formatGuide,
  runHealthChecks,
  runSelftest,
};
