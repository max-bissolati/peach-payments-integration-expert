#!/usr/bin/env node
"use strict"

/*
 * decode-result.js — Peach Payments result-code decoder and human-facing explainer.
 *
 * PROVENANCE
 *   Human-facing companion to scripts/map-result-code.js.
 *   Bucket classification is delegated directly to map-result-code.js (via require)
 *   to ensure the decoder NEVER disagrees with the production mapper.
 *   Categories and regex groups match references/result-codes.md.
 *   MerchantAdviceCode dunning guidance matches references/result-codes.md
 *   and playbooks/failed-renewal-card-expiry.md.
 *   Payload shape matches references/webhooks.md (flat dotted keys result.code etc.).
 *
 * FAIL CLOSED
 *   Any unknown, malformed, or missing code fails closed:
 *   "unknown code → treat as error, do not fulfil" (never imply success).
 *
 * RUNTIME: Node >= 18, zero dependencies.
 *
 * EXIT CODES:
 *   0 = mapped and decoded successfully;
 *   1 = selftest failure;
 *   2 = usage or input error.
 */

const path = require("path")
const {
  mapResultCode,
  mapResultCodeDetailed,
  merchantAdviceGuidance,
  PENDING_EXTERNAL,
  CODE_SHAPE,
} = require(path.join(__dirname, "map-result-code.js"))

// Verification endpoint reference: /v2/checkout/{id}/status
const STATUS_CONFIRM_ENDPOINT = "/v2/checkout/{id}/status"

/**
 * Documented groups from references/result-codes.md.
 * Evaluated in strict order; first matching regex assigns the family/category.
 */
const CATEGORY_GROUPS = [
  {
    name: "Chargebacks",
    regex: /^000\.100\.2/,
    meaning: "Chargeback / reversal family (000.100.2xx) — dispute, reversal, or refund in progress",
  },
  {
    name: "Soft decline",
    regex: /^300\.100\.100$/,
    meaning: "SCA / exemption refused by issuer — 3DS challenge required",
  },
  {
    name: "3DS authentication rejected",
    regex: /^100\.390\.1/,
    meaning: "3-D Secure authentication rejected by issuer (cardholder failed challenge or fraud suspicion)",
  },
  {
    name: "3DS / risk_m",
    regex: /^(000\.400\.[1][0-9][1-9]|000\.400\.2)/,
    meaning: "3DS-step or risk rejection (intermediate 3DS code; NOT a capture — debit terminal code decides)",
  },
  {
    name: "Pending, short-term",
    regex: /^000\.200/,
    meaning: "Transaction pending (session open; ~30 min timeout; sandbox 3DS decline can also land here)",
  },
  {
    name: "Pending, delayed finalisation",
    regex: /^(800\.400\.5|100\.400\.500)/,
    meaning: "Pending delayed finalisation — non-instant method (debit orders, async EFT); can take days",
  },
  {
    name: "Successful, flagged for review",
    regex: /^(000\.400\.0[0-24-9]|000\.400\.100|000\.400\.1[12]0)/,
    meaning: "Successful, flagged for review — money moved; review (fraud/AVS/CVV suspicion) before fulfilment",
  },
  {
    name: "Successful",
    regex: /^(000\.000\.|000\.100\.1|000\.[36])/,
    meaning: "Transaction succeeded / captured — money moved; fulfil order after /status check",
  },
  {
    name: "Async workflow",
    regex: /^100\.39[765]/,
    meaning: "Async workflow / user cancelled payment session",
  },
  {
    name: "Communication error",
    regex: /^(900\.[1234]00|000\.400\.030)/,
    meaning: "Communication error or network timeout — often retryable",
  },
  {
    name: "External payment system",
    regex: /^(800\.[17]00|800\.800\.[123])/,
    meaning: "External PSP or bank authorisation decline",
  },
  {
    name: "System error",
    regex: /^(800\.[56]|999\.|600\.1|800\.800\.[84])/,
    meaning: "System or configuration error — investigate backend configuration",
  },
  {
    name: "MAC/signature",
    regex: /^(700\.600|700\.601)/,
    meaning: "MAC / signature verification error — request signature does not match secret token",
  },
  {
    name: "Format validation",
    regex: /^(200\.[123]|100\.[53][07]|800\.900|100\.[69]00\.500)/,
    meaning: "Format validation error — request shape or parameter syntax is invalid",
  },
  {
    name: "Amount validation",
    regex: /^100\.55/,
    meaning: "Amount validation error — amount exceeds capturable limit or currency mismatch",
  },
]

/**
 * Curated codes from references/result-codes.md ("Codes worth memorizing" and core behaviors).
 */
const KNOWN_CODES = {
  "000.000.000": {
    meaning: "Transaction succeeded / successfully processed",
    refund: "Refundable via POST /v1/checkout/refund using the transaction id (not checkoutId).",
  },
  "000.100.110": {
    meaning: "Transaction succeeded (sandbox Integrator Test Mode)",
    refund: "Refundable via POST /v1/checkout/refund using the transaction id in sandbox.",
  },
  "000.100.112": {
    meaning: "Transaction succeeded (sandbox test mode)",
    refund: "Refundable via POST /v1/checkout/refund using the transaction id in sandbox.",
  },
  "000.400.000": {
    meaning: "Transaction succeeded, flagged for review",
    refund: "Refundable via POST /v1/checkout/refund if review fails or order is canceled.",
  },
  "000.400.100": {
    meaning: "Transaction succeeded, review required (risk/scoring check)",
    refund: "Refundable via POST /v1/checkout/refund if merchant review declines the transaction.",
  },
  "000.400.110": {
    meaning: "Transaction succeeded, authorisation review required",
    refund: "Refundable via POST /v1/checkout/refund if review fails.",
  },
  "000.400.120": {
    meaning: "Transaction succeeded, authorisation review required",
    refund: "Refundable via POST /v1/checkout/refund if review fails.",
  },
  "000.400.101": {
    meaning: "Card not participating / 3DS authentication unavailable (intermediate 3DS-step code; NOT a capture)",
    action: "do not fulfil",
    actionDetail: "do not fulfil (fail closed; intermediate 3DS-step code — debit terminal code decides)",
    retryable: "no (intermediate 3DS-step code — wait for terminal debit status)",
    refund: "Not applicable (intermediate 3DS code; no money captured).",
  },
  "000.400.102": {
    meaning: "User not enrolled in 3DS (intermediate 3DS-step code; NOT a capture)",
    action: "do not fulfil",
    actionDetail: "do not fulfil (fail closed; intermediate 3DS-step code — debit terminal code decides)",
    retryable: "no (intermediate 3DS-step code — wait for terminal debit status)",
    refund: "Not applicable (intermediate 3DS code; no money captured).",
  },
  "000.400.103": {
    meaning: "3DS technical error or invalid response from directory server",
    action: "do not fulfil",
    retryable: "no (technical error in 3DS flow)",
    refund: "Not applicable (no money captured).",
  },
  "000.400.104": {
    meaning: "3DS system error during authentication",
    action: "do not fulfil",
    retryable: "conditional (retry authentication after system issue resolves)",
    refund: "Not applicable (no money captured).",
  },
  "000.400.107": {
    meaning: "3DS signature validation failed",
    action: "do not fulfil",
    retryable: "no (signature mismatch)",
    refund: "Not applicable (no money captured).",
  },
  "000.400.109": {
    meaning: "Card not 3DS2-enrolled (sandbox unlisted card)",
    action: "do not fulfil",
    actionDetail: "do not fulfil (sandbox unlisted card — use documented test card numbers)",
    retryable: "yes (retry with a listed sandbox test card)",
    refund: "Not applicable (no money captured).",
  },
  "000.400.121": {
    meaning: "3DS amount or currency check failed",
    action: "do not fulfil",
    retryable: "no (amount/currency mismatch in 3DS payload)",
    refund: "Not applicable (no money captured).",
  },
  "000.400.199": {
    meaning: "3DS internal system failure",
    action: "do not fulfil",
    retryable: "conditional (retry after system recovery)",
    refund: "Not applicable (no money captured).",
  },
  "000.400.030": {
    meaning: "Communication error with external risk provider",
    action: "do not fulfil",
    retryable: "yes (network/timeout with risk provider — retryable)",
    refund: "Not applicable (no money captured).",
  },
  "000.100.000": {
    meaning: "Transaction status unknown or generic processing error",
    action: "do not fulfil",
    retryable: "no (unverified status — fail closed)",
    refund: "Not applicable (unverified status).",
  },
  "000.100.201": {
    meaning: "Chargeback / reversal initiated (dispute)",
    action: "do not fulfil",
    retryable: "no (chargeback initiated)",
    refund: "Money already disputed / reversed — do NOT issue a merchant refund (causes double loss).",
  },
  "000.100.211": {
    meaning: "Transaction succeeded, amount differs from pre-authorisation (held non-success by fail-closed mapper)",
    action: "do not fulfil",
    actionDetail: "do not fulfil automatically (held in error by fail-closed mapper; reconcile via /status)",
    retryable: "no (reconcile capture amount via /status)",
    refund: "Reconcile via GET /v2/checkout/{id}/status before attempting refund.",
  },
  "000.100.212": {
    meaning: "Transaction succeeded, amount differs from pre-authorisation (held non-success by fail-closed mapper)",
    action: "do not fulfil",
    actionDetail: "do not fulfil automatically (held in error by fail-closed mapper; reconcile via /status)",
    retryable: "no (reconcile capture amount via /status)",
    refund: "Reconcile via GET /v2/checkout/{id}/status before attempting refund.",
  },
  "000.100.220": {
    meaning: "Transaction reversal in progress",
    action: "do not fulfil",
    retryable: "no (reversal in progress)",
    refund: "Money is being reversed — do NOT issue an additional merchant refund.",
  },
  "000.100.226": {
    meaning: "Chargeback / reversal family (reversal, refund, or dispute)",
    action: "do not fulfil",
    actionDetail: "do not fulfil (chargeback/reversal family; fail closed)",
    retryable: "no (chargeback / reversal)",
    refund: "Money already disputed or reversed — do NOT issue a merchant refund (causes double loss).",
  },
  "000.100.230": {
    meaning: "Transaction disputed by cardholder",
    action: "do not fulfil",
    retryable: "no (dispute opened)",
    refund: "Transaction disputed — do NOT issue a refund; respond through dispute management.",
  },
  "000.100.234": {
    meaning: "Chargeback notification received",
    action: "do not fulfil",
    retryable: "no (chargeback received)",
    refund: "Chargeback received — do NOT issue a refund.",
  },
  "000.100.299": {
    meaning: "Chargeback / reversal generic outcome",
    action: "do not fulfil",
    retryable: "no (chargeback family)",
    refund: "Chargeback family — do NOT issue a refund.",
  },
  "000.200.000": {
    meaning: "Transaction pending (session open, ~30 min timeout; sandbox 3DS decline can also land here)",
    action: "poll-wait",
    actionDetail: "poll-wait (session open; poll /status or wait for webhook; in sandbox discriminate via /status)",
    retryable: "no (session in progress; do not create duplicate debit)",
    refund: "Not applicable (session open; no money captured).",
  },
  "000.200.100": {
    meaning: "Transaction created (waiting for shopper to complete payment)",
    action: "poll-wait",
    actionDetail: "poll-wait (waiting for shopper action; do not fulfil)",
    retryable: "no (session created; wait for shopper completion)",
    refund: "Not applicable (not yet paid).",
  },
  "000.200.201": {
    meaning: "Checkout QR code or payment link opened by shopper",
    action: "poll-wait",
    actionDetail: "poll-wait (shopper viewing checkout; do not fulfil)",
    retryable: "no (session active)",
    refund: "Not applicable (not yet paid).",
  },
  "800.400.500": {
    meaning: "Pending delayed finalisation (non-instant method: debit orders, async EFT; can take days)",
    action: "poll-wait",
    actionDetail: "poll-wait (delayed finalisation; can take days — do NOT retry)",
    retryable: "no (delayed finalisation — retrying may cause duplicate debit)",
    refund: "Not applicable (pending settlement).",
  },
  "100.400.500": {
    meaning: "Pending delayed finalisation (waiting for external settlement confirmation)",
    action: "poll-wait",
    actionDetail: "poll-wait (waiting for external confirmation — do NOT retry)",
    retryable: "no (delayed finalisation — do NOT retry)",
    refund: "Not applicable (pending settlement).",
  },
  "300.100.100": {
    meaning: "Soft decline: SCA / exemption refused by issuer — 3DS challenge required",
    action: "re-auth via 3DS",
    actionDetail: "re-auth via 3DS (shopper action needed: retry through 3DS or challengeIndicator=04)",
    retryable: "yes (re-authenticate through 3DS challenge)",
    refund: "Not applicable (soft decline; no money captured).",
  },
  "900.100.300": {
    meaning: "Communication timeout with processor or SCA challenge timeout",
    action: "re-auth via 3DS",
    actionDetail: "re-auth via 3DS (SCA timeout — prompt shopper to complete authentication)",
    retryable: "yes (shopper may retry authentication)",
    refund: "Not applicable (timed out; no money captured).",
  },
  "900.100.400": {
    meaning: "Communication timeout or SCA challenge expired",
    action: "re-auth via 3DS",
    actionDetail: "re-auth via 3DS (SCA challenge expired — prompt shopper to retry)",
    retryable: "yes (shopper may retry authentication)",
    refund: "Not applicable (timed out; no money captured).",
  },
  "100.390.100": {
    meaning: "3-D Secure authentication rejected by issuer (failed challenge or fraud suspicion)",
    action: "do not fulfil",
    actionDetail: "do not fulfil (3DS authentication failed; decline)",
    retryable: "yes (shopper should retry or use another payment method)",
    refund: "Not applicable (authentication rejected; no money captured).",
  },
  "100.390.121": {
    meaning: "3DS authentication error: PARes rejected or invalid signature",
    action: "do not fulfil",
    retryable: "yes (shopper may retry authentication)",
    refund: "Not applicable (no money captured).",
  },
  "100.390.124": {
    meaning: "3DS authentication error: invalid enrolment or auth status",
    action: "do not fulfil",
    retryable: "yes (shopper may retry or use alternative card)",
    refund: "Not applicable (no money captured).",
  },
  "100.396.101": {
    meaning: "Cancelled by shopper (user clicked cancel or aborted payment session)",
    action: "treat as canceled",
    actionDetail: "treat as canceled (do not fulfil; never downgrade an already-confirmed order)",
    retryable: "yes (shopper may initiate a new checkout session)",
    refund: "Not applicable (cancelled; no money captured).",
  },
  "100.396.104": {
    meaning: "Uncertain / probably cancelled (session timed out or aborted without confirmation)",
    action: "treat as canceled",
    actionDetail: "treat as canceled (do not fulfil; never downgrade an already-confirmed order)",
    retryable: "yes (shopper may initiate a new checkout session)",
    refund: "Not applicable (uncertain/cancelled; no money captured).",
  },
  "200.300.404": {
    meaning: "Invalid or missing parameter (e.g. nested JSON body in refund request; requires flat form keys)",
    action: "do not fulfil",
    actionDetail: "do not fulfil (fix request shape: flatten nested keys to application/x-www-form-urlencoded)",
    retryable: "no (fix request body format before retrying)",
    refund: "Common refund failure: POST /v1/checkout/refund requires flat form keys, not nested JSON.",
  },
  "700.300.100": {
    meaning: "Referenced transaction cannot be refunded (unsettled transaction, invalid ID, or already refunded)",
    action: "do not fulfil",
    actionDetail: "do not fulfil (refund rejected — verify transaction ID and settlement state)",
    retryable: "no (check transaction eligibility before re-attempting)",
    refund: "Refund rejected: original transaction cannot be refunded (unsettled, wrong ID, or already refunded).",
  },
  "700.400.200": {
    meaning: "Refund not allowed for this transaction or payment method",
    action: "do not fulfil",
    actionDetail: "do not fulfil (refund not supported for this transaction/method)",
    retryable: "no (method does not support automated refund)",
    refund: "Refund not allowed: payment method does not support automated refunds; refund manually out of band.",
  },
  "700.600.100": {
    meaning: "MAC / signature verification failed (request signature mismatch)",
    action: "do not fulfil",
    actionDetail: "do not fulfil (fix signature calculation using secret token)",
    retryable: "no (fix HMAC calculation before retrying)",
    refund: "Refund request rejected due to invalid signature.",
  },
  "800.100.100": {
    meaning: "Bank / processor transaction decline (general decline)",
    action: "do not fulfil",
    retryable: "yes (shopper can retry with another card or payment method)",
    refund: "Not applicable (declined; no money captured).",
  },
  "800.100.150": {
    meaning: "General bank authorisation decline",
    action: "do not fulfil",
    retryable: "yes (shopper can retry with another card or payment method)",
    refund: "Not applicable (declined; no money captured).",
  },
  "800.100.152": {
    meaning: "Generic bank authorisation decline (insufficient funds, card blocked, or policy decline)",
    action: "do not fulfil",
    retryable: "yes (shopper can retry with another card or payment method)",
    refund: "Not applicable (declined; no money captured).",
  },
  "800.100.153": {
    meaning: "Wrong CVV / card security code",
    action: "do not fulfil",
    actionDetail: "do not fulfil (shopper entered incorrect CVV; shopper-fixable)",
    retryable: "yes (shopper can re-enter correct CVV and retry)",
    refund: "Not applicable (declined; no money captured).",
  },
  "800.100.156": {
    meaning: "Format error from bank / processor (recurring standingInstruction issue)",
    action: "do not fulfil",
    actionDetail: "do not fulfil (fix recurring config: set standingInstruction.type=UNSCHEDULED instead of INSTALLMENT)",
    retryable: "conditional (fix standingInstruction.type=UNSCHEDULED instead of INSTALLMENT before retrying)",
    refund: "Not applicable (declined; no money captured).",
  },
  "800.100.195": {
    meaning: "UserAccount Number/ID unknown (e.g. refund where original payment captured no refund destination)",
    action: "do not fulfil",
    actionDetail: "do not fulfil (refund failed — original payment had no refund destination)",
    retryable: "no (refund destination missing; refund out of band/manually)",
    refund: "Refund failed: original payment captured no destination account (common on MoneyBadger/EFT); refund out of band.",
  },
  "800.120.100": {
    meaning: "Bank authorisation failed (transaction not permitted for card/account)",
    action: "do not fulfil",
    retryable: "yes (shopper should try a different card)",
    refund: "Not applicable (declined; no money captured).",
  },
  "100.550.701": {
    meaning: "Refund amount mismatch (requested refund exceeds capturable amount or currency mismatch)",
    action: "do not fulfil",
    actionDetail: "do not fulfil (verify original transaction amount and currency before refunding)",
    retryable: "no (fix refund amount / currency)",
    refund: "Refund rejected: amount mismatch — cannot refund more than original captured amount; verify currency.",
  },
  "600.200.500": {
    meaning: "System configuration error on merchant or processor account",
    action: "do not fulfil",
    actionDetail: "do not fulfil (check channel configuration and entity ID)",
    retryable: "no (fix channel/processor configuration before retrying)",
    refund: "Not applicable (configuration error).",
  },
  "999.999.999": {
    meaning: "System error / general backend processing failure",
    action: "do not fulfil",
    actionDetail: "do not fulfil (backend system failure; investigate system status)",
    retryable: "conditional (retry after gateway/processor service is restored)",
    refund: "Not applicable (system error; no money captured).",
  },
}

/**
 * Decodes a single Peach Payments result code.
 * Reuses map-result-code.js for bucket and moneyMoved.
 */
function decodeResultCode(rawCode, opts = {}) {
  const codeStr = rawCode == null ? "" : String(rawCode)
  const isMissing = codeStr === ""
  const isMalformed = /\s/.test(codeStr) || !CODE_SHAPE.test(codeStr)

  // 1. Get bucket and moneyMoved from map-result-code.js (reused verbatim)
  const mapped = mapResultCodeDetailed(codeStr, opts)
  const bucket = mapped.status // captured | review | pending | requires_more | canceled | error
  const moneyMovedBool = Boolean(mapped.moneyMoved)
  const moneyMoved = moneyMovedBool ? "yes" : "no"

  // 2. Family / category from references/result-codes.md documented groups
  let category = "Unknown category"
  let matchedGroup = null
  if (isMissing) {
    category = "Missing / No code"
  } else if (isMalformed) {
    category = "Malformed / Invalid shape"
  } else {
    for (const group of CATEGORY_GROUPS) {
      if (group.regex.test(codeStr)) {
        category = group.name
        matchedGroup = group
        break
      }
    }
    if (!matchedGroup) {
      if (/^\d{4}\./.test(codeStr)) category = "Payment Links / Payouts"
      else if (/^700\./.test(codeStr)) category = "Refund restriction / MAC"
      else if (/^800\./.test(codeStr)) category = "External payment system"
      else if (/^900\./.test(codeStr)) category = "Communication error"
      else if (/^600\./.test(codeStr)) category = "System error"
      else if (/^200\./.test(codeStr)) category = "Format validation"
      else if (/^100\./.test(codeStr)) category = "Async workflow"
    }
  }

  // 3. Plain-English meaning
  let meaning = ""
  const specificKnown = KNOWN_CODES[codeStr]

  if (isMissing) {
    meaning = "unknown code → treat as error, do not fulfil (no result code present; treated as pending per plugin)"
  } else if (isMalformed) {
    meaning = "unknown code → treat as error, do not fulfil (malformed code shape: expected ddd.ddd.ddd)"
  } else if (specificKnown && specificKnown.meaning) {
    meaning = specificKnown.meaning
  } else if (matchedGroup) {
    meaning = matchedGroup.meaning
  } else {
    meaning = "unknown code → treat as error, do not fulfil (unrecognized result code; fail closed)"
  }

  // 4. Recommended ACTION (fulfil / review before fulfilling / poll-wait / re-auth via 3DS / treat as canceled / do not fulfil)
  let action = "do not fulfil"
  let actionDetail = ""

  if (isMissing) {
    action = "poll-wait"
    actionDetail = "poll-wait (no code present yet; poll /status or wait for webhook; do not fulfil)"
  } else if (isMalformed || category === "Unknown category") {
    action = "do not fulfil"
    actionDetail = "do not fulfil (unknown code → treat as error, do not fulfil)"
  } else if (specificKnown && specificKnown.action) {
    action = specificKnown.action
    actionDetail = specificKnown.actionDetail || specificKnown.action
  } else {
    switch (bucket) {
      case "captured":
        action = "fulfil"
        actionDetail = "fulfil (fulfil order after /status and amount verification)"
        break
      case "review":
        action = "review before fulfilling"
        actionDetail = "review before fulfilling (money moved; verify fraud/risk flags before fulfilment)"
        break
      case "pending":
        action = "poll-wait"
        actionDetail = "poll-wait (poll /status or wait for webhook; do not fulfil)"
        break
      case "requires_more":
        action = "re-auth via 3DS"
        actionDetail = "re-auth via 3DS (prompt shopper to complete 3DS challenge / retry with 3DS)"
        break
      case "canceled":
        action = "treat as canceled"
        actionDetail = "treat as canceled (do not fulfil; never downgrade an already-confirmed order)"
        break
      case "error":
      default:
        action = "do not fulfil"
        actionDetail = "do not fulfil (fail closed; payment was declined or code is invalid)"
        break
    }
  }

  // 5. Retryable? and MerchantAdviceCode dunning guidance
  let retryable = "no"
  let isRetryable = false
  const adviceCode = opts.merchantAdviceCode ? String(opts.merchantAdviceCode).trim() : ""

  if (adviceCode) {
    const advice = merchantAdviceGuidance(adviceCode)
    if (adviceCode === "01") {
      retryable = "yes (01 retry now: new account info — the card was updated; a retry is sensible)"
      isRetryable = true
    } else if (adviceCode === "02") {
      retryable = "yes (02 retry later: cannot approve now — retry later)"
      isRetryable = true
    } else if (adviceCode === "03") {
      retryable = "no (03: Dashboard says Retry is not allowed — stop billing this mandate)"
      isRetryable = true
    } else if (adviceCode === "04") {
      retryable = "no (04 never retry: do not try again — kill the mandate)"
      isRetryable = false
    } else if (advice) {
      retryable = `${advice.retry ? "yes" : "no"} (${adviceCode}: ${advice.guidance})`
      isRetryable = Boolean(advice.retry)
    } else {
      retryable = `unknown (MerchantAdviceCode ${adviceCode}: look up in /status resultDetails before automating retries)`
      isRetryable = null
    }
  } else if (specificKnown && specificKnown.retryable) {
    retryable = specificKnown.retryable
    isRetryable = retryable.startsWith("yes")
  } else if (isMissing || isMalformed || category === "Unknown category") {
    retryable = "no (fail closed; do not retry automatically)"
    isRetryable = false
  } else if (bucket === "captured") {
    retryable = "no (payment already successful)"
    isRetryable = false
  } else if (bucket === "review") {
    retryable = "no (payment captured; awaiting manual review)"
    isRetryable = false
  } else if (bucket === "pending") {
    if (PENDING_EXTERNAL.test(codeStr)) {
      retryable = "no (delayed finalisation — non-instant methods take days; do NOT retry)"
    } else {
      retryable = "no (session open; wait for completion, do not duplicate debit)"
    }
    isRetryable = false
  } else if (bucket === "requires_more") {
    retryable = "yes (retry through 3DS or challengeIndicator=04)"
    isRetryable = true
  } else if (bucket === "canceled") {
    retryable = "yes (shopper may start a new checkout session)"
    isRetryable = true
  } else if (category === "Communication error") {
    retryable = "yes (communication error / timeout — retryable)"
    isRetryable = true
  } else {
    retryable = "no (decline / error — do not retry automatically)"
    isRetryable = false
  }

  // 6. Refund implication
  let refund = ""
  if (specificKnown && specificKnown.refund) {
    refund = specificKnown.refund
  } else if (opts.paymentType === "RF") {
    if (bucket === "captured") {
      refund = "Refund processed successfully — funds returned to shopper."
    } else {
      refund = "Refund failed — inspect result code and original transaction."
    }
  } else if (codeStr.startsWith("000.100.2")) {
    refund = "Money already reversed or disputed — do NOT issue a merchant refund (causes double loss)."
  } else if (bucket === "captured") {
    refund = "Refundable via POST /v1/checkout/refund using the transaction id (not checkoutId)."
  } else if (bucket === "review") {
    refund = "Refundable via POST /v1/checkout/refund if merchant review declines or order is canceled."
  } else {
    refund = "Not applicable (no money captured; cannot be refunded)."
  }

  return {
    code: codeStr,
    category,
    meaning,
    bucket,
    moneyMoved,
    moneyMovedBool,
    action,
    actionDetail,
    retryable,
    isRetryable,
    refund,
    merchantAdvice: mapped.merchantAdvice || null,
  }
}

/**
 * Decodes a full Peach Payments JSON status or webhook payload.
 * Extracts flat dotted keys: result.code, amount, id, paymentBrand, resultDetails.*, MerchantAdviceCode.
 */
function decodePayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid payload: expected a JSON object")
  }

  // Extract flat dotted result.code or fallback
  let resultCode = null
  if (payload["result.code"] != null) {
    resultCode = String(payload["result.code"])
  } else {
    const res = payload["result"]
    if (res && typeof res === "object" && res["code"] != null) {
      resultCode = String(res["code"])
    }
  }

  const id = payload["id"] != null ? String(payload["id"]) : null
  const amount = payload["amount"] != null ? String(payload["amount"]) : null
  const currency = payload["currency"] != null ? String(payload["currency"]) : null
  const paymentBrand = payload["paymentBrand"] != null ? String(payload["paymentBrand"]) : null
  const paymentType = payload["paymentType"] != null ? String(payload["paymentType"]) : null

  // Extract MerchantAdviceCode
  let merchantAdviceCode = null
  if (payload["resultDetails.MerchantAdviceCode"] != null) {
    merchantAdviceCode = String(payload["resultDetails.MerchantAdviceCode"])
  } else if (payload["resultDetails.merchantAdviceCode"] != null) {
    merchantAdviceCode = String(payload["resultDetails.merchantAdviceCode"])
  } else if (payload["MerchantAdviceCode"] != null) {
    merchantAdviceCode = String(payload["MerchantAdviceCode"])
  } else if (payload["merchantAdviceCode"] != null) {
    merchantAdviceCode = String(payload["merchantAdviceCode"])
  } else {
    const rd = payload["resultDetails"]
    if (rd && typeof rd === "object") {
      if (rd["MerchantAdviceCode"] != null) merchantAdviceCode = String(rd["MerchantAdviceCode"])
      else if (rd["merchantAdviceCode"] != null) merchantAdviceCode = String(rd["merchantAdviceCode"])
    }
  }

  // Extract resultDetails.*
  const resultDetails = {}
  for (const key of Object.keys(payload)) {
    if (key.startsWith("resultDetails.")) {
      const subKey = key.slice("resultDetails.".length)
      resultDetails[subKey] = payload[key]
    }
  }
  const rd = payload["resultDetails"]
  if (rd && typeof rd === "object") {
    for (const subKey of Object.keys(rd)) {
      if (resultDetails[subKey] === undefined) {
        resultDetails[subKey] = rd[subKey]
      }
    }
  }

  // Decode code
  const decoded = decodeResultCode(resultCode, { merchantAdviceCode, paymentType })

  // Build one-line outcome summary
  let outcomeSummary = ""
  const amtStr = (currency ? currency + " " : "") + (amount || "")
  const brandStr = paymentBrand ? ` via ${paymentBrand}` : ""
  const idStr = id ? ` (id: ${id})` : ""
  const txDesc = amtStr ? `Payment of ${amtStr}${brandStr}${idStr}` : `Transaction${idStr}`

  if (resultCode == null || resultCode === "" || decoded.category === "Malformed / Invalid shape") {
    outcomeSummary = `Transaction outcome cannot be verified (invalid/missing code); do not fulfil.`
  } else if (decoded.bucket === "captured") {
    outcomeSummary = `${txDesc} captured successfully; fulfil order after /status check.`
  } else if (decoded.bucket === "review") {
    outcomeSummary = `${txDesc} captured but flagged for review; verify fraud/risk before fulfilment.`
  } else if (decoded.bucket === "pending") {
    outcomeSummary = `${txDesc} pending; poll /status or wait for webhook — do not fulfil yet.`
  } else if (decoded.bucket === "requires_more") {
    outcomeSummary = `${txDesc} requires 3DS challenge authentication; prompt shopper action.`
  } else if (decoded.bucket === "canceled") {
    outcomeSummary = `${txDesc} cancelled by shopper; treat as canceled, do not fulfil.`
  } else {
    // error
    if (resultCode.startsWith("000.400.10")) {
      outcomeSummary = `${txDesc} at intermediate 3DS step (${resultCode}); do not fulfil — wait for debit terminal status.`
    } else if (resultCode.startsWith("000.100.2")) {
      outcomeSummary = `${txDesc} reversed or charged back (${resultCode}); do not fulfil.`
    } else {
      outcomeSummary = `${txDesc} declined or failed (${resultCode}); do not fulfil.`
    }
  }

  if (merchantAdviceCode) {
    if (merchantAdviceCode === "04") {
      outcomeSummary += ` Dunning: MerchantAdviceCode 04 — never retry (kill the mandate).`
    } else if (merchantAdviceCode === "01") {
      outcomeSummary += ` Dunning: MerchantAdviceCode 01 — retry now (card updated).`
    } else if (merchantAdviceCode === "02") {
      outcomeSummary += ` Dunning: MerchantAdviceCode 02 — retry later.`
    } else if (merchantAdviceCode === "03") {
      outcomeSummary += ` Dunning: MerchantAdviceCode 03 — do NOT retry (Dashboard strict reading).`
    } else {
      outcomeSummary += ` Dunning: MerchantAdviceCode ${merchantAdviceCode}.`
    }
  }

  return {
    ...decoded,
    payloadContext: {
      id,
      amount,
      currency,
      paymentBrand,
      paymentType,
      merchantAdviceCode,
      resultDetails,
    },
    outcomeSummary,
  }
}

/** Formats the decoded record for human readability. */
function formatHuman(decoded) {
  const lines = []

  if (decoded.outcomeSummary) {
    lines.push("================================================================================")
    lines.push("Outcome Summary:")
    lines.push(`  ${decoded.outcomeSummary}`)
    lines.push("================================================================================")
    lines.push("")
  }

  if (decoded.payloadContext) {
    const ctx = decoded.payloadContext
    lines.push("Payload Context:")
    if (ctx.id) lines.push(`  Transaction ID:      ${ctx.id}`)
    if (ctx.paymentBrand) lines.push(`  Payment Brand:       ${ctx.paymentBrand}`)
    if (ctx.amount) lines.push(`  Amount:              ${(ctx.currency ? ctx.currency + " " : "") + ctx.amount}`)
    if (ctx.paymentType) lines.push(`  Payment Type:        ${ctx.paymentType}`)
    if (ctx.merchantAdviceCode) lines.push(`  MerchantAdviceCode:  ${ctx.merchantAdviceCode}`)
    const rdKeys = Object.keys(ctx.resultDetails || {})
    if (rdKeys.length > 0) {
      const rdFormatted = rdKeys.map((k) => `${k}: ${ctx.resultDetails[k]}`).join(", ")
      lines.push(`  Result Details:      ${rdFormatted}`)
    }
    lines.push("")
  }

  lines.push(`Result Code:         ${decoded.code || "(none)"}`)
  lines.push(`Category / Family:   ${decoded.category}`)
  lines.push(`Meaning:             ${decoded.meaning}`)
  lines.push(`Mapped Bucket:       ${decoded.bucket}`)
  lines.push(`Money Moved:         ${decoded.moneyMoved}`)
  lines.push(`Recommended Action:  ${decoded.actionDetail || decoded.action}`)
  lines.push(`Retryable:           ${decoded.retryable}`)
  lines.push(`Refund Implication:  ${decoded.refund}`)

  return lines.join("\n")
}

/* ────────────────────────────────────────────────────────────────────────────
 * Selftest
 * ──────────────────────────────────────────────────────────────────────────── */

function runSelftest() {
  const tests = []
  const t = (name, fn) => tests.push({ name, fn })
  const eq = (got, want, label) => {
    if (got !== want) throw new Error(`${label || "value"}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  }

  const CODES = [
    "000.000.000",
    "000.100.110",
    "000.400.101",
    "000.400.100",
    "000.100.226",
    "100.390.100",
    "000.200.000",
    "300.100.100",
    "100.396.101",
    "800.100.156",
    "999.999.999",
    "junk",
    "", // empty
  ]

  // (a) printed bucket EQUALS map-result-code.js bucket for that code
  t("printed bucket EQUALS map-result-code.js bucket for all spread codes", () => {
    for (const code of CODES) {
      const wantBucket = mapResultCode(code)
      const decoded = decodeResultCode(code)
      eq(decoded.bucket, wantBucket, `decoded.bucket for ${JSON.stringify(code)}`)
      const printed = formatHuman(decoded)
      const match = printed.match(/Mapped Bucket:\s+(\w+)/)
      if (!match) throw new Error(`printed output missing Mapped Bucket line for ${JSON.stringify(code)}`)
      eq(match[1], wantBucket, `printed bucket for ${JSON.stringify(code)}`)
    }
  })

  // (b) success codes say money-moved yes + fulfil
  t("success codes say money-moved yes + fulfil", () => {
    for (const code of ["000.000.000", "000.100.110"]) {
      const decoded = decodeResultCode(code)
      eq(decoded.moneyMoved, "yes", `${code}.moneyMoved`)
      eq(decoded.moneyMovedBool, true, `${code}.moneyMovedBool`)
      if (!decoded.action.toLowerCase().includes("fulfil")) {
        throw new Error(`${code} action must contain fulfil, got: ${decoded.action}`)
      }
      const printed = formatHuman(decoded)
      if (!/Money Moved:\s+yes/i.test(printed)) {
        throw new Error(`${code} printed output must say Money Moved: yes`)
      }
      if (!/Recommended Action:\s+fulfil/i.test(printed)) {
        throw new Error(`${code} printed output must recommend fulfil`)
      }
    }
  })

  // (c) 000.400.101/102 and unknown say NOT success / do-not-fulfil
  t("000.400.101/102 and unknown say NOT success / do-not-fulfil", () => {
    const nonSuccessCases = [
      "000.400.101",
      "000.400.102",
      "junk",
      "999.999.999",
      "444.444.444",
      "000.000.000extra",
      " 000.000.000",
    ]
    for (const code of nonSuccessCases) {
      const decoded = decodeResultCode(code)
      eq(decoded.moneyMoved, "no", `${code}.moneyMoved`)
      eq(decoded.moneyMovedBool, false, `${code}.moneyMovedBool`)
      if (decoded.bucket === "captured" || decoded.bucket === "review") {
        throw new Error(`${code} bucket must NOT be success, got ${decoded.bucket}`)
      }
      if (!decoded.action.toLowerCase().includes("do not fulfil")) {
        throw new Error(`${code} action must say do not fulfil, got ${decoded.action}`)
      }
      const printed = formatHuman(decoded)
      if (!/Money Moved:\s+no/i.test(printed)) {
        throw new Error(`${code} printed output must say Money Moved: no`)
      }
      if (!/do not fulfil/i.test(printed)) {
        throw new Error(`${code} printed output must say do not fulfil`)
      }
    }
    // Check fail closed phrase on unknown / malformed
    for (const junkCode of ["junk", "444.444.444", "000.000.000extra"]) {
      const decoded = decodeResultCode(junkCode)
      if (!decoded.meaning.includes("unknown code → treat as error, do not fulfil")) {
        throw new Error(
          `${junkCode} meaning must say 'unknown code → treat as error, do not fulfil', got: ${decoded.meaning}`
        )
      }
    }
  })

  // (d) a payload with MerchantAdviceCode 04 says "never retry"
  t("payload with MerchantAdviceCode 04 says 'never retry'", () => {
    const payload = {
      id: "8ac7a4a08c0e29d4018c0f56bc3004b2",
      amount: "250.00",
      currency: "ZAR",
      paymentBrand: "MASTERCARD",
      "result.code": "800.100.150",
      "resultDetails.MerchantAdviceCode": "04",
      "resultDetails.ExtendedDescription": "Do not honor",
    }
    const decoded = decodePayload(payload)
    if (!decoded.retryable.toLowerCase().includes("never retry")) {
      throw new Error(`payload with MAC 04 retryable must say 'never retry', got: ${decoded.retryable}`)
    }
    const printed = formatHuman(decoded)
    if (!/never retry/i.test(printed)) {
      throw new Error(`printed payload with MAC 04 must say 'never retry'`)
    }
    if (!/never retry/i.test(decoded.outcomeSummary)) {
      throw new Error(`outcome summary must say 'never retry'`)
    }
  })

  // Additional test: other MerchantAdviceCodes (01, 02, 03)
  t("payload with MerchantAdviceCodes 01, 02, 03 provide proper dunning guidance", () => {
    const p1 = decodePayload({ "result.code": "800.100.150", "resultDetails.MerchantAdviceCode": "01" })
    if (!p1.retryable.includes("01 retry now")) throw new Error(`MAC 01 expected '01 retry now', got: ${p1.retryable}`)
    const p2 = decodePayload({ "result.code": "800.100.150", "resultDetails.MerchantAdviceCode": "02" })
    if (!p2.retryable.includes("02 retry later")) throw new Error(`MAC 02 expected '02 retry later', got: ${p2.retryable}`)
    const p3 = decodePayload({ "result.code": "800.100.150", "resultDetails.MerchantAdviceCode": "03" })
    if (!p3.retryable.includes("Retry is not allowed")) throw new Error(`MAC 03 expected no-retry, got: ${p3.retryable}`)
  })

  // Additional test: intermediate 3DS codes 000.400.101/102 are 3DS / risk_m
  t("000.400.101 and 000.400.102 categorize as 3DS / risk_m and error bucket", () => {
    for (const code of ["000.400.101", "000.400.102"]) {
      const decoded = decodeResultCode(code)
      eq(decoded.category, "3DS / risk_m", `${code}.category`)
      eq(decoded.bucket, "error", `${code}.bucket`)
      eq(decoded.moneyMoved, "no", `${code}.moneyMoved`)
    }
  })

  // Additional test: chargeback 000.100.226 warns against merchant refund
  t("chargeback 000.100.226 explains reversal/chargeback and warns against refund", () => {
    const decoded = decodeResultCode("000.100.226")
    eq(decoded.category, "Chargebacks", "000.100.226.category")
    eq(decoded.bucket, "error", "000.100.226.bucket")
    if (!/double loss|do NOT issue a merchant refund/i.test(decoded.refund)) {
      throw new Error(`chargeback refund warning expected, got: ${decoded.refund}`)
    }
  })

  // Additional test: soft decline 300.100.100 recommends re-auth via 3DS
  t("soft decline 300.100.100 recommends re-auth via 3DS", () => {
    const decoded = decodeResultCode("300.100.100")
    eq(decoded.category, "Soft decline", "300.100.100.category")
    eq(decoded.bucket, "requires_more", "300.100.100.bucket")
    eq(decoded.action, "re-auth via 3DS", "300.100.100.action")
  })

  // Additional test: review code 000.400.100 money moved yes and review before fulfilling
  t("000.400.100 review code has moneyMoved yes and review before fulfilling", () => {
    const decoded = decodeResultCode("000.400.100")
    eq(decoded.category, "Successful, flagged for review", "000.400.100.category")
    eq(decoded.bucket, "review", "000.400.100.bucket")
    eq(decoded.moneyMoved, "yes", "000.400.100.moneyMoved")
    eq(decoded.action, "review before fulfilling", "000.400.100.action")
  })

  // Additional test: pending code 000.200.000 has poll-wait action
  t("pending code 000.200.000 has poll-wait action", () => {
    const decoded = decodeResultCode("000.200.000")
    eq(decoded.category, "Pending, short-term", "000.200.000.category")
    eq(decoded.bucket, "pending", "000.200.000.bucket")
    eq(decoded.action, "poll-wait", "000.200.000.action")
  })

  // Additional test: cancelled code 100.396.101 has treat as canceled action
  t("cancelled code 100.396.101 has treat as canceled action", () => {
    const decoded = decodeResultCode("100.396.101")
    eq(decoded.category, "Async workflow", "100.396.101.category")
    eq(decoded.bucket, "canceled", "100.396.101.bucket")
    eq(decoded.action, "treat as canceled", "100.396.101.action")
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
  return failed === 0
}

/* ────────────────────────────────────────────────────────────────────────────
 * CLI
 * ──────────────────────────────────────────────────────────────────────────── */

function printHelp() {
  console.log(`decode-result.js — Peach Payments result-code decoder and human explainer

CLI:
  node scripts/decode-result.js <code>                 # e.g. 000.400.101
  node scripts/decode-result.js --stdin                # read a JSON status/webhook payload from stdin
  node scripts/decode-result.js selftest               # run built-in validation suite

OPTIONS:
  --stdin          Read JSON payload (or codes) from stdin
  --json           Output raw decoded JSON object instead of formatted text
  --mac <code>     Attach MerchantAdviceCode for dunning guidance (01, 02, 03, 04)
  --help, -h       Show this help message

EXAMPLES:
  node scripts/decode-result.js 000.000.000
  node scripts/decode-result.js 000.400.101
  node scripts/decode-result.js 800.100.150 --mac 04
  cat webhook.json | node scripts/decode-result.js --stdin
`)
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
  let stdinFlag = false
  let jsonFlag = false
  let mac = null
  const codes = []

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--help" || a === "-h" || a === "help") {
      printHelp()
      process.exitCode = 0
      return
    }
    if (a === "selftest") {
      const ok = runSelftest()
      process.exitCode = ok ? 0 : 1
      return
    }
    if (a === "--stdin") {
      stdinFlag = true
    } else if (a === "--json") {
      jsonFlag = true
    } else if (a === "--mac" || a === "--advice") {
      mac = argv[++i]
    } else if (a.startsWith("--")) {
      console.error(`decode-result.js: error: unknown flag '${a}'`)
      process.exitCode = 2
      return
    } else {
      codes.push(a)
    }
  }

  if (stdinFlag || (codes.length === 0 && !process.stdin.isTTY)) {
    const raw = (await readStdin()).trim()
    if (!raw) {
      console.error("decode-result.js: error: no input provided on stdin")
      process.exitCode = 2
      return
    }
    // Check if input looks like JSON
    if (raw.startsWith("{") || raw.startsWith("[")) {
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch (err) {
        console.error("decode-result.js: error: invalid JSON on stdin: " + err.message)
        process.exitCode = 2
        return
      }
      if (Array.isArray(parsed)) {
        const decodedList = parsed.map((item) => decodePayload(item))
        if (jsonFlag) {
          console.log(JSON.stringify(decodedList, null, 2))
        } else {
          for (let idx = 0; idx < decodedList.length; idx++) {
            if (idx > 0) console.log("\n" + "-".repeat(80) + "\n")
            console.log(formatHuman(decodedList[idx]))
          }
        }
      } else {
        const decoded = decodePayload(parsed)
        if (jsonFlag) {
          console.log(JSON.stringify(decoded, null, 2))
        } else {
          console.log(formatHuman(decoded))
        }
      }
      process.exitCode = 0
      return
    } else {
      // It's line-delimited codes on stdin
      const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      if (lines.length === 0) {
        console.error("decode-result.js: error: no codes found on stdin")
        process.exitCode = 2
        return
      }
      for (const line of lines) codes.push(line)
    }
  }

  if (codes.length === 0) {
    console.error("decode-result.js: error: no result code provided")
    console.error("run 'node scripts/decode-result.js --help' for usage")
    process.exitCode = 2
    return
  }

  const results = codes.map((c) => decodeResultCode(c, { merchantAdviceCode: mac }))
  if (jsonFlag) {
    console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2))
  } else {
    for (let idx = 0; idx < results.length; idx++) {
      if (idx > 0) console.log("\n" + "-".repeat(80) + "\n")
      console.log(formatHuman(results[idx]))
    }
  }
  process.exitCode = 0
}

/* ────────────────────────────────────────────────────────────────────────────
 * Entry point
 * ──────────────────────────────────────────────────────────────────────────── */

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`decode-result.js: error: ${e && e.message ? e.message : e}`)
    process.exitCode = 2
  })
}

module.exports = {
  decodeResultCode,
  decodePayload,
  formatHuman,
  runSelftest,
  CATEGORY_GROUPS,
  KNOWN_CODES,
}
