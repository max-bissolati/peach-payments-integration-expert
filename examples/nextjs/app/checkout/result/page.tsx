"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

interface StatusResult {
  checkoutId: string;
  resultCode: string;
  status: string;
  amount: string;
  currency: string;
  transactionId?: string;
  fulfilled: boolean;
}

function ResultContent() {
  const searchParams = useSearchParams();
  const checkoutId = searchParams.get("checkoutId") || searchParams.get("cid");
  const [data, setData] = useState<StatusResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!checkoutId) {
      setError("Missing checkoutId parameter.");
      setLoading(false);
      return;
    }

    async function fetchStatus() {
      try {
        const res = await fetch(`/api/checkout/${encodeURIComponent(checkoutId as string)}/status`);
        if (!res.ok) {
          throw new Error(`HTTP error ${res.status}`);
        }
        const json = await res.json();
        setData(json);
      } catch (err: any) {
        setError(err.message || "Failed to confirm payment status");
      } finally {
        setLoading(false);
      }
    }

    fetchStatus();
  }, [checkoutId]);

  if (loading) {
    return <div>Verifying payment status with server...</div>;
  }

  if (error || !data) {
    return (
      <div style={{ color: "#de350b" }}>
        <h3>Status Verification Failed</h3>
        <p>{error || "Could not retrieve transaction details."}</p>
        <Link href="/checkout" style={{ color: "#0052cc" }}>← Try again</Link>
      </div>
    );
  }

  const isSuccess = data.status === "captured";

  return (
    <div>
      <div
        style={{
          display: "inline-block",
          padding: "6px 12px",
          borderRadius: "4px",
          fontWeight: 600,
          fontSize: "14px",
          marginBottom: "16px",
          background: isSuccess ? "#e3fcef" : "#ffebe6",
          color: isSuccess ? "#006644" : "#de350b",
        }}
      >
        {isSuccess ? "Payment Successful" : `Payment ${data.status.toUpperCase()}`}
      </div>

      <div style={{ fontSize: "14px", lineHeight: "1.8" }}>
        <p><strong>Status:</strong> {data.status}</p>
        <p><strong>Result Code:</strong> {data.resultCode || "N/A"}</p>
        <p><strong>Amount:</strong> {data.amount} {data.currency}</p>
        <p><strong>Transaction ID:</strong> {data.transactionId || "N/A"}</p>
        <p><strong>Order Fulfilled:</strong> {data.fulfilled ? "Yes (Fulfillment Confirmed)" : "No"}</p>
      </div>

      <div style={{ marginTop: "24px" }}>
        <Link href="/" style={{ color: "#0052cc", textDecoration: "none", fontWeight: 500 }}>
          ← Return to Store
        </Link>
      </div>
    </div>
  );
}

export default function CheckoutResultPage() {
  return (
    <main style={{ maxWidth: "600px", margin: "60px auto", padding: "0 20px" }}>
      <div style={{ border: "1px solid #e0e0e0", borderRadius: "8px", padding: "24px", boxShadow: "0 2px 4px rgba(0,0,0,0.05)" }}>
        <h2>Payment Confirmation</h2>
        <Suspense fallback={<div>Loading result...</div>}>
          <ResultContent />
        </Suspense>
      </div>
    </main>
  );
}
