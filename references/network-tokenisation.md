# Network tokenisation

## When to load

Load for scheme network tokens, token provisioning, bringing an existing token vault, token expiry,
card replacement, cryptograms, or network-token CIT/MIT migrations. Read `orchestration-api.md`
for Orchestration contracts and `recurring-and-tokenisation.md` for classic saved-card billing.
**Public sources reviewed 2026-10-07. No sandbox transaction or provisioning was executed.**

## Identify the credential and product first

| Credential | What the application handles | Integration consequence |
|---|---|---|
| Classic `registrationId` | A reference to a stored credential | Keep using this reference when Peach enables managed network tokenisation. It is not the scheme token number. |
| Orchestration `payment_method_id` / mandate | A product-specific saved-method or agreement reference | Use `recurring_details`; do not substitute a classic registration ID. |
| Scheme network token | A card-format surrogate, its expiry and, where required, a fresh cryptogram | Requires network/TSP arrangements and an eligible connector, not just a different request field. |
| Wallet payload | Apple/Google/Samsung Pay session data | Follow the wallet contract. An encrypted payload is not a reusable network-token string. |

Apple Pay merchant tokens (MPANs) and device tokens have different lifetimes. Issuer support determines
MPAN availability; do not promise every wallet enrolment survives device replacement. A classic
registration can wrap a tokenised wallet, but that does not make the original encrypted session payload
replayable. [Token types](https://developer.peachpayments.com/docs/oppwa-guides-tokenisation),
[Checkout tokenisation](https://developer.peachpayments.com/docs/checkout-tokenisation).

Before implementation establish the product, merchant/profile/entity, country, card networks,
connector/acquirer, CIT versus MIT, consent evidence, who owns the vault and TSP relationship, and
whether credentials already exist. New integrations should start from Orchestration and hosted/SDK
collection. The classic guidance below is for an existing integration or an explicit migration need.

## Choose who manages provisioning

**Managed tokenisation:** Peach's classic token-vault flow can provision/fetch a network token behind
the merchant's registration reference after enablement. Registration creation, network provisioning,
issuer activation and payment authorisation are separate events. An initial payment may use the PAN
while activation is pending. Check both payment outcome and token-processing history; successful
registration does not prove the first payment used a network token.

**Merchant-managed tokens:** your TSP supplies token credentials and fresh authentication data. Peach
accepting those fields does not mean Peach provisioned the token or that every connector can process it.
Confirm token requestor/domain, supported networks, connector enablement and lifecycle responsibility.
The public Orchestration acceptance API does not establish a universal self-service provisioning API.
[Managed and own-TSP overview](https://support.peachpayments.com/support/solutions/articles/47001273512-network-tokenisation),
[Orchestration S2S](https://playground.peachpayments.com/integrate/api-only).

Do not apply the older support article's ACI/OPP platform statements to every current Orchestration
profile. Likewise, its omni-token discussion does not establish that the POS Integrations REST API
exports a reusable online credential. Confirm a supported cross-channel setup with Peach.

## Orchestration: accepting network tokens

Use the environment, secret `api-key` and payment status model in `orchestration-api.md`. Amounts
are **integer minor units**. The current S2S documentation specifies both method fields as
`network_token`. This is an illustrative credential fragment, not an executable payment request:

```json illustrative
{
  "payment_method": "network_token",
  "payment_method_type": "network_token",
  "payment_method_data": {
    "network_token": {
      "network_token": "<TSP-issued token>",
      "token_exp_month": "<MM>",
      "token_exp_year": "<YY>",
      "token_cryptogram": "<fresh cryptogram>",
      "card_holder_name": "<holder>",
      "eci": "<value from authentication/token provider>"
    }
  }
}
```

Never hardcode a successful ECI or invent authentication data. A token can still require shopper
authentication. Handle `requires_customer_action` and `next_action` through the selected SDK or
documented redirect flow. Tokenisation alone grants no 3DS exemption or liability shift.
[S2S fields](https://playground.peachpayments.com/integrate/api-only),
[3DS contract](https://playground.peachpayments.com/concepts/three-ds-next-action).

For subsequent MITs, distinguish two paths:

- Peach vault: completed customer-present setup with consent and the appropriate future-use/mandate
  configuration, then `recurring_details: { "type": "payment_method_id", "data": "<returned ID>" }`.
- Own vault: retain the original scheme transaction reference and use the documented variant below.
  `network_transaction_id` identifies the original customer-authorised transaction, not an order ID,
  token number, or a fabricated placeholder.

```json illustrative
{
  "confirm": true,
  "off_session": true,
  "recurring_details": {
    "type": "network_transaction_id_and_network_token_details",
    "data": {
      "network_token": "<TSP-issued token>",
      "token_exp_month": "<MM>",
      "token_exp_year": "<YY>",
      "card_holder_name": "<holder>",
      "network_transaction_id": "<original scheme transaction reference>"
    }
  }
}
```

Add actual amount, currency, customer and other required request fields. Top-level
`payment_method_id` is not the saved-method charging interface. Connector eligibility must be tested
for the chosen recurring variant; accepting the JSON shape is not proof a charge can route.
[Own-vault and hosted-vault MIT contracts](https://playground.peachpayments.com/integrate/api-only).

## Classic card facade: managed and own-TSP flows

Use decimal-string **major units**, the card-facade bearer credential and `standingInstruction`.
Never send Orchestration JSON fields to this API.

- Managed registration: retain the merchant registration reference; `TK` provisioning and `TF` fetch
  entries can appear in `processingDetails.transactions`. `800.100.311` indicates token provisioning
  is still pending, not permission to blindly repeat a possibly successful debit.
- Own-TSP payment: `POST /v1/payments` uses flat `tokenAccount.type=NETWORK`,
  `tokenAccount.number`, `tokenAccount.expiryMonth`, `tokenAccount.expiryYear`, and
  `tokenAccount.cryptogram` when required. Send genuine payment, customer, stored-credential and
  authentication data according to the chosen flow.
- CIT token authorisation needs a fresh cryptogram. Under the published classic rules, if the
  original CIT used a network token plus cryptogram, later MITs can omit it. If that CIT used PAN,
  the first subsequent token MIT needs a cryptogram. Later MITs in that agreement can omit it.

[Classic S2S network-token integration](https://developer.peachpayments.com/docs/oppwa-integrations-server-to-server-network-tokens).

### Proactive provisioning and source contradictions

The [release notes](https://developer.peachpayments.com/docs/oppwa-references-release-notes)
document `POST /v1/registrations/{registrationId}/provisionNetworkToken` for provisioning before a
stored card expires. This is provisioning, not payment or a guarantee of issuer activation. The
S2S page identifies the same URL but its sample sends `createOmniToken=true` to the shorter
registration path. **Do not present that conflicting sample as a verified implementation.** Confirm
the exact request body and enabled endpoint with Peach, then exercise it in the correct sandbox.

The S2S own-token MIT sample also uses `standingInstruction.mode=RECURRING`, while the stored-card
mode contract uses `INITIAL`/`REPEATED`; billing type is a different field. Use the documented mode
contract and confirm the sample defect rather than copying it. The release notes also make network
onboarding and acquirer support explicit. A date on a public page is not deployment confirmation for
a merchant's account.

The Orchestration own-vault MIT example omits a cryptogram. It does not explain the classic
PAN-to-first-token-MIT transition. Obtain connector-specific confirmation before migrating that case;
do not invent an unsupported recurring payload field or blindly carry classic rules across products.

## Lifecycle, security and portability

Treat lifecycle separately from payment status. An active token can still decline. A suspended token
must not be charged while suspended; a deleted token needs replacement credentials. Maintain a
shopper recovery flow and controlled dunning even when issuer updates reduce expired-card declines.
Older marketing claims that tokens never expire or eliminate fraud declines are not operational
guarantees. [Lifecycle guidance](https://support.peachpayments.com/support/solutions/articles/47001273512-network-tokenisation).

Implementation safeguards:

- Bind each vault reference to its owning customer, merchant/profile and environment. Authorise every
  stored-method selection server-side; guessing another customer's token must never charge it.
- Keep cryptograms and complete token credentials out of logs, fixtures, analytics and support tickets.
  Cryptograms are single-use authentication material. A network token does not remove PCI scope;
  confirm the architecture's assessment with the acquirer/QSA. Prefer hosted collection.
- Reconcile ambiguous requests before any new attempt. Ask the TSP for fresh cryptographic material
  when a new authorisation is actually required; do not replay one across connector retries yourself.
- Document whether configured routing may fall back to PAN after token failure. This is a deliberate
  connector/profile capability, not a reason for an app to collect or retain PAN opportunistically.
- For migration, preserve consent and original scheme transaction references alongside the authorised
  credential migration. Vault IDs, merchant token domains and processor references are not universally
  portable. Prove destination eligibility before retiring the source integration.

These are implementation controls, not claims that a particular merchant's compliance, migration,
PAN fallback, account updater or token export has been approved.

## Acceptance checklist

Use mocks for application controls and the product-specific sandbox for connector behaviour.
Never use live payment data for tests. Record evidence separately from this documentation review.

| Case | Required evidence |
|---|---|
| Saved-method ownership and environments | A different customer's ID or production ID in sandbox is rejected before dispatch. |
| Provisioning delayed/ineligible/disabled | Registration and payment outcomes stay distinct; no duplicate charge or infinite provisioning loop. |
| CIT and MIT transitions | Correct original scheme reference and cryptogram policy for the confirmed connector; consent retained. |
| Reused cryptogram | Application does not cache/replay authentication material. Provider UAT acceptance alone is insufficient. |
| Token suspended/deleted/card updated | Billing pauses or requests new credentials as appropriate; safe display metadata updates. |
| Timeout, duplicate webhook, restart | Exactly one order fulfilment and no blind debit replay; reconcile final payment and attempt state. |
| 3DS challenge or MIT authentication failure | Shopper-present recovery remains available; tokenisation does not bypass authentication. |
| Connector/token-domain migration | Destination test proves routing and recurring support before source retirement. |

Classic [network-token test cards](https://developer.peachpayments.com/docs/oppwa-guides-tokenisation-network-tokens-test-cards)
use expiry years to choose fixtures: 2031 activation, 2032 ineligible, 2033 unsupported issuer,
2034 active/suspended/active/deleted lifecycle, 2035 card update, 2036 cannot tokenise, and 2041
slower invalid-state transitions. Follow the page's precise timing and supported networks. These are
classic UAT fixtures, not a promise that Orchestration connectors share the simulator. Its fixed UAT
cryptogram cannot prove production replay protection.

## Traps

- Replacing `registrationId` with a token number in an existing saved-card integration.
- Mistaking network-token support for automatic provisioning, enabled routing or universal portability.
- Copying 3DS/ECI values, sample bearer credentials or malformed documentation commands.
- Selling guaranteed approval uplift, interchange savings, liability shift or zero PCI scope.
- Treating token activation, a successful HTTP response or a return-page redirect as captured funds.

For a go-live plan, include merchant enablement, connector-specific CIT/MIT evidence, recovery tests,
webhook authentication, redaction checks and the appropriate checks in `testing-and-go-live.md`.
