// Shared demo state (idempotency + per-checkout created amount).
// DEMO in-memory: replace with a DURABLE store (DB) in production — Peach retries up to 30 days, and a
// restart must not allow a re-fulfil. Read the created amount back by checkoutId and fulfil inside a
// DB transaction. Kept in its own module so unrelated routes can import shared state without pulling
// in signature-verification concerns.
const globalStore = globalThis as unknown as {
  processedCheckouts?: Set<string>;
  createdAmounts?: Map<string, string>;
};

export const processedCheckouts: Set<string> =
  globalStore.processedCheckouts ?? (globalStore.processedCheckouts = new Set<string>());

export const createdAmounts: Map<string, string> =
  globalStore.createdAmounts ?? (globalStore.createdAmounts = new Map<string, string>());
