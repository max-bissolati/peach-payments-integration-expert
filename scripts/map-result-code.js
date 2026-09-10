#!/usr/bin/env node
"use strict"

/*
 * map-result-code.js — standalone, dependency-free Peach Payments result-code mapper.
 *
 * PROVENANCE
 *   Regex buckets ported EXACTLY from medusa-payment-peach-payments
 *   src/providers/peach/lib/result-codes.ts — production-verified and hardened
 *   (fail closed). Output vocabulary and terminology match
 *   references/result-codes.md: captured | review | pending | requires_more |
 *   canceled | error.
 *
 * VOCABULARY NOTE
 *   The plugin folds its SUCCESS_REVIEW band (000.400.0xx/100/110/120) into
 *   `captured`; this tool reports the reference doc's finer `review` status —
 *   money moved either way (`moneyMoved: true`), but gate fulfilment on review
 *   first. Every other mapping is behaviour-identical to the plugin, including:
 *     - 000.100.2xx (chargeback/reversal family) → error, NOT captured
 *     - 000.400.101/102 (intermediate 3DS-step codes) → error, NOT captured
 *     - 100.396.101/104 (cancelled/uncertain) → canceled, so late out-of-order
 *       webhooks never downgrade an already-authorised order
 *
 * HARDENING (ported verbatim — junk can never bucket as success)
 *   - ANY whitespace (leading/trailing/embedded, incl. "\n") → error
 *   - a real code is exactly ^\d{3}\.\d{3}\.\d{3}$ (end-anchored full-token
 *     match), so "000.000.000extra" → error; Payment Links/Payouts codes (4-digit
 *     first group) fail the 3-group shape check by design
 *   - missing/empty code → pending (per the plugin: no code is not yet an error)
 *
 * RUNTIME: Node >= 18, zero dependencies.
 *
 * EXIT CODES: 0 always once codes were mapped (even when every code maps to
 * error); 2 on usage errors.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Ported core — keep the regexes byte-identical to lib/result-codes.ts.
 * ──────────────────────────────────────────────────────────────────────────── */

// SUCCESS: 000.000.* (approved), 000.100.1* (successfully processed: NOT the
// 000.100.2xx chargeback/reversal family), 000.3xx/000.6xx (manual review /
// chargeback handling that still settles as captured for DB).
const SUCCESS = /^(000\.000\.|000\.100\.1|000\.[36])/
// SUCCESS_REVIEW (000.400.* band): the 000.400.0xx approvals (except 000.400.03x)
// plus ONLY 000.400.100 (review-success) and 000.400.110/120 (auth-success).
// Everything else in 000.400.1xx falls through to error — deliberately including
// 000.400.101 ("card not participating / authentication unavailable") and
// 000.400.102 ("user not enrolled"): intermediate 3DS-step codes, Rejected per
// Peach's docs; the debit's own terminal code decides capture. The third-segment
// class is digits-only ([0-24-9]): "000.400.0X" must never bucket as success.
const SUCCESS_REVIEW = /^(000\.400\.0[0-24-9]|000\.400\.100|000\.400\.1[12]0)/
const PENDING = /^(000\.200)/
const PENDING_EXTERNAL = /^(800\.400\.5|100\.400\.500)/
const REQUIRES_MORE = /^(300\.100\.100|900\.100\.[34])/
// 100.396.101 = cancelled by user, 100.396.104 = uncertain/probably-cancelled.
const CANCELLED = /^(100\.396\.101|100\.396\.104)/

// A real Peach/OPPWA result code is exactly three dot-separated 3-digit groups.
// Matching the FULL token means junk like "000.000.000extra" or a code with a
// trailing newline can never bucket as success.
const CODE_SHAPE = /^\d{3}\.\d{3}\.\d{3}$/

/** Bucket → status (reference vocabulary) + whether money moved. */
const BUCKET_STATUS = {
  SUCCESS: { status: "captured", moneyMoved: true },
  SUCCESS_REVIEW: { status: "review", moneyMoved: true },
  PENDING: { status: "pending", moneyMoved: false },
  PENDING_EXTERNAL: { status: "pending", moneyMoved: false },
  REQUIRES_MORE: { status: "requires_more", moneyMoved: false },
  CANCELLED: { status: "canceled", moneyMoved: false },
  CODE_SHAPE: { status: "error", moneyMoved: false }, // shape/whitespace rejection
  ERROR: { status: "error", moneyMoved: false }, // everything else — fail closed
  MISSING: { status: "pending", moneyMoved: false }, // plugin: no code yet ≠ error
}

/** Actionable hints for the error buckets integrators most often mis-map. */
function errorHint(code) {
  if (/^000\.100\.2/.test(code)) {
    return "Chargeback / reversal family (000.100.2xx) — NOT a successful capture; fail closed"
  }
  if (/^000\.400\.10[12]/.test(code)) {
    return "Intermediate 3DS-step code (authentication unavailable / user not enrolled), NOT success — the debit's own terminal code decides"
  }
  if (/^000\.400\.03/.test(code)) {
    return "Communication error band (000.400.03x) — often retryable"
  }
  return "Declined / error — fail closed; never map an unknown code to success (match the first two groups against the result-code list)"
}

/** Human explanation per bucket (terminology from references/result-codes.md). */
function explain(bucket, code) {
  switch (bucket) {
    case "SUCCESS":
      return "Successful — captured/authorised; fulfil after /status + amount check"
    case "SUCCESS_REVIEW":
      return "Successful, flagged for review — money moved; review (fraud/AVS/CVV suspicion) before fulfilment"
    case "PENDING":
      return "Pending, short-term — session open; ~30 min then timeout; a sandbox 3DS decline can also land here, discriminate via /status not the code alone"
    case "PENDING_EXTERNAL":
      return "Pending, delayed finalisation — non-instant methods (debit orders, async EFT) can take days; do NOT retry"
    case "REQUIRES_MORE":
      return "Requires shopper action — SCA soft-decline / timeout; retry through 3DS or challengeIndicator=04"
    case "CANCELLED":
      return "Cancelled by shopper / uncertain — map to canceled so late out-of-order webhooks never downgrade a confirmed order"
    case "MISSING":
      return "No result code present — treated as pending (not an error), per the plugin"
    case "CODE_SHAPE":
      return /\s/.test(code)
        ? "Contains whitespace — a padded or newline-suffixed code is not a real Peach code; fail closed to error"
        : "Not a Peach/OPPWA result code (expected ddd.ddd.ddd; Payment Links/Payouts use a 4-digit first group and fail this shape check by design); fail closed to error"
    default:
      return errorHint(code)
  }
}

/**
 * MerchantAdviceCode guidance hook (from /status resultDetails) — drive dunning
 * off this: references/result-codes.md, playbooks/failed-renewal-card-expiry.md.
 * Returns { merchantAdviceCode, guidance, retry } or null when unknown.
 */
const MERCHANT_ADVICE_GUIDANCE = {
  "01": "new account info — the card was updated; a retry is sensible",
  "02": "cannot approve now — retry later",
  "03": "do not try again — Dashboard docs: 'Retry is not allowed' (the API-reference gloss says 're-initiate'; when the two conflict, the stricter Dashboard table governs — treat 03 as terminal for this mandate)",
  "04": "do not try again — token requirements unfulfilled; kill the mandate",
}

function merchantAdviceGuidance(adviceCode) {
  const key = adviceCode == null ? "" : String(adviceCode).trim()
  if (!MERCHANT_ADVICE_GUIDANCE[key]) return null
  return { merchantAdviceCode: key, guidance: MERCHANT_ADVICE_GUIDANCE[key], retry: key === "01" || key === "02" }
}

/**
 * Full detail for one code:
 *   { code, status, bucket, moneyMoved, explanation, merchantAdvice? }
 * opts.merchantAdviceCode (optional) attaches MerchantAdviceCode guidance.
 */
function mapResultCodeDetailed(code, opts) {
  const c = code == null ? null : String(code)
  let bucket
  if (c === null || c === "") bucket = "MISSING"
  else if (/\s/.test(c) || !CODE_SHAPE.test(c)) bucket = "CODE_SHAPE"
  else if (SUCCESS.test(c)) bucket = "SUCCESS"
  else if (SUCCESS_REVIEW.test(c)) bucket = "SUCCESS_REVIEW"
  else if (PENDING.test(c)) bucket = "PENDING"
  else if (PENDING_EXTERNAL.test(c)) bucket = "PENDING_EXTERNAL"
  else if (REQUIRES_MORE.test(c)) bucket = "REQUIRES_MORE"
  else if (CANCELLED.test(c)) bucket = "CANCELLED"
  else bucket = "ERROR"
  const { status, moneyMoved } = BUCKET_STATUS[bucket]
  const detail = {
    code: c,
    status,
    bucket,
    moneyMoved,
    explanation: explain(bucket, c == null ? "" : c),
  }
  if (opts && opts.merchantAdviceCode != null && opts.merchantAdviceCode !== "") {
    const known = merchantAdviceGuidance(opts.merchantAdviceCode)
    detail.merchantAdvice =
      known || {
        merchantAdviceCode: String(opts.merchantAdviceCode),
        guidance: "unknown MerchantAdviceCode — look it up in /status resultDetails before automating retries",
        retry: null,
      }
  }
  return detail
}

/** The mapping: code → captured | review | pending | requires_more | canceled | error. */
function mapResultCode(code) {
  return mapResultCodeDetailed(code).status
}

/* ────────────────────────────────────────────────────────────────────────────
 * CLI
 * ──────────────────────────────────────────────────────────────────────────── */

const PROG = "map-result-code.js"

function usageError(msg) {
  console.error(`${PROG}: error: ${msg}`)
  console.error(`run '${PROG} --help' for usage`)
  process.exitCode = 2
}

function printHelp() {
  console.log(`${PROG} — Peach Payments result-code mapper (standalone, zero deps, Node >=18)

Provenance: buckets ported EXACTLY from medusa-payment-peach-payments
lib/result-codes.ts (production-verified, fail-closed). Terminology matches
references/result-codes.md.

STATUSES
  captured       money taken — fulfil after /status + amount check (000.000.*, 000.100.1*, 000.3xx, 000.6xx)
  review         money taken, flagged for review — gate fulfilment (000.400.0xx not 03x, .100, .110, .120)
  pending        session open (000.200.*) or delayed finalisation (800.400.5*, 100.400.500)
  requires_more  SCA soft-decline / timeout — shopper action needed (300.100.100, 900.100.3xx/4xx)
  canceled       cancelled/uncertain (100.396.101/104) — never downgrade a confirmed order
  error          everything else, fail closed (declines, 000.100.2xx chargebacks, 000.400.101/102, junk)

FAIL-CLOSED GUARANTEES (ported hardening): any whitespace (incl. a trailing
newline) → error; junk like "000.000.000extra" → error (end-anchored shape
check); a missing/empty code → pending (per the plugin, not an error).

USAGE
  ${PROG} <code> [<code>…]     map codes given as arguments
  ... | ${PROG}                map codes from stdin, one per line
  ${PROG} --json <code> …      machine output (detailed records)
  ${PROG} selftest             run the ported spec vectors (all must pass)
  ${PROG} --help

OUTPUT: one line per code: <code>\\t<status>\\t<human explanation>
(--json: {code, status, bucket, moneyMoved, explanation} per code)

EXIT CODES
  0  mapped (even when every code maps to error)
  2  usage or input error

EXAMPLES
  ${PROG} 000.100.110 000.400.101 000.100.201 100.396.104
  printf '000.000.000\\n800.100.150\\n' | ${PROG}
  ${PROG} --json 000.200.000`)
}

function parseArgv(argv) {
  const out = { json: false, help: false, command: undefined, codes: [], error: undefined }
  for (const a of argv) {
    if (a === "--help" || a === "-h") out.help = true
    else if (a === "--json") out.json = true
    else if (a.startsWith("--")) {
      out.error = `unknown flag '${a}' (supported: --json, --help)`
      break
    } else if (out.command === undefined && (a === "selftest" || a === "help")) out.command = a
    else out.codes.push(a)
  }
  return out
}

function readStdin() {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) return resolve("")
    let data = ""
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (chunk) => (data += chunk))
    process.stdin.on("end", () => resolve(data))
    process.stdin.on("error", reject)
  })
}

async function main(argv) {
  const parsed = parseArgv(argv)
  if (parsed.error) return usageError(parsed.error)
  if (parsed.help || parsed.command === "help") {
    printHelp()
    process.exitCode = 0
    return
  }
  if (parsed.command === "selftest") return runSelftest()

  let codes = parsed.codes
  if (codes.length === 0) {
    // A trailing newline SEPARATES lines on stdin; it is not part of a code.
    codes = (await readStdin()).split(/\r?\n/).filter((line) => line.length > 0)
    if (codes.length === 0) return usageError("no codes given — pass them as arguments or one per line on stdin")
  }
  const records = codes.map((raw) => mapResultCodeDetailed(raw))
  if (parsed.json) {
    console.log(JSON.stringify(records, null, 2))
  } else {
    for (const r of records) console.log(`${r.code == null ? "" : r.code}\t${r.status}\t${r.explanation}`)
  }
  process.exitCode = 0
}

/* ────────────────────────────────────────────────────────────────────────────
 * Selftest — vectors ported from the plugin spec
 * (src/providers/peach/__tests__/result-codes.unit.spec.ts), statuses expressed
 * in the reference vocabulary (SUCCESS_REVIEW band → review).
 * ──────────────────────────────────────────────────────────────────────────── */

// Full mapping-table snapshot from the spec: every REAL code must map identically
// to the (pre-hardening) plugin behaviour; only junk inputs may differ.
const SNAPSHOT = [
  ["000.000.000", "captured"], ["000.100.110", "captured"], ["000.100.112", "captured"],
  ["000.400.000", "review"], ["000.400.100", "review"], ["000.400.110", "review"], ["000.400.120", "review"],
  ["000.300.000", "captured"], ["000.600.000", "captured"],
  ["000.100.201", "error"], ["000.100.220", "error"], ["000.100.230", "error"],
  ["000.100.234", "error"], ["000.100.299", "error"],
  ["000.100.211", "error"], ["000.100.212", "error"], // "succeeded (amount != pre-auth)" outliers, held non-success by the fail-closed matcher
  ["000.400.101", "error"], ["000.400.102", "error"], ["000.400.103", "error"],
  ["000.400.104", "error"], ["000.400.107", "error"], ["000.400.121", "error"], ["000.400.199", "error"],
  ["100.390.100", "error"], ["100.390.121", "error"], ["100.390.124", "error"], // 3DS authentication-step rejections
  ["000.100.000", "error"],
  ["000.200.000", "pending"], ["000.200.100", "pending"], ["800.400.500", "pending"], ["100.400.500", "pending"],
  ["300.100.100", "requires_more"], ["900.100.300", "requires_more"], ["900.100.400", "requires_more"],
  ["100.396.101", "canceled"], ["100.396.104", "canceled"],
  ["800.100.100", "error"], ["800.100.150", "error"], ["800.120.100", "error"],
  ["600.200.500", "error"], ["999.999.999", "error"],
]

function runSelftest() {
  const tests = []
  const t = (name, fn) => tests.push({ name, fn })
  const eq = (got, want, label) => {
    if (got !== want) throw new Error(`${label || "value"}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  }

  t("bucket regexes are byte-identical to lib/result-codes.ts", () => {
    eq(SUCCESS.source, "^(000\\.000\\.|000\\.100\\.1|000\\.[36])", "SUCCESS")
    eq(SUCCESS_REVIEW.source, "^(000\\.400\\.0[0-24-9]|000\\.400\\.100|000\\.400\\.1[12]0)", "SUCCESS_REVIEW")
    eq(PENDING.source, "^(000\\.200)", "PENDING")
    eq(PENDING_EXTERNAL.source, "^(800\\.400\\.5|100\\.400\\.500)", "PENDING_EXTERNAL")
    eq(REQUIRES_MORE.source, "^(300\\.100\\.100|900\\.100\\.[34])", "REQUIRES_MORE")
    eq(CANCELLED.source, "^(100\\.396\\.101|100\\.396\\.104)", "CANCELLED")
    eq(CODE_SHAPE.source, "^\\d{3}\\.\\d{3}\\.\\d{3}$", "CODE_SHAPE")
  })

  t("success variants map to captured with moneyMoved", () => {
    for (const code of ["000.000.000", "000.100.110", "000.100.112", "000.300.000", "000.600.000"]) {
      const d = mapResultCodeDetailed(code)
      eq(d.status, "captured", code)
      eq(d.moneyMoved, true, `${code}.moneyMoved`)
    }
  })

  t("review band (000.400.0xx/100/110/120) maps to review — money moved", () => {
    for (const code of ["000.400.000", "000.400.100", "000.400.110", "000.400.120"]) {
      const d = mapResultCodeDetailed(code)
      eq(d.status, "review", code)
      eq(d.moneyMoved, true, `${code}.moneyMoved`)
    }
  })

  t("000.400.101/102 are error, NOT captured (3DS-step codes, fail closed)", () => {
    for (const code of ["000.400.101", "000.400.102"]) {
      const d = mapResultCodeDetailed(code)
      eq(d.status, "error", code)
      eq(d.moneyMoved, false, `${code}.moneyMoved`)
    }
  })

  t("chargeback 000.100.201 (and 220/230) is error, NOT captured", () => {
    for (const code of ["000.100.201", "000.100.220", "000.100.230"]) eq(mapResultCode(code), "error", code)
    if (!/chargeback/i.test(mapResultCodeDetailed("000.100.201").explanation)) {
      throw new Error("explanation should call out the chargeback family")
    }
  })

  t("000.100.000 stays error (000.100 narrowed to 000.100.1)", () => eq(mapResultCode("000.100.000"), "error"))

  t("rest of the 000.400.1xx band is error (103/104/107/121/199)", () => {
    for (const code of ["000.400.103", "000.400.104", "000.400.107", "000.400.121", "000.400.199"]) {
      eq(mapResultCode(code), "error", code)
    }
  })

  t("pending band 000.200.* maps to pending", () => {
    eq(mapResultCode("000.200.000"), "pending")
    eq(mapResultCode("000.200.100"), "pending")
  })

  t("external pending (800.400.5*, 100.400.500) maps to pending", () => {
    eq(mapResultCode("800.400.500"), "pending")
    eq(mapResultCode("100.400.500"), "pending")
    eq(mapResultCodeDetailed("100.400.500").bucket, "PENDING_EXTERNAL")
  })

  t("SCA / timeout codes map to requires_more", () => {
    for (const code of ["300.100.100", "900.100.300", "900.100.400"]) eq(mapResultCode(code), "requires_more", code)
  })

  t("both cancelled codes map to canceled (never downgrade)", () => {
    eq(mapResultCode("100.396.101"), "canceled")
    eq(mapResultCode("100.396.104"), "canceled")
  })

  t("declines and unknown codes map to error (fail closed)", () => {
    for (const code of ["800.100.100", "800.100.150", "800.120.100", "600.200.500", "999.999.999"]) {
      eq(mapResultCode(code), "error", code)
    }
  })

  t("full mapping-table snapshot (hardening must not move any real code)", () => {
    for (const [code, want] of SNAPSHOT) eq(mapResultCode(code), want, code)
  })

  t("junk input is NOT success (trailing junk / whitespace / non-digit class)", () => {
    for (const junk of ["000.000.000extra", " 000.000.000", "000.400.0X", "000.000.000\nanything"]) {
      eq(mapResultCode(junk), "error", JSON.stringify(junk))
    }
  })

  t("a trailing newline is whitespace → error, never success", () => {
    eq(mapResultCode("000.000.000\n"), "error")
    eq(mapResultCodeDetailed("000.000.000\n").bucket, "CODE_SHAPE")
  })

  t("missing/empty code → pending (per the plugin), not error", () => {
    eq(mapResultCode(undefined), "pending")
    eq(mapResultCode(null), "pending")
    eq(mapResultCode(""), "pending")
  })

  t("MerchantAdviceCode guidance hook (04 = never retry)", () => {
    eq(merchantAdviceGuidance("01").guidance, "new account info — the card was updated; a retry is sensible")
    eq(merchantAdviceGuidance("02").retry, true, "02.retry")
    eq(merchantAdviceGuidance("04").retry, false, "04.retry")
    eq(merchantAdviceGuidance("99"), null)
    const d = mapResultCodeDetailed("800.100.150", { merchantAdviceCode: "04" })
    if (!d.merchantAdvice || d.merchantAdvice.retry !== false) throw new Error("detailed must attach advice guidance")
  })

  let failed = 0
  for (const { name, fn } of tests) {
    try {
      fn()
      console.log(`PASS  ${name}`)
    } catch (e) {
      failed++
      console.log(`FAIL  ${name}`)
      console.log(`      ${e.message}`)
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`)
  process.exitCode = failed ? 1 : 0
}

/* ────────────────────────────────────────────────────────────────────────────
 * Entry point
 * ──────────────────────────────────────────────────────────────────────────── */

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`${PROG}: error: ${e && e.message ? e.message : e}`)
    process.exitCode = 2
  })
}

/* Public API so agents/tests can require() this file. */
module.exports = {
  mapResultCode,
  mapResultCodeDetailed,
  merchantAdviceGuidance,
  // the ported buckets
  SUCCESS,
  SUCCESS_REVIEW,
  PENDING,
  PENDING_EXTERNAL,
  REQUIRES_MORE,
  CANCELLED,
  CODE_SHAPE,
}
