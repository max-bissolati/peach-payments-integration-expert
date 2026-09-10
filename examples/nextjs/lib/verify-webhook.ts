import crypto from "crypto";

/**
 * Timing-safe string equality comparison to prevent timing side-channel attacks.
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Scheme A canonical string construction:
 * Sort all parameters alphabetically by key (excluding 'signature'),
 * concatenate key + value with no separators.
 */
export function classicCanonicalMessage(params: URLSearchParams): string {
  const entries: [string, string][] = [];
  for (const [k, v] of params.entries()) {
    if (k !== "signature") {
      entries.push([k, v]);
    }
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return entries.map(([k, v]) => `${k}${v}`).join("");
}

export interface WebhookVerifyOptions {
  rawBody: string;
  headers?: Record<string, string | undefined>;
  secretToken?: string;
  webhookSecret?: string;
  configuredUrl?: string;
  maxAgeMs?: number;
}

export interface WebhookVerifyResult {
  valid: boolean;
  scheme?: string;
  reason?: string;
}

/**
 * Verifies Peach Payments webhook signatures.
 * Supports Scheme A (classic form body) and Scheme B (x-webhook-signature header).
 * Fails closed if secret is missing or signature mismatches.
 */
export function verifyWebhookSignature(opts: WebhookVerifyOptions): WebhookVerifyResult {
  const {
    rawBody,
    headers = {},
    secretToken,
    webhookSecret,
    configuredUrl,
    maxAgeMs = 300000,
  } = opts;

  if (!secretToken && !webhookSecret) {
    return { valid: false, reason: "no_secret_configured" };
  }

  // 1. Scheme A check (Checkout default: signature inside form-urlencoded body)
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

// Shared demo state (processedCheckouts, createdAmounts) now lives in ./store — see lib/store.ts.

