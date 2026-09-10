import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Peach Payments — Next.js Checkout Example",
  description: "Peach Payments Checkout V2 Card Flow integration with Next.js App Router",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif", margin: 0, padding: 0 }}>
        {children}
      </body>
    </html>
  );
}
