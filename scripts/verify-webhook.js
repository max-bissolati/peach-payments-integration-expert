#!/usr/bin/env node
"use strict"

/*
 * verify-webhook.js — standalone, dependency-free Peach Payments webhook signature verifier.
 *
 * PROVENANCE
 *   Ported from medusa-payment-peach-payments src/providers/peach/lib/verify-webhook.ts —
 *   adversarially verified (unit-tested in the plugin and proven against real sandbox
 *   webhooks). The reconstruction logic (parsed object → canonical string) reproduces
 *   Peach's `signature` field exactly. Terminology matches references/webhooks.md.
 *
 * SCHEMES
 *   Scheme A — classic body signature (Checkout HPP / Embedded; what Checkout V2 sends):
 *     body is `application/x-www-form-urlencoded` and the signature is a FIELD INSIDE the
 *     body (`signature=<64-hex>`). Canonical string = ALL other body parameters — including
 *     empty-valued ones — sorted alphabetically by key and concatenated as `key` + `value`
 *     with NO separators (no `=`, no `&`); HMAC-SHA256 hex keyed with the Checkout SECRET
 *     token. Example: `amount5.00authentication.entityId8ac7..currencyZARid8ac7..paymentTypeRF`
 *   Scheme B — header signing (Dashboard → Webhook security):
 *     canonical string = `${timestamp}.${webhookId}.${url}.${rawBody}`; HMAC-SHA256 hex
 *     keyed with the webhook shared secret; compared against the `x-webhook-signature`
 *     header. The URL is the webhook URL exactly as configured in the Dashboard.
 *
 *   REPLAY / FRESHNESS: a valid signature is NOT enough. A captured webhook with a valid
 *     signature replays forever unless you also reject stale timestamps. This tool's CLI
 *     enforces freshness on Scheme B (x-webhook-timestamp) by default (`--max-age 300`,
 *     reject outside ±300s); the core verify function below returns ONLY signature validity,
 *     so production code must run the freshness check (see isFresh) itself. The bundled
 *     examples (examples/*) already do.
 *
 *   NOTE: Payment Links bodies are JSON while Checkout bodies are form-urlencoded.
 *
 * RUNTIME: Node >= 18, zero dependencies (builtin `crypto` only).
 * The secret is used VERBATIM as the HMAC key (UTF-8 bytes of the string) — no hex
 * decoding — exactly like the plugin. The secret is never printed by this tool.
 *
 * EXIT CODES: 0 = signature valid; 1 = signature invalid (mismatch / missing / wrong
 * secret); 2 = usage or input error.
 */

const crypto = require("crypto")

/* ────────────────────────────────────────────────────────────────────────────
 * Ported core — keep behaviour-identical to lib/verify-webhook.ts.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Timing-safe string compare with a length guard (length leak is harmless: a
 *  hex/base64 digest's length is public). Returns false immediately on length mismatch. */
function timingSafeEqualStrings(a, b) {
  const ab = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

/**
 * Replay-freshness check — SEPARATE from signature validity, and just as load-bearing.
 * A valid signature over an OLD timestamp is still a replay: an attacker who captures one
 * delivery can resend it forever. Signature verification alone does NOT stop that. Scheme B
 * carries the send time in `x-webhook-timestamp` (epoch seconds); reject anything outside a
 * short window. Returns true when |now - ts| <= maxAgeSeconds (default 300s). A
 * non-numeric/absent timestamp is NOT fresh (fail closed). maxAgeSeconds <= 0 disables the
 * check (only for re-verifying an archived webhook offline). If you copy this file's logic
 * into production, copy THIS check too — the CLI enforces it, the core verify fn does not.
 */
function isFresh(timestampSeconds, maxAgeSeconds = 300, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (maxAgeSeconds <= 0) return true
  const ts = Number(timestampSeconds)
  if (!Number.isFinite(ts)) return false
  return Math.abs(nowSeconds - ts) <= maxAgeSeconds
}

/** Case-insensitive header lookup (values may be string | string[] | undefined). */
function header(headers, name) {
  const lower = String(name).toLowerCase()
  for (const key of Object.keys(headers || {})) {
    if (key.toLowerCase() === lower) {
      const v = headers[key]
      return Array.isArray(v) ? v[0] : v
    }
  }
  return undefined
}

/** True when the raw body carries a classic `signature=` form field. */
function hasBodySignature(rawBody) {
  return /(^|&)signature=/.test(rawBody || "")
}

/**
 * Scheme A canonical string from a RAW form-urlencoded body:
 * parse, drop `signature`, sort remaining params by key, concat `key`+`value` (no
 * separators). Empty-valued params are included (they ARE part of the signed string).
 */
function classicMessageFromRaw(rawBody) {
  const params = new URLSearchParams(rawBody || "")
  const entries = []
  for (const [k, v] of params.entries()) {
    if (k !== "signature") entries.push([k, v])
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return entries.map(([k, v]) => `${k}${v}`).join("")
}

/** Extract the `signature` field value from a raw form body (or null). */
function extractBodySignature(rawBody) {
  if (!hasBodySignature(rawBody)) return null
  const sig = new URLSearchParams(rawBody || "").get("signature")
  return sig || null
}

/**
 * Flatten a parsed body object back to form-urlencoded key names, so a nested
 * `customParameters: { medusaSessionId }` becomes `customParameters[medusaSessionId]` —
 * the exact key Peach signs. Dotted keys (`result.code`, `recon.authCode`) are already
 * flat and pass through unchanged. Arrays become repeated keys (one entry per element,
 * NOT String(array) which joins with commas). null/undefined become "".
 */
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
    const key = prefix ? `${prefix}[${k}]` : k
    pushParam(key, v, out)
  }
}

/** Scheme A canonical string from a PARSED body object (see pushParam above). */
function classicMessageFromParsed(data) {
  const entries = []
  for (const [k, v] of Object.entries(data || {})) {
    if (k === "signature") continue
    pushParam(k, v, entries)
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return entries.map(([k, v]) => `${k}${v}`).join("")
}

function hmacSha256Hex(secret, message) {
  return crypto.createHmac("sha256", secret).update(message, "utf8").digest("hex")
}

/**
 * Scheme A — classic body signature, raw body preserved.
 * Returns { valid, scheme?, reason? }.
 */
function verifyClassicRaw(secretToken, rawBody) {
  const signature = extractBodySignature(rawBody)
  if (!signature) {
    return { valid: false, reason: "missing_signature_field" }
  }
  const message = classicMessageFromRaw(rawBody)
  const hex = hmacSha256Hex(secretToken, message)
  if (timingSafeEqualStrings(hex, signature)) {
    return { valid: true, scheme: "classic-checkout(sorted-kv)" }
  }
  return { valid: false, reason: "signature_mismatch" }
}

/**
 * Scheme A — classic body signature when the raw body was NOT preserved (e.g. Medusa /
 * Express parsed the form body into an object and dropped the bytes): reconstruct the
 * canonical string from the parsed object and verify. PROVEN to reproduce Peach's
 * signature exactly against real sandbox webhooks.
 */
function verifyClassicFromParsed(secretToken, data) {
  const signature = data ? data["signature"] : undefined
  if (typeof signature !== "string" || !signature) {
    return { valid: false, reason: "missing_signature_field" }
  }
  const message = classicMessageFromParsed(data)
  const hex = hmacSha256Hex(secretToken, message)
  if (timingSafeEqualStrings(hex, signature)) {
    return { valid: true, scheme: "classic-checkout(parsed-kv)" }
  }
  return { valid: false, reason: "signature_mismatch" }
}

/**
 * Scheme B — header signing. Primary (documented) canonical is
 * `${timestamp}.${webhookId}.${url}.${rawBody}` with an HMAC-SHA256 hex signature. The
 * ported source also tries a 3-component variant (no URL) and base64 digests defensively,
 * and reports which construction matched.
 */
function verifyHeaderScheme(secretToken, opts) {
  const { sig, timestamp, webhookId, url, rawBody } = opts
  if (!sig) {
    return { valid: false, reason: "missing_signature" }
  }
  const ts = timestamp == null ? "" : String(timestamp)
  const id = webhookId == null ? "" : String(webhookId)
  const body = rawBody == null ? "" : String(rawBody)
  const candidates = {
    "ts.id.url.payload": `${ts}.${id}.${url == null ? "" : url}.${body}`,
    "ts.id.payload": `${ts}.${id}.${body}`,
  }
  for (const [scheme, message] of Object.entries(candidates)) {
    const hex = hmacSha256Hex(secretToken, message)
    if (timingSafeEqualStrings(hex, sig)) {
      return { valid: true, scheme }
    }
    const b64 = crypto.createHmac("sha256", secretToken).update(message, "utf8").digest("base64")
    if (timingSafeEqualStrings(b64, sig)) {
      return { valid: true, scheme: `${scheme}(base64)` }
    }
  }
  return { valid: false, reason: "signature_mismatch" }
}

/**
 * Verify a Peach webhook (ported cascade). Tries Scheme A on the raw body first, then
 * Scheme A on `parsedData` (when the raw bytes were consumed by a framework parser),
 * then Scheme B when an `x-webhook-signature` header is present.
 *
 * Fails CLOSED: with no secret nothing verifies — an unverifiable webhook must never
 * authorise or capture money.
 *
 * @param {object} opts
 *   secretToken?  {string} Checkout secret token (Scheme A) / webhook shared secret (B)
 *   headers       {object} Scheme B headers (x-webhook-signature/-timestamp/-id)
 *   rawBody       {string} the raw body exactly as received ("" if unavailable)
 *   url?          {string} webhook URL as configured in the Dashboard (Scheme B)
 *   parsedData?   {object} parsed body object (Scheme A reconstruction path)
 * @returns {{valid: boolean, scheme?: string, reason?: string}}
 */
function verifyPeachWebhook(opts) {
  const { secretToken, headers, rawBody, url, parsedData } = opts || {}

  if (!secretToken) {
    return { valid: false, reason: "no_secret_configured" }
  }

  // Scheme A, raw body preserved: the signature lives in the form-urlencoded body.
  const bodySigPresent = hasBodySignature(rawBody)
  if (bodySigPresent) {
    const classic = verifyClassicRaw(secretToken, rawBody)
    if (classic.valid) return classic
  }

  // Scheme A, raw body NOT preserved: reconstruct + verify from the parsed object.
  const parsedSigPresent =
    parsedData != null && typeof parsedData === "object" && typeof parsedData["signature"] === "string"
  if (parsedSigPresent) {
    const parsed = verifyClassicFromParsed(secretToken, parsedData)
    if (parsed.valid) return parsed
  }

  // Scheme B: signature in the x-webhook-signature header.
  const headerSig = header(headers, "x-webhook-signature")
  if (headerSig) {
    return verifyHeaderScheme(secretToken, {
      sig: headerSig,
      timestamp: header(headers, "x-webhook-timestamp"),
      webhookId: header(headers, "x-webhook-id"),
      url,
      rawBody,
    })
  }

  if (bodySigPresent || parsedSigPresent) {
    return { valid: false, reason: "signature_mismatch" }
  }
  return { valid: false, reason: "missing_signature" }
}

/** Verify with a FORCED scheme (CLI --scheme classic|header); `auto` = ported cascade. */
function verifyWithScheme(scheme, opts) {
  if (scheme === "classic") {
    if (!opts.secretToken) return { valid: false, reason: "no_secret_configured" }
    const bodySigPresent = hasBodySignature(opts.rawBody)
    const parsedSigPresent =
      opts.parsedData != null && typeof opts.parsedData === "object" && typeof opts.parsedData["signature"] === "string"
    if (bodySigPresent) {
      const r = verifyClassicRaw(opts.secretToken, opts.rawBody)
      if (r.valid) return r
    }
    if (parsedSigPresent) {
      const r = verifyClassicFromParsed(opts.secretToken, opts.parsedData)
      if (r.valid) return r
    }
    if (bodySigPresent || parsedSigPresent) return { valid: false, reason: "signature_mismatch" }
    return { valid: false, reason: "missing_signature" }
  }
  if (scheme === "header") {
    if (!opts.secretToken) return { valid: false, reason: "no_secret_configured" }
    const sig = header(opts.headers, "x-webhook-signature")
    if (!sig) return { valid: false, reason: "missing_signature" }
    return verifyHeaderScheme(opts.secretToken, {
      sig,
      timestamp: header(opts.headers, "x-webhook-timestamp"),
      webhookId: header(opts.headers, "x-webhook-id"),
      url: opts.url,
      rawBody: opts.rawBody,
    })
  }
  return verifyPeachWebhook(opts)
}

/* ────────────────────────────────────────────────────────────────────────────
 * CLI
 * ──────────────────────────────────────────────────────────────────────────── */

const PROG = "verify-webhook.js"

function usageError(msg) {
  console.error(`${PROG}: error: ${msg}`)
  console.error(`run '${PROG} --help' for usage`)
  process.exitCode = 2
}

function printHelp() {
  console.log(`${PROG} — Peach Payments webhook signature verifier (standalone, zero deps, Node >=18)

Provenance: ported from medusa-payment-peach-payments lib/verify-webhook.ts
(adversarially verified; reconstruction proven against real sandbox webhooks).

SCHEMES
  Scheme A — classic body signature (Checkout HPP/Embedded; the default for Checkout):
      body is application/x-www-form-urlencoded and the signature is a FIELD INSIDE
      the body. Canonical = all other params (INCLUDING empty values) sorted by key,
      concatenated key+value with no separators; HMAC-SHA256 hex with the Checkout
      SECRET token; timing-safe compare.
  Scheme B — header signing (Dashboard -> Webhook security):
      canonical = \`\${timestamp}.\${webhookId}.\${url}.\${rawBody}\`; HMAC-SHA256 hex
      with the webhook shared secret; compared to x-webhook-signature. The URL is the
      webhook URL exactly as configured in the Dashboard.
  NOTE: Payment Links bodies are JSON while Checkout bodies are form-urlencoded.

USAGE
  ${PROG} verify --secret <hex|text> [--scheme auto|classic|header] [options] < body
  ${PROG} reconstruct [--from-json '<json>'] < body
  ${PROG} parse < body
  ${PROG} selftest
  ${PROG} --help

OPTIONS
  --secret <value>       Checkout secret token (Scheme A) or webhook shared secret
                         (Scheme B). Used verbatim as the HMAC key (no hex decoding).
                         Empty secrets are rejected. Env: PEACH_WEBHOOK_SECRET
  --scheme <mode>        auto (default) | classic | header
  --sig <value>          Scheme B signature (x-webhook-signature).
                         Env: PEACH_WEBHOOK_SIG or PEACH_WEBHOOK_SIGNATURE
  --timestamp <value>    Scheme B x-webhook-timestamp. Env: PEACH_WEBHOOK_TIMESTAMP
  --webhook-id <value>   Scheme B x-webhook-id. Env: PEACH_WEBHOOK_ID
  --url <value>          Webhook URL as configured in the Dashboard (Scheme B).
                         Env: PEACH_WEBHOOK_URL
  --max-age <seconds>    Scheme B freshness window (default 300). A valid signature over a
                         timestamp older than this is treated as a REPLAY: the tool prints
                         STALE and exits 1. Pass 0 to disable (re-verifying archived webhooks).
                         Signature validity and freshness are separate checks — see isFresh.
  --from-json '<json>'   Verify/reconstruct from a PARSED object instead of raw stdin
                         (nested objects flatten to bracket notation, arrays become
                         repeated keys, 'signature' is dropped then verified).

STDIN: the raw webhook body, exactly as received. One trailing newline is trimmed
(pipes/echo convenience) — use printf '%s' for byte-exact input. If --from-json is
given, stdin is not read.

EXIT CODES
  0  signature valid
  1  signature invalid (mismatch / missing / wrong secret / bad format)
  2  usage or input error

EXAMPLES
  # Scheme A — verify a raw Checkout webhook body (auto-detects the body signature):
  printf '%s' "$BODY" | ${PROG} verify --secret "$PEACH_CHECKOUT_SECRET"

  # Scheme B — verify with header values (env or flags):
  printf '%s' "$BODY" | ${PROG} verify --secret "$SECRET" --scheme header \\
      --sig "$SIG" --timestamp "$TS" --webhook-id "$ID" \\
      --url "https://shop.example.com/hooks/peach"

  # Debug — print the exact Scheme A canonical string that gets signed:
  printf '%s' "$BODY" | ${PROG} reconstruct

  # The framework ate the raw body? Verify from the parsed object:
  ${PROG} verify --secret "$S" --from-json '{"amount":"5.00","customParameters":{"medusaSessionId":"payses_01J"},"signature":"<64-hex>"}'

  # What does the webhook actually contain?
  printf '%s' "$BODY" | ${PROG} parse

  # Built-in test vectors ported from the plugin spec (all must pass):
  ${PROG} selftest`)
}

/** Normalize a flag name so --webhook-id / --webhookId / --webhookid all match. */
function norm(k) {
  return k.toLowerCase().replace(/[^a-z0-9]/g, "")
}

/** Minimal flag parser: --flag value and --flag=value. Values are required. */
function parseArgs(argv) {
  const out = { command: undefined, help: false, flags: {} }
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

/** Resolve canonical flag names (kebab/camel/aliases). */
function readFlags(flags) {
  const get = (...names) => {
    for (const n of names) {
      const v = flags[norm(n)]
      if (v !== undefined) return v
    }
    return undefined
  }
  return {
    secret: get("secret"),
    scheme: get("scheme"),
    sig: get("sig", "signature"),
    timestamp: get("timestamp", "ts"),
    webhookId: get("webhook-id", "webhookid", "id"),
    url: get("url", "webhook-url", "webhookurl"),
    fromJson: get("from-json", "fromjson", "json"),
    maxAge: get("max-age", "maxage"),
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = ""
    if (process.stdin.isTTY) return resolve(data)
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (chunk) => (data += chunk))
    process.stdin.on("end", () => resolve(data))
    process.stdin.on("error", reject)
  })
}

/** Trim ONE trailing newline (pipes/echo convenience); bodies never end in newlines. */
function stripTrailingNewline(s) {
  if (s.endsWith("\r\n")) return s.slice(0, -2)
  if (s.endsWith("\n")) return s.slice(0, -1)
  return s
}

function looksLikeJson(s) {
  const t = (s || "").trim()
  return t.startsWith("{") || t.startsWith("[")
}

/** Pretty-print parsed form fields (repeated keys become arrays). */
function parseFormToObject(rawBody) {
  const params = new URLSearchParams(rawBody || "")
  const obj = {}
  for (const [k, v] of params.entries()) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) {
      if (Array.isArray(obj[k])) obj[k].push(v)
      else obj[k] = [obj[k], v]
    } else {
      obj[k] = v
    }
  }
  return obj
}

/** Actionable explanation per failure reason. Never includes secret material. */
function explainResult(result, providedSig) {
  const hints = {
    no_secret_configured:
      "no secret provided — pass --secret (Checkout secret token for Scheme A, webhook shared secret for Scheme B)",
    missing_signature_field:
      "the body has no 'signature' field — Scheme A bodies must contain signature=<hex>; if this is a Scheme B webhook pass --sig/--timestamp/--webhook-id/--url",
    missing_signature:
      "no signature found: no 'signature' body field (Scheme A) and no x-webhook-signature (Scheme B: pass --sig/--timestamp/--webhook-id/--url)",
    signature_mismatch:
      "recomputed HMAC-SHA256 does not match the provided signature (wrong secret, tampered body, or wrong canonicalisation — 'reconstruct' prints the Scheme A canonical string)",
    bad_signature_format:
      "the provided signature is not plausible hex/base64 (expected 64 hex chars, or ~88/44 base64 chars)",
  }
  let reason = result.reason || "unknown"
  if (reason === "signature_mismatch" && providedSig && !/^[A-Za-z0-9+/=_-]+$/.test(providedSig)) {
    reason = "bad_signature_format"
  }
  const line = result.valid
    ? `VALID — ${result.scheme}`
    : `INVALID — ${reason}: ${hints[reason] || "verification failed"}`
  return { line, reason }
}

async function cmdVerify(flags) {
  const { secret, scheme, sig, timestamp, webhookId, url, fromJson, maxAge: maxAgeRaw } = readFlags(flags)

  if (secret === undefined) return usageError("missing required --secret <checkout secret token / webhook shared secret>")
  if (secret === "") return usageError("--secret must be a non-empty string (empty secrets are rejected)")
  const mode = (scheme || "auto").toLowerCase()
  if (!["auto", "classic", "header"].includes(mode)) {
    return usageError(`--scheme must be auto|classic|header (got '${scheme}')`)
  }

  let parsedData
  let rawBody = ""
  if (fromJson !== undefined) {
    try {
      parsedData = JSON.parse(fromJson)
    } catch (e) {
      return usageError(`--from-json is not valid JSON: ${e.message}`)
    }
    if (parsedData === null || typeof parsedData !== "object" || Array.isArray(parsedData)) {
      return usageError("--from-json must be a JSON object (the parsed webhook body)")
    }
  } else {
    rawBody = stripTrailingNewline(await readStdin())
    if (!rawBody) {
      return usageError(
        "empty body on stdin — pipe the RAW webhook body in (printf '%s' \"$BODY\" | verify-webhook.js verify --secret ...), or use --from-json"
      )
    }
  }

  const headers = {}
  const sigVal = sig !== undefined ? sig.trim() : process.env.PEACH_WEBHOOK_SIG || process.env.PEACH_WEBHOOK_SIGNATURE
  const tsVal = timestamp !== undefined ? timestamp.trim() : process.env.PEACH_WEBHOOK_TIMESTAMP
  const idVal = webhookId !== undefined ? webhookId.trim() : process.env.PEACH_WEBHOOK_ID
  const urlVal = url !== undefined ? url.trim() : process.env.PEACH_WEBHOOK_URL
  if (sigVal) headers["x-webhook-signature"] = sigVal
  if (tsVal) headers["x-webhook-timestamp"] = tsVal
  if (idVal) headers["x-webhook-id"] = idVal

  if (mode === "header" && !headers["x-webhook-signature"]) {
    return usageError("--scheme header requires --sig <x-webhook-signature> (or env PEACH_WEBHOOK_SIG)")
  }

  const result = verifyWithScheme(mode, { secretToken: secret, headers, rawBody, url: urlVal, parsedData })
  const { line, reason } = explainResult(result, headers["x-webhook-signature"] || extractBodySignature(rawBody))

  console.log(line)
  if (result.valid) {
    // A valid signature over a stale timestamp is still a replay. Enforce freshness on
    // Scheme B by default (the examples do the same); signature validity alone is not enough.
    const isHeaderScheme = typeof result.scheme === "string" && result.scheme.startsWith("ts.")
    if (isHeaderScheme && tsVal) {
      const maxAge = maxAgeRaw === undefined ? 300 : Number(maxAgeRaw)
      if (!Number.isFinite(maxAge)) return usageError(`--max-age must be a number of seconds (got '${maxAgeRaw}')`)
      if (!isFresh(tsVal, maxAge)) {
        console.error(
          `STALE — the signature is valid but x-webhook-timestamp is outside the freshness window ` +
            `(--max-age ${maxAge}s): treat this as a REPLAY and reject it. Use --max-age 0 only to ` +
            `re-verify an archived webhook offline.`
        )
        process.exitCode = 1
        return
      }
    }
    process.exitCode = 0
    return
  }
  // Context-sensitive guidance for the most common real-world mixups.
  if ((reason === "missing_signature" || reason === "missing_signature_field") && looksLikeJson(rawBody)) {
    console.error(
      "hint: the body looks like JSON — Payment Links bodies are JSON while Checkout bodies are form-urlencoded; JSON (Payment Links) webhooks use Scheme B, so pass --sig/--timestamp/--webhook-id/--url"
    )
  }
  process.exitCode = 1
}

async function cmdReconstruct(flags) {
  const { fromJson } = readFlags(flags)
  let message
  if (fromJson !== undefined) {
    let data
    try {
      data = JSON.parse(fromJson)
    } catch (e) {
      return usageError(`--from-json is not valid JSON: ${e.message}`)
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return usageError("--from-json must be a JSON object (the parsed webhook body)")
    }
    message = classicMessageFromParsed(data)
  } else {
    const rawBody = stripTrailingNewline(await readStdin())
    if (!rawBody) return usageError("empty body on stdin — pipe the raw form-urlencoded webhook body in")
    message = classicMessageFromRaw(rawBody)
  }
  console.log(message)
  process.exitCode = 0
}

async function cmdParse() {
  const rawBody = stripTrailingNewline(await readStdin())
  if (!rawBody) return usageError("empty body on stdin — pipe the raw webhook body in")
  if (looksLikeJson(rawBody)) {
    let json
    try {
      json = JSON.parse(rawBody)
    } catch (e) {
      return usageError(`stdin looks like JSON but does not parse: ${e.message}`)
    }
    console.log(JSON.stringify(json, null, 2))
  } else {
    console.log(JSON.stringify(parseFormToObject(rawBody), null, 2))
  }
  process.exitCode = 0
}

/* ────────────────────────────────────────────────────────────────────────────
 * Selftest — fixtures ported from the plugin spec
 * (src/providers/peach/__tests__/verify-webhook.unit.spec.ts — synthetic values).
 * ──────────────────────────────────────────────────────────────────────────── */

function selftestFixtures() {
  return {
    SECRET: "test_secret_token_abc123",
    TS: "1718700000",
    ID: "wh_12345",
    HOOK_URL: "https://api.example.com/hooks/payment/peach_checkout",
    BODY: "result.code=000.000.000&merchantTransactionId=abcdef123456&amount=15000.00&customParameters%5BmedusaSessionId%5D=payses_01J",
  }
}

function runSelftest() {
  const { SECRET, TS, ID, HOOK_URL, BODY } = selftestFixtures()
  const sign = (message, encoding = "hex") =>
    crypto.createHmac("sha256", SECRET).update(message, "utf8").digest(encoding)
  const classicSign = (fields) => {
    const msg = Object.keys(fields)
      .sort()
      .map((k) => `${k}${fields[k]}`)
      .join("")
    return crypto.createHmac("sha256", SECRET).update(msg, "utf8").digest("hex")
  }

  const samplePayload = () => ({
    amount: "1400.00",
    "result.code": "000.100.110",
    checkoutId: "CHECKOUT00000000000000000000TEST",
    currency: "ZAR",
    customParameters: { medusaSessionId: "payses_01KVDRWBMY2Q6E7TA3XZP5QGJK" },
    paymentBrand: "VISA",
    "recon.authCode": "006887",
  })
  const parsedSign = (data) => {
    const entries = []
    for (const [k, v] of Object.entries(data)) {
      if (k === "signature") continue
      if (Array.isArray(v)) v.forEach((el) => entries.push([k, String(el)]))
      else if (v !== null && typeof v === "object") flattenParams(v, k, entries)
      else entries.push([k, v == null ? "" : String(v)])
    }
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    return sign(entries.map(([k, v]) => `${k}${v}`).join(""))
  }

  const tests = []
  const t = (name, fn) => tests.push({ name, fn })
  const check = (cond, msg) => {
    if (!cond) throw new Error(msg || "assertion failed")
  }

  // ── fail-closed behaviour ──
  t("fails closed when no secret is configured", () => {
    const r = verifyPeachWebhook({ headers: {}, rawBody: BODY })
    check(r.valid === false && r.reason === "no_secret_configured", `got ${JSON.stringify(r)}`)
  })
  t("fails with missing_signature when neither body field nor header is present", () => {
    const r = verifyPeachWebhook({ secretToken: SECRET, headers: {}, rawBody: BODY })
    check(r.valid === false && r.reason === "missing_signature", `got ${JSON.stringify(r)}`)
  })

  // ── Scheme A: classic raw body ──
  t("Scheme A: verifies classic body signature (empty params included in canonical)", () => {
    const fields = {
      amount: "5.00",
      "authentication.entityId": "ENTITY00TEST",
      currency: "ZAR",
      id: "TXN00000TEST",
      merchantTransactionId: "", // empty value MUST still be part of the signed string
      paymentType: "RF",
    }
    const params = new URLSearchParams(fields)
    params.set("signature", classicSign(fields))
    const r = verifyPeachWebhook({ secretToken: SECRET, headers: {}, rawBody: params.toString() })
    check(r.valid === true && String(r.scheme).includes("classic"), `got ${JSON.stringify(r)}`)
  })
  t("Scheme A: rejects a tampered body (amount inflated after signing)", () => {
    const fields = {
      amount: "5.00",
      "authentication.entityId": "ENTITY00TEST",
      currency: "ZAR",
      id: "TXN00000TEST",
      paymentType: "RF",
    }
    const params = new URLSearchParams(fields)
    params.set("signature", classicSign(fields))
    params.set("amount", "99999.00")
    const r = verifyPeachWebhook({ secretToken: SECRET, headers: {}, rawBody: params.toString() })
    check(r.valid === false && r.reason === "signature_mismatch", `got ${JSON.stringify(r)}`)
  })
  t("Scheme A: rejects a body signed with the wrong secret", () => {
    const fields = { amount: "5.00", currency: "ZAR", id: "x", paymentType: "RF" }
    const params = new URLSearchParams(fields)
    params.set(
      "signature",
      crypto.createHmac("sha256", "wrong").update(classicSign(fields)).digest("hex")
    )
    const r = verifyPeachWebhook({ secretToken: SECRET, headers: {}, rawBody: params.toString() })
    check(r.valid === false, `got ${JSON.stringify(r)}`)
  })
  t("Scheme A: canonical from raw body matches the hand-built canonical (drop signature, keep empties)", () => {
    const fields = { amount: "5.00", currency: "ZAR", id: "x", note: "", paymentType: "RF" }
    const params = new URLSearchParams(fields)
    params.set("signature", "deadbeef")
    const expected = Object.keys(fields)
      .sort()
      .map((k) => `${k}${fields[k]}`)
      .join("")
    check(classicMessageFromRaw(params.toString()) === expected, `got ${JSON.stringify(classicMessageFromRaw(params.toString()))}`)
  })

  // ── Scheme B: header signing ──
  t("Scheme B: verifies the documented 4-component scheme (ts.id.url.payload, hex)", () => {
    const sig = sign(`${TS}.${ID}.${HOOK_URL}.${BODY}`)
    const r = verifyPeachWebhook({
      secretToken: SECRET,
      headers: { "x-webhook-signature": sig, "x-webhook-timestamp": TS, "x-webhook-id": ID },
      rawBody: BODY,
      url: HOOK_URL,
    })
    check(r.valid === true && r.scheme === "ts.id.url.payload", `got ${JSON.stringify(r)}`)
  })
  t("Scheme B: verifies the 3-component scheme (ts.id.payload)", () => {
    const sig = sign(`${TS}.${ID}.${BODY}`)
    const r = verifyPeachWebhook({
      secretToken: SECRET,
      headers: { "x-webhook-signature": sig, "x-webhook-timestamp": TS, "x-webhook-id": ID },
      rawBody: BODY,
    })
    check(r.valid === true && r.scheme === "ts.id.payload", `got ${JSON.stringify(r)}`)
  })
  t("Scheme B: accepts a base64-encoded signature", () => {
    const sig = sign(`${TS}.${ID}.${HOOK_URL}.${BODY}`, "base64")
    const r = verifyPeachWebhook({
      secretToken: SECRET,
      headers: { "x-webhook-signature": sig, "x-webhook-timestamp": TS, "x-webhook-id": ID },
      rawBody: BODY,
      url: HOOK_URL,
    })
    check(r.valid === true && String(r.scheme).includes("base64"), `got ${JSON.stringify(r)}`)
  })
  t("Scheme B: rejects a tampered body (decline flipped to success)", () => {
    const sig = sign(`${TS}.${ID}.${HOOK_URL}.${BODY}`)
    const r = verifyPeachWebhook({
      secretToken: SECRET,
      headers: { "x-webhook-signature": sig, "x-webhook-timestamp": TS, "x-webhook-id": ID },
      rawBody: BODY.replace("000.000.000", "800.100.150"),
      url: HOOK_URL,
    })
    check(r.valid === false && r.reason === "signature_mismatch", `got ${JSON.stringify(r)}`)
  })
  t("Scheme B: rejects a wrong secret", () => {
    const sig = crypto.createHmac("sha256", "wrong").update(`${TS}.${ID}.${HOOK_URL}.${BODY}`).digest("hex")
    const r = verifyPeachWebhook({
      secretToken: SECRET,
      headers: { "x-webhook-signature": sig, "x-webhook-timestamp": TS, "x-webhook-id": ID },
      rawBody: BODY,
      url: HOOK_URL,
    })
    check(r.valid === false, `got ${JSON.stringify(r)}`)
  })
  t("Scheme B: header names are case-insensitive", () => {
    const sig = sign(`${TS}.${ID}.${HOOK_URL}.${BODY}`)
    const r = verifyPeachWebhook({
      secretToken: SECRET,
      headers: { "X-Webhook-Signature": sig, "X-Webhook-Timestamp": TS, "X-Webhook-Id": ID },
      rawBody: BODY,
      url: HOOK_URL,
    })
    check(r.valid === true, `got ${JSON.stringify(r)}`)
  })

  // ── Scheme A from a PARSED object (framework ate the raw body) ──
  t("Scheme A parsed: reconstructs the signature exactly (nested customParameters → bracket notation)", () => {
    const data = samplePayload()
    data.signature = parsedSign(data)
    const r = verifyPeachWebhook({ secretToken: SECRET, headers: {}, rawBody: "", parsedData: data })
    check(r.valid === true && r.scheme === "classic-checkout(parsed-kv)", `got ${JSON.stringify(r)}`)
  })
  t("Scheme A parsed: rejects a tampered amount", () => {
    const data = samplePayload()
    data.signature = parsedSign(data)
    data.amount = "1.00"
    const r = verifyPeachWebhook({ secretToken: SECRET, headers: {}, rawBody: "", parsedData: data })
    check(r.valid === false && r.reason === "signature_mismatch", `got ${JSON.stringify(r)}`)
  })
  t("Scheme A parsed: rejects a wrong secret", () => {
    const data = samplePayload()
    data.signature = parsedSign(data)
    const r = verifyPeachWebhook({ secretToken: "wrong", headers: {}, rawBody: "", parsedData: data })
    check(r.valid === false, `got ${JSON.stringify(r)}`)
  })
  t("Scheme A parsed: missing signature field → missing_signature overall", () => {
    const r = verifyPeachWebhook({ secretToken: SECRET, headers: {}, rawBody: "", parsedData: samplePayload() })
    check(r.valid === false && r.reason === "missing_signature", `got ${JSON.stringify(r)}`)
  })
  t("Scheme A parsed: arrays become repeated keys (per element, not String(array))", () => {
    const data = { amount: "10.00", tags: ["a", "b"], currency: "ZAR" }
    data.signature = parsedSign(data)
    const r = verifyPeachWebhook({ secretToken: SECRET, headers: {}, rawBody: "", parsedData: data })
    check(r.valid === true, `got ${JSON.stringify(r)}`)
  })
  t("Scheme A: raw-body canonical === parsed-object canonical for the same webhook", () => {
    const data = samplePayload()
    const flat = {
      amount: data.amount,
      "result.code": data["result.code"],
      checkoutId: data.checkoutId,
      currency: data.currency,
      "customParameters[medusaSessionId]": data.customParameters.medusaSessionId,
      paymentBrand: data.paymentBrand,
      "recon.authCode": data["recon.authCode"],
    }
    const sig = parsedSign(data)
    const rawParams = new URLSearchParams(flat)
    rawParams.set("signature", sig)
    check(
      classicMessageFromRaw(rawParams.toString()) === classicMessageFromParsed({ ...data, signature: sig }),
      "canonical strings diverge between raw and parsed paths"
    )
    check(verifyClassicRaw(SECRET, rawParams.toString()).valid === true, "raw verification failed")
  })

  // ── timing-safety / edge cases ──
  t("timing-safe compare: rejects a same-prefix different-length signature", () => {
    check(timingSafeEqualStrings("abc", "abc") === true, "equal strings must match")
    check(timingSafeEqualStrings("abc", "abd") === false, "equal-length mismatch must fail")
    check(timingSafeEqualStrings("abc", "abcd") === false, "length mismatch must fail")
  })
  t("empty/whitespace secret cannot verify (fail closed)", () => {
    const r = verifyPeachWebhook({ secretToken: "", headers: {}, rawBody: BODY })
    check(r.valid === false && r.reason === "no_secret_configured", `got ${JSON.stringify(r)}`)
  })
  t("freshness: recent ts fresh, stale ts rejected, maxAge<=0 disables, non-numeric fails closed", () => {
    const now = 1_700_000_000
    check(isFresh(now - 100, 300, now) === true, "a 100s-old timestamp must be fresh")
    check(isFresh(now - 3600, 300, now) === false, "a 1h-old timestamp must be stale (replay)")
    check(isFresh(now + 100, 300, now) === true, "small clock skew forward is tolerated")
    check(isFresh(now - 3600, 0, now) === true, "maxAge<=0 disables the freshness check")
    check(isFresh("not-a-number", 300, now) === false, "a non-numeric timestamp is not fresh")
    check(isFresh(undefined, 300, now) === false, "an absent timestamp is not fresh")
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
  const flags = parsed.flags
  const cmd = (parsed.command || "").toLowerCase()

  if (parsed.help && !cmd) {
    printHelp()
    process.exitCode = 0
    return
  }
  if (!cmd) {
    return usageError("missing command (verify | reconstruct | parse | selftest) — see --help")
  }
  switch (cmd) {
    case "verify":
      return cmdVerify(flags)
    case "reconstruct":
      return cmdReconstruct(flags)
    case "parse":
      return cmdParse()
    case "selftest":
      return runSelftest()
    case "help":
      printHelp()
      process.exitCode = 0
      return
    default:
      return usageError(`unknown command '${parsed.command}' (expected verify | reconstruct | parse | selftest)`)
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
  // ported core
  verifyPeachWebhook,
  verifyWithScheme,
  verifyClassicRaw,
  verifyClassicFromParsed,
  verifyHeaderScheme,
  classicMessageFromRaw,
  classicMessageFromParsed,
  extractBodySignature,
  hasBodySignature,
  parseFormToObject,
  timingSafeEqualStrings,
  isFresh,
  // CLI helpers / fixtures
  readFlags,
  selftestFixtures,
}
