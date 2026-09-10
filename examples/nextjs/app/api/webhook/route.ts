import { NextResponse } from "next/server";
import { getCheckoutStatus } from "@/lib/peach";
import { mapResultCode } from "@/lib/result-codes";
import { verifyWebhookSignature } from "@/lib/verify-webhook";
import { createdAmounts, processedCheckouts } from "@/lib/store";

export async function POST(req: Request) {
  // CRITICAL: Read RAW body text to preserve exact bytes for HMAC-SHA256 signature verification
  const rawBody = await req.text();

  // Extract request headers as a lowercase record
  const headersRecord: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headersRecord[key.toLowerCase()] = value;
  });

  // Signature verification: fail closed if signature mismatches or if secret is missing
  const verification = verifyWebhookSignature({
    rawBody,
    headers: headersRecord,
    secretToken: process.env.PEACH_SECRET_TOKEN,
    webhookSecret: process.env.PEACH_WEBHOOK_SECRET,
    configuredUrl: process.env.PEACH_WEBHOOK_URL,
  });

  if (!verification.valid) {
    console.error(`[WEBHOOK REJECTED] Signature verification failed (${verification.reason})`);
    return NextResponse.json({ error: "Invalid webhook signature" }, { status: 400 });
  }

  let checkoutId: string | null = null;
  let webhookResultCode: string | null = null;

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
  } catch (err: any) {
    console.error("[WEBHOOK ERROR] Failed to parse webhook payload:", err.message);
    return NextResponse.json({ error: "Malformed payload" }, { status: 400 });
  }

  if (!checkoutId) {
    return NextResponse.json({ message: "No checkoutId present, acknowledged" }, { status: 200 });
  }

  // Deduplication by checkoutId
  if (processedCheckouts.has(checkoutId)) {
    console.log(`[WEBHOOK DEDUPE] Checkout ${checkoutId} already processed, skipping`);
    return NextResponse.json({ status: "already_processed" }, { status: 200 });
  }
  processedCheckouts.add(checkoutId); // ATOMIC CLAIM — before any async work (TOCTOU fix)

  // Principle: A webhook is a wake-up call, not truth.
  // Check if webhook signals terminal success; if not, acknowledge with 200 without fulfilling
  const webhookOutcome = mapResultCode(webhookResultCode);
  if (webhookOutcome !== "captured") {
    console.log(`[WEBHOOK IGNORED] Non-terminal code: ${webhookResultCode} (${webhookOutcome})`);
    processedCheckouts.delete(checkoutId); // roll back claim
    return NextResponse.json({ status: "acknowledged_non_terminal" }, { status: 200 });
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
      processedCheckouts.add(checkoutId);
      console.log(`[FULFILLED] Order confirmed for checkout ${checkoutId} | TxID: ${statusData["id"]} | Amount: ${confirmedAmount}`);
      return NextResponse.json({ status: "fulfilled" }, { status: 200 });
    } else {
      console.warn(`[WEBHOOK FULFIL REJECTED] Verification mismatch on /status. Code: ${confirmedCode}, Amount: ${confirmedAmount}, Expected: ${expectedAmount}`);
      processedCheckouts.delete(checkoutId); // roll back — allow retry
      return NextResponse.json({ status: "verification_failed" }, { status: 200 });
    }
  } catch (statusErr: any) {
    console.error(`[WEBHOOK ERROR] Failed to fetch /status for ${checkoutId}:`, statusErr.message);
    return NextResponse.json({ error: "Failed to verify status" }, { status: 500 });
  }
}
