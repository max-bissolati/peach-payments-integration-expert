# Onboarding, eligibility, and restricted industries

## When to load

Any question about WHO can open a Peach account or WHAT a merchant may sell: eligibility (age, ID,
bank account, company registration), KYC/document checklists, restricted or prohibited business
categories, merchant category codes (MCC), approval timelines/likelihood, or legal/procurement
artifacts (POPIA processor agreements, AOC copies, SLAs, tender compliance packs).

## What is publicly documented about onboarding

- **Flow**: sign up → Peach risk review gates the LIVE account; the **sandbox is available soon
  after signup** (`testing-and-go-live.md`). Live activation is an account/risk decision made by
  Peach, not an API step.
- **Product activations are support-gated**: recurring credentials (`recurring-and-tokenisation.md`),
  MOTO channel approval, Payouts (+ **source-of-funds document**), wallet onboarding (Apple/Google/
  Samsung), Mobile SDK distribution, extension connections (each "requires review by Peach Payments
  South Africa" — `plugins/_matrix.md`).
- **"High-risk merchant"** appears in method rules (Capitec Pay and Absa Pay verified-ID
  requirements — `methods-catalog.md`) without a public definition of how the classification is
  made.
- Per-product credentials surface in the Dashboard only after the product is activated for the
  account.

## What the onboarding docs DO publish `[DOCS — dashboard-onboarding]`

- **Eligibility band (SME self-serve onboarding)** `[DOCS]`: South African businesses that **trade in ZAR,
  use a listed platform (WooCommerce, Shopify, etc.), and have monthly revenue between R100,000 and
  R1 million**. Outside that band the docs don't state the path — contact Peach (sales/support) rather
  than asserting any routing.
- **Flow**: getting-started form → emailed Dashboard access (limited functionality until onboarding
  completes) → verifications → risk evaluation → live payments unlocked.
- **Identity verification**: proof of identity (**driver's licences NOT accepted**); three failed
  attempts → manual review. Plus proof of liveness.
- **Ultimate beneficial owners**: every individual/company owning **≥5%** must be disclosed (sole
  proprietors exempt). Accepted evidence: CIPC beneficial-ownership register, company share
  register, or SARS IT3 (partnerships only). Each UBO completes their own identity + address
  verification via an emailed link.
- **Bank verification**: two failed attempts → manual review with a bank statement / account
  confirmation letter (<3 months old, in the legal entity's name).
- **Proof of physical business address** (e.g. bank statement <3 months old).
- **Timeline**: the risk check takes **up to 48 hours** after onboarding completion; a rejected
  document set gives two more attempts, then Peach responds within 48 hours (feedback or decline).

## What is NOT public — and how to answer anyway

Peach does not publish: the prohibited/restricted business list, MCC assignment rules, approval
likelihood beyond the 48-hour risk check, or standard legal artifacts (DPA/AOC/SLA). These belong
to Peach onboarding/sales and compliance. (List PRICING is published at peachpayments.com/fees —
marketing-site rates, verify current; commercial/merchant-specific terms stay with sales.)

**FICA / KYC data retention** is not a Peach API feature and is not publicly specified per-merchant.
Card data itself never touches the merchant (Peach's PCI-DSS Level 1 vault holds it; you keep only a
`registrationId`/`payment_method_id` token — `pci-security.md`). But how long the MERCHANT must retain
its own transaction and customer-identity records under FICA/POPIA is a **legal/compliance question for
the merchant's counsel**, not something the integration decides or the docs answer. State that honestly
and route it to counsel + Peach compliance; do not invent a retention period.

**Refusal script (use it, don't improvise):**
> "Peach doesn't publish its restricted-business list or onboarding document requirements — they're
> set by Peach's risk/onboarding team per merchant. What I can tell you from the public docs is
> [the relevant fact above]. For the current list and what your business needs, contact Peach
> sales/support before building — integration code can't fix an onboarding decision."

**Red line:** never help a merchant *evade* categorization — masking an MCC, rephrasing a
restricted business model for approval, or structuring around a category block is assisting
misrepresentation. Refuse that specific help plainly and route to Peach onboarding + the user's
own compliance counsel. (Telling a merchant honestly what IS public — e.g. "gambling requires
provincial licensing in SA; Peach onboarding makes the call" — is fine.)

## Pattern for regulated/gray-zone asks (gambling, lending, crypto, medicines, adult, alcohol)

1. Name the regulatory reality generically (licensing exists; you are not their lawyer).
2. State that Peach's acceptance decision is non-public and made at onboarding/risk.
3. Route: Peach sales/support for eligibility; their own counsel for licensing.
4. Only then discuss integration surface — and never promise that a technical integration path
   implies approval (or vice versa).

## Procurement/pack artifacts (AOC, POPIA DPA, SLAs, uptime)

Peach's PCI posture is public at a high level (`pci-security.md`: hosted surfaces keep merchants
SAQ A; "PCI DSS v4.x level 1 compliant vault"). Specific artifacts — signed DPAs, AOC copies,
uptime SLAs, audit letters — are commercial/legal documents from Peach sales, not from this skill.
Same referral pattern as pricing/fees (SKILL.md "When NOT to use").

## Traps

- Inventing KYC requirements BEYOND the published list above (the published list is real — quote
  it; don't pad it), or inventing approval likelihoods beyond the documented 48-hour risk check.
- Answering "can I sell X?" with a yes/no on Peach's behalf — the honest answer is "Peach
  onboarding decides; here's the contact path."
- Assuming sandbox access implies live eligibility — sandbox comes first by design; live is a
  separate risk approval.
- Helping optimize the *phrasing* of a restricted business model for approval — refuse; that's
  the MCC-masking trap in softer clothes.
- Pointing procurement at developer docs for legal artifacts — wrong door; Peach sales owns those.
