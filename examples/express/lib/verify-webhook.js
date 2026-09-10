"use strict";

const crypto = require("crypto");

/**
 * Timing-safe string equality comparison to prevent timing side-channel attacks.
 * Returns false immediately if byte lengths differ.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqualStrings(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Scheme A canonical string construction:
 * Sort all parameters alphabetically by key (excluding 'signature'),
 * concatenate key + value with no separators.
 * Note: Empty values ARE part of the canonical string.
 * @param {URLSearchParams} params
 * @returns {string}
 */
function classicCanonicalMessage(params) {
  const entries = [];
  for (const [k, v] of params.entries()) {
    if (k !== "signature") {
      entries.push([k, v]);
    }
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return entries.map(([k, v]) => `${k}${v}`).join("");
}

/**
 * Verifies Peach Payments webhook signatures.
 * Supports:
 * - Scheme A (default for Checkout): Classic form-urlencoded body signature with secret token.
 *   Canonical: all parameters sorted by key (excluding signature), concatenated key+value with no separators.
 * - Scheme B: Dashboard header scheme (x-webhook-signature) with webhook secret.
 *   Canonical: `${timestamp}.${webhookId}.${configuredUrl}.${rawBody}`
 *
 * FAILS CLOSED: With no secret configured, verification always returns false.
 *
 * @param {object} opts
 * @param {string} opts.rawBody - Exact unparsed raw request body string
 * @param {object} [opts.headers={}] - Request headers object
 * @param {string} [opts.secretToken] - PEACH_SECRET_TOKEN for Scheme A
 * @param {string} [opts.webhookSecret] - PEACH_WEBHOOK_SECRET for Scheme B
 * @param {string} [opts.configuredUrl] - Webhook URL as configured in Dashboard
 * @param {number} [opts.maxAgeMs=300000] - Max timestamp age in ms for Scheme B replay protection (default 5 min)
 * @returns {{ valid: boolean, scheme?: string, reason?: string }}
 */
function verifyWebhookSignature(opts) {
  const {
    rawBody,
    headers = {},
    secretToken,
    webhookSecret,
    configuredUrl,
    maxAgeMs = 300000,
  } = opts || {};

  if (!secretToken && !webhookSecret) {
    return { valid: false, reason: "no_secret_configured" };
  }

  // 1. Scheme A check (Checkout default: signature in form-urlencoded body)
  const params = new URLSearchParams(rawBody || "");
  const bodySig = params.get("signature");
  if (bodySig && secretToken) {
    const message = classicCanonicalMessage(params);
    const expected = crypto.createHmac("sha256", secretToken).update(message, "utf8").digest("hex");
    if (timingSafeEqualStrings(expected, bodySig)) {
      return { valid: true, scheme: "classic-body" };
    }
  }

  // 2. Scheme B check (Header scheme: x-webhook-signature)
  const headerSig = headers["x-webhook-signature"] || headers["X-Webhook-Signature"];
  const timestamp = headers["x-webhook-timestamp"] || headers["X-Webhook-Timestamp"];
  const webhookId = headers["x-webhook-id"] || headers["X-Webhook-Id"];
  if (headerSig && webhookSecret) {
    // Scheme B replay protection: reject stale timestamp BEFORE HMAC comparison
    const rawTs = String(timestamp || "").trim();
    let ts = Number(rawTs);
    if (rawTs.length === 10) {
      ts *= 1000;
    }
    if (!rawTs || Number.isNaN(ts) || Math.abs(Date.now() - ts) > maxAgeMs) {
      return { valid: false, reason: "stale_timestamp" };
    }

    const message = `${timestamp || ""}.${webhookId || ""}.${configuredUrl || ""}.${rawBody || ""}`;
    const expected = crypto.createHmac("sha256", webhookSecret).update(message, "utf8").digest("hex");
    if (timingSafeEqualStrings(expected, headerSig)) {
      return { valid: true, scheme: "header-signature" };
    }
  }

  if (bodySig || headerSig) {
    return { valid: false, reason: "signature_mismatch" };
  }

  return { valid: false, reason: "missing_signature" };
}

module.exports = {
  verifyWebhookSignature,
  classicCanonicalMessage,
  timingSafeEqualStrings,
};
