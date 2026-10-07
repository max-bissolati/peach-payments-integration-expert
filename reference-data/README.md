# Peach Payments Machine-Readable Reference Data

This directory provides machine-readable reference specifications (`hosts.json`, `payment-methods.json`, and `result-code-families.json`) for Peach Payments integrations, generated directly from and aligned with the skill's reference documentation (`references/testing-and-go-live.md`, `references/checkout-v2.md`, `references/methods-catalog.md`, and `references/result-codes.md`). These artifacts enable AI agents and tooling to consume structured host endpoints, payment method capabilities, and result-code taxonomy rules without parsing prose. Because method availability and response code rosters are entity- and version-sensitive, always query the live channel endpoint (`GET /v2/channels/{entityId}/payment-methods`) to verify active methods for a given channel, and prefer the live result codes endpoint (`https://card.peachpayments.com/v1/resultcodes` or `https://sandbox-card.peachpayments.com/v1/resultcodes`) for complete and up-to-date result-code lookups.


## Product scope

`hosts.json` includes separate Orchestration and POS hosts. A host entry does not establish that
`preflight.js` or `smoke-test.js` implements that product. Do not send one product's credentials
or amounts to another host.

`payment-methods.json` describes the classic product catalogue. Its POS labels describe broad
product availability, not a REST/Intent method contract. Use the current Orchestration catalogue
for that product. Channel discovery above is a classic Checkout endpoint, not a universal one.
`result-code-families.json` contains classic dotted codes; POS and Orchestration use different
outcome models described in their references.

## Consuming result-code-families.json safely
The family `regex`es are **prefix-anchored** (they match the leading digits of a code). If you classify a
code yourself instead of calling `scripts/map-result-code.js`, first **shape-check** that the code is
`ddd.ddd.ddd` (reject junk / trailing whitespace — e.g. `000.000.000extra` must NOT count as success),
then match families in array order and take the **first** match. This mirrors the production mapper, which
shape-checks and fails closed on anything unexpected.
