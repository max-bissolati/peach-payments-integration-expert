# Legacy Surfaces

## When to load
Load when an existing codebase shows `/v1/checkouts` + `paymentWidgets.js`, oppwa-style URLs, Mobile SDK V1, or Checkout V1 `/status` — identify what you're looking at BEFORE proposing changes or "migrations".

## 1. Identity table

| Legacy surface | What it is | Tell-tale signs | Often confused with | Current equivalent |
|---|---|---|---|---|
| **COPYandPAY** | SAQ-A payment widget (the classic widget flow) | `POST /v1/checkouts`; `paymentWidgets.js`; `wpwlOptions` config object | Checkout V2 (no deprecation banner on its docs) | **Checkout Embedded/Hosted V2** (`/v2/checkout` + `checkout.js` SDK) |
| **Server-to-Server (OPPWA)** | Direct API with raw card data; parameters in the request body (never the URL); registration + network tokens; standalone 3DS and exemption handling done merchant-side | `POST /v1/payments` with `card.number`; oppwa parameter style | Payments API v2 (different surface; v2 is non-card) | **Payments API v2** for non-card; **Embedded + tokenisation** (`createRegistration`) for cards — raw-card S2S still exists but carries SAQ A-EP/D (`pci-security.md`) |
| **Checkout V1 status** | Old signed status read | `GET /v1/checkout/{id}/status` style / `/status?...&signature=` calls | Checkout V2 status | **`GET /v2/checkout/{checkoutId}/status`** (Bearer, flat dotted keys) |
| **Mobile SDK V1** | Legacy native SDK | SDK <8.x imports; IPWorks references; manual download via support | Mobile SDK V2 | **Mobile SDK V2** (`mobile.md`) |

Deprecation-status honesty: **the docs carry no deprecation banners** on these pages, and the `oppwa-*` URL tree hosts BOTH legacy and current documentation — agents regularly read COPYandPAY pages as current Checkout V2. Check the endpoints, not the page styling.

## 2. COPYandPAY specifics (for reading old code)

- Config via `wpwlOptions` (styles, brands, callbacks) — V2 has no `wpwlOptions`; equivalent behaviour moved to `Checkout.initiate` options/customisations (`checkout-v2.md`).
- Checkout ID valid **30 minutes**; if the shopper's browser is closed, the widget **auto-calls `shopperResultUrl` after ~29 minutes** — servers must tolerate that late callback.
- **ID-reuse trap**: reusing a checkout ID can create **multiple transactions** (one failed, one successful). Treat checkout IDs as single-use; that rule carries into V2 (not reusable after `unmount()`).
- One-click: `registrations[n].id` + `standingInstruction.mode=REPEATED, source=CIT, type=UNSCHEDULED` — the same registration-token model V2 uses.

## 3. Do NOT over-migrate

**The V1 refund endpoint is STILL the current refund path for Checkout V2 payments.** `POST {apiHost}/v1/checkout/refund` (HMAC-signed, form-urlencoded, flat dotted keys, payment `id` in the body) is what Checkout V2-origin refunds use — it is not legacy for this purpose. "Migrating" it to V2 would break refunds. `[PLUGIN-VERIFIED]`

Refund routing by origin (`payments-api.md` covers the others): Checkout-origin payment → V1 signed refund endpoint · Payments API-origin → `POST /payments/{uniqueId}` with `paymentType=RF` · any → Dashboard (role-gated).

## 4. Modernisation direction

| Old code | Action |
|---|---|
| COPYandPAY widget | Map to Checkout Embedded (SDK `initiate`/`render`, eventHandlers replace wpwlOptions callbacks); Hosted if redirect was in use |
| `/status?...&signature=` reads | Replace with `GET /v2/checkout/{id}/status` (Bearer auth; the old signed-status pattern is deprecated — the signature can't be reused) |
| Raw-card S2S payment calls | Replace with `createRegistration` tokenisation on Checkout at SAQ A; if raw-card S2S must stay, it also needs merchant-side EMVCo 3DS handling (standalone 3DS / exemption management are S2S features) — budget for the PCI cost first |
| Network-token logic | Carry across: network tokens are current (`recurring-and-tokenisation.md`); the expiry-keyed test cards still apply |
| Mobile SDK V1 | Plan migration to V2 (`mobile.md`); V1's cert-expiry episode is the risk argument |

Reading old S2S/OPPWA code: request parameters live in the body (never URL); MIT/reg-token semantics (`paymentType` TK/TF, cryptogram rules) match the current tokenisation model — see `recurring-and-tokenisation.md` rather than re-deriving from the OPPWA pages.

### Migrating COPYandPAY → Checkout V2: credential continuity

Your legacy build authenticates with the **card-facade entity ID + bearer token** (COPYandPAY /
S2S / recurring Dashboard sections). Checkout V2 does not use those: it needs its own **OAuth
client credentials** — client ID, client secret, merchant ID (plus V2 entity + secret token) from
Dashboard → **Checkout → API keys**. Provision the V2 credential set as part of the migration and
confirm with Peach support whether your existing entity serves both surfaces during transition.
Expect a full re-plumb of prepare-checkout → `/v2/checkout` + OAuth, the widget swap
(`paymentWidgets.js` → `checkout.js`), and `resourcePath` status reads → `GET /v2/checkout/{id}/status`.

## COPYandPAY capabilities worth knowing before refusing

- **Apple Pay IS documented on COPYandPAY**: `data-brands="APPLEPAY"` + `wpwlOptions.applePay`
  configuration (`[DOCS — copyandpay-apple-pay]`). So "the legacy widget can't do wallets" is FALSE —
  if a merchant asks for Apple Pay on an existing COPYandPAY form, it's a configuration change, not
  a migration blocker. Google Pay has an equivalent page. Migration to Checkout V2 remains the
  recommended path for NEW work; just don't refuse the capability on the old surface.

## Traps
- Identifying COPYandPAY docs/code as "current Checkout" — no deprecation banner exists; the `/v1/checkouts` + `paymentWidgets.js` pair is the giveaway.
- The `oppwa-*` URL tree mixes legacy and current pages — verify the endpoint path, not the page location.
- Over-migrating the V1 refund endpoint — it is the live refund path for Checkout V2 payments (signed HMAC, flat form body, 32-char payment `id`, NOT nested JSON). `[PLUGIN-VERIFIED]`
- V1 signed-GET status reused in new code — deprecated; signature can't be reused across requests.
- Assuming old COPYandPAY checkout IDs behave like V2 checkoutIds — both expire (~30 min) but COPYandPAY's auto-callback-at-29-min and ID-reuse multi-transaction behaviour are legacy-specific hazards.
