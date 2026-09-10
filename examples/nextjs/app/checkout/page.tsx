"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Script from "next/script";

// Type declaration for the global Peach Checkout SDK
declare global {
  interface Window {
    Checkout?: {
      initiate: (options: {
        key: string;
        checkoutId: string;
        eventHandlers?: {
          onCompleted?: (event: any) => void;
          onCancelled?: (event?: any) => void;
          onExpired?: (event?: any) => void;
          onError?: (event: any) => void;
        };
      }) => {
        render: (selector: string) => void;
        unmount?: () => void;
      };
    };
  }
}

export default function CheckoutPage() {
  const router = useRouter();
  const [sdkReady, setSdkReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function handleStartPayment() {
    setLoading(true);
    setErrorMsg(null);

    try {
      if (!window.Checkout) {
        throw new Error("Peach Checkout SDK is still loading. Please try again in a moment.");
      }

      // 1. Create checkout session via server-side route handler
      const res = await fetch("/api/checkout", { method: "POST" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to create checkout session");
      }

      const { checkoutId, entityId } = await res.json();

      // 2. Initialize Checkout V2 Embedded Widget
      // entityId doubles as the browser SDK semi-public key
      const checkoutInstance = window.Checkout.initiate({
        key: entityId,
        checkoutId: checkoutId,
        eventHandlers: {
          onCompleted: (event: any) => {
            console.log("Peach onCompleted event:", event);
            // Providing onCompleted suppresses the default redirect; route to our result page
            router.push(`/checkout/result?checkoutId=${encodeURIComponent(event.checkoutId)}`);
          },
          onCancelled: () => {
            console.log("Peach onCancelled event");
            setErrorMsg("Payment cancelled by shopper. You can try again.");
            setLoading(false);
          },
          onExpired: () => {
            console.log("Peach onExpired event");
            // 30-minute session TTL expired; checkoutId cannot be reused.
            setErrorMsg("Checkout session expired. Please restart checkout.");
            setLoading(false);
          },
          onError: (err: any) => {
            console.error("Peach onError event:", err);
            setErrorMsg("Payment processing error. Please check card details.");
            setLoading(false);
          },
        },
      });

      // 3. Render widget to the container (returns void — do NOT await)
      checkoutInstance.render("#peach-checkout-root");
    } catch (err: any) {
      console.error("Failed to initiate checkout:", err);
      setErrorMsg(err.message || "Failed to initialize payment");
      setLoading(false);
    }
  }

  return (
    <>
      {/* Load Peach Checkout V2 Embedded SDK script */}
      <Script
        src="https://sandbox-checkout.peachpayments.com/js/checkout.js"
        strategy="afterInteractive"
        onLoad={() => setSdkReady(true)}
      />

      <main style={{ maxWidth: "680px", margin: "40px auto", padding: "0 20px", color: "#222" }}>
        <h1>Card Checkout</h1>

        <div style={{ border: "1px solid #e0e0e0", borderRadius: "8px", padding: "24px", marginBottom: "24px" }}>
          <h3>Integration Reference Order</h3>
          <p>Amount: <strong>R10.00</strong> (Major-unit decimal string: "10.00")</p>
          <p>Payment Method: Card (Sandbox)</p>

          <button
            onClick={handleStartPayment}
            disabled={loading || !sdkReady}
            style={{
              background: loading || !sdkReady ? "#ccc" : "#0052cc",
              color: "#fff",
              border: "none",
              padding: "12px 24px",
              fontSize: "16px",
              borderRadius: "6px",
              cursor: loading || !sdkReady ? "not-allowed" : "pointer",
              fontWeight: 600,
            }}
          >
            {loading ? "Starting Payment..." : sdkReady ? "Pay R10.00 Now" : "Loading SDK..."}
          </button>

          {errorMsg && (
            <div style={{ marginTop: "16px", padding: "12px", background: "#ffebe6", color: "#de350b", borderRadius: "6px" }}>
              {errorMsg}
            </div>
          )}
        </div>

        {/* Embedded checkout container MUST have explicit height of at least 640px */}
        <div id="peach-checkout-root" style={{ height: "640px", minHeight: "640px" }} />
      </main>
    </>
  );
}
