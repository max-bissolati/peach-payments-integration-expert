# 3-D Secure — behaviour control, exemptions, and special authentication modes

## When to load
Load for: controlling SCA/3DS behaviour programmatically, exemption strategy and `300.100.100` soft-decline handling, raising frictionless-authentication rates, recurring × 3DS interactions, and 3RI / NPA / decoupled / Identity Check Insights questions. The Checkout widget's automatic 3DS is covered in `checkout-v2.md`; in-app 3DS in `mobile.md`; 3DS test cards and simulator-forcing parameters in `testing-and-go-live.md`.

## Where 3-D Secure runs per surface
| Surface | Who does the 3DS work |
|---|---|
| COPYandPAY / Checkout | The widget handles the extra communication and collects the required browser-based information automatically. The parameter surface below is not your job (`checkout-v2.md`). |
| Server-to-Server | You do: follow EMVCo's frontend guidelines, send the browser/card data below, and handle the 3DS response — it can differ from non-3DS payment responses. |
| Mobile SDK (Android/iOS) | Native in-app authentication via the SDK — do not hand-roll browser 3DS inside an app (`mobile.md`). |
| Standalone 3DS / standalone exemption (S2S endpoints) | Fully manual: you collect card data (requires **full PCI compliance**) and drive iframes + status polling yourself (see Traps). |

WebView warning: browser-based 3DS inside a WebView may work in some cases but is **not officially supported by EMVCo**, is not guaranteed to function, and can result in an increased rate of 3DS failures. Native apps use the Mobile SDK (`mobile.md`).

## S2S parameter surface (3DS2 cards)
Send **as many parameters as possible**: richer data improves the risk checks during risk-based authentication and increases the share of **frictionless** flows.

Basic payment data (all Required; `card.holder` "required unless market or regional mandate restricts sending this information"):

| Parameter | Format |
|---|---|
| `card.number` | numeric, 13–19 |
| `card.expiryMonth` / `card.expiryYear` | 2 / 4 numeric |
| `card.holder` | string, 2–45 |
| `amount` | numeric, 2 minor units, max 12 chars |
| `currency` | ISO 4217 A3 |

Browser data:

| Parameter | Format | Condition |
|---|---|---|
| `customer.browser.acceptHeader` | string, max 2048 | Required |
| `customer.browser.userAgent` | string, max 2048 | Required |
| `customer.browser.language` | string, 1–8 (`navigator.language`) | Required |
| `customer.browser.screenHeight` / `screenWidth` | numeric, 1–6 (`screen.height` / `screen.width`) | Required |
| `customer.browser.timezone` | numeric, 1–5 (`getTimezoneOffset()`) | Required |
| `customer.browser.javascriptEnabled` | `true` / `false` | Required |
| `customer.browser.javaEnabled` | `navigator.javaEnabled` | Required when `javascriptEnabled=true`; else optional |
| `customer.ip` | max 45, IPv4 | Required unless market/regional mandate restricts |
| `customer.browser.screenColorDepth` | `1` `4` `8` `15` `16` `24` `32` `48` (bit depth) | Optional |
| `customer.browser.challengeWindow` | `01` 250x400 · `02` 390x400 · `03` 500x600 · `04` 600x400 · `05` Full screen | Optional |

Customer/address: `customer.email` (max 128), `billing.city`/`street1`/`postcode` (strings), `billing.country` (ISO 3166-1 A2), and **one of** `customer.phone` / `customer.workPhone` / `customer.mobile` (max 20, `+ccc-nnnnnnnn`) — all required unless a market/regional mandate restricts. Optional: `billing.street2`, `billing.state` (ISO 3166-2, max 3), the `shipping.*` set.

Account/history `customParameters` (not required, strongly recommended — they sharpen the issuer's risk check → more frictionless flows), grouped:
- Authentication history: `ReqAuthMethod` (`01` none … `06` FIDO), `ReqAuthTimestamp` (`YYYYMMDDHHMM`).
- Prior 3DS: `PriorAuthMethod` (`01` frictionless … `04` other), `PriorAuthTimestamp`, `PriorReference` (prior `acsTransactionId`), `PriorAuthData` (prior `dsTransID`, ≤2048 chars), `AAVRefresh` (`true`/`false`).
- Account age/change: `AccountId`, `AccountAgeIndicator` (`01` guest … `05` >60 days), `AccountDate`, `AccountChangeDate`/`Indicator`, `AccountPasswordChangeDate`/`Indicator`, `AccountPurchaseCount` (last 6 months), `AccountProvisioningAttempts` (24 h), `AccountDayTransactions`, `AccountYearTransactions`.
- Payment account / shipping: `PaymentAccountAge(Date|Indicator)`, `ShipAddressUsage(Date|Indicator)`, `ShipIndicator` (`01` ship-to-billing … `07` other), `ShipNameIndicator` (`01` match / `02` differs).
- Order/risk: `SuspiciousAccountActivity` (`01`/`02`), `TransactionType` (`01` goods, `03` check, `10` funding, `11` quasi-cash, `28` prepaid load), `DeliveryTimeframe` (`01`–`04`), `DeliveryEmailAddress`, `ReorderItemsIndicator`, `PreOrderPurchaseIndicator`, `PreOrderDate`, `GiftCardAmount`/`Currency`/`Count`.

3-D Secure specific parameters:

| Parameter | Purpose |
|---|---|
| `threeDSecure.amount` + `threeDSecure.currency` | Authentication amount/currency when they differ from the payment amount (amount unknown at auth time; instalments). Payment `amount`/`currency` stay mandatory; if omitted, the customer authenticates with the payment amount. |
| `threeDSecure.challengeIndicator` | Challenge preference — table below. |
| `threeDSecure.exemptionFlag` | Request an exemption — `01`–`04` below. |
| `threeDSecure.decoupled` | `true` requests decoupled authentication. |
| `threeDSecure.npa` | `true` forces non-payment authentication. |
| `threeDSecure.channel` + `threeDSecure.threeRIInd` | 3RI authentication. |
| `threeDSecure.messageCategory` | `MASTERCARD_IDCI` requests Identity Check Insights. |

`threeDSecure.challengeIndicator` values (a preference the issuer weighs during risk assessment — it does **not** guarantee a challenge or its absence):

| Value | Preference | Meaning |
|---|---|---|
| `01` | No preference | Issuer decides. |
| `02` | No challenge requested | Frictionless flow only. |
| `03` | Challenge requested | 3DS requestor preference. |
| `04` | Challenge requested: Mandate | You must authenticate (e.g. regional mandates). |
| `05` | No challenge requested | Transactional risk analysis already performed. |
| `06` | No challenge requested | Data share only. |
| `07` | No challenge requested | Strong consumer authentication already performed. |
| `08` | No challenge requested | Allowlist exemption, no challenge needed. |
| `09` | Challenge requested | Allowlist prompt if a challenge is needed. |

Default: for initial 3DS2 CIT requests and any 3DS2 transaction with `createRegistration=true`, `challengeIndicator` is populated with `04` when the merchant sends no value; merchant-provided values are not overridden.

Response values: the `threeDSecure` object carries brand-agnostic fields — `eci`, `verificationId`, `version`, `flow` (`challenge`/`frictionless`), `dsTransactionId`, `challengeMandatedIndicator`, `authenticationType`, `acsTransactionId`, `cardHolderInfo` (issuer text, useful on declines), plus `errorCode`/`errorDescription`/`errorSource` on error. Brand-specific values (e.g. Cartes Bancaires `CB_Score`) land in `resultDetails`.

## Exemption management
Exemptions are transactions that don't need strong customer authentication and don't necessarily need explicit cardholder authentication — no prior authentication for authorisation, or a frictionless flow. Types: **low value**, **low risk** (TRA), **trusted beneficiary** (cardholder allowlisted the merchant), **corporate card**.

Request via `threeDSecure.exemptionFlag`: `01` low value · `02` TRA · `03` trusted beneficiary · `04` corporate card. Caveats: **the issuer can override** an exemption request, and **some acquirers disallow specific exemptions** — consult your acquirer.

Soft decline `300.100.100` = the acquirer rejected an exemption requested via authorisation (skipping the 3DS call). Handling options:
1. Manual: re-send the transaction through 3-D Secure authentication, then authorise with the authentication result. For the manual retry include `threeDSecure.challengeIndicator=04`.
2. Automatic: the gateway retries the transaction itself.

Retried transactions always involve a **challenge flow**. Soft declines can also occur *after* frictionless authentication (you frictionless-authed when you should have challenged).

Out-of-scope (SCA) transactions — send directly for authorisation, but flag them:

| Transaction type | Flag |
|---|---|
| Mail order / telephone order | `transactionCategory` = `MO` or `TO` |
| Recurring transactions (MIT subscriptions) | `recurringType` = `REPEATED` |
| Merchant-initiated transactions | `standingInstruction.source` = `MIT` |

Standalone exemption check (card facade, sandbox `https://sandbox-card.peachpayments.com/v1/exemption`; full PCI required): read `resultDetails.RiskRuleCategory` — `SCAEX_` prefix plus `00` none / `01` low-value / `02` TRA / `03` trusted beneficiary / `04` corporate — then send that value as `threeDSecure.exemptionFlag` on the payment.

### S2S standalone 3DS challenge flow (the redirect object) `[DOCS]`
Standalone 3DS is `POST /v1/threeDSecure`. When a challenge is needed the response is `result.code`
`000.200.000` ("pending") plus a **`redirect` object** you must drive from the browser:
- `redirect.url` — the ACS authentication URL to load in an iframe.
- `redirect.parameters[]` — an array of `{name, value}` pairs to POST to `redirect.url` (creq/threeDS
  fields).
- `redirect.preconditions[]` (optional, first) — the ACS **method-data** step: POST
  `preconditions.parameters[]` (e.g. `{name:"threeDSMethodData", value:…}`) to `preconditions.url` in a
  **hidden** iframe, wait for its `onLoad`, THEN load the `redirect.url` authentication iframe.
Complete/resume by polling `GET /v1/threeDSecure/{id}?entityId=…` for the terminal status, then send the
payment with the 3DS result. Full PCI applies (you hold the card data). The merchant-side risk-rule
TUNING that decides frictionless-vs-challenge appears to be configured in the Dashboard, not via the
API — Peach publishes no request parameter for it `[VERIFY-SANDBOX]`.

## Recurring × 3DS
- Scheme rules for MIT agreements: there must be an **originating CIT**; that initial CIT **must go through SCA**; schemes mandate `threeDSecure.challengeIndicator=04` on the initial CIT to force it. Miss this and future MIT requests can fail for want of SCA.
- `standingInstruction.expiry` (`YYYY-MM-DD`, future) and `standingInstruction.frequency` (1–9999 days) are **mandatory when processing 3-D Secure on recurring transactions**, optional otherwise.
- After the 3DS'd CIT, MIT debits carry **no 3DS parameters** (and no CVV) — their presence breaks the flow (`recurring-and-tokenisation.md`).
- Network tokens: issuers can **silently authenticate** cardholders via 3DS — frictionless without challenges — and Peach provisions the network token before 3DS/payment and uses it when active (`recurring-and-tokenisation.md`).

## Special authentication modes
- **3RI** (3DS Requestor Initiated Authentication): merchant-initiated authentication while the cardholder is absent, leveraging SCA already obtained in-session — instalments, recurring, split/delayed shipment, one auth across multiple merchants (travel agents, marketplaces), re-authorising after a refund, unknown final amounts (car rental damages), and requesting a fresh CAVV when authorising >90 days after authentication. CAVVs and amounts are single-use: a 3RI is a **new** authentication, not an amount merge. Send `threeDSecure.channel=01`, `customParameters[PriorReference]` (prior `acsTransactionId`), `customParameters[PriorAuthData]` (prior `dsTransactionId`), `threeDSecure.threeRIInd` = `RECURRING` | `SPLIT_SHIPMENT` | `DELAYED_SHIPMENT`; optional `PriorAuthTimestamp` (`YYYYMMDDHHMM`) and `PriorAuthMethod` (`01`–`04`). Process the resulting CAVV like a customer-present CAVV.
- **NPA** (non-payment authentication): authenticate when no payment happens or the amount is unknown — storing a card without a purchase, zero-amount card verification. Registration-time 3DS must first be enabled by Peach support; with `createRegistration=true` on a PA, 3DS runs on the payment, not the registration. A zero-amount PA triggers NPA automatically once 3DS is enabled; force it on a non-zero amount with `threeDSecure.npa=true`. The authenticated amount must be ≥ the payment amount; `amount=0.00` with `threeDSecure.amount>0` authenticates at `threeDSecure.amount`.
- **Decoupled authentication**: `threeDSecure.decoupled=true` — the cardholder authenticates outside the challenge iframe (e.g. in a separate banking app). Not all issuers support it; unsupported means the customer falls back to the normal challenge workflow.
- **Identity Check Insights** (Mastercard, formerly Data Only): shares cardholder data over EMV 3DS rails (message category 80, not sent to the ACS) so Mastercard's Smart Authentication engine — not the issuer ACS — generates `ECI`/`AAV`/`dsTransactionId`, influencing approval without a challenge and without challenge latency. Request with `threeDSecure.messageCategory=MASTERCARD_IDCI`. There is **no fraud liability shift** to the issuer, and never use it for "Card Add" transactions — adding a card on file requires SCA, which Insights does not support.

## Traps
- Assuming Checkout needs any of this: COPYandPAY collects browser data and runs 3DS itself — these parameters are for S2S / card-facade builds only.
- Exemption ≠ guaranteed: the issuer may override the request and some acquirers disallow specific exemptions; build for the `300.100.100` soft decline, not "exemption accepted".
- Omitting browser data / account-history `customParameters` doesn't error — it silently degrades risk checks and pushes more customers into challenges.
- Sending 3DS parameters (or CVV) on an MIT debit breaks the flow (`recurring-and-tokenisation.md`); 3DS belongs on the CIT, then flag MITs as out of scope.
- Forgetting `challengeIndicator=04` on the initial CIT (or skipping SCA there) risks payment failures on all future MITs.
- S2S standalone 3DS is real frontend work: optional preconditions iframe (`redirect.preconditions.*`) → authentication iframe from `redirect.url`/`redirect.parameters[]` → poll `/v1/threeDSecure/{id}` — and full PCI compliance, since you handle card data.
- Format: use the **2-character** `threeDSecure.challengeIndicator` (`01`–`09`; the parameter reference's schema is `0[1-9]`, and the public pages use e.g. `04`). The testing guide's bare `4` is the outlier — treat it as sandbox shorthand and send the zero-padded form (`04`) in production. `[DOCS]`
