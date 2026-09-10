#!/usr/bin/env node
"use strict"

/*
 * canonical-string.js — Scheme A (classic) canonical-string builder + fully signed
 * V1 refund body. Standalone, zero dependencies (builtin `crypto` only), Node >= 18.
 *
 * PROVENANCE
 *   Canonical construction ported from the verified plugin (medusa-payment-peach-
 *   payments lib/verify-webhook.ts — classicMessageFromParsed, proven to reproduce
 *   Peach's signature exactly against real sandbox webhooks). Refund request shape
 *   per references/checkout-v2.md § Refunds: POST /v1/checkout/refund takes
 *   application/x-www-form-urlencoded FLAT DOTTED keys — authentication.entityId,
 *   amount (2dp string), currency, id = the original payment's 32-hex transaction
 *   id (NOT the checkoutId), paymentType=RF, signature. Nested JSON bodies fail
 *   with 200.300.404.
 *
 * THE TWO #1 SIGNING BUGS THIS KILLS
 *   1. wrong concatenation — the canonical string is ALL params (INCLUDING
 *      empty-valued ones) sorted alphabetically by key and concatenated as
 *      key+value with NO separators (no `=`, no `&`); HMAC-SHA256 hex, the secret
 *      token used VERBATIM as the key (UTF-8 bytes, no hex decoding).
 *   2. nested-JSON refund bodies — Peach wants a flat form body; nested objects
 *      are flattened to bracket notation (`customParameters.x` →
 *      `customParameters[x]`) and the refund body is emitted URLSearchParams-ready.
 *
 * The secret is never printed: pass it via --secret or env PEACH_SECRET_TOKEN.
 *
 * EXIT CODES: 0 ok; 1 selftest failure; 2 usage or input error.
 */

const crypto = require("crypto")

/* ────────────────────────────────────────────────────────────────────────────
 * Ported core — keep behaviour-identical to lib/verify-webhook.ts.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Timing-safe string compare with a length guard (a hex digest's length is public). */
function timingSafeEqualStrings(a, b) {
  const ab = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

/** HMAC-SHA256 hex — the secret is used verbatim as the key (UTF-8, no hex decoding). */
function hmacSha256Hex(secretToken, message) {
  return crypto.createHmac("sha256", secretToken).update(message, "utf8").digest("hex")
}

/** Arrays → repeated keys (NOT String(array)); nested objects → bracket notation;
 *  null/undefined → "" (empty values ARE part of the signed string). */
function pushParam(key, v, out) {
  if (Array.isArray(v)) {
    for (const el of v) pushParam(key, el, out)
  } else if (v !== null && typeof v === "object") {
    flattenParams(v, key, out)
  } else {
    out.push([key, v == null ? "" : String(v)])
  }
}

function flattenParams(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj || {})) {
    pushParam(prefix ? `${prefix}[${k}]` : k, v, out)
  }
}

const byKey = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)

/** Validate input, drop `signature`, flatten, sort alphabetically. */
function canonicalEntries(params) {
  const entries = []
  const add = (k, v) => {
    if (k !== "signature") pushParam(k, v, entries)
  }
  if (Array.isArray(params)) {
    for (const pair of params) {
      if (!Array.isArray(pair) || pair.length !== 2) {
        throw new Error("canonical-string: array input must be [key, value] pairs")
      }
      add(String(pair[0]), pair[1])
    }
  } else if (params !== null && typeof params === "object") {
    for (const [k, v] of Object.entries(params)) add(k, v)
  } else {
    throw new Error("canonical-string: pass a plain object or an array of [key, value] pairs")
  }
  entries.sort(byKey)
  return entries
}

/**
 * The Scheme A canonical string: drop `signature`, flatten nested objects to
 * bracket notation, sort keys alphabetically, concatenate key+value with NO
 * separators — empty values included. Accepts a plain object or [[k, v], …]
 * pairs supporting repeated keys.
 */
function classicMessage(params) {
  return canonicalEntries(params)
    .map(([k, v]) => `${k}${v}`)
    .join("")
}

/** Numbers → 2dp string (5 → "5.00", 10.5 → "10.50"); strings pass through. */
function canonicalizeAmount(amount) {
  if (typeof amount === "number") {
    if (!Number.isFinite(amount)) {
      throw new Error("canonical-string: amount must be a finite number or a 'ddd.dd' string")
    }
    return amount.toFixed(2)
  }
  return amount == null ? "" : String(amount)
}

/** Flat dotted refund fields (no signature) — throws actionable errors when incomplete. */
function refundFields(input) {
  const { entityId, amount, currency, transactionId, id } = input || {}
  const missing = []
  if (entityId == null || entityId === "") missing.push("entityId (→ authentication.entityId)")
  if (amount === undefined || amount === null || amount === "") missing.push("amount (2dp string)")
  if (currency == null || currency === "") missing.push("currency")
  if (transactionId == null && id == null) {
    missing.push("transactionId (the original payment's 32-hex transaction id — NOT the checkoutId)")
  }
  if (missing.length) throw new Error(`canonical-string: missing required field(s): ${missing.join(", ")}`)
  return {
    "authentication.entityId": String(entityId),
    amount: canonicalizeAmount(amount),
    currency: String(currency),
    id: String(transactionId != null ? transactionId : id),
    paymentType: "RF",
  }
}

/**
 * Build a fully signed V1 refund body. Returns
 *   { body, canonical, signature }
 * where `body` is a flat dotted map (URLSearchParams-ready, incl. paymentType=RF
 * and the hex signature), `canonical` is the exact string that was signed, and
 * `signature` is its HMAC-SHA256 hex.
 */
function signRefund(input) {
  const { secretToken } = input || {}
  if (secretToken == null || secretToken === "") {
    throw new Error("canonical-string: secretToken is required (Checkout secret token, used verbatim as the HMAC key)")
  }
  const fields = refundFields(input)
  const canonical = classicMessage(fields)
  const signature = hmacSha256Hex(secretToken, canonical)
  return { body: { ...fields, signature }, canonical, signature }
}

/* ────────────────────────────────────────────────────────────────────────────
 * CLI
 * ──────────────────────────────────────────────────────────────────────────── */

const PROG = "canonical-string.js"

function usageError(msg) {
  console.error(`${PROG}: error: ${msg}`)
  console.error(`run '${PROG} --help' for usage`)
  process.exitCode = 2
}

function printHelp() {
  console.log(`${PROG} — Scheme A canonical string + signed V1 refund body (zero deps, Node >=18)

Provenance: canonical construction ported from the verified plugin
(medusa-payment-peach-payments lib/verify-webhook.ts — proven against real
sandbox webhooks); refund shape per references/checkout-v2.md § Refunds.

USAGE
  ${PROG} canonical < body.json
      Read a JSON object (or [[k,v],…] pairs) from stdin; print the Scheme A
      canonical string: drop 'signature', flatten nested objects to bracket
      notation (customParameters.x → customParameters[x]), sort keys
      alphabetically, concat key+value with NO separators, empty values included.

  ${PROG} refund-body [--sandbox] [--secret <token>] < body.json
      Read JSON {entityId, amount, currency, transactionId} from stdin; print
      the flat dotted form fields (k=v, incl. paymentType=RF and the hex
      signature), the canonical string that was signed, and a ready
      curl --data-urlencode block. Number amounts are canonicalised to a 2dp
      string. Lines starting with '# ' are comments. Secret: --secret or env
      PEACH_SECRET_TOKEN, never printed. --sandbox targets
      testapi.peachpayments.com (default: api.peachpayments.com).

  ${PROG} selftest        run the built-in vectors (all must pass)
  ${PROG} --help

API (require): classicMessage, signRefund, canonicalizeAmount, refundFields,
canonicalEntries, hmacSha256Hex, timingSafeEqualStrings.

EXIT CODES
  0  ok
  1  selftest failure
  2  usage or input error`)
}

function norm(k) {
  return k.toLowerCase().replace(/[^a-z0-9]/g, "")
}

const BOOL_FLAGS = new Set(["sandbox"])

/** Minimal flag parser: --flag value and --flag=value; --sandbox is boolean. */
function parseArgs(argv) {
  const out = { command: undefined, help: false, flags: {}, error: undefined }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--help" || a === "-h") {
      out.help = true
      continue
    }
    if (a.startsWith("--")) {
      let key = a.slice(2)
      let value
      const eq = key.indexOf("=")
      if (eq !== -1) {
        value = key.slice(eq + 1)
        key = key.slice(0, eq)
      } else if (BOOL_FLAGS.has(norm(key))) {
        value = true
      } else if (i + 1 < argv.length) {
        value = argv[++i]
      } else {
        out.error = `flag --${key} requires a value`
        return out
      }
      out.flags[norm(key)] = value
      continue
    }
    if (out.command === undefined) out.command = a
    else {
      out.error = `unexpected extra argument '${a}'`
      return out
    }
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

/** Trim ONE trailing newline (pipes/echo convenience). */
function stripTrailingNewline(s) {
  if (s.endsWith("\r\n")) return s.slice(0, -2)
  if (s.endsWith("\n")) return s.slice(0, -1)
  return s
}

async function cmdCanonical() {
  const raw = stripTrailingNewline(await readStdin())
  if (!raw) return usageError('empty stdin — pipe a JSON object (or [[k,v],…]) in, e.g. {"amount":"5.00","currency":"ZAR"}')
  let params
  try {
    params = JSON.parse(raw)
  } catch (e) {
    return usageError(`stdin is not valid JSON: ${e.message}`)
  }
  let message
  try {
    message = classicMessage(params)
  } catch (e) {
    return usageError(e.message)
  }
  console.log(message)
  process.exitCode = 0
}

async function cmdRefundBody(flags) {
  const secret = flags.secret !== undefined ? String(flags.secret) : process.env.PEACH_SECRET_TOKEN
  if (secret === undefined) return usageError("missing --secret <checkout secret token> (or env PEACH_SECRET_TOKEN)")
  if (secret === "") return usageError("--secret must be a non-empty string")
  const raw = stripTrailingNewline(await readStdin())
  if (!raw) return usageError("empty stdin — pipe JSON {entityId, amount, currency, transactionId} in")
  let input
  try {
    input = JSON.parse(raw)
  } catch (e) {
    return usageError(`stdin is not valid JSON: ${e.message}`)
  }
  let result
  try {
    result = signRefund({ ...input, secretToken: secret })
  } catch (e) {
    return usageError(e.message)
  }
  if (!/^\d+\.\d{2}$/.test(result.body.amount)) {
    console.error(
      `hint: amount '${result.body.amount}' is not a 2-decimal string (e.g. '5.00') — Peach expects 2dp; pass a number to canonicalise automatically`
    )
  }
  const endpoint = flags.sandbox
    ? "https://testapi.peachpayments.com/v1/checkout/refund"
    : "https://api.peachpayments.com/v1/checkout/refund"
  const keys = Object.keys(result.body).sort()
  console.log("# canonical (Scheme A — the exact string the signature signs):")
  console.log(`# ${result.canonical}`)
  console.log("# form fields (k=v):")
  for (const k of keys) console.log(`${k}=${result.body[k]}`)
  console.log("")
  console.log("# ready-to-paste (never includes your secret):")
  console.log(`curl -X POST '${endpoint}' \\`)
  console.log("  -H 'Content-Type: application/x-www-form-urlencoded' \\")
  console.log(keys.map((k) => `  --data-urlencode '${k}=${result.body[k]}'`).join(" \\\n"))
  process.exitCode = 0
}

/* ────────────────────────────────────────────────────────────────────────────
 * Selftest — canonical/refund vectors (synthetic fixture values).
 * ──────────────────────────────────────────────────────────────────────────── */

function runSelftest() {
  const SECRET = "test_secret_token_abc123"
  const tests = []
  const t = (name, fn) => tests.push({ name, fn })
  const eq = (got, want, label) => {
    if (got !== want) throw new Error(`${label || "value"}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  }
  const throws = (fn, label) => {
    try {
      fn()
    } catch (e) {
      return e
    }
    throw new Error(`${label || "fn"}: expected a throw`)
  }

  t("empty values are part of the canonical string", () => {
    eq(
      classicMessage({ amount: "5.00", merchantTransactionId: "", paymentType: "RF" }),
      "amount5.00merchantTransactionIdpaymentTypeRF"
    )
  })

  t("nested objects flatten to bracket notation (customParameters.x → customParameters[x])", () => {
    eq(classicMessage({ amount: "5.00", customParameters: { medusaSessionId: "payses_01J" } }),
      "amount5.00customParameters[medusaSessionId]payses_01J")
    eq(classicMessage({ a: { b: { c: "deep" } } }), "a[b][c]deep")
  })

  t("repeated keys emit one entry per value (pairs and array values)", () => {
    eq(classicMessage([["merchantTransactionId", "abc"], ["merchantTransactionId", "def"], ["amount", "1.00"]]),
      "amount1.00merchantTransactionIdabcmerchantTransactionIddef")
    eq(classicMessage({ merchantTransactionId: ["abc", "def"] }),
      "merchantTransactionIdabcmerchantTransactionIddef")
  })

  t("alphabetical order reproduces the documented refund example shape", () => {
    const fields = {
      paymentType: "RF",
      id: "8ac7a4c1755f8a8c0175600a1b2c3d4e",
      currency: "ZAR",
      "authentication.entityId": "8ac7a4c0749c4c8b01749f0a1d2e3f4a",
      amount: "5.00",
    }
    eq(classicMessage(fields),
      "amount5.00authentication.entityId8ac7a4c0749c4c8b01749f0a1d2e3f4acurrencyZARid8ac7a4c1755f8a8c0175600a1b2c3d4epaymentTypeRF")
  })

  t("dotted keys pass through unchanged and sort among flat keys", () => {
    eq(classicMessage({ "result.code": "000.100.110", amount: "1.00" }), "amount1.00result.code000.100.110")
  })

  t("the signature field is dropped before canonicalising", () => {
    eq(classicMessage({ amount: "1.00", signature: "f".repeat(64), currency: "ZAR" }),
      classicMessage({ amount: "1.00", currency: "ZAR" }))
  })

  t("number amounts canonicalise to a 2dp string in signRefund", () => {
    eq(signRefund({ entityId: "E", amount: 5, currency: "ZAR", transactionId: "T", secretToken: SECRET }).body.amount, "5.00")
    eq(signRefund({ entityId: "E", amount: 10.5, currency: "ZAR", transactionId: "T", secretToken: SECRET }).body.amount, "10.50")
    eq(signRefund({ entityId: "E", amount: "5.00", currency: "ZAR", transactionId: "T", secretToken: SECRET }).body.amount, "5.00")
  })

  t("refund body is flat, dotted-keyed, paymentType=RF, 64-hex signature (no nested JSON)", () => {
    const r = signRefund({
      entityId: "EID00TEST",
      amount: 5,
      currency: "ZAR",
      transactionId: "8ac7a4c1755f8a8c0175600a1b2c3d4e",
      secretToken: SECRET,
    })
    eq(Object.keys(r.body).sort().join(","), "amount,authentication.entityId,currency,id,paymentType,signature")
    for (const [k, v] of Object.entries(r.body)) {
      if (typeof v !== "string") throw new Error(`${k} must be a string (nested JSON fails with 200.300.404)`)
    }
    eq(r.body.paymentType, "RF")
    if (!/^[0-9a-f]{64}$/.test(r.body.signature)) throw new Error("signature must be 64 hex chars")
  })

  t("signature is the HMAC-SHA256 hex of the canonical string (timing-safe verified)", () => {
    const r = signRefund({ entityId: "E", amount: 5, currency: "ZAR", transactionId: "T", secretToken: SECRET })
    if (!timingSafeEqualStrings(r.signature, hmacSha256Hex(SECRET, r.canonical))) {
      throw new Error("signature does not verify against the canonical string")
    }
  })

  t("tampering the canonical string (or the secret) changes the signature", () => {
    const r = signRefund({ entityId: "E", amount: 5, currency: "ZAR", transactionId: "T", secretToken: SECRET })
    const tampered = r.canonical.replace("5.00", "9.00")
    if (tampered === r.canonical) throw new Error("tamper must change the message")
    eq(timingSafeEqualStrings(r.signature, hmacSha256Hex(SECRET, tampered)), false)
    eq(timingSafeEqualStrings(r.signature, hmacSha256Hex("wrong", r.canonical)), false)
  })

  t("round-trip: classicMessage(signed body) === canonical, incl. URLSearchParams encode/decode", () => {
    const r = signRefund({ entityId: "E", amount: 5, currency: "ZAR", transactionId: "T", secretToken: SECRET })
    eq(classicMessage(r.body), r.canonical)
    const encoded = new URLSearchParams(r.body).toString()
    eq(classicMessage(Object.fromEntries(new URLSearchParams(encoded).entries())), r.canonical,
      "URLSearchParams round-trip")
  })

  t("timing-safe helper semantics", () => {
    eq(timingSafeEqualStrings("abc", "abc"), true)
    eq(timingSafeEqualStrings("abc", "abd"), false)
    eq(timingSafeEqualStrings("abc", "abcd"), false)
  })

  t("incomplete/malformed input throws actionable errors", () => {
    if (!/entityId/.test(throws(() => signRefund({ amount: 5, currency: "ZAR", transactionId: "T", secretToken: SECRET })).message)) {
      throw new Error("missing entityId must be reported")
    }
    if (!/secretToken/.test(throws(() => signRefund({ entityId: "E", amount: 5, currency: "ZAR", transactionId: "T" })).message)) {
      throw new Error("missing secretToken must be reported")
    }
    if (!/transactionId/.test(throws(() => signRefund({ entityId: "E", amount: 5, currency: "ZAR", secretToken: SECRET })).message)) {
      throw new Error("missing transactionId must be reported")
    }
    throws(() => classicMessage("not-an-object"), "classicMessage(string)")
    throws(() => signRefund({ entityId: "E", amount: NaN, currency: "ZAR", transactionId: "T", secretToken: SECRET }), "NaN amount")
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

async function main(argv) {
  const parsed = parseArgs(argv)
  if (parsed.error) return usageError(parsed.error)
  if (parsed.help || parsed.command === "help") {
    printHelp()
    process.exitCode = 0
    return
  }
  switch (parsed.command) {
    case "canonical":
      return cmdCanonical()
    case "refund-body":
      return cmdRefundBody(parsed.flags)
    case "selftest":
      return runSelftest()
    default:
      return usageError(`missing/unknown command '${parsed.command || ""}' (expected canonical | refund-body | selftest) — see --help`)
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`${PROG}: error: ${e && e.message ? e.message : e}`)
    process.exitCode = 2
  })
}

/* Public API so agents/tests can require() this file. */
module.exports = {
  classicMessage,
  canonicalEntries,
  canonicalizeAmount,
  signRefund,
  refundFields,
  hmacSha256Hex,
  timingSafeEqualStrings,
}
