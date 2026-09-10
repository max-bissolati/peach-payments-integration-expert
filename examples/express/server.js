"use strict";

require("dotenv").config();
const express = require("express");
const path = require("path");
const { createCheckoutSession, getCheckoutStatus } = require("./lib/peach");
const { mapResultCode, isSuccessResultCode } = require("./lib/result-codes");
const { verifyWebhookSignature } = require("./lib/verify-webhook");

const app = express();
const port = process.env.PORT || 3000;

// DEMO in-memory: replace with a DURABLE idempotency store (DB) in production — Peach retries up to 30 days, and a restart must not allow a re-fulfil. Fulfil inside a DB transaction.
const processedCheckouts = new Set();
// DEMO: in-memory map. In production store the created amount in your DB keyed by checkoutId and read it back here.
const createdAmounts = new Map();

// Fulfilment stub: safe to run only after signature, terminal status, and amount verification
function fulfillOrder(checkoutId, statusData) {
  const amount = statusData["amount"];
  const currency = statusData["currency"];
  const txId = statusData["id"];
  console.log(`[FULFILLED] Order confirmed for checkout ${checkoutId} | TxID: ${txId} | Amount: ${amount} ${currency}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Webhook Handler
// CRITICAL: Must preserve the raw body bytes for HMAC-SHA256 signature verification.
// Mounted with express.raw() BEFORE any global JSON or urlencoded parsers.
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/webhook", express.raw({ type: "*/*" }), async (req, res) => {
  const rawBody = req.body ? req.body.toString("utf8") : "";

  // Signature verification: fail closed if invalid or if secret is missing
  const verification = verifyWebhookSignature({
    rawBody,
    headers: req.headers,
    secretToken: process.env.PEACH_SECRET_TOKEN,
    webhookSecret: process.env.PEACH_WEBHOOK_SECRET,
    configuredUrl: process.env.PEACH_WEBHOOK_URL,
  });

  if (!verification.valid) {
    console.error(`[WEBHOOK REJECTED] Signature verification failed (${verification.reason})`);
    return res.status(400).json({ error: "Invalid webhook signature" });
  }

  // Parse parameters from form-urlencoded body (or JSON if initial verification ping)
  let checkoutId = null;
  let webhookResultCode = null;

  try {
    if (rawBody.trim().startsWith("{")) {
      const json = JSON.parse(rawBody);
      checkoutId = json.checkoutId;
      webhookResultCode = json["result.code"];
    } else {
      const params = new URLSearchParams(rawBody);
      checkoutId = params.get("checkoutId");
      webhookResultCode = params.get("result.code");
    }
  } catch (parseErr) {
    console.error("[WEBHOOK ERROR] Failed to parse webhook payload:", parseErr.message);
    return res.status(400).json({ error: "Malformed payload" });
  }

  if (!checkoutId) {
    return res.status(200).json({ message: "No checkoutId present, acknowledged" });
  }

  // Deduplication by checkoutId — ATOMIC CLAIM pattern: add to the Set BEFORE any async
  // work so concurrent duplicate webhooks can't race past the check (TOCTOU fix).
  if (processedCheckouts.has(checkoutId)) {
    console.log(`[WEBHOOK DEDUPE] Checkout ${checkoutId} already processed, skipping`);
    return res.status(200).json({ status: "already_processed" });
  }
  processedCheckouts.add(checkoutId); // claim NOW; roll back on any non-fulfil path

  // Principle: A webhook is a wake-up call, not truth.
  // Check if webhook signals terminal success; if not, acknowledge with 200 without fulfilling
  const webhookStatus = mapResultCode(webhookResultCode);
  if (webhookStatus !== "captured") {
    processedCheckouts.delete(checkoutId); // roll back claim — this wasn't terminal
    console.log(`[WEBHOOK IGNORED] Non-terminal code: ${webhookResultCode} (${webhookStatus})`);
    return res.status(200).json({ status: "acknowledged_non_terminal" });
  }

  // Re-confirm outcome AND amount via GET /v2/checkout/{id}/status before fulfilling!
  try {
    const statusData = await getCheckoutStatus(checkoutId);
    const confirmedCode = statusData["result.code"];
    const confirmedStatus = mapResultCode(confirmedCode);
    const confirmedAmount = statusData["amount"];

    // Enforce amount integrity: paid amount must match stored created amount
    const expectedAmount = createdAmounts.get(checkoutId);
    const amountMatches =
      expectedAmount !== undefined &&
      confirmedAmount != null &&
      !Number.isNaN(Number(confirmedAmount)) &&
      Number(confirmedAmount) === Number(expectedAmount);

    if (confirmedStatus === "captured" && amountMatches) {
      fulfillOrder(checkoutId, statusData);
      return res.status(200).json({ status: "fulfilled" });
    } else {
      processedCheckouts.delete(checkoutId); // roll back — allow Peach's retry to re-attempt
      console.warn(`[WEBHOOK FULFIL REJECTED] Verification mismatch on /status. Code: ${confirmedCode}, Amount: ${confirmedAmount}, Expected: ${expectedAmount}`);
      return res.status(200).json({ status: "verification_failed" });
    }
  } catch (statusErr) {
    processedCheckouts.delete(checkoutId); // roll back — let Peach's retry re-attempt
    console.error(`[WEBHOOK ERROR] Failed to fetch /status for ${checkoutId}:`, statusErr.message);
    // Return 500 to request Peach retry
    return res.status(500).json({ error: "Failed to verify status" });
  }
});

// Global parsers for non-webhook JSON routes
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend assets from public/
app.use(express.static(path.join(__dirname, "public")));

// ─────────────────────────────────────────────────────────────────────────────
// 2. Create Checkout Endpoint
// Initiates server-side OAuth and creates Checkout V2 session.
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/checkout", async (req, res) => {
  try {
    // Checkout amounts are major-unit decimal strings ("10.00"), never cents
    const amount = "10.00";
    const currency = process.env.PEACH_CURRENCY || "ZAR";

    const session = await createCheckoutSession({
      amount,
      currency,
      orderId: `ORD-${Date.now()}`,
    });

    // Store created amount keyed by checkoutId for amount integrity checks at fulfillment
    createdAmounts.set(session.checkoutId, amount);

    // Return browser-safe identifiers only: checkoutId and entityId (semi-public SDK key).
    // NEVER expose secrets, secret token, or OAuth access token to the browser.
    return res.json({
      checkoutId: session.checkoutId,
      entityId: process.env.PEACH_ENTITY_ID,
      redirectUrl: session.redirectUrl,
      amount,
      currency,
    });
  } catch (err) {
    console.error("[CHECKOUT CREATE ERROR]", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Status-Confirm Endpoint
// Client calls this after completing widget payment.
// Fetches GET /v2/checkout/{id}/status, parses flat dotted keys, validates amount.
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/checkout/:id/status", async (req, res) => {
  const checkoutId = req.params.id;
  try {
    const statusData = await getCheckoutStatus(checkoutId);
    const resultCode = statusData["result.code"];
    const statusState = mapResultCode(resultCode);
    const amount = statusData["amount"];
    const isCaptured = isSuccessResultCode(resultCode);

    // Enforce amount integrity: confirm amount matches stored created amount
    const expectedAmount = createdAmounts.get(checkoutId);
    const amountMatches =
      expectedAmount !== undefined &&
      amount != null &&
      !Number.isNaN(Number(amount)) &&
      Number(amount) === Number(expectedAmount);

    if (isCaptured && amountMatches && !processedCheckouts.has(checkoutId)) {
      processedCheckouts.add(checkoutId);
      fulfillOrder(checkoutId, statusData);
    }

    return res.json({
      checkoutId,
      resultCode,
      status: statusState,
      amount,
      currency: statusData["currency"],
      transactionId: statusData["id"],
      paymentBrand: statusData["paymentBrand"],
      fulfilled: isCaptured && amountMatches,
    });
  } catch (err) {
    console.error(`[STATUS CONFIRM ERROR] Checkout ${checkoutId}:`, err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => {
  console.log(`Peach Payments Express server running at http://localhost:${port}`);
});
