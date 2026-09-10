import { NextResponse } from "next/server";
import { getCheckoutStatus } from "@/lib/peach";
import { mapResultCode, isSuccessResultCode } from "@/lib/result-codes";
import { createdAmounts, processedCheckouts } from "@/lib/store";

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const checkoutId = params.id;
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
      console.log(`[ORDER FULFILLED] Verified checkout ${checkoutId} | TxID: ${statusData["id"]} | Amount: ${amount} ${statusData["currency"]}`);
    }

    return NextResponse.json({
      checkoutId,
      resultCode,
      status: statusState,
      amount,
      currency: statusData["currency"],
      transactionId: statusData["id"],
      paymentBrand: statusData["paymentBrand"],
      fulfilled: isCaptured && amountMatches,
    });
  } catch (err: any) {
    console.error(`[STATUS CONFIRM ERROR] Checkout ${checkoutId}:`, err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
