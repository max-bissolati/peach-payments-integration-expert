import { NextResponse } from "next/server";
import { createCheckoutSession } from "@/lib/peach";
import { createdAmounts } from "@/lib/store";

export async function POST() {
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

    // Return browser-safe identifiers only.
    // NEVER return secrets or OAuth access tokens to the client.
    return NextResponse.json({
      checkoutId: session.checkoutId,
      entityId: process.env.PEACH_ENTITY_ID,
      redirectUrl: session.redirectUrl,
      amount,
      currency,
    });
  } catch (err: any) {
    console.error("[CHECKOUT CREATE ERROR]", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
