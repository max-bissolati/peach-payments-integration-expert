#!/usr/bin/env node
/*
 * check-integration.js — lint AGENT-GENERATED Peach integration code for the known footguns.
 *
 * The other scripts verify a single value (a webhook payload, a result code, a canonical string).
 * This one scans the integration you just WROTE for the mistakes that pass code review, pass a
 * naive test, and then lose real money or fail silently in production. Run it before you call an
 * integration done.
 *
 * Usage:
 *   node scripts/check-integration.js <file-or-dir> [more...]   # scan paths (recurses dirs)
 *   node scripts/check-integration.js --stdin < file            # scan piped content
 *   node scripts/check-integration.js selftest                  # run the built-in tests
 *
 * Exit code: 1 if any FAIL finding (or a failing selftest), else 0. WARN alone exits 0.
 * Zero dependencies. Heuristic by nature — every finding names the file/line and the reference to
 * check; treat WARN as "confirm this is intentional", FAIL as "this will break money or security".
 */
/*
 * Known heuristic limits:
 * - Fastify default-parser raw-body destruction (no parser call to match)
 * - Python get_json framework body-caching nuance
 * - 60*60*1000 TTL idiom
 * - Payouts amount decimal check relies on proximity (within 15 lines) to a payouts marker
 * - Webhook unconditional 200 checks for absence of verification identifiers in file
 * - Sandbox host in prod flags files combining sandbox URLs and production markers
 * - A determined adversary can evade any line-based heuristic
 * Heuristic linter contract: WARN = confirm intentional, FAIL = fix.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const CODE_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte', '.py', '.php', '.rb', '.go', '.java', '.kt', '.rs', '.cs']);
const DYNAMIC_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte', '.py', '.php', '.rb']);
const FRONTEND_EXT = new Set(['.jsx', '.tsx', '.vue', '.svelte']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next']);

// A check: { id, severity, ref, scan(ctx) -> [{line, msg}] }
//   ctx = { text, lines, codeLines, codeText, file, ext, isFrontend, has(re), hasCode(re), linesMatching(re), codeLinesMatching(re) }
const CHECKS = [
  {
    id: 'webhook-raw-body-destroyed',
    severity: 'FAIL',
    ref: 'webhooks.md → "The framework-body trap"',
    scan(ctx) {
      if (!ctx.mentionsWebhook) return [];
      // A global JSON/urlencoded body parser consumes the raw bytes the signature needs.
      const parser = /express\.json\s*\(|bodyParser\.(json|urlencoded)\s*\(|app\.use\s*\(\s*express\.(json|urlencoded)|await\s+req(uest)?\.json\s*\(|request\.get_json\s*\(|JSON\.parse\s*\(\s*req(uest)?\.body/;
      const hits = ctx.linesMatching(parser);
      if (!hits.length) return [];
      // If they already preserve a raw body on a non-comment line, assume they know what they're doing.
      const rawBodyEvidence = /express\.raw\s*\(|bodyParser\.raw\s*\(|req(uest)?\.rawBody|\.rawBody\b|\.body\.toString\s*\(|getReader\s*\(|await\s+req(uest)?\.text\s*\(/;
      if (ctx.hasCode(rawBodyEvidence)) return [];
      return hits.map(h => ({ line: h.line, msg: 'Webhook file parses the body as JSON/urlencoded — this destroys the raw bytes the signature is computed over, so verification will always fail. Read the raw body (express.raw / request text) or reconstruct + re-sign from the parsed object.' }));
    },
  },
  {
    id: 'result-underscore-key',
    severity: 'FAIL',
    ref: 'result-codes.md / webhooks.md',
    scan(ctx) {
      // The footgun is READING the wire key result_code/result_description/resultDetails_<x> (Peach's
      // real key is the dotted result.code) FROM a payload/response object — the read is always
      // undefined. Fire ONLY on a READ-SHAPE against a payload-ish receiver, so a local variable named
      // result_code, an ORM column, a SQL string, a defensive test assertion, or a typed struct field
      // is NOT flagged (those tripped false FAILs, which BLOCK a build — worse than a miss).
      //   Form A (ANY language): a quoted key indexing / .get() on a payload-ish receiver, or on a
      //     payload-producing call (get_json()/get_data()/json()/parse()).
      //   Form B (DYNAMIC languages only): a property access <payloadish>.result_code — in a typed
      //     language a rename attribute decouples the field name from the wire key, so it is correct.
      //   Comments are already stripped (codeLinesMatching), so trailing-comment words can't suppress.
      const KEY = '(?:result_code|result_description|resultDetails_\\w*)';
      // A payload-ish receiver: an identifier whose name contains one of these tokens. Deliberately
      // EXCLUDES row / node / cur / models / record so DB/CSV/ORM/test access is not flagged.
      // Known limits (independent review): a payload-ish name reused for the CALLER's own data, a
      // key spelled inside a string literal, and write-to-own-response can still FP contextually;
      // destructuring `const {result_code}=payload` and helper-wrapped reads `getStatus().result_code`
      // can FN. Accepted heuristic boundaries — a false FAIL on truly idiomatic code is the line we hold.
      const RECV = '\\b(?=[\\w$]*(?:payload|body|data|json|event|evt|webhook|notif|resp|response|res|status|result|checkout|session|hook|msg|message|req|request|parsed))[A-Za-z_$][\\w$]*';
      const PAYLOAD_CALL = '(?:get_json|get_data|getBody|json|parse)\\s*\\([^)]*\\)';
      const formA = new RegExp(
        '(?:' + RECV + '(?:\\.[\\w$]+)*|' + PAYLOAD_CALL + ')' +
        '\\s*(?:\\??\\.\\s*get\\s*\\(\\s*|\\[\\s*)' +
        '([\'"`])' + KEY + '\\1', 'i');
      const formB = new RegExp(
        RECV + '(?:\\?\\.|\\.|->)(?:[\\w$]+(?:\\?\\.|\\.|->))*' + KEY + '\\b', 'i');
      const isDynamic = DYNAMIC_EXT.has(ctx.ext);
      const driver = new RegExp('\\b' + KEY + '\\b');
      const hits = [];
      for (const h of ctx.codeLinesMatching(driver)) {
        if (formA.test(h.code) || (isDynamic && formB.test(h.code))) {
          hits.push({
            line: h.line,
            msg: 'Peach uses DOT-notation keys (result.code, resultDetails.ExtendedDescription) — result_code / an underscore variant never exists in a real payload, so this read is always undefined. Access obj["result.code"].',
          });
        }
      }
      return hits;
    },
  },
  {
    id: 'result-code-nested-access',
    severity: 'WARN',
    ref: 'webhooks.md / checkout-v2.md (flat dotted keys)',
    scan(ctx) {
      // Classic webhook bodies and /status responses are FLAT objects with dotted keys.
      const nestedPattern = /\.result\s*\??\.\s*\w+|\[["']result["']\]\s*\[["']\w+["']\]|\.get\(\s*["']result["']\s*(?:,\s*[^)]+)?\)\s*(?:\.get\s*\(|\[)/;
      return ctx.linesMatching(nestedPattern).map(h => ({ line: h.line, msg: 'Peach classic webhooks and GET /status return FLAT objects with dotted keys — obj["result.code"], not obj.result.code. Nested access returns undefined and your success check silently fails closed (or open). Confirm the surface: Payments-API v2 differs.' }));
    },
  },
  {
    id: 'amount-in-minor-units',
    severity: 'WARN',
    ref: 'checkout-v2.md / methods-catalog.md (major-unit decimal strings; Payouts is the exception)',
    scan(ctx) {
      const out = [];
      const rounding2dp = /\bMath\.round\s*\([^)]*\*\s*100[^)]*\)\s*\/\s*100\b|\bamount[^\n;]{0,40}\*\s*100\s*\/\s*100\b/g;
      const minorUnitRe = /amount[^\n;]{0,40}\*\s*100\b|\bMath\.round\s*\([^)]*\*\s*100/;
      // amount multiplied by 100 near a checkout/payments context = probably sending cents where major units are expected.
      for (const h of ctx.linesMatching(minorUnitRe)) {
        const cleaned = h.text.replace(rounding2dp, '');
        if (minorUnitRe.test(cleaned)) {
          out.push({ line: h.line, msg: 'Checkout and Payments API amounts are DECIMAL-STRING MAJOR UNITS ("15.00"), never cents. Multiplying by 100 double-scales the charge 100x. (Only the Payouts API takes integer cents — different surface.)' });
        }
      }
      return out;
    },
  },
  {
    id: 'secret-in-frontend',
    severity: 'FAIL',
    ref: 'pci-security.md / checkout-v2.md (server-side only)',
    scan(ctx) {
      const out = [];
      // Public-prefixed env secrets are client-exposed by framework convention even in plain .js/.ts files.
      const publicEnvSecret = /\b(?:NEXT_PUBLIC|VITE|REACT_APP|PUBLIC|EXPO_PUBLIC)_[A-Za-z0-9_]*(?:SECRET|TOKEN|KEY)[A-Za-z0-9_]*\b/i;
      for (const h of ctx.linesMatching(publicEnvSecret)) {
        out.push({ line: h.line, msg: 'A Peach secret/key appears in a client-exposed environment variable (NEXT_PUBLIC_, VITE_, REACT_APP_, etc.). Framework conventions expose these to the browser bundle. Secrets belong on the server only.' });
      }
      // Files under conventionally browser-served directories ship to the client even with a plain
      // .js/.ts extension, so a secret there is exposed (this is the public/config.js footgun).
      const pathLooksServed = /(?:^|[\\/])(?:public|static|assets|www|dist|build)[\\/]/i.test(ctx.file || "");
      if (ctx.isFrontend || ctx.looksFrontend || pathLooksServed) {
        // A secret token / client secret / OAuth call in browser code leaks credentials.
        const secretPattern = /\bclientSecret\b|(?:\b|_)client_secret\b|\bsecretToken\b|(?:\b|_)SECRET_TOKEN\b|\/api\/oauth\/token\b/;
        for (const h of ctx.linesMatching(secretPattern)) {
          if (!out.some(o => o.line === h.line)) {
            out.push({ line: h.line, msg: 'A Peach secret (secret token / client secret / the OAuth token call) appears in what looks like client-side code. OAuth, checkout creation, refunds and webhooks are SERVER-SIDE ONLY. Only the entityId (semi-public SDK key) belongs in the browser.' });
          }
        }
      }
      return out;
    },
  },
  {
    id: 'token-expiry-hardcoded',
    severity: 'WARN',
    ref: 'checkout-v2.md (cache by returned expires_in)',
    scan(ctx) {
      if (!ctx.mentionsPeachAuth) return [];
      return ctx.linesMatching(/expires?_?in['"]?\s*[:=]\s*3600\b|,\s*3600\s*\*\s*1000\b|\b3600000\b/).map(h => ({ line: h.line, msg: 'Do not hardcode a 3600s (1h) token lifetime — cache by the token response\'s own expires_in (sandbox has been observed at 14400s / 4h). A hardcoded 3600 re-auths 4x too often or, if used as a hard TTL, can outlive the real token.' }));
    },
  },
  {
    id: 'mit-uses-checkout-token',
    severity: 'WARN',
    ref: 'recurring-and-tokenisation.md (MIT uses the S2S/recurring token, not the Checkout OAuth token)',
    scan(ctx) {
      if (!/registrations\/[^\n"'`]*\/payments/.test(ctx.text)) return [];
      const usesCheckoutTok = ctx.linesMatching(/registrations\/[^\n"'`]*\/payments/);
      if (!ctx.has(/checkoutToken|oauthToken|checkout.?access.?token|Bearer \$\{?(checkout|oauth)/i)) return [];
      return usesCheckoutTok.map(h => ({ line: h.line, msg: 'MIT recurring debits (POST /v1/registrations/{id}/payments) authenticate with the Server-to-Server / recurring token, NOT the Checkout OAuth token. Using the Checkout token here causes auth failures. Confirm which bearer you pass.' }));
    },
  },
  {
    id: 'fulfil-without-status-confirm',
    severity: 'WARN',
    ref: 'webhooks.md / SKILL.md (a webhook is a wake-up call, not truth)',
    scan(ctx) {
      if (!ctx.mentionsWebhook) return [];
      // A webhook handler that fulfils/ships/updates order but never re-fetches /status.
      const fulfils = ctx.codeLinesMatching(/fulfil|fulfill|ship|markPaid|mark_paid|completeOrder|complete_order|grantAccess|activateSubscription|deliver/i);
      if (!fulfils.length) return [];
      const statusCallRe = /fetch\([^)]*status|axios\.[a-z]+\([^)]*status|getCheckoutStatus|\/v2\/checkout\/[^)"'`]*\/status/i;
      if (ctx.hasCode(statusCallRe)) return [];
      return [{ line: fulfils[0].line, msg: 'This webhook path appears to fulfil/ship/grant without re-confirming via GET /v2/checkout/{id}/status. A webhook is a wake-up call, not truth (its body can be replayed/tampered and arrives out of order) — re-fetch status + check amount before fulfilling.' }];
    },
  },
  {
    id: 'missing-signature-verification',
    severity: 'WARN',
    ref: 'webhooks.md / scripts/verify-webhook.js',
    scan(ctx) {
      if (!ctx.mentionsWebhook) return [];
      // Only fire on a file that actually HANDLES a webhook (a POST route / body read), not a data or
      // config module that merely mentions "webhook" in a comment or import.
      const handlerRe = /\.post\s*\(|export\s+(async\s+)?function\s+POST\b|@app\.(route|post)|def\s+\w*(webhook|notif)|req(uest)?\.(body|rawBody|text)\b|request\.(get_data|json|body)/i;
      if (!ctx.hasCode(handlerRe)) return [];
      // A webhook endpoint with no sign of signature verification anywhere in the file.
      // Require verification SHAPE (a crypto operation with a call/dot), not bare vocabulary — a route
      // string like '/webhook/hmac' or a bare `import hashlib` must not count as verification.
      const verificationRe = /createHmac|createHash|timingSafeEqual|hmac\.(new|compare_digest|digest|update)|hashlib\.(sha|md5|new)|compare_digest|Mac\.getInstance|verifyWebhook|verify_webhook|x-webhook-signature-algorithm/i;
      if (ctx.hasCode(verificationRe)) return [];
      const anchor = ctx.codeLinesMatching(/webhook|notification|\bnotif/i)[0] || ctx.linesMatching(/webhook|notification|\bnotif/i)[0];
      return [{ line: anchor ? anchor.line : 1, msg: 'Webhook endpoint with no visible signature verification. Never act on an unverified webhook — verify (HMAC classic body-signature, or the header scheme) and fail closed. See scripts/verify-webhook.js.' }];
    },
  },
  {
    id: 'live-host-hardcoded',
    severity: 'WARN',
    ref: 'testing-and-go-live.md (parametrise sandbox vs live)',
    scan(ctx) {
      // Live host literally in code with no sandbox counterpart = a sandbox/live swap waiting to go wrong.
      const live = ctx.codeLinesMatching(/https?:\/\/(secure|dashboard|api|card)\.peachpayments\.com/);
      if (!live.length) return [];
      const hostEnvOrSandbox = /testsecure\.|sandbox-dashboard\.|sandbox-card\.|testapi|PEACH_[A-Z_]*HOST|process\.env\.[A-Z_]*HOST/;
      if (ctx.hasCode(hostEnvOrSandbox)) return [];
      const envRef = /process\.env|os\.environ|getenv|ENV\[/;
      const hits = [];
      for (const h of live) {
        // Only the SAME-line env-fallback idiom (host = process.env.X || "live-default") is a real
        // env switch; an env reference on a merely-adjacent unrelated line must NOT suppress the finding.
        const sameLineEnv = envRef.test(ctx.codeLines[h.idx] || '');
        if (!sameLineEnv) {
          hits.push({ line: h.line, msg: 'A live Peach host is hardcoded with no sandbox counterpart or env switch. Drive the host from config so sandbox and live can\'t be swapped by accident — testing against live is a red line.' });
        }
      }
      return hits;
    },
  },
  {
    id: 'payouts-amount-not-cents',
    severity: 'WARN',
    ref: 'payouts.md / methods-catalog.md',
    scan(ctx) {
      const payoutsContextRe = /\/payouts\b|sandbox-payouts\.|payouts\.peachpayments|createPayout|payoutId/i;
      const payoutLines = ctx.codeLinesMatching(payoutsContextRe);
      if (!payoutLines.length) return [];

      const decimalAmountRe = /\bamount\s*[:=]\s*(?:['"`]\d+\.\d+['"`]|\d+\.\d+)|(?:amount[^\n;]*\.toFixed|\.toFixed[^\n;]*amount)/;
      const candidateLines = ctx.codeLinesMatching(decimalAmountRe);
      const out = [];
      for (const h of candidateLines) {
        const isNear = payoutLines.some(p => Math.abs(h.line - p.line) <= 15);
        if (isNear) {
          out.push({
            line: h.line,
            msg: 'Payouts API amounts are INTEGER CENTS (e.g. 1000 = R10.00), not major-unit decimals — a decimal amount here is wrong. (Checkout/Payments API are the opposite: decimal strings.)',
          });
        }
      }
      return out;
    },
  },
  {
    id: 'webhook-unconditional-200',
    severity: 'WARN',
    ref: 'webhooks.md',
    scan(ctx) {
      if (!ctx.mentionsWebhook) return [];
      const handlerRe = /\.post\s*\(|export\s+(async\s+)?function\s+POST\b|@app\.(route|post)|def\s+\w*(webhook|notif)/i;
      if (!ctx.hasCode(handlerRe)) return [];
      // Suppress only on verification SHAPE, not vocabulary: an actual comparison operation OR a
      // fail-closed non-2xx branch. A bare `import hashlib` or a route named `/webhook/hmac` must NOT
      // count as verification (that would silence genuinely unverified webhooks).
      const comparisonOp = /createHmac|crypto\.timingSafeEqual|\btimingSafeEqual\b|compare_digest|hmac\.compare_digest|hmac\.Equal|MessageDigest\.isEqual|verifyWebhook\s*\(|verify_webhook\s*\(/i;
      const failClosedBranch = /\breturn\b[^\n]*\b(?:400|401|403)\b|(?:res|reply)\.status\s*\(\s*(?:400|401|403)|(?:res|reply)\.sendStatus\s*\(\s*(?:400|401|403)|\babort\s*\(\s*(?:400|401|403)|NextResponse[^\n]*status:\s*(?:400|401|403)/;
      if (ctx.hasCode(comparisonOp) || ctx.hasCode(failClosedBranch)) return [];
      const resp200Re = /res\.sendStatus\s*\(\s*200\s*\)|res\.status\s*\(\s*200\s*\)|\bstatus:\s*200\b|NextResponse[^\n;]*status:\s*200|\breturn\s+(?:[^;\n]*,)?\s*200\b/;
      const hits = ctx.codeLinesMatching(resp200Re);
      if (!hits.length) return [];
      return hits.map(h => ({
        line: h.line,
        msg: 'Webhook returns 200 with no signature verification/branching — this acknowledges (and drops) unverified events and stops Peach\'s retries. Verify first, fail closed, and only 200 after you\'ve durably recorded a verified event.',
      }));
    },
  },
  {
    id: 'sandbox-host-in-prod',
    severity: 'WARN',
    ref: 'testing-and-go-live.md',
    scan(ctx) {
      const sandboxHostRe = /testsecure\.|sandbox-dashboard\.|sandbox-card\.|sandbox-payouts\.|testapi/;
      const hits = ctx.codeLinesMatching(sandboxHostRe);
      if (!hits.length) return [];
      const prodMarkerRe = /NODE_ENV[^\n]*production|['"]production['"]|isProd|\.env\.production|PROD\b/;
      const hasProdMarker = ctx.hasCode(prodMarkerRe) || prodMarkerRe.test(ctx.file || '');
      if (!hasProdMarker) return [];
      // A LIVE host present too means this is an environment SWITCH (live vs sandbox), not a sandbox
      // host hardcoded into prod — the correct pattern. Only the sandbox-host-ALONE case is the mistake.
      // Lookbehind excludes the sandbox variants (testsecure., sandbox-card., sandbox-dashboard.) so we
      // match a real live host even when written scheme-less ("secure.peachpayments.com").
      const liveHostRe = /(?<![a-z-])(secure|dashboard|api|card)\.peachpayments\.com/;
      if (ctx.hasCode(liveHostRe)) return [];
      return hits.map(h => ({
        line: h.line,
        msg: 'A Peach SANDBOX host appears alongside a production marker — sandbox credentials/hosts must never ship to production. Drive the host from env per environment.',
      }));
    },
  },
  {
    id: 'unauthenticated-money-endpoint',
    severity: 'WARN',
    ref: 'pci-security.md',
    scan(ctx) {
      const ROUTE_START_RE = /(?:app|router|server|fastify)\s*\.\s*(?:post|get|put|delete|patch|all|route)\s*\(|\.(?:route)\s*\(['"`]|@(?:app\.|router\.|bp\.|api\.)?(?:route|post|get|put|delete|patch)\s*\(|@(?:Post|Get|Put|Patch|Delete)Mapping\b|\[Http(?:Post|Get|Put|Patch|Delete)\b|\[Route\s*\(|\b(?:post|get|put|patch|delete)\s+['"`]\/[^'"`]*['"`]|export\s+(?:async\s+)?function\s+(?:POST|GET|PUT|PATCH|DELETE)\b/i;
      const WEBHOOK_RE = /(?:webhook|notification|notify|\bnotif)/i;
      // The added money-verbs (disburse/withdraw) still fire on money kebabs (/withdraw-funds) and plain
      // forms, but a short follower denylist keeps non-money compounds (/withdraw-consent, GDPR data
      // withdrawal, etc.) quiet. (Residual note-level FP: hyphen BEFORE the verb, e.g. /data-withdrawal.)
      const HIGH_RISK_PATH = /\/(?:debits?|refunds?|captures?|payouts?|revers(?:e|al)?s?|registrations?)\b|\/(?:disburse(?:ments?)?|withdrawals?|withdraw)(?!-(?:consent|permission|access|gdpr|data|policy|preference|notice|form|request-form))(?!\w)/i;
      const HIGH_RISK_CALL = /\b(?:debitStoredCard|refundPayment|capturePreauth|createPayout|reversePayment|listRegistrations|getRegistrations)\s*\(/i;
      const PEACH_CONTEXT = /peachpayments|entityId|registrationId|['"][^'"]*peach['"]/i;

      // Auth-suppression allowlists: include the most common real idioms so correctly-protected money
      // routes do NOT warn (alert fatigue on the highest-value check). Covers Express custom middleware
      // (protect/authGuard/isAuthenticated), NestJS @UseGuards(...), Spring @Secured/@RolesAllowed, and
      // parameterized [Authorize(...)]. (Independent review flagged the closed-allowlist FPs.)
      const AUTH_NAMES = 'requireAuth|require_auth|authenticate|authMiddleware|auth_middleware|ensureAuth|ensure_auth|verifyToken|verify_token|verifyJwt|verify_jwt|check_authentication|check_auth|login_required|jwt_required|protect|authGuard|isAuthenticated|requireLogin|ensureLoggedIn';
      // passport counts as auth ONLY as `passport.authenticate(...)` (the actual guard) — never a bare
      // `require('passport')` import or the plumbing `passport.initialize()/.session()/.configure()`,
      // which guard nothing and must NOT suppress a later unauth money route.
      const PASSPORT = 'passport\\s*\\.\\s*authenticate';
      const AUTH_DECORATORS = '@Authorize\\b|\\[Authorize\\b|@PreAuthorize\\b|@(?:Secured|RolesAllowed)\\b|\\bUseGuards\\s*\\(';
      const APP_AUTH_RE = new RegExp('(?:app|router|server|api)\\.use\\s*\\([^)]*?(?:' + AUTH_NAMES + '|' + PASSPORT + ')\\b', 'i');
      const PER_ROUTE_AUTH_RE = new RegExp('\\b(?:' + AUTH_NAMES + '|' + PASSPORT + ')\\b|' + AUTH_DECORATORS + '|before\\s+do|\\bbefore_action\\b', 'i');
      const USER_CONTEXT_RE = /\breq(?:uest)?\.user\b|\bres\.locals\.user\b/i;
      const BYPASS_AUTH_RE = /if\s*\(\s*(?:(?:config|env|process\.env)\.[\w$]+|[\w$]*(?:token|secret|key|auth|admin|password)[\w$]*)\s*&&\s*.*?(?:!==|!=)|if\s*\(\s*[a-zA-Z_$][\w$]*\s*&&\s*.*?(?:req|request|header|auth).*?(?:!==|!=)/i;

      const candidateRoutes = [];
      for (let i = 0; i < ctx.codeLines.length; i++) {
        if (ROUTE_START_RE.test(ctx.codeLines[i])) {
          candidateRoutes.push({ line: i + 1, idx: i, code: ctx.codeLines[i] });
        }
      }
      if (!candidateRoutes.length) return [];

      const findings = [];
      for (let k = 0; k < candidateRoutes.length; k++) {
        const cr = candidateRoutes[k];
        const declLines = [];
        for (let j = cr.idx; j < Math.min(ctx.codeLines.length, cr.idx + 12); j++) {
          declLines.push(ctx.codeLines[j]);
          if (/[{]|\bdo\b|:\s*$/.test(ctx.codeLines[j])) break;
        }
        const declChunk = declLines.join('\n');
        if (WEBHOOK_RE.test(declChunk) || (ctx.file && WEBHOOK_RE.test(ctx.file))) continue;

        const nextRouteIdx = (k + 1 < candidateRoutes.length) ? candidateRoutes[k + 1].idx : ctx.codeLines.length;
        const routeBody = ctx.codeLines.slice(cr.idx, nextRouteIdx).join('\n');

        const hasRiskPath = HIGH_RISK_PATH.test(declChunk);
        const hasRiskCall = HIGH_RISK_CALL.test(routeBody) && (PEACH_CONTEXT.test(ctx.text) || HIGH_RISK_PATH.test(ctx.text) || !ctx.file);
        if (!hasRiskPath && !hasRiskCall) continue;

        const codeBefore = ctx.codeLines.slice(0, cr.idx).join('\n');
        const hasAppAuth = APP_AUTH_RE.test(codeBefore) || /(?:@Authorize|\[Authorize\]|@PreAuthorize|before\s+do|\bbefore_action\b)/i.test(codeBefore);
        if (hasAppAuth) continue;

        const prevLines = ctx.codeLines.slice(Math.max(0, cr.idx - 5), cr.idx).join('\n');
        const hasPerRouteAuth = PER_ROUTE_AUTH_RE.test(declChunk) || PER_ROUTE_AUTH_RE.test(prevLines);
        if (hasPerRouteAuth) continue;

        if (USER_CONTEXT_RE.test(routeBody)) continue;

        const hasBypass = BYPASS_AUTH_RE.test(routeBody);
        const hasGenuineCompare = !hasBypass && (
          /\b(?:timingSafeEqual|compare_digest)\b/i.test(routeBody) ||
          (/(?:headers?\b[^;\n]*?(?:authorization|token|key|secret)|(?:authorization|token|key|secret)\b[^;\n]*?(?:===|!==|==|!=))/i.test(routeBody) &&
           /(?:res|reply|response)\.(?:sendStatus|status)\s*\(\s*(?:401|403)|return\s+(?:[^;\n]*,)?\s*(?:401|403)\b|abort\s*\(\s*(?:401|403)/i.test(routeBody))
        );
        if (hasGenuineCompare) continue;

        const msg = hasBypass
          ? 'Money-moving or token endpoint appears to lack an effective auth guard: the guard no-ops when the secret is unset (the default). Enforce authentication unconditionally or fail closed when unconfigured. See pci-security.md.'
          : 'Money-moving or token endpoint appears to lack an effective auth guard. Charging stored cards, debits, refunds, captures, payouts, or exposing card tokens without authentication allows unauthorized calls. Confirm this endpoint is protected by an auth guard. See pci-security.md.';

        findings.push({ line: cr.line, msg });
      }
      return findings;
    },
  },
  {
    id: 'toctou-dedupe-ordering',
    severity: 'WARN',
    ref: 'webhooks.md (atomic claim before await)',
    scan(ctx) {
      // TOCTOU dedupe race: a fulfilment dedupe written CHECK -> await -> CLAIM double-fulfils under
      // concurrent duplicate webhooks (Peach retries + the redirect-return race). Correct = claim
      // BEFORE the await (atomic claim), rolled back on non-fulfil paths.
      //
      // POSITIVE name gating is essential. The check->await->set shape is byte-identical to benign
      // cache-aside / memoization (`if (cache.has(k)) return cache.get(k); v = await load(k); cache.set(k,v)`),
      // which is NOT a bug — a duplicate cache fill is idempotent. There is no STRUCTURAL discriminator,
      // only intent, signalled by the collection's NAME. So this fires ONLY on dedupe-ish-named
      // collections; a cache / memo / tokenCache is never flagged. (Independent review: cache-aside was
      // the blocking false positive; the earlier name-denylist could not separate the two.)
      //
      // Known heuristic limits (accepted): a claim folded into a discarded-boolean call
      // (`if (!seen.add(id)) return;`); double-checked locking with an inner re-check; a dedupe
      // collection whose name is not dedupe-ish; and Python `x in coll` gates (no method form).
      const DEDUPE_NAME = /seen|processed|handled|dedup|delivered|completed|consumed|recorded|fulfil|acked|idempoten|\bdone\b|applied|processedcheckouts|processedwebhooks|handledevents/i;
      const ASYNC_BOUNDARY_RE = /\bawait\b|\.then\s*\(/;
      const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Gate = a membership/truthiness READ on C: .has/.includes/.contains/.key?/.include?, .get(, or C[key].
      const gateRe = (C) => new RegExp('\\b' + esc(C) + '\\s*(?:\\.\\s*(?:has|includes?|contains?|key\\?|has_key\\?|include\\?|get)\\s*\\(|\\[)', 'i');
      // Claim = a MARK on C: .add/.set/.push/.insert/.append(, or C[key] = (assignment, not ==).
      const claimRe = (C) => new RegExp('\\b' + esc(C) + '\\s*(?:\\.\\s*(?:add|set|push|insert|append)\\s*\\(|\\[[^\\]]*\\]\\s*=(?!=))', 'i');

      // Candidate collections: dedupe-ish-named identifiers appearing in any gate/claim form.
      const idRe = /\b([a-zA-Z_$][\w$]*)\s*(?:\.\s*(?:has|includes?|contains?|key\?|has_key\?|include\?|get|add|set|push|insert|append)\s*\(|\[)/gi;
      const candidates = new Set();
      for (const line of ctx.codeLines) {
        let m; idRe.lastIndex = 0;
        while ((m = idRe.exec(line)) !== null) {
          if (DEDUPE_NAME.test(m[1])) candidates.add(m[1]);
        }
      }
      if (!candidates.size) return [];

      const findings = [];
      for (const C of candidates) {
        const isGate = gateRe(C), isClaim = claimRe(C);
        // first gate line that is NOT itself a claim (an atomic same-line claim is not a TOCTOU)
        let gateIdx = -1;
        for (let i = 0; i < ctx.codeLines.length; i++) {
          if (isGate.test(ctx.codeLines[i]) && !isClaim.test(ctx.codeLines[i])) { gateIdx = i; break; }
        }
        if (gateIdx === -1) continue;
        // first claim strictly after the gate
        let claimIdx = -1;
        for (let i = gateIdx + 1; i < ctx.codeLines.length; i++) {
          if (isClaim.test(ctx.codeLines[i])) { claimIdx = i; break; }
        }
        if (claimIdx === -1) continue;
        // an async boundary strictly between the gate and that first claim = the claim is not atomic
        let racy = false;
        for (let i = gateIdx + 1; i < claimIdx; i++) {
          if (ASYNC_BOUNDARY_RE.test(ctx.codeLines[i])) { racy = true; break; }
        }
        if (racy) {
          findings.push({
            line: gateIdx + 1,
            msg: `Dedupe collection '${C}' is checked, then only claimed AFTER an async boundary. Concurrent duplicate requests can all pass the gate before any claim lands (TOCTOU) → double-fulfilment. Claim atomically BEFORE the await and roll back on non-fulfil paths.`,
          });
        }
      }
      return findings;
    },
  },
];

function getCodeLines(text) {
  // Remove multi-line /* ... */ comments while preserving newlines
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat((m.match(/\n/g) || []).length));
  return noBlock.split(/\r?\n/).map(line => {
    const t = line.trim();
    if (t.startsWith('//') || (t.startsWith('#') && !t.startsWith('#['))) return '';
    return line.replace(/\s+(\/\/|#(?!\[)).*$/, '');
  });
}

function makeCtx(text, file) {
  const lines = text.split(/\r?\n/);
  const codeLines = getCodeLines(text);
  const codeText = codeLines.join('\n');
  const ext = path.extname(file || '').toLowerCase();
  const linesMatching = (re) => {
    const out = [];
    for (let i = 0; i < lines.length; i++) { if (re.test(lines[i])) out.push({ line: i + 1, text: lines[i] }); }
    return out;
  };
  const codeLinesMatching = (re) => {
    const out = [];
    for (let i = 0; i < codeLines.length; i++) { if (re.test(codeLines[i])) out.push({ line: i + 1, text: lines[i], code: codeLines[i], idx: i }); }
    return out;
  };
  const looksFrontend = /useState|useEffect|document\.|window\.|<script|createRoot|ReactDOM|from ['"]react['"]|@vue\/|svelte/.test(text);
  return {
    text, lines, codeLines, codeText, file, ext,
    isFrontend: FRONTEND_EXT.has(ext),
    looksFrontend,
    mentionsWebhook: /webhook|notification[_ ]?url|notificationUrl|\bnotif/i.test(text),
    mentionsPeachAuth: /oauth\/token|access_token|peachpayments|entityId|clientId/i.test(text),
    has: (re) => re.test(text),
    hasCode: (re) => {
      if (re.global) re.lastIndex = 0;
      return re.test(codeText);
    },
    linesMatching,
    codeLinesMatching,
  };
}

function scanText(text, file) {
  const ctx = makeCtx(text, file);
  const findings = [];
  for (const c of CHECKS) {
    let hits = [];
    try { hits = c.scan(ctx) || []; } catch (_) { hits = []; }
    for (const h of hits) findings.push({ file: file || '<stdin>', line: h.line, id: c.id, severity: c.severity, msg: h.msg, ref: c.ref });
  }
  return findings;
}

function collectFiles(p, acc) {
  let st;
  try { st = fs.statSync(p); } catch (_) { return; }
  if (st.isDirectory()) {
    const segments = p.split(/[\\/]/);
    if (segments.some(seg => SKIP_DIRS.has(seg))) return;
    for (const name of fs.readdirSync(p)) collectFiles(path.join(p, name), acc);
  } else if (CODE_EXT.has(path.extname(p).toLowerCase())) {
    acc.push(p);
  }
}

function printReport(findings) {
  if (!findings.length) { console.log('✓ no Peach integration footguns found.'); return; }
  const order = { FAIL: 0, WARN: 1 };
  findings.sort((a, b) => (order[a.severity] - order[b.severity]) || a.file.localeCompare(b.file) || a.line - b.line);
  for (const f of findings) {
    console.log(`${f.severity}  ${f.file}:${f.line}  [${f.id}]`);
    console.log(`      ${f.msg}`);
    console.log(`      → ${f.ref}`);
  }
  const fails = findings.filter(f => f.severity === 'FAIL').length;
  const warns = findings.length - fails;
  console.log(`\n${fails} FAIL, ${warns} WARN`);
}

/* ─────────────────────────────── selftest ─────────────────────────────── */
function runSelftest() {
  const tests = [];
  const t = (name, fn) => tests.push({ name, fn });
  const has = (findings, id) => findings.some(f => f.id === id);
  const none = (findings, id) => !has(findings, id);

  t('clean server integration → no findings', () => {
    const good = `
      import express from 'express';
      const app = express();
      const host = process.env.PEACH_CHECKOUT_HOST; // sandbox or live from config
      app.post('/webhook', express.raw({type:'*/*'}), (req) => {
        const raw = req.body.toString();
        const sig = require('crypto').createHmac('sha256', process.env.SECRET).update(raw).digest('hex');
        // verify sig, then re-fetch GET /v2/checkout/\${id}/status before fulfilling
      });
      const amount = "15.00";
    `;
    const f = scanText(good, 'server.js');
    if (f.length) throw new Error('clean code flagged: ' + f.map(x => x.id).join(','));
  });

  t('webhook JSON parser destroys raw body → FAIL', () => {
    const bad = `app.use(express.json());\napp.post('/peach/webhook', (req,res)=>{ verify(req.body.signature); });`;
    const f = scanText(bad, 'app.js');
    if (none(f, 'webhook-raw-body-destroyed')) throw new Error('did not catch raw-body destruction');
  });

  t('result_code underscore → FAIL', () => {
    const f = scanText(`if (payload.result_code.startsWith("000")) fulfil();`, 'h.js');
    if (none(f, 'result-underscore-key')) throw new Error('missed result_code');
  });

  t('nested result.code access → WARN', () => {
    const f = scanText(`const ok = body.result.code === "000.000.000"; // webhook`, 'h.js');
    if (none(f, 'result-code-nested-access')) throw new Error('missed nested result.code');
  });

  t('amount * 100 → WARN', () => {
    const f = scanText(`const amount = Math.round(price * 100); // peach checkout`, 'pay.js');
    if (none(f, 'amount-in-minor-units')) throw new Error('missed cents conversion');
  });

  t('secret in frontend → FAIL', () => {
    const bad = `import {useState} from 'react';\nconst secretToken = "abc"; // clientSecret\nfetch('/api/oauth/token');`;
    const f = scanText(bad, 'Checkout.jsx');
    if (none(f, 'secret-in-frontend')) throw new Error('missed frontend secret');
  });

  t('hardcoded 3600 token TTL → WARN', () => {
    const f = scanText(`const token = await getToken('peachpayments'); cache.set(token, {expires_in: 3600});`, 'auth.js');
    if (none(f, 'token-expiry-hardcoded')) throw new Error('missed hardcoded TTL');
  });

  t('MIT debit with checkout token → WARN', () => {
    const bad = "fetch(`/v1/registrations/${id}/payments`, {headers:{Authorization:`Bearer ${checkoutToken}`}});";
    const f = scanText(bad, 'mit.js');
    if (none(f, 'mit-uses-checkout-token')) throw new Error('missed MIT token mixup');
  });

  t('fulfil without status confirm → WARN', () => {
    const bad = `app.post('/webhook',(req)=>{ shipOrder(req.body); });`;
    const f = scanText(bad, 'wh.js');
    if (none(f, 'fulfil-without-status-confirm')) throw new Error('missed fulfil-without-status');
  });

  t('webhook without signature verification → WARN', () => {
    const bad = `app.post('/notificationUrl', express.raw({type:'*/*'}), (req)=>{ const o = parse(req.body); save(o); });`;
    const f = scanText(bad, 'wh.js');
    if (none(f, 'missing-signature-verification')) throw new Error('missed missing-verification');
  });

  t('data/config file mentioning "webhook" in a comment (no handler) → NO missing-sig FP', () => {
    const ok = `// shared store used by the webhook route\nexport const seen = new Map();`;
    const f = scanText(ok, 'store.ts');
    if (has(f, 'missing-signature-verification')) throw new Error('false positive: non-handler file flagged for missing verification');
  });

  t('hardcoded live host, no env/sandbox → WARN', () => {
    const f = scanText(`const url = "https://secure.peachpayments.com/v2/checkout";`, 'cfg.js');
    if (none(f, 'live-host-hardcoded')) throw new Error('missed hardcoded live host');
  });

  t('live host WITH env switch → no live-host finding', () => {
    const ok = `const host = process.env.PEACH_HOST || "https://testsecure.peachpayments.com";`;
    const f = scanText(ok, 'cfg.js');
    if (has(f, 'live-host-hardcoded')) throw new Error('false positive on env-driven host');
  });

  // ── Regression selftests for adversarial review fixes ──

  // Fix 1a: webhook-raw-body-destroyed not suppressed by unrelated .text() in comments or resp.text()
  t('regression 1a: raw-body destroyed not suppressed by unrelated .text() comment → FAIL', () => {
    const bad = `
      app.use(express.json());
      // Note: inspect response using resp.text()
      app.post('/peach/webhook', (req, res) => {
        verify(req.body.signature);
      });
    `;
    const f = scanText(bad, 'app.js');
    if (none(f, 'webhook-raw-body-destroyed')) throw new Error('unrelated .text() comment wrongly suppressed raw-body destruction');
  });

  // Fix 1b: missing-signature-verification requires verification-shaped evidence, not bare x-webhook-signature with ===
  t('regression 1b: reading x-webhook-signature and comparing with === does not suppress → WARN', () => {
    const bad = `
      app.post('/webhook', express.raw({type: '*/*'}), (req, res) => {
        const sig = req.headers['x-webhook-signature'];
        if (sig === expectedSignature) {
          processOrder(req.body);
        }
      });
    `;
    const f = scanText(bad, 'wh.js');
    if (none(f, 'missing-signature-verification')) throw new Error('reading x-webhook-signature with === wrongly suppressed verification check');
  });

  // Fix 1c: fulfil-without-status-confirm requires actual HTTP status call, not bare /status in comment
  t('regression 1c: fulfil without status confirm not suppressed by /status in comment → WARN', () => {
    const bad = `
      app.post('/webhook', (req, res) => {
        // TODO: check /status endpoint before shipping
        shipOrder(req.body);
      });
    `;
    const f = scanText(bad, 'wh.js');
    if (none(f, 'fulfil-without-status-confirm')) throw new Error('comment with /status wrongly suppressed fulfilment check');
  });

  // Fix 1d: live-host-hardcoded not suppressed by unrelated non-adjacent process.env
  t('regression 1d: hardcoded live host not suppressed by unrelated non-adjacent process.env → WARN', () => {
    const bad = `
      const port = process.env.PORT || 3000;
      const db = process.env.DATABASE_URL;
      // 10 lines of other setup
      const url = "https://secure.peachpayments.com/v2/checkout";
    `;
    const f = scanText(bad, 'cfg.js');
    if (none(f, 'live-host-hardcoded')) throw new Error('unrelated process.env.PORT wrongly suppressed live host finding');
  });

  t('regression 1d-adjacent: hardcoded live host not suppressed by unrelated ADJACENT process.env → WARN', () => {
    const bad = `const PEACH_LIVE = 'https://secure.peachpayments.com';\nconst DB_URL = process.env.DATABASE_URL;`;
    const f = scanText(bad, 'cfg.js');
    if (none(f, 'live-host-hardcoded')) throw new Error('adjacent unrelated env wrongly suppressed live host finding');
  });

  t('live-host same-line env fallback → suppressed (no finding)', () => {
    const ok = `const host = process.env.MY_HOST || "https://secure.peachpayments.com";`;
    const f = scanText(ok, 'cfg.js');
    if (has(f, 'live-host-hardcoded')) throw new Error('same-line env-fallback idiom should be suppressed');
  });

  // Fix 2: secret-in-frontend catches public-prefixed env secrets in .ts and PEACH_SECRET_TOKEN with leading underscore
  t('regression 2: NEXT_PUBLIC secret in .ts and PEACH_SECRET_TOKEN with leading underscore → FAIL', () => {
    const f1 = scanText('export const secret = process.env.NEXT_PUBLIC_PEACH_SECRET_TOKEN;', 'config.ts');
    if (none(f1, 'secret-in-frontend')) throw new Error('missed NEXT_PUBLIC secret in plain ts file');
    const f2 = scanText('import {useState} from "react"; const token = PEACH_SECRET_TOKEN;', 'Checkout.tsx');
    if (none(f2, 'secret-in-frontend')) throw new Error('missed PEACH_SECRET_TOKEN with leading underscore in frontend component');
    // A plain client_secret in a browser-served directory (public/, static/, …) is still exposed.
    const f3 = scanText('window.CONFIG = { client_secret: "leaked_secret_value" };', 'public/config.js');
    if (none(f3, 'secret-in-frontend')) throw new Error('missed client_secret in a browser-served public/ file');
  });

  // Fix 3: result-code-nested-access catches generalized nested properties (result.description) and Python get chains
  t('regression 3: req.body.result.description in webhook and Python get chain → WARN', () => {
    const f1 = scanText('const desc = req.body.result.description; // webhook handler', 'wh.js');
    if (none(f1, 'result-code-nested-access')) throw new Error('missed nested result.description access');
    const f2 = scanText('code = payload.get("result", {}).get("code")', 'wh.py');
    if (none(f2, 'result-code-nested-access')) throw new Error('missed Python get chain on result');
  });

  // Fix 4: webhook classification recognizes /payment/notify routes (\bnotif)
  t('regression 4: /payment/notify route classified as webhook → WARN on missing verification', () => {
    const code = `
      app.post('/payment/notify', (req, res) => {
        fulfillOrder(req.body);
      });
    `;
    const f = scanText(code, 'routes.js');
    if (none(f, 'missing-signature-verification')) throw new Error('missed /payment/notify webhook route classification');
  });

  // Fix 5: amount-in-minor-units false-positive excluded on 2dp rounding Math.round(x * 100) / 100
  t('regression 5: Math.round(x * 100) / 100 2dp rounding does not flag amount-in-minor-units', () => {
    const code = 'const displayPrice = Math.round(price * 100) / 100;';
    const f = scanText(code, 'format.js');
    if (has(f, 'amount-in-minor-units')) throw new Error('false positive on 2dp rounding Math.round(x * 100) / 100');
  });

  // Fix 6: collectFiles scans distribution/ without wrongly skipping by substring
  t('regression 6: collectFiles scans distribution/ without skipping → scanned', () => {
    const os = require('os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'peach-test-'));
    try {
      const distDir = path.join(tmp, 'distribution');
      fs.mkdirSync(distDir, { recursive: true });
      const testFile = path.join(distDir, 'x.js');
      fs.writeFileSync(testFile, 'const x = 1;');
      const acc = [];
      collectFiles(tmp, acc);
      if (!acc.includes(testFile)) throw new Error('distribution/x.js was wrongly skipped');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // Fix 7: payouts-amount-not-cents catches decimal amounts in payouts context, ignores integer cents and pure checkout
  t('regression 7a: payouts amount as decimal string → WARN', () => {
    const bad = `
      const payout = await createPayout({
        payoutId: "pay_123",
        amount: "10.00",
      });
    `;
    const f = scanText(bad, 'payout.js');
    if (none(f, 'payouts-amount-not-cents')) throw new Error('missed decimal amount in payouts');
  });

  t('regression 7b: payouts amount with toFixed(2) → WARN', () => {
    const bad = `
      const amount = (10.5).toFixed(2);
      await api.post('/v1/payouts', { payoutId: 'p_1', amount });
    `;
    const f = scanText(bad, 'payout.js');
    if (none(f, 'payouts-amount-not-cents')) throw new Error('missed toFixed in payouts');
  });

  t('regression 7c: payouts amount as integer cents → no payouts-amount-not-cents finding', () => {
    const ok = `
      const payout = await createPayout({
        payoutId: "pay_123",
        amount: 1000, // R10.00 in integer cents
      });
    `;
    const f = scanText(ok, 'payout.js');
    if (has(f, 'payouts-amount-not-cents')) throw new Error('false positive on integer cents payout');
  });

  t('regression 7d: pure checkout with decimal string amount → no payouts-amount-not-cents finding', () => {
    const ok = `
      const checkout = await createCheckoutSession({
        amount: "10.00",
        currency: "ZAR",
      });
    `;
    const f = scanText(ok, 'checkout.js');
    if (has(f, 'payouts-amount-not-cents')) throw new Error('false positive on checkout decimal amount');
  });

  // Fix 8: webhook-unconditional-200 flags unverified 200 responses, ignores verified webhooks and handlers without 200
  t('regression 8a: webhook returning unconditional 200 without verification → WARN', () => {
    const bad = `
      app.post('/peach/webhook', (req, res) => {
        res.status(200).json({ received: true });
      });
    `;
    const f = scanText(bad, 'wh.js');
    if (none(f, 'webhook-unconditional-200')) throw new Error('missed unconditional 200 in webhook');
  });

  t('regression 8b: Next.js POST webhook returning unconditional 200 without verification → WARN', () => {
    const bad = `
      import { NextResponse } from 'next/server';
      // peach webhook handler
      export async function POST(req) {
        return NextResponse.json({ ok: true }, { status: 200 });
      }
    `;
    const f = scanText(bad, 'route.js');
    if (none(f, 'webhook-unconditional-200')) throw new Error('missed unconditional 200 in Next.js webhook');
  });

  t('regression 8c: webhook with signature verification returning 200 → no unconditional-200 finding', () => {
    const ok = `
      app.post('/peach/webhook', (req, res) => {
        const sig = req.headers['x-webhook-signature'];
        if (!verifyWebhook(req.body, sig)) return res.sendStatus(400);
        res.status(200).json({ received: true });
      });
    `;
    const f = scanText(ok, 'wh.js');
    if (has(f, 'webhook-unconditional-200')) throw new Error('false positive on verified webhook');
  });

  t('regression 8d: webhook handler without 200 response → no unconditional-200 finding', () => {
    const ok = `
      app.post('/peach/webhook', (req, res) => {
        saveEvent(req.body);
      });
    `;
    const f = scanText(ok, 'wh.js');
    if (has(f, 'webhook-unconditional-200')) throw new Error('false positive on webhook without 200 response');
  });

  t('regression 8e (FP): Python HMAC webhook (hmac.new/hashlib) → no unconditional-200 FP', () => {
    const ok = `
@app.route("/webhook", methods=["POST"])
def wh():
    sig = hmac.new(secret, request.get_data(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, hdr): return "", 400
    return "", 200
`;
    const f = scanText(ok, 'wh.py');
    if (has(f, 'webhook-unconditional-200')) throw new Error('false positive on Python HMAC-verified webhook');
  });

  t('regression 8f (FN): unverified webhook merely MENTIONING hmac/hashlib (no compare, no branch) → still WARN', () => {
    const bad = `import hashlib\napp.post('/webhook/hmac', (req, res) => { res.sendStatus(200); save(req.body); });`;
    const f = scanText(bad, 'wh.js');
    if (none(f, 'webhook-unconditional-200')) throw new Error('false NEGATIVE: vocabulary without verification shape must not suppress');
  });

  // Fix 9: sandbox-host-in-prod flags sandbox hosts with production markers, ignores non-prod sandbox config
  t('regression 9a: sandbox host literal alongside production marker → WARN', () => {
    const bad = `
      if (process.env.NODE_ENV === 'production') {
        const host = "https://testsecure.peachpayments.com";
      }
    `;
    const f = scanText(bad, 'cfg.js');
    if (none(f, 'sandbox-host-in-prod')) throw new Error('missed sandbox host in prod marker');
  });

  t('regression 9b: sandbox host in .env.production file → WARN', () => {
    const bad = `PEACH_AUTH_HOST=https://sandbox-dashboard.peachpayments.com`;
    const f = scanText(bad, '.env.production');
    if (none(f, 'sandbox-host-in-prod')) throw new Error('missed sandbox host in .env.production');
  });

  t('regression 9c: sandbox host in non-prod config → no sandbox-host-in-prod finding', () => {
    const ok = `
      const host = process.env.PEACH_HOST || "https://testsecure.peachpayments.com";
    `;
    const f = scanText(ok, 'cfg.js');
    if (has(f, 'sandbox-host-in-prod')) throw new Error('false positive on sandbox host in non-prod config');
  });

  t('regression 9d (FP): env-switch ternary (live vs sandbox on NODE_ENV) → no sandbox-host-in-prod FP', () => {
    const ok = `const host = process.env.NODE_ENV === "production" ? "https://secure.peachpayments.com" : "https://testsecure.peachpayments.com";`;
    const f = scanText(ok, 'cfg.js');
    if (has(f, 'sandbox-host-in-prod')) throw new Error('false positive on a correct env-switch (live present = a switch, not a mistake)');
  });

  // Fix 10: Rust / C# language coverage, result-underscore-key refinement, and PascalCase statusCallRe
  t('regression 10a: Rust module path use crate::result_code::ResultCode → no result-underscore-key finding', () => {
    const code = 'use crate::result_code::ResultCode;';
    const f = scanText(code, 'main.rs');
    if (has(f, 'result-underscore-key')) throw new Error('false positive on Rust module path');
  });

  t('regression 10b: Rust serde-renamed field → no result-underscore-key finding', () => {
    const code = '#[serde(rename = "result.code")] result_code: String,';
    const f = scanText(code, 'types.rs');
    if (has(f, 'result-underscore-key')) throw new Error('false positive on Rust serde-renamed field');
  });

  t('regression 10c: real footgun preserved payload["result_code"] → FAIL result-underscore-key', () => {
    const code = 'const ok = payload["result_code"] === "000.000.000";';
    const f = scanText(code, 'checkout.ts');
    if (none(f, 'result-underscore-key')) throw new Error('missed real footgun payload["result_code"]');
  });

  t('regression 10d: C# PascalCase status confirm suppresses fulfil-without-status-confirm', () => {
    const code = `
      // Peach webhook handler
      public async Task HandleWebhook(WebhookNotification notif) {
        await GetCheckoutStatusAsync(notif.Id);
        FulfilOrder(notif);
      }
    `;
    const f = scanText(code, 'WebhookHandler.cs');
    if (has(f, 'fulfil-without-status-confirm')) throw new Error('PascalCase GetCheckoutStatusAsync failed to suppress fulfil-without-status-confirm');
  });

  t('regression 10e: collectFiles includes .rs and .cs files', () => {
    const os = require('os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'peach-ext-test-'));
    try {
      const rsFile = path.join(tmp, 'lib.rs');
      const csFile = path.join(tmp, 'Service.cs');
      fs.writeFileSync(rsFile, 'const X: i32 = 1;');
      fs.writeFileSync(csFile, 'class Service {}');
      const acc = [];
      collectFiles(tmp, acc);
      if (!acc.includes(rsFile) || !acc.includes(csFile)) throw new Error('.rs or .cs files not collected');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // Fix 11: result-underscore-key round-2 hardening (comment stripping, dynamic vs static property access)
  t('regression 11a: Rust comment mentioning result_code (.rs, a // line) → NO result-underscore-key finding', () => {
    const code = '// serde maps the Rust field `result_code` to the real wire key "result.code"\nconst X: i32 = 1;';
    const f = scanText(code, 'handler.rs');
    if (has(f, 'result-underscore-key')) throw new Error('false positive on Rust comment line');
  });

  t('regression 11b: Rust field-access read resp.result_code in .rs file → NO finding', () => {
    const code = 'fn is_success(resp: &StatusResponse) -> bool { resp.result_code.starts_with("000.000") }';
    const f = scanText(code, 'handler.rs');
    if (has(f, 'result-underscore-key')) throw new Error('false positive on Rust field-access read');
  });

  t('regression 11c: Quoted key payload["result_code"] in .rs file → STILL FAIL', () => {
    const code = 'fn check(payload: &HashMap<String, String>) -> bool { payload["result_code"] == "000.000.000" }';
    const f = scanText(code, 'handler.rs');
    if (none(f, 'result-underscore-key')) throw new Error('missed quoted key footgun in .rs file');
  });

  t('regression 11d: Dynamic-lang property form req.body.result_code in .js file → STILL FAIL', () => {
    const code = 'const code = req.body.result_code;';
    const f = scanText(code, 'handler.js');
    if (none(f, 'result-underscore-key')) throw new Error('missed dynamic-lang property form footgun in .js file');
  });

  // ── adversarial review round (read-shape redesign): fire only on a payload key READ, not on token
  //    presence. The 5 false positives below were confirmed firing before the redesign. ──
  t('regression 12a (FP): snake_case local assigned from the CORRECT key → NO finding', () => {
    if (has(scanText('result_code = payload["result"]["code"]', 'h.py'), 'result-underscore-key')) throw new Error('FP on local var reading correct dotted key');
    if (has(scanText('const result_code = res.result.code;', 'h.js'), 'result-underscore-key')) throw new Error('FP on JS local var reading correct key');
  });
  t('regression 12b (FP): Django ORM column definition → NO finding', () => {
    const code = 'class Payment(models.Model):\n    result_code = models.CharField(max_length=3)';
    if (has(scanText(code, 'models.py'), 'result-underscore-key')) throw new Error('FP on ORM column definition');
  });
  t('regression 12c (FP): CSV/DB row["result_code"] (non-payload receiver) → NO finding', () => {
    if (has(scanText('var code = row["result_code"];', 'import.cs'), 'result-underscore-key')) throw new Error('FP on CSV/DB row access');
  });
  t('regression 12d (FP): test asserting the wrong key is ABSENT (node.get) → NO finding', () => {
    if (has(scanText('assertNull(node.get("result_code"));', 'PayTest.java'), 'result-underscore-key')) throw new Error('FP on defensive test assertion');
  });
  t('regression 12e (FP): SQL string naming own columns → NO finding', () => {
    if (has(scanText('cur.execute("SELECT result_code, result_description FROM payments")', 'db.py'), 'result-underscore-key')) throw new Error('FP on SQL column names');
  });
  t('regression 12f (FN): payload property read with a trailing comment word "use" → STILL FAIL', () => {
    // The pre-redesign suppressor tested the raw line incl. comments; the word "use" wrongly suppressed.
    const f = scanText('result_code = resp.result_code  # use int() later', 'h.py');
    if (none(f, 'result-underscore-key')) throw new Error('missed real footgun suppressed by comment word');
  });
  t('regression 12g: payload-producing call get_json()["result_code"] → STILL FAIL', () => {
    const f = scanText('code = request.get_json()["result_code"]', 'h.py');
    if (none(f, 'result-underscore-key')) throw new Error('missed get_json() payload-call read');
  });
  t('regression 12h (FN reduction): common webhook abbreviation evt.result_code → STILL FAIL', () => {
    const f = scanText('const code = evt.result_code;', 'wh.js');
    if (none(f, 'result-underscore-key')) throw new Error('missed evt.result_code webhook read');
  });

  // ── unauthenticated-money-endpoint ──
  t('unauthenticated-money-endpoint: money POST route, no auth in file → WARN', () => {
    const code = `
      const express = require('express');
      const app = express();
      app.post('/api/debits', (req, res) => {
        res.json({ ok: true });
      });
    `;
    const f = scanText(code, 'routes.js');
    if (none(f, 'unauthenticated-money-endpoint')) throw new Error('missed unauthenticated money endpoint');
    if (f.find(x => x.id === 'unauthenticated-money-endpoint').severity !== 'WARN') throw new Error('expected WARN severity');
  });

  t('unauthenticated-money-endpoint: token-exposing route with if(config.adminToken && …) bypass → WARN', () => {
    const code = `
      const express = require('express');
      const app = express();
      const config = { adminToken: process.env.TOKEN || '' };
      app.get('/relay/registrations', (req, res) => {
        if (config.adminToken && req.headers['x-admin-token'] !== config.adminToken) {
          return res.sendStatus(401);
        }
        res.json({ registrations: [] });
      });
    `;
    const f = scanText(code, 'relay.js');
    if (none(f, 'unauthenticated-money-endpoint')) throw new Error('missed bypass anti-pattern');
    const finding = f.find(x => x.id === 'unauthenticated-money-endpoint');
    if (!/no-ops when the secret is unset/i.test(finding.msg)) throw new Error('message should mention guard no-ops when secret is unset');
  });

  t('unauthenticated-money-endpoint: money route WITH requireAuth per-route arg → no finding', () => {
    const code = `
      const express = require('express');
      const app = express();
      app.post('/api/debits', requireAuth, (req, res) => {
        res.json({ ok: true });
      });
    `;
    const f = scanText(code, 'routes.js');
    if (has(f, 'unauthenticated-money-endpoint')) throw new Error('false positive on per-route auth guard');
  });

  t('unauthenticated-money-endpoint: money route in a file with app-level app.use(requireAuth) before the routes → no finding', () => {
    const code = `
      const express = require('express');
      const app = express();
      app.use(requireAuth);
      app.post('/api/debits', (req, res) => {
        res.json({ ok: true });
      });
    `;
    const f = scanText(code, 'routes.js');
    if (has(f, 'unauthenticated-money-endpoint')) throw new Error('false positive on app-level auth guard');
  });

  t('unauthenticated-money-endpoint: a webhook POST route (/webhook) that charges nothing → NO unauthenticated-money-endpoint finding (webhook exclusion)', () => {
    const code = `
      const express = require('express');
      const app = express();
      app.post('/webhook', (req, res) => {
        res.sendStatus(200);
      });
    `;
    const f = scanText(code, 'webhook.js');
    if (has(f, 'unauthenticated-money-endpoint')) throw new Error('false positive on webhook route');
  });

  // ── adversarial review round: closed auth-allowlist FPs on common idioms + a /disburse FN ──
  t('auth (FP): NestJS @UseGuards + @Post refunds → NO finding', () => {
    const code = '@UseGuards(AuthGuard)\n@Post("refunds")\nasync refund(@Body() b) { return this.svc.refundPayment(b.id, b.amount /* entityId */); }';
    if (has(scanText(code, 'refund.controller.ts'), 'unauthenticated-money-endpoint')) throw new Error('FP on NestJS @UseGuards');
  });
  t('auth (FP): Express custom middleware protect → NO finding', () => {
    const code = "router.post('/refund/:id', protect, async (req,res)=>{ await refundPayment(req.params.id, req.body.amount); res.json({ok:true}); });";
    if (has(scanText(code, 'routes.js'), 'unauthenticated-money-endpoint')) throw new Error('FP on protect middleware');
  });
  t('auth (FP): router.use(protect) app-level → NO finding', () => {
    const code = "router.use(protect);\nrouter.post('/refunds/:id', async (req,res)=>{ await refundPayment(req.params.id); res.json({ok:true}); });";
    if (has(scanText(code, 'routes.js'), 'unauthenticated-money-endpoint')) throw new Error('FP on router.use(protect)');
  });
  t('auth (FP): Spring @Secured + @PostMapping refunds → NO finding', () => {
    const code = '@Secured("ROLE_ADMIN")\n@PostMapping("/refunds")\npublic Refund refund() { return service.refundPayment(id); }';
    if (has(scanText(code, 'RefundCtrl.java'), 'unauthenticated-money-endpoint')) throw new Error('FP on Spring @Secured');
  });
  t('auth (FP): parameterized [Authorize(Policy=...)] + [HttpPost] refunds → NO finding', () => {
    const code = '[Authorize(Policy="Admin")]\n[HttpPost("/refunds")]\npublic IActionResult Refund() { return Ok(_svc.RefundPayment(id)); }';
    if (has(scanText(code, 'RefundController.cs'), 'unauthenticated-money-endpoint')) throw new Error('FP on parameterized [Authorize(...)]');
  });
  t('auth (FN): unauth /disburse payout route → WARN', () => {
    const code = "router.post('/disburse', (req,res)=>payout(req.body));";
    if (none(scanText(code, 'routes.js'), 'unauthenticated-money-endpoint')) throw new Error('missed /disburse unauth money endpoint');
  });
  t('auth (r2 FN): passport.initialize() boilerplate does NOT suppress an unauth payout route → WARN', () => {
    const code = "const passport = require('passport');\napp.use(passport.initialize());\nrouter.post('/payouts', async (req,res)=>{ await createPayout(req.body); res.json({ok:true}); });";
    if (none(scanText(code, 'app.js'), 'unauthenticated-money-endpoint')) throw new Error('passport plumbing wrongly suppressed an unauth money route');
  });
  t('auth (regression): real passport.authenticate guard → no finding', () => {
    const code = "app.use(passport.authenticate('jwt', {session:false}));\nrouter.post('/payouts', async (req,res)=>{ await createPayout(req.body); });";
    if (has(scanText(code, 'app.js'), 'unauthenticated-money-endpoint')) throw new Error('real passport.authenticate wrongly flagged');
  });
  t('auth (r2 FP): /withdraw-consent is not a money path → no finding', () => {
    const code = "router.post('/withdraw-consent', (req,res)=>{ savePrefs(req.body); res.json({ok:true}); });";
    if (has(scanText(code, 'routes.js'), 'unauthenticated-money-endpoint')) throw new Error('FP on /withdraw-consent (non-money hyphenated path)');
  });
  t('auth (r3): kebab money verb /withdraw-funds still fires → WARN', () => {
    const code = "router.post('/withdraw-funds', (req,res)=>payout(req.body));";
    if (none(scanText(code, 'routes.js'), 'unauthenticated-money-endpoint')) throw new Error('missed kebab money route /withdraw-funds');
  });

  // ── toctou-dedupe-ordering ──
  t('toctou: check→await→set on the same Set → WARN', () => {
    const bad = `
      const processed = new Set();
      async function handle(id) {
        if (processed.has(id)) return;
        const status = await getStatus(id);
        processed.add(id);
        fulfil(id);
      }
    `;
    const f = scanText(bad, 'wh.js');
    if (none(f, 'toctou-dedupe-ordering')) throw new Error('missed check→await→set TOCTOU race');
    if (f.find(x => x.id === 'toctou-dedupe-ordering').severity !== 'WARN') throw new Error('expected WARN severity');
  });

  t('toctou: claim-before-await (atomic) → no finding', () => {
    const ok = `
      const processed = new Set();
      async function handle(id) {
        if (processed.has(id)) return;
        processed.add(id);
        const status = await getStatus(id);
        fulfil(id);
      }
    `;
    const f = scanText(ok, 'wh.js');
    if (has(f, 'toctou-dedupe-ordering')) throw new Error('false positive on atomic claim-before-await');
  });

  t('toctou: a file that only does .has() with no .add()/.set() → no finding', () => {
    const ok = `
      const processed = new Set();
      async function handle(id) {
        if (processed.has(id)) return;
        const status = await getStatus(id);
      }
    `;
    const f = scanText(ok, 'wh.js');
    if (has(f, 'toctou-dedupe-ordering')) throw new Error('false positive on file with only .has()');
  });

  t('toctou: a file with .add() before any .has()/await → no finding', () => {
    const ok = `
      const processed = new Set();
      processed.add('seed');
      async function handle(id) {
        if (processed.has(id)) return;
        const status = await getStatus(id);
      }
    `;
    const f = scanText(ok, 'wh.js');
    if (has(f, 'toctou-dedupe-ordering')) throw new Error('false positive on .add() before any .has()/await');
  });

  // ── adversarial review round: cache-aside FP (blocker) + dedupe-form FNs; fixed by positive name gating ──
  t('toctou (FP): cache-aside memoization → NO finding', () => {
    const code = 'async function get(k){ if (cache.has(k)) return cache.get(k); const v = await load(k); cache.set(k, v); return v; }';
    if (has(scanText(code, 'cache.js'), 'toctou-dedupe-ordering')) throw new Error('FP on cache-aside memoization');
  });
  t('toctou (FP): OAuth token cache → NO finding', () => {
    const code = 'async function token(){ if (tokenCache.has("t")) return tokenCache.get("t"); const t = await fetchToken(); tokenCache.set("t", t); return t; }';
    if (has(scanText(code, 'auth.js'), 'toctou-dedupe-ordering')) throw new Error('FP on OAuth token cache');
  });
  t('toctou (FN): plain-object dedupe processedEvents[id] check→await→assign → WARN', () => {
    const code = 'async function wh(ev){\n  if (processedEvents[ev.id]) return;\n  await fulfil(ev);\n  processedEvents[ev.id] = true;\n}';
    if (none(scanText(code, 'wh.js'), 'toctou-dedupe-ordering')) throw new Error('missed plain-object dedupe race');
  });
  t('toctou (FN): Map.get truthiness gate seenIds.get→await→set → WARN', () => {
    const code = 'async function wh(ev){\n  if (seenIds.get(ev.id)) return;\n  await fulfil(ev);\n  seenIds.set(ev.id, true);\n}';
    if (none(scanText(code, 'wh.js'), 'toctou-dedupe-ordering')) throw new Error('missed Map.get dedupe race');
  });
  t('toctou (FN): array .includes gate + .push claim processedIds → WARN', () => {
    const code = 'async function wh(ev){\n  if (processedIds.includes(ev.id)) return;\n  await fulfil(ev);\n  processedIds.push(ev.id);\n}';
    if (none(scanText(code, 'wh.js'), 'toctou-dedupe-ordering')) throw new Error('missed array push dedupe race');
  });

  let passed = 0;
  for (const { name, fn } of tests) {
    try { fn(); console.log(`PASS  ${name}`); passed++; }
    catch (e) { console.log(`FAIL  ${name} — ${e.message}`); }
  }
  console.log(`\n${passed}/${tests.length} passed`);
  return passed === tests.length;
}

/* ─────────────────────────────── main ─────────────────────────────── */
function main() {
  const args = process.argv.slice(2);
  if (args[0] === 'selftest') { process.exit(runSelftest() ? 0 : 1); }
  if (!args.length) {
    console.log('Usage: node scripts/check-integration.js <file-or-dir>... | --stdin | selftest');
    process.exit(2);
  }
  let findings = [];
  if (args[0] === '--stdin') {
    const text = fs.readFileSync(0, 'utf8');
    findings = scanText(text, '<stdin>');
  } else {
    const files = [];
    for (const a of args) collectFiles(a, files);
    if (!files.length) { console.log('No code files found in: ' + args.join(', ')); process.exit(2); }
    for (const file of files) {
      let text; try { text = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
      findings = findings.concat(scanText(text, file));
    }
  }
  printReport(findings);
  process.exit(findings.some(f => f.severity === 'FAIL') ? 1 : 0);
}

if (require.main === module) main();
module.exports = { scanText, CHECKS };
