import Link from "next/link";

export default function HomePage() {
  return (
    <main style={{ maxWidth: "600px", margin: "60px auto", padding: "0 20px" }}>
      <h1>Peach Payments Checkout V2 Demo</h1>
      <div style={{ border: "1px solid #e0e0e0", borderRadius: "8px", padding: "24px", marginTop: "24px" }}>
        <h3>Integration Guide & Reference</h3>
        <p>Amount: <strong>R10.00</strong> (Major-unit decimal string: "10.00")</p>
        <p>Payment Method: Card (Sandbox)</p>
        <Link
          href="/checkout"
          style={{
            display: "inline-block",
            background: "#0052cc",
            color: "#fff",
            padding: "12px 24px",
            borderRadius: "6px",
            textDecoration: "none",
            fontWeight: 600,
            marginTop: "16px",
          }}
        >
          Proceed to Checkout
        </Link>
      </div>
    </main>
  );
}
