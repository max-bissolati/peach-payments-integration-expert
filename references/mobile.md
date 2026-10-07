# Mobile

## When to load
Load for any native mobile app payment question (iOS/Android), for hybrid apps (React Native,
Flutter, WebView) deciding how to integrate, and for anyone who says "Mobile SDK" without saying
which version — the answer changes everything downstream (hosts, auth shape, webhook crypto).

For cashier apps accepting cards on a physical terminal, load `pos-integrations.md` and
`pos-expo-sunmi.md` instead. The online Mobile SDK V2 does not control Peach's card-present Payment App.

## 0. Two unrelated products both live under "mobile"

Peach has **two separate mobile-payment products**. They do not share a backend, an auth model,
or a webhook format. Confirm which one a merchant is actually on before writing any code —
mixing hosts/credentials between them fails outright.

| | **Mobile SDK V2 / Peach Orchestration** (this file, §1–§8) | **Checkout V2** (`checkout-v2.md`) |
|---|---|---|
| Native SDKs | Yes — iOS, Android, **and official React Native / Flutter packages** `[DOCS playground.peachpayments.com/sdk-mobile/*]` | No native SDK for any platform |
| Core object | `PaymentIntent` + `client_secret` | `checkoutId` |
| Auth | `api-key` header, secret in the request | OAuth bearer token |
| API host | `app.sandbox-next.peachpayments.com/api` (sandbox) / `app.next.peachpayments.com/api` (live) | `secure.peachpayments.com` / `testsecure.peachpayments.com` |
| Webhook signing | HMAC-SHA512, header `x-webhook-signature-512` `[DOCS playground.peachpayments.com/flows/webhooks]` | Form-POST, own signature scheme — see `webhooks.md` |
| Hybrid app path | Official RN/Flutter SDK — no WebView needed | WebView Checkout only (§9 below) — no RN/Flutter SDK exists for Checkout V2 |

**Correction to earlier guidance**: this file previously said no React Native or Flutter SDK
exists "for either SDK version." That was true for Checkout V2 and for legacy Mobile SDK V1, but
Mobile SDK V2 ships official `@peach-payments/react-native` and
`peachpayments_flutter` packages `[DOCS]`. If a merchant is on Checkout V2, the WebView guidance
in §9 still stands.

The current React Native package is `@peach-payments/react-native@1.1.0`, replacing the earlier
reference to `@juspay-tech/hyperswitch-sdk-react-native`. Update install commands and imports
together. This package is for online payment sheets, not terminal card taps.

The rest of this section (§1–§8) covers Mobile SDK V2 / Peach Orchestration only. Orchestration is
bigger than its mobile SDKs: the server-side REST API (capture/refund/mandates/customers/webhooks) is in
`orchestration-api.md` and the browser Web SDK is in `sdk-web.md` — this file is the native-app view of the
same backend.

## 1. Decision: which SDK / approach

| App type, on Peach Orchestration | Approach |
|---|---|
| Native iOS | **Mobile SDK V2 iOS** (Swift, `Hyperswitch` module). Min **iOS 15.1+**. `[DOCS]` |
| Native Android | **Mobile SDK V2 Android** (Kotlin, `io.peachpayments`). Min **Android 7.0 / API 24+**. `[DOCS]` |
| React Native | Official `@peach-payments/react-native` wraps the native iOS/Android SDKs. Min **RN 0.70+**; guide says Android `minSdkVersion 21`, conflicting with native API 24 below. `[DOCS]` |
| Flutter | Official `peachpayments_flutter` wraps the native SDKs. Min **Flutter 3.0+ / Dart 2.17+**, iOS 15.1; guide says Android minSdk 21, conflicting with native API 24 below. `[DOCS]` |
| Any app already on Checkout V2 (not Orchestration) | No native SDK — use Checkout-in-WebView per §9, or migrate the merchant to Orchestration first. |

Confirm the provisioned product and credential type. Orchestration publishable keys use
`pk_snd_...` / `pk_prd_...`; a generic `pk_` prefix alone is not proof that a key belongs in an app.
The POS Integrations docs use `pk_live_...` for a merchant API key that must stay on your backend.
Checkout V2 uses OAuth client/secret credentials.

**Android minimum conflict:** the native Android guide says API 24+, while the React Native and
Flutter guides still say minSdk 21. These wrappers use the native layer. Treat API 24 as a
conservative planning floor and verify the selected package's merged manifest, Gradle build,
and real-device behavior before promising older Android support. Do not force a lower minimum
by overriding a dependency requirement.

## 2. Mobile SDK V2 — install & bootstrap

Versions below were rechecked on **2026-10-07** against the platform guides and the
2026-10-05 release notes. They are documentation-verified, not build-tested.

All four platforms follow the same three-step shape: **create a session with a publishable key →
init with a server-issued `client_secret` → present the payment sheet.**

| Platform | Package | Current version `[DOCS]` | Distribution |
|---|---|---|---|
| iOS | `peachpayments-hyperswitch-ios` (+ `-lite`, `-authentication`) | `0.7.4` | CocoaPods, **private spec repo**, not trunk |
| Android | `io.peachpayments:hyperswitch-sdk-android` | `1.5.5` (Gradle plugin `0.2.14`) | Peach's own GitLab Maven registry, anonymous read |
| React Native | `@peach-payments/react-native` | `1.1.0` | npm + CocoaPods for the iOS side |
| Flutter | `peachpayments_flutter` (+ `_netcetera_3ds`, `_scancard` optional; `_airborne` not yet published) | core `1.4.0`; optional plugins `1.1.3` | pub.dev |

```ruby illustrative
# iOS Podfile — BOTH sources are required, the pod is not on CocoaPods trunk
source 'https://github.com/peach-payments/hyperswitch-sdk-ios.git'
source 'https://cdn.cocoapods.org/'
pod 'peachpayments-hyperswitch-ios', '~> 0.7.4'
```
`[DOCS playground.peachpayments.com/sdk-mobile/ios]` Then `pod repo update && pod install`. The
Swift module is imported as `import Hyperswitch` (this is the module name the pod exposes) —
keep that import line as-is; don't rename it.

```kotlin illustrative
// Android — Peach's Maven registry (anonymous reads, no token) plus two transitive hosts
maven { url = uri("https://gitlab.com/api/v4/projects/81506485/packages/maven") }
maven { url = uri("https://maven.juspay.in/hyper-sdk/") }
maven { url = uri("https://jitpack.io") }

implementation("io.peachpayments:hyperswitch-sdk-android:1.5.5")
// ProGuard/R8: -keep class io.peachpayments.** { *; }
```
`[DOCS playground.peachpayments.com/sdk-mobile/android]` The Gradle **plugin** bump (`0.2.14`) is
not cosmetic — it pins the SDK version inside its own artifact, so an old plugin silently keeps
resolving an old SDK even after you bump the dependency line.

```yaml illustrative
# Flutter pubspec.yaml
dependencies:
  peachpayments_flutter: ^1.4.0
  peachpayments_flutter_netcetera_3ds: ^1.1.3   # optional
  peachpayments_flutter_scancard: ^1.1.3        # optional
```
`[DOCS playground.peachpayments.com/sdk-mobile/flutter]` Then `flutter pub get`, and — Android
only — run `dart run peachpayments_flutter:apply_plugins` **after every upgrade**, not just once.
On iOS the Flutter plugin still needs both Podfile sources above (it depends on
`peachpayments-hyperswitch-ios/sentry`). **Breaking Android requirement**: `MainActivity` must
extend `FlutterFragmentActivity`, not `FlutterActivity`, or the wallet-button widget fails to
attach.

React Native install: `npm install @peach-payments/react-native@1.1.0` then
`cd ios && pod install`. The RN guide lists Android `minSdkVersion 21`; apply the native
minimum conflict check in §1 before selecting the actual minimum. `[DOCS]`

### Bootstrap code, all four platforms

```swift illustrative
// iOS
import Hyperswitch
let paymentSession = PaymentSession(
    publishableKey: "pk_snd_your_publishable_key",
    customBackendUrl: "https://app.sandbox-next.peachpayments.com/api"
)
paymentSession.initPaymentSession(paymentIntentClientSecret: clientSecret)
let configuration = PaymentSheet.Configuration()
paymentSession.presentPaymentSheet(viewController: self, configuration: configuration) { result in
    switch result {
    case .completed(let data): break   // success
    case .canceled(let data): break    // user dismissed
    case .failed(let error): break     // error
    }
}
```
`[DOCS playground.peachpayments.com/sdk-mobile/ios]`

```kotlin illustrative
// Android
import io.peachpayments.PaymentSession
import io.peachpayments.paymentsheet.PaymentSheet
import io.peachpayments.paymentsheet.PaymentSheetResult

paymentSession = PaymentSession.Builder(this, "pk_snd_your_publishable_key")
    .customBackendUrl("https://app.sandbox-next.peachpayments.com/api")
    .build()
paymentSession.initPaymentSession(clientSecret)
paymentSession.presentPaymentSheet { result ->
    when (result) {
        is PaymentSheetResult.Completed -> {}
        is PaymentSheetResult.Canceled -> {}
        is PaymentSheetResult.Failed -> { /* result.error */ }
    }
}
```
`[DOCS playground.peachpayments.com/sdk-mobile/android]` Create the `PaymentSession` inside the
Activity's `onCreate()`.

```typescript illustrative
// React Native
import { HyperProvider, useHyper } from '@peach-payments/react-native';

<HyperProvider publishableKey="pk_snd_your_publishable_key"
  customBackendUrl="https://app.sandbox-next.peachpayments.com/api">
  {/* app */}
</HyperProvider>

const { initPaymentSession, presentPaymentSheet } = useHyper();
const session = await initPaymentSession({ clientSecret, merchantDisplayName: 'Your Store' });
const result = await presentPaymentSheet(session);   // { type_, code, message, status }
```
`[DOCS playground.peachpayments.com/sdk-mobile/react-native]` `status === 'cancelled'` means the
shopper dismissed the sheet. `initPaymentSession` must resolve before `presentPaymentSheet` is
called — there's no internal queueing.

```dart illustrative
// Flutter
final _peach = PeachPayments();
_peach.init(HyperConfig(
  publishableKey: 'pk_snd_your_publishable_key',
  customBackendUrl: 'https://app.sandbox-next.peachpayments.com/api',
));
await _peach.initPaymentSession(PaymentSheetParams(clientSecret: checkoutData.clientSecret));
final result = await _peach.presentPaymentSheet();   // Map<String, dynamic>?
```
`[DOCS playground.peachpayments.com/sdk-mobile/flutter]` If a build breaks after upgrading, `flutter clean && flutter pub get` is the documented first move.

## 3. Server side — PaymentIntent, not checkoutId

The SDK never creates its own intent. Server responsibilities:

1. `POST {api-host}/payments` with `api-key` header (merchant secret key) — body includes `amount`
   (**minor units**, e.g. `6500` = R65.00 — unlike Checkout V2's decimal-string major units),
   `currency`, `confirm: false`, `capture_method` (`automatic` | `manual` | `manual_multiple` |
   `scheduled` | `sequential_automatic` — see `orchestration-api.md` §3), `authentication_type`
   (e.g. `no_three_ds`), `return_url`. Response includes a `client_secret`. `[DOCS
   playground.peachpayments.com/playground]`
2. Return only the `client_secret` (and publishable key context) to the app — never the secret
   key.
3. App: `initPaymentSession(clientSecret)` → `presentPaymentSheet()`.
4. Server confirms the outcome via `GET /payments/{payment_id}` and/or the webhook (§7) — same
   don't-trust-the-client-event discipline as every other Peach surface (`checkout-v2.md`,
   `payments-api.md`).

Hosts: sandbox `https://app.sandbox-next.peachpayments.com/api`, live
`https://app.next.peachpayments.com/api`. `[DOCS]`

## 4. Payment methods per platform

| Method | iOS | Android | React Native | Flutter |
|---|---|---|---|---|
| Cards (payment sheet) | Yes | Yes | Yes | Yes |
| Apple Pay | Yes — `PaymentSheet.ApplePayConfiguration`, plus a direct `ApplePayButton` for a branded button with no sheet | — | via iOS layer | via iOS layer, `PeachWalletButton(type: .applePay)` |
| Google Pay | — | Yes — `PaymentSheet.GooglePayConfiguration`; direct `BasePaymentWidget(paymentMethod="google_pay")` | Yes — `googlePay` config on `initPaymentSession` | Yes, `PeachWalletButton(type: .googlePay)` |
| Samsung Pay | — | Mentioned as requiring merchant-owned Samsung service ID/certs `[DOCS]` — **no code sample published**; treat as configuration-gated, verify availability before promising it | not documented | not documented |
| `ExpressCheckoutButton` / `expressCheckout` widget | Yes (renders every enabled wallet) | via `BasePaymentWidget(paymentMethod="expressCheckout")` | not documented separately | `WalletButtonType.expressCheckout` |
| Bank redirects | Yes | Yes (deep-link based) | not detailed | not detailed |
| PayJustNow (BNPL) | Yes | Yes | not detailed | not detailed |

`[DOCS]` for all rows above unless noted "not documented" — where the public pages are silent, this
draft does not invent behaviour. Availability of any wallet is decided at runtime by the SDK
(merchant-enabled + connector returns a session token + device supports it); an unavailable wallet
button **collapses to zero height rather than erroring** on all four platforms — always keep a
card fallback, and drive UI state off the readiness callback (`readyCallback` on Android,
`onReady` on Flutter), not off "the button exists."

### Wallet onboarding is merchant-owned, not automatic

- **Apple Pay**: merchant needs their own Apple merchant ID (`merchant.com.yourcompany`) and
  payment-processing certificate. Peach provides the CSR; the merchant registers the ID in the
  [Apple developer portal](https://developer.apple.com/account/resources/identifiers/list/merchant),
  adds the capability in Xcode, then sends the merchant ID + cert to Peach support to activate.
  `[DOCS]`
- **Google Pay**: merchant needs their own Google Pay merchant ID from the
  [Google Pay & Wallet Console](https://pay.google.com/business/console), enforced in production
  only (sandbox works without it). Send the ID to Peach and get production access approved before
  going live. `[DOCS]`
- **Samsung Pay**: merchant registers an Online/In-App service at
  [Samsung Pay Developers](https://pay.samsung.com/developers), Peach issues a CSR on request.
  `[DOCS]`

None of this is optional config inside the SDK — it's an out-of-band onboarding step per merchant,
per wallet. Don't promise a wallet is "just a flag" without checking this has happened.

## 5. Saved cards / tokenisation

Model: `customer.id` you choose → set `"setup_future_usage": "on_session"` on the PaymentIntent →
sheet shows a save checkbox (on by default) → on success a `payment_method_id` is generated and
attached to that customer. `[DOCS playground.peachpayments.com/flows/save-card-on-session]`

- Next purchase: create a **new** PaymentIntent with the same `customer.id`; the SDK auto-detects
  saved payment methods for that customer and lists them in the sheet (masked, e.g. `•••• 4242`).
- **No ephemeral-key flow is documented for this on-session path** — the public page describes
  direct payment creation with `setup_future_usage`, not a
  `CustomerConfiguration(id:ephemeralKeySecret:)` handshake for that specific flow, even though the
  iOS/Android SDK reference does expose a `CustomerConfiguration(id, ephemeralKeySecret)` type for
  the payment-sheet customer object `[DOCS sdk-mobile/ios, sdk-mobile/android]`. Treat the
  ephemeral-key object as the SDK-level API and the `save-card-on-session` flow doc as the
  server-side contract; if they appear to disagree in a specific integration, that's worth flagging
  to Peach rather than guessing which one wins.
- Off-session/MIT charge with a saved `payment_method_id`: the **Orchestration API-level MIT
  mechanism is now documented** (`mandate_data` / `recurring_details` / `off_session:true` — see
  `orchestration-api.md` §10). The mobile-SDK flow pages themselves still walk only the on-session,
  customer-present path; the MIT charge is a server-side `POST /payments`, not a payment-sheet action,
  so it lives in your backend regardless of platform.
- A Setup Intent object type is referenced in the iOS SDK surface
  (`PaymentSheet(setupIntentClientSecret:configuration:)`, Android
  `presentWithSetupIntent`) for saving a card **without** charging — this exists in the SDK API
  even though the flow-level walkthrough above uses the `setup_future_usage` shortcut instead.

## 6. 3-D Secure

`[DOCS playground.peachpayments.com/concepts/three-ds-next-action]`

- The PaymentIntent's `status` field is the switch: `succeeded` / `requires_capture` = frictionless,
  done; `requires_customer_action` = challenge needed, and it's the **only** status where
  `next_action` is populated; `failed` = declined (a retry may already have run server-side).
- `next_action` is a **tagged union** — branch on `next_action.type`, never on field presence.
  Server-to-server card 3DS is always `redirect_to_url`. Other types
  (`three_ds_invoke`, `invoke_hidden_iframe`, `redirect_inside_popup`) exist for SDK-driven flows;
  the full 14-variant union (QR, bank-transfer, voucher, OTP, UPI, …) is in `orchestration-api.md` §4.
  **Inside the mobile SDKs this is handled for you** — the payment sheet drives the challenge UI
  itself; you don't manually branch on `next_action.type` in normal SDK usage. Handle the redirect
  types yourself only if you're building a headless/custom flow against the raw Payments API.
- iOS: register `PaymentSession.handleURLCallback(url)` in `AppDelegate` to catch the return from a
  3DS redirect/deep link. Android: handle it in `onNewIntent(...)`.
- If you ever do redirect the shopper yourself: **send them to `redirect_to_url` verbatim** — don't
  parse it, rewrite it, or append query parameters; the docs call this out explicitly as a common
  mistake.
- Return-URL query params (`status`, `payment_id`, `signature`) are **not trustworthy for
  fulfilment** — `status` is frequently `processing` because the authorisation is still in flight.
  Confirm via webhook or `GET /payments/{payment_id}`, same discipline as Checkout V2's
  `/status` and Payments API v2's status endpoint.

## 7. Webhooks (Orchestration — distinct crypto from the other two surfaces)

`[DOCS playground.peachpayments.com/flows/webhooks]`

- Signature: **HMAC-SHA512** over the raw body using your `payment_response_hash_key`, compared
  against the `x-webhook-signature-512` header. Reject on mismatch with 401.
- This is neither Checkout V2's form-POST signature nor Payments API v2's AES-128-GCM encrypted
  body (`payments-api.md`) — **don't reuse verification code across surfaces.**
- Event types: the `EventType` enum carries **29 values** — 9 `payment_*` (incl. `payment_captured`,
  `payment_partially_authorized`, `payment_expired`, `payment_cancelled_post_capture`), `action_required`,
  2 `refund_*`, **7 `dispute_*`** (`dispute_opened/expired/accepted/cancelled/challenged/won/lost`), 2
  `mandate_*` (`mandate_active`/`mandate_revoked`), 7 `payout_*`, and `invoice_paid`. There are **no
  `subscription_*` events**. Full list + config in `orchestration-api.md` §11.2 / `webhooks.md`. Dispute
  events do fire, but there is no dispute-response API — respond via the Dashboard (`reconciliation.md`
  § Disputes). Each payload carries an `event_id` (dedupe on it), `event_type`, the full object, and a
  timestamp.
- The current [webhook flow](https://playground.peachpayments.com/flows/webhooks) documents retries
  up to 24 hours at 1 minute, 5 minutes, 10 minutes, 1 hour, 6 hours and 24 hours (reviewed
  2026-10-07). The operations page gives general replay guidance without repeating the cadence.
  Keep durable deduplication and recovery; do not assume a manual replay cannot arrive later.
- Configure via Dashboard or API.

## 8. Theming — payment-sheet Appearance API

Both native SDKs (and their RN/Flutter wrappers) expose an `Appearance`/`PaymentSheetAppearance`
object rather than raw CSS-like styling:

| Axis | iOS | Android |
|---|---|---|
| Colours | `PaymentSheet.Appearance.colors` (primary, background, text, error) | `PaymentSheet.Colors` via `PaymentSheetAppearance.colorsLight` |
| Shape | `.cornerRadius`, `.borderWidth`, `.shadow` | `PaymentSheet.Shapes(cornerRadiusDp)` |
| Type | `.font` | `PaymentSheet.Typography` |
| Buttons | `.primaryButton` | `PaymentSheet.PrimaryButton` |

`[DOCS sdk-mobile/ios, sdk-mobile/android]` Peach hosts a **live theming simulator** at
`playground.peachpayments.com` (iOS and Android tools) that generates ready-to-paste Swift/Kotlin
`Appearance` code from a colour-picker + corner-radius/border-width sliders, with five presets
(Default/Peach orange, Dark Mode, Branded Blue, Branded Purple, Minimal) `[DOCS]`. Flutter mirrors
the same shape (`PaymentSheetColors`, `PaymentSheetShapes`, `PaymentSheetTypography`,
`PaymentSheetPrimaryButton`). This is theming of Peach's **ready-to-use payment sheet**, not a
build-your-own-fields product — same "no fully custom card-fields UI" ceiling that Checkout V2 has
(`checkout-v2.md` §"There is no fully-stylable tokenised card-fields product").

### October 2026 SDK behavior changes

The [2026-10-05 release notes](https://playground.peachpayments.com/docs/release-notes) describe
three fixes to verify during upgrade: billing fields now honor disabled collection when the
connector does not require them; a configured country no longer prevents state/province
prefill; and input borders now honor width/radius across all fields. Property names differ:
iOS `appearance.borderWidth` / `cornerRadius`, Android `shapes.borderStrokeWidthDp` /
`cornerRadiusDp`, Flutter/React Native `shapes.borderWidth` / `borderRadius`.

Flutter also adds `link`, `addPaymentMethodButton`, and `useSavedPaymentMethodButton` colors
on the light/dark objects in `Appearance.colors`. Test saved/new-card toggles, billing settings,
state prefill and custom field styling in the actual SDK UI after upgrading.

## 9. Hybrid apps still on Checkout V2 — WebView Checkout

If the merchant's mobile app talks to Checkout V2 (`checkoutId`, not `client_secret`) rather than
Orchestration, there is still no RN/Flutter SDK for that surface — the integration is
Checkout-in-a-WebView. Full required config (HTTPS-served page, `domStorageEnabled`, Google Pay
Payment Request API version floors, Samsung Pay intent interception, EMVCo caveat on in-WebView
3DS) is documented in `checkout-v2.md` and is unchanged by anything in this rewrite — it is not
duplicated here to avoid the two copies drifting.

## 10. Mobile SDK V1 — legacy, do not use for new integrations

The V1 docs themselves say: use Mobile SDK V2 (Peach Orchestration, §1–§8) for new integrations.
V1 facts worth knowing (evidence it carries risk and why migration matters):

- **Mastercard certificate deadline**: cert expired **15 July 2026**; V1 required SDK **7.11.0+**
  and **IPWorks 2.4.9625** upgraded **before 7 July 2026** or 3DS could fail / transactions
  declined / Mastercard transactions fail. Lesson: V1 carries certificate-lifecycle risk you own.
- **Native only** (iOS/Android). No React Native or Flutter SDK — unlike V2, which now has both.
- Distribution: SDK downloads via **Peach support only**, not public package managers.
- `_deploy`-configuration builds **block simulators** — if 3DS "fails in the emulator", that's the
  build config, not your integration.
- Flow (V1's pattern — V2 replaces `checkoutId` with `client_secret` but keeps the same
  split-responsibility shape): **server** prepares (V1: `POST /v1/checkouts` with card facade
  credentials) → app SDK takes the handle → **server** reads the result/status. The SDK never does
  both halves. `[PLUGIN-VERIFIED]` (host split pattern)
- UI modes: ready-to-use (Drop-In Checkout or per-brand forms) or your own UI.
- **3DS2 runs as an in-app native challenge** (no browser redirect); works out of the box;
  `threeDSConfig` customisation available; SDK error codes 6000/6001 = 3DS family.
- Error-code families (V1 only — **V2 does not publish an equivalent numbered error-code table**;
  V2 platforms instead return a typed result — `.completed`/`.canceled`/`.failed` on iOS/Android,
  `{type_, code, message, status}` on React Native, a result map on Flutter — inspect that object
  rather than looking for a V1-style code list):

| Family | iOS | Android |
|---|---|---|
| General | 1000 | — |
| Luhn/card invalid | 1111 | — |
| Declined | 2010 | — |
| Connection | 3000 | — |
| Checksum | 4000 | — |
| Apple Pay | 1150–1153 | — |
| 3DS | 6000/6001 | 6000/6001 |
| Google Pay | — | 5000 |
| Samsung Pay | — | 5005 |
| Card scan / UI | 7000 | 7000 |
| Web loading | 8000 | 8000 |
| Custom components | 9000 | 9000 |

- Fraud: iovation FraudForce integration (SDK ≥5.0.0) surfaced as
  `customer.browserFingerprint.value`.
- Compliance: the Android app's privacy policy must disclose 3DS2 device-data collection (involve
  security/compliance teams). iOS ships a privacy manifest with the SDK.
- PCI: Peach's AOC covers COPYandPAY and S2S — **the mobile SDK is NOT covered by the AOC**; scope
  your own PCI posture accordingly. (Not re-verified for V2 in this rewrite — ask Peach support
  before assuming V2's PCI scoping mirrors V1's.)

## 11. Server responsibilities (any mobile approach, either product)

1. Create the payment session server-side (PaymentIntent for V2, checkout for Checkout V2); return
   only browser/app-safe session data to the client — never secret keys or client secrets meant to
   stay server-side beyond the one intended handoff. `[PLUGIN-VERIFIED]`
2. App completes payment (SDK payment sheet, or WebView Checkout for the Checkout V2 path).
3. Server confirms via the surface's own status/webhook mechanism before fulfilling — treat
   webhooks as the wake-up call and the status/GET endpoint as truth; amount-integrity check before
   fulfilling. See `webhooks.md` and §7 above.

## What this draft could not confirm publicly

Documented honestly as gaps rather than invented:

- No public numbered error/result-code table for Mobile SDK V2 (unlike V1's families above) — only
  the per-platform result types described in §2/§10.
- Samsung Pay on Mobile SDK V2 has no published code sample (button component, config object) —
  only the merchant-onboarding requirement (§4).
- Off-session/merchant-initiated (MIT) charging of a previously-saved `payment_method_id` from a
  mobile context is not covered on the fetched flow pages (only the on-session, customer-present
  save/reuse flow is) (§5).
- Actual webhook delivery timing under failure was not tested; §7 records the published cadence,
  not a delivery guarantee verified against a merchant environment.
- Whether Peach's AOC/PCI scoping statement for V1 ("mobile SDK is NOT covered") also applies
  unchanged to V2 was not found on a V2-specific page — don't assert it either way without asking
  Peach.
- **M-PESA / KES on the native Mobile SDK V2 payment sheet**: the mobile-SDK pages enumerate only
  cards + wallets + bank redirects + PayJustNow (§4) — **M-PESA does not appear on the native-SDK
  pages**. It IS a supported Orchestration method at the **S2S / Web SDK** level (KE market,
  sandbox-testable, non-refundable by API — `orchestration-api.md` §5, `methods-catalog.md`). So the gap
  is specifically the native payment sheet, not Orchestration overall: for a Kenyan / mobile-money mobile
  build, confirm whether the native sheet surfaces M-PESA in sandbox, or drive it through the Web SDK /
  a server-side redirect. `[VERIFY-SANDBOX — native sheet only]`
- **Capture amount vs authorised**: now documented (`docs/manage-transactions`, `orchestration-api.md`
  §6). `amount_to_capture` may be less than authorised and the status can become `partially_captured`.
  Remaining-hold release depends on connector support and the capture mode; verify it before promising
  an immediate release, especially with multiple captures. Capturing **more** than authorised needs **overcapture**,
  a separate opt-in PSP capability set at create time (`enable_overcapture:true`), not something you can
  just exceed. Capture is final (undo = refund); an unused authorisation is released by voiding
  (`POST /payments/{id}/cancel`, pre-capture only). `[DOCS]`
- **Native runtime availability:** merchant/customer method-list APIs in `orchestration-api.md`
  do not establish wallet readiness on a particular device. Use the native readiness callbacks (§4)
  and verify the selected connector/device; distinguish configured methods from methods ready to use.

## Sources
The base reference was fetched on 2026-09-08. The four platform guide sections and release
notes were compared with the fresh official `llms-full.txt` on **2026-10-07**. Package names,
versions, Android minimum conflict, and October behavior changes above were updated from
that review. The on-session/recurring distinction and published webhook retry cadence were also
checked against the current flow pages on 2026-10-07. This does not claim that every older flow or legacy SDK fact was independently
retested. Sources:
- https://playground.peachpayments.com/sdk-mobile/ios (+ `.md`)
- https://playground.peachpayments.com/sdk-mobile/android (+ `.md`)
- https://playground.peachpayments.com/sdk-mobile/react-native.md
- https://playground.peachpayments.com/sdk-mobile/flutter.md
- https://playground.peachpayments.com/operate/customization/ios.md
- https://playground.peachpayments.com/operate/customization/android.md
- https://playground.peachpayments.com/playground.md (PaymentIntent creation)
- https://playground.peachpayments.com/docs/testing.md
- https://playground.peachpayments.com/payment-flows.md
- https://playground.peachpayments.com/payment-states.md
- https://playground.peachpayments.com/concepts/three-ds-next-action.md
- https://playground.peachpayments.com/flows/save-card-on-session.md
- https://playground.peachpayments.com/flows/webhooks.md
- https://developer.peachpayments.com/llms.txt (V1 mobile SDK index, confirms V1 pages are
  unchanged legacy content — used only for §10's provenance, not as a V2 source)

V1 facts in §10 are carried from the already-mirrored legacy OPPWA mobile-SDK docs
(developer.peachpayments.com), not re-fetched for this rewrite.

## Traps
- Treating "Mobile SDK V2" and "Checkout V2" as the same product because they're both "V2" — they
  are unrelated backends with unrelated credentials, hosts, and webhook crypto (§0). Get this wrong
  and nothing authenticates.
- Assuming no RN/Flutter path exists because that was true historically — Mobile SDK V2 ships both
  officially now; only Checkout V2 still lacks them.
- Amount units: Orchestration's `POST /payments` takes **minor units** (`6500` = R65.00); Checkout
  V2 and Payments API v2 take **decimal-string major units** (`"65.00"`). Copy-pasting an amount
  between surfaces silently over- or under-charges by 100x.
- Fulfilling on the SDK's `.completed` / `Completed` / `status` callback alone — it's a client-side
  event; confirm server-side via `GET /payments/{payment_id}` or the webhook before shipping goods.
- Fulfilling on the 3DS return-URL query params — `status` there is frequently `processing`, not
  terminal.
- Reusing Checkout V2's or Payments API v2's webhook-verification code against Orchestration
  webhooks (or vice versa) — three different signing/encryption schemes across the three surfaces.
- Mobile SDK V1 for a new build: legacy on arrival; certificate-expiry history (Mastercard 2026)
  shows what maintaining V1 costs.
- Simulator 3DS "failures" on V1 `_deploy` builds — the build config blocks simulators; test on
  real devices.
- A wallet button rendering nothing and being read as a bug — check merchant onboarding (§4) and
  the readiness callback before assuming an SDK fault.
- Quoting V2 error/result codes as if they follow V1's numbered-family scheme — no such public
  table exists for V2; inspect the platform's own result type instead.
- Calling `POST /payments` or any secret-keyed endpoint from the app itself — credentials leak; the
  server must own PaymentIntent creation and status confirmation, same rule as every other Peach
  surface.
