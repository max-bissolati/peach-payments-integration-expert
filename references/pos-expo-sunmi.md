# Custom POS apps with Expo and SUNMI

Verified against public Peach Payments, Expo, and SUNMI documentation on **2026-10-07**.
This is implementation guidance derived from the docs, not a terminal-tested Expo integration.
Read `pos-integrations.md` for cloud REST, webhook security, and reconciliation contracts.

## When to load

Load when building a cashier app with Expo/React Native, selecting SUNMI hardware, wrapping the Intent API, or planning terminal peripherals and deployment.

## Choose where the app runs first

| Deployment | Payment connection | Recommended implementation |
|---|---|---|
| Till on a separate tablet, phone, computer, or browser | Backend calls the POS Integrations REST API to push a payment to the assigned terminal | Expo/React Native or web frontend plus your backend; no SUNMI payment SDK in the till |
| Your POS UI on the same SUNMI device as Peach's Payment App | Android app-to-app Intent API | Expo development build with a Kotlin native module around `com.peach:intent_api` |
| Existing web POS displayed on the payment terminal | Kotlin WebView shell and Intent API | Consider Peach's documented web-wrapper pattern before rebuilding the frontend |

Peach explicitly distinguishes [same-device Intent integration](https://developer.peachpayments.com/docs/terminal-integration-flows) from the [separate-device REST API](https://developer.peachpayments.com/docs/pos-integrations-api). Both can support a custom till. An Android terminal does not force the separate till to use Android, and cloud integration does not itself permit installing an app on the terminal.

**Expo is a reasonable candidate**, subject to a device proof of concept. For same-device payments, the app needs native Android integration. Peach documents Kotlin/Java and a Kotlin WebView wrapper; these pages do not provide an official Expo package. The Kotlin Expo module proposed here is an implementation recommendation, not a claim of Peach certification. Peach's online Orchestration React Native SDK is a different payment surface and is not the terminal handoff library.

## Hardware and runtime facts

Peach's [SUNMI deployment guide](https://developer.peachpayments.com/docs/pos-deploy-sunmi) lists `P2_SE` and `P2_LITE_SE` in its supported-model selection instructions. Confirm the merchant's actual model and firmware before choosing dependencies or procuring hardware.

| Item | Verified public documentation | Consequence |
|---|---|---|
| SUNMI P2 SE, model T6820 | [SUNMI specs](https://www.sunmi.com/p2-se/) say Android 11 Go, 2 GB RAM, built-in 58 mm thermal printer, optional scanner | Android runtime is plausible for Expo; printing and scanning still require model-specific integration |
| SUNMI P2 LITE SE | [SUNMI product page](https://www.sunmi.com/en/p2-lite-se/) says Android 11 Go | Validate its peripherals separately; do not assume every P2-family device has the P2 SE printer |
| Other SUNMI families | [P3 family](https://www.sunmi.com/en/p3-family) includes Android 11 and Android 11 Go models | This proves Android hardware exists, not that Peach supports those devices or firmware |
| Expo Android requirement | [Expo SDK table](https://docs.expo.dev/versions/latest/) listed SDKs 54 through 57 with Android 7+ and compile/target SDK 36 when checked | Android 11 Go clears this documented OS minimum; native libraries, ABI, memory and device policies remain separate checks |

`compileSdkVersion`/`targetSdkVersion` do not mean the device must run that Android version. Do not lower native dependency minimums merely to force a build. Pin the chosen Expo/React Native, Intent library and Payment App versions, then verify them together on the terminal. Record installed Android API level, CPU ABIs, memory, model, serial number, Payment App variant, and required peripherals. Do not assume Play Store, Google Play Services, ADB access or arbitrary sideloading are available on a managed payment device.

## Discovery for a build

Infer answered items, then ask only what changes the design:

1. Separate till or the same terminal? Existing web app or new Expo app?
2. Country, currency, Peach POS account, terminal model, Payment App version and number of terminals?
3. Sales only, or tips, cashback, refunds, voids, split tenders and receipts? Obtain exact supported flows for the selected integration.
4. Product catalogue, tax rules, inventory, booking/folio integration, cashier roles and supervisor actions?
5. Printer, camera barcode scanning, dedicated scanner, cash drawer or other peripherals?
6. Connectivity and recovery requirements; backend hosting; webhook endpoint; reporting and order IDs?
7. UAT hardware/account access, SUNMI partner access and rollout owner?

Do not promise offline card acceptance. Draft baskets can be stored locally, but payment execution and recovery must follow the supported Peach flow. Do not silently replay an offline queue of charge requests after reconnection.

## Suggested application architecture

This structure is a recommendation for a new build:

```text
Expo cashier UI: catalogue, basket, customer, payment progress, receipts
  -> order/attempt service: immutable totals, roles, terminal assignment
  -> payment adapter:
       cloud: authenticated backend -> Peach POS REST -> terminal
       local: Kotlin Expo module -> Peach Intent library -> Payment App
  -> durable attempt journal and backend outcome/reconciliation service
  -> printer/scanner adapters, isolated from the payment adapter
```

Calculate the charge from trusted order data. Use integer minor units internally, then serialize to the selected surface's documented types. Never calculate money with floating-point multiplication without explicit decimal validation. A typed amount such as `amountMinor` should not be confused with online Checkout's major-unit strings.

Persist order ID, unique attempt ID, terminal association, requested amount/currency, timestamps, outcome evidence and Peach IDs before/after handoff. Keep secrets on the backend for REST. For native Intent, the Gradle dependency does not require embedding Peach cloud credentials in the app. Treat client callbacks as evidence to correlate with the journal and server records, not as an excuse to bypass role or amount checks.

Suggested application states are `created`, `awaiting_terminal`, `processing`, `approved`, `declined`, `cancelled`, and `unresolved`. They are local states, not Peach enum values. An unresolved attempt stays unpaid and blocks a replacement charge until recovery or an explicit reviewed decision. Use one active payment attempt per order and terminal. Protect both UI double taps and concurrent backend requests. The Intent API does not deduplicate repeated `merchantTransactionId` values.

## Same-device native integration

The [app-to-app guide](https://developer.peachpayments.com/docs/pos-app-to-app) currently documents `com.peach:intent_api:2.0.8` from the public GitLab Maven registry. Refund/void require 2.0.6 or later. Pin the version agreed with Peach, not an unbounded latest dependency. The library handles AIDL when available and a `CommunicationActivity` fallback, and delivers listener callbacks on the UI thread. Use its builders rather than inventing Payment App package names, intent actions or extras.

For Expo, implement a small Kotlin [Expo module](https://docs.expo.dev/modules/overview/) exposing sale, refund, void and lookup operations. This is the proposed adapter contract, not a shipped Peach API:

```typescript
// Illustrative adapter contract. Implement and validate the native module first.
interface TerminalPayments {
  sale(input: { attemptId: string; amountMinor: number; orderId: string }): Promise<unknown>;
  refund(input: { attemptId: string; amountMinor: number; originalTransactionId: string }): Promise<unknown>;
  void(input: { attemptId: string; originalTransactionId: string }): Promise<unknown>;
  lastTransaction(): Promise<unknown>;
}
```

Validate positive safe integers at the JavaScript boundary and convert to Kotlin `Long`. Implement the operation-specific listener and validate the returned model before converting it to a typed application outcome. A promise alone is not durable recovery: the app can die while the Payment App remains active. Persist pending attempts independently of the in-memory promise, and recover them on cold start.

Add the Maven repository and dependency through a config plugin when using Expo Continuous Native Generation, or intentionally maintain the native project. [Expo custom native code guidance](https://docs.expo.dev/workflow/customizing/) requires a development build for this library; Expo Go cannot load a custom Kotlin module. Rebuild after native code/config changes. A generic Android intent launcher being available in Expo Go does not prove compatibility with Peach's AIDL, callback and lifecycle protocol.

Peach's documented WebView alternative exposes `window.FinimoPay` from its Kotlin shell. It is not a global available in a normal browser or React Native runtime. If selecting that route, follow the linked wrapper sample, restrict bridge access to trusted content, and keep payment builders in Kotlin. Do not mix its JavaScript callbacks with the proposed Expo module API.

## Sale, refund and void rules

Use the [Intent data models](https://developer.peachpayments.com/docs/pos-intent-data-models) and [terminal flows](https://developer.peachpayments.com/docs/terminal-integration-flows), not online `result.code` regexes:

| Operation | Expected model and acceptance rule |
|---|---|
| Sale | `PosTransactionSummary`: `isApproved == true` and type `SALE` or `SALE_WITH_CASHBACK`; match the intended order, amount and currency |
| Refund | `PosTransactionSummary`: `isApproved == true` and type `REFUND`; match the requested refund |
| Void | `VoidResponse`: `transactionResult == "voided"`; no `isApproved` field exists |
| History/search | `PosTransactionResult` uses `approved` and `id`, unlike summary `isApproved` and `transactionId`; normalize deliberately |

Persist the original sale UUID for subsequent operations. Refund and void use the same terminal as the sale and prompt for a supervisor PIN; refunds also prompt for a reason. Use lookup `isRefundable`/`isVoidable` flags before offering actions. Peach documents multiple partial refunds within 180 days, limited to the original total. Enforce cashier/supervisor permissions and retain an audit trail; never log a supervisor PIN.

Set `externalPosData.merchantTransactionId` before starting a sale. Preserve the returned UUID and RRN separately. Use `disableReceiptingOnOutcome(true)` when the chosen integrated flow should auto-return after roughly ten seconds. Ask Peach to configure integrated mode for dedicated deployments. Keep merchant-enabled tips, cashback and payment-link features conditional; do not infer REST feature support from Intent release notes.

## Recovery and documentation conflicts

The terminal flow page says to treat a missing final result as failed, but also warns that authorization can complete after the POS app dies. Implement that as **unpaid/unresolved**, with no fulfilment and no automatic fresh charge. This preserves the documented no-success rule without treating loss of a callback as evidence that the customer was never charged.

Use normal callbacks first, then on-terminal lookup, merchant POS webhooks and full-day Reconciliation API recovery. `lastTransaction()` only covers the latest attempt where a card was presented. It can return an unrelated sale and excludes pre-card cancellation or initiation errors. `searchTransaction` supports filters such as amount/time/RRN, but cannot search `posData.merchantTransactionId`. A lookup error or an uncorrelated result must never mark the order paid.

The docs describe reversal within five minutes if the terminal cannot show success. Do not implement a five-minute timer that presumes the financial outcome is settled. Record the uncertainty, reconcile available evidence, and define an operator escalation path when outcomes conflict.

The terminal flow page names `PAYMENT_APP_NOT_INSTALLED`; the dedicated [error-code table](https://developer.peachpayments.com/docs/pos-intent-error-codes) uses `APP_NOT_FOUND`. Compile against the pinned SDK enum and verify runtime responses; do not reference an enum merely because a prose page names it. Handle missing app, user cancellation, invalid amount, interrupted response and unknown errors separately. Error text is not an authoritative transaction outcome.

## Peripherals and receipts

SUNMI printing is separate from Peach card processing. Use the [SUNMI SDK starting point linked by Peach](https://docs.sunmi.com/en-US/cdixeghjk491/xmafeghjk535) and the actual model's printer/scanner documentation. The [SUNMI printer developer guide](https://cdn.sunmi.com/public/generalfile/mgt-document/841c6680d673447ba9c5d9b1e1131d01.pdf) describes device print services; it is not evidence that a generic React Native print library supports every SUNMI terminal. The linked SUNMI developer portal did not load in this verification, so re-open it before implementing model-specific SDK calls.

A hardware printer/scanner adapter may require another native module or a verified compatible library. Confirm ABI, service binding, permissions and lifecycle behavior. Camera scanning and a dedicated barcode engine are different inputs. Do not use a hardware NFC API to collect card/PIN data in the till; the Payment App owns card processing.

Persist payment success before printing. A paper-out error should offer receipt reprint, never another charge. Decide whether Peach prints the payment slip and whether your app prints a separate itemized receipt. Test width, wrapping, currency, tax, order reference, reprints, paper out and service disconnects on the real unit.

## Implementation phases and acceptance matrix

1. Prove the device and toolchain: install a minimal Expo development APK on the intended test device, then exercise one Intent sale against the mock app through the Kotlin module.
2. Build order persistence and outcome normalization with duplicate prevention and role checks. Add webhook/reconciliation recovery before implementing automatic order completion.
3. Run mock scenarios, then UAT on the actual SUNMI model. Add required peripherals and verify interrupted workflows.
4. Produce a signed release APK, validate its metadata and signatures, and arrange the documented SUNMI/Peach pilot process. Do not publish or trigger live transactions without explicit authorization.

The [Peach testing guide](https://developer.peachpayments.com/docs/pos-test-app-to-app) offers a Mock Payments App on any Android phone/tablet without a UAT account. Physical UAT requires the UAT Payment App, account/PIN and SUNMI hardware. Mock success does not validate real card processing, firmware, peripherals or distribution.

| Test | Required evidence |
|---|---|
| Round UAT amount, such as R100.00 | Approved model, correct amount/order, exactly one order completion |
| Non-round amount, such as R10.51 | Decline shown; order unpaid |
| Special UAT amounts | `50.05`: failure then approval; `.55`: failed transaction array; `.65`: tap failure then success; `.51`: decline; `.69`: timeout; handle all events without duplicate fulfilment |
| Double tap and concurrent requests | One active attempt; no extra sale even if an order reference is reused |
| Cancel before card presentment | No fulfilment; lookup does not accidentally adopt an earlier successful sale |
| POS killed or Payment App closed | Journal survives; missing callback stays unresolved; recovery correlates the correct transaction |
| Network loss before and after authorization | Record screen, callback, webhook and reconciliation evidence; no blind retry |
| Repeated/out-of-order webhook | Deduplicated update; paid state not overwritten by stale evidence |
| Refund, partial refund, void, invalid PIN | Correct operation model, limits and permissions; original terminal association retained |
| Backend/webhook outage | Full-day reconciliation matches order reference; unresolved attempts surface for review |
| Printer/scanner failure | Payment state preserved; scan duplicates controlled; reprint does not charge |
| Signed release build, restart and upgrade | Works without Metro; pending attempt recovers; Payment App handoff and return work on pilot hardware |

Magic UAT amounts override the general round/non-round rule. For every failure, record whether the terminal displayed success and what callbacks, webhooks and reconciliation returned. No physical terminal was available for this documentation update, so none of these rows is claimed as passed.

## Distribution and ongoing versions

Follow [Peach's deployment guide](https://developer.peachpayments.com/docs/pos-deploy-sunmi): integrators own the signed POS APK, SUNMI partner account and version lifecycle; Peach manages the Payment App, channel binding and integrated-mode configuration. Its documented publication path is public app upload so Peach can enable it on the merchant channel. Payment-series review can require manual verification. Pilot by device serial number using gray release before widening deployment.

Validate V1 and V2 APK signatures, increasing `versionCode`, stable package name and the device-required `armeabi-v7a`/`arm64-v8a` ABIs. Build an APK for this path: [Expo documents that the default AAB cannot be installed directly](https://docs.expo.dev/build-reference/apk/) and supports `android.buildType: "apk"`. EAS is an optional build service; building locally is also possible. A successful EAS build does not publish to SUNMI or enable Peach terminals.

Track Expo runtime, Intent library and Payment App versions separately. [Payment App release notes](https://developer.peachpayments.com/docs/point-of-sale-release-notes) currently list 2.2.11 dated 2026-03-19. Recheck them when changing either native library or terminal firmware. Native library changes require a new binary; do not expect a JavaScript update to add a missing native module or bypass the terminal rollout process.

## Traps

- Expo Go cannot load the custom Peach Intent bridge.
- Peach Mobile SDK V2 handles online payments, not terminal card taps.
- Callback loss is not proof that no charge occurred.
- Android version compatibility alone does not establish terminal approval or native-library compatibility.
