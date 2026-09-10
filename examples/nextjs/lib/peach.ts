import crypto from "crypto";

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

/**
 * Server-side OAuth token retrieval with dynamic caching.
 * Caches token based on Peach's returned expires_in value (sandbox observed at 14400s / 4h).
 * Refreshes ~60s before expiration. Does NOT hardcode a fixed token lifetime.
 */
export async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60000) {
    return cachedToken;
  }

  const authHost = process.env.PEACH_AUTH_HOST || "https://sandbox-dashboard.peachpayments.com";
  const clientId = process.env.PEACH_CLIENT_ID;
  const clientSecret = process.env.PEACH_CLIENT_SECRET;
  const merchantId = process.env.PEACH_MERCHANT_ID;

  if (!clientId || !clientSecret || !merchantId) {
    throw new Error("Missing required Peach credentials: PEACH_CLIENT_ID, PEACH_CLIENT_SECRET, PEACH_MERCHANT_ID");
  }

  const response = await fetch(`${authHost}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId, clientSecret, merchantId }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to obtain Peach access token (HTTP ${response.status}): ${errorText}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  // Use expires_in returned by Peach (default to 14400s if not specified; never hardcode 3600)
  const expiresInSec = typeof data.expires_in === "number" ? data.expires_in : 14400;
  tokenExpiresAt = Date.now() + expiresInSec * 1000;

  return cachedToken as string;
}

export interface CreateCheckoutParams {
  amount: string; // Major-unit decimal string like "10.00", never cents
  currency?: string;
  orderId?: string;
  shopperResultUrl?: string;
}

export interface CheckoutSessionResult {
  checkoutId: string;
  redirectUrl: string;
}

/**
 * Creates a Checkout V2 session on Peach Payments.
 * Enforces:
 * - BOTH Origin (no trailing slash) and Referer (with trailing slash) headers.
 * - Major-unit decimal string amount ("10.00"), never cents.
 * - Server-side execution only.
 */
export async function createCheckoutSession(params: CreateCheckoutParams): Promise<CheckoutSessionResult> {
  let token = await getAccessToken();
  const checkoutHost = process.env.PEACH_CHECKOUT_HOST || "https://testsecure.peachpayments.com";
  const entityId = process.env.PEACH_ENTITY_ID;

  if (!entityId) {
    throw new Error("Missing required PEACH_ENTITY_ID in environment");
  }

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
  // Verified requirement: BOTH Origin (NO trailing slash) and Referer (WITH trailing slash)
  const originHeader = appUrl;
  const refererHeader = `${appUrl}/`;

  // 8–16 alphanumeric characters for merchantTransactionId
  const merchantTxId = "TX" + crypto.randomBytes(6).toString("hex").toUpperCase();
  const nonce = crypto.randomUUID();
  // shopperResultUrl must be fully-qualified lowercase URL
  const shopperResultUrl = (params.shopperResultUrl || `${appUrl}/checkout/result`).toLowerCase();

  const payload = {
    "authentication.entityId": entityId,
    merchantTransactionId: merchantTxId,
    amount: params.amount || "10.00",
    currency: params.currency || "ZAR",
    nonce: nonce,
    shopperResultUrl: shopperResultUrl,
    defaultPaymentMethod: "CARD",
    forceDefaultMethod: true,
    paymentType: "DB",
    customer: {
      givenName: "Jane",
      surname: "Doe",
      email: "jane.doe@example.com",
    },
    customParameters: {
      orderId: params.orderId || `ORD-${Date.now()}`,
      createdAmount: params.amount || "10.00",
    },
  };

  let response = await fetch(`${checkoutHost}/v2/checkout`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Origin: originHeader,
      Referer: refererHeader,
    },
    body: JSON.stringify(payload),
  });

  // On 401 mid-flight: clear token, re-auth once, retry once
  if (response.status === 401) {
    cachedToken = null;
    tokenExpiresAt = 0;
    token = await getAccessToken();
    response = await fetch(`${checkoutHost}/v2/checkout`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Origin: originHeader,
        Referer: refererHeader,
      },
      body: JSON.stringify(payload),
    });
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to create checkout (HTTP ${response.status}): ${errText}`);
  }

  return response.json();
}

/**
 * Fetches status of a Checkout V2 session.
 * Response is a FLAT object with dotted string keys: obj["result.code"], obj["amount"], etc.
 */
export async function getCheckoutStatus(checkoutId: string): Promise<Record<string, any>> {
  const token = await getAccessToken();
  const checkoutHost = process.env.PEACH_CHECKOUT_HOST || "https://testsecure.peachpayments.com";

  const response = await fetch(`${checkoutHost}/v2/checkout/${encodeURIComponent(checkoutId)}/status`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to fetch checkout status (HTTP ${response.status}): ${errText}`);
  }

  return response.json();
}
