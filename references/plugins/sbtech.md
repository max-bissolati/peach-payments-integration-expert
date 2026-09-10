# SBTech

## When to load
SBTech sports-betting platform integration; mapping Peach credentials to SBTech's terminology; dedicated `/checkout/sbt` and `/status/sbt` endpoints.

## Capabilities
| Capability | Detail |
|---|---|
| Scope | Peach Payments integrated into the SBTech betting platform for multiple payment methods |
| Refunds | **Not supported via SBTech** — full or partial refunds must be requested from Peach Payments and are processed manually |
| Recurring | Not applicable |
| Sandbox | Dedicated sandbox endpoints (same credential pair) |
| Webhooks | Handled inside the SBTech platform — no merchant-side webhook wiring documented |
| Merchant account | Requires a Peach Payments account; standard activation |

## Configuration
1. Request credentials from Peach support:
   - `API secret` = Peach's **secret token**
   - `API merchant reference` = Peach's **entity ID**
2. Send them to SBTech — SBTech configures your site to accept payments through Peach Payments.
3. Use SBTech's exact terms (`API secret`, `API merchant reference`) in all communication — these are the terms SBTech knows.

## Endpoints
| Purpose | Sandbox | Live |
|---|---|---|
| Pay-in request | `https://testsecure.peachpayments.com/checkout/sbt` | `https://secure.peachpayments.com/checkout/sbt` |
| Check status request | `https://testsecure.peachpayments.com/status/sbt` | `https://secure.peachpayments.com/status/sbt` |

## Credentials
Both values come from Peach **support** (not Dashboard Connect self-serve). Only two secrets total: the secret token and the entity ID under SBTech aliases.

## Traps
- Terminology mismatch is the #1 failure: handing SBTech Peach's names ("entity ID", "secret token") verbatim can stall configuration — translate to `API merchant reference` / `API secret`.
- Refunds are manual through Peach only — no self-serve refund path exists anywhere in this integration; budget ops time for every refund.
- `/checkout/sbt` + `/status/sbt` are dedicated SBTech paths, NOT the standard `/v2/checkout` surface — never mix the two documentations; standard Checkout request parameters don't necessarily apply.
- Payment method availability still follows your Peach account configuration.
- Compare platforms: [_matrix.md](_matrix.md); webhook signing background (if you build around SBTech): `../webhooks.md`.
