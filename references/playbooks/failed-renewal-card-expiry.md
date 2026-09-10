# Playbook — card expired / renewal payment failed (retokenization)

## When to load

A recurring debit failed because the stored card expired or was replaced, the user asks "what
happens when cards lapse", you're designing subscription dunning, or a renewal charge just failed
with an issuer decline. This is the scenario most integrations forget until churn bites.

## The situation

Stored-card debits fail when the physical card expires (you can see it coming — you stored
`card.expiryMonth/Year`) or is replaced (fraud reissue, bank migration — expiry may even stay the
same while the PAN changed; that's what network tokens solve). Peach will keep accepting your MIT
attempts and the issuer will keep declining them (`800.100.*`, often with
`MerchantAdviceCode 01` = new account information available). Nobody at Peach updates the card for
you. The fix is always the same shape: **get the customer to re-enter card details on a Peach
surface, capture a fresh `registrationId`, swap it in, resume.**

## Decision tree

```
Did the debit fail, or is it about to?
├─ ABOUT TO (expiry scan: expiryMonth/Year < next debit date + buffer)
│    → proactive: send retokenization link BEFORE the debit date (best recovery rates)
├─ FAILED
│    ├─ MerchantAdviceCode 01 (card updated upstream) → retry the debit once now — often succeeds
│    ├─ MerchantAdviceCode 03 (do NOT retry — Dashboard docs say "Retry is not allowed") → STOP retries, cancel mandate per your policy + confirm with cardholder
│    ├─ MerchantAdviceCode 02 (try later)             → retry per ladder + send link
│    └─ MerchantAdviceCode 04 (never retry) / hard decline / expired
│         → STOP retrying; retokenization link is the ONLY path
└─ Token deregistered (customer removed card) → retokenization link immediately
```

(Dunning ladder timing itself: `subscriptions.md`.)

## The retokenization play (recommended default)

**Send a Payment Link that tokenises without charging: a zero-amount `PA` link with
`tokeniseCard: true`.** The customer clicks, enters the new card on Peach's hosted page (SAQ A —
no card data ever touches your stack), pays nothing, and the `completed` webhook delivers the new
`registrationId`.

```json
// runnable — POST https://links.peachpayments.com/api/channels/{entityId}/payments
// (sandbox https://sandbox-l.ppay.io) with OAuth bearer from /api/oauth/token
{
  "payment": { "merchantInvoiceId": "RETOKEN-4821", "amount": 0, "currency": "ZAR" },
  "customer": { "givenName": "Thabo", "surname": "M", "email": "thabo@example.com",
                 "mobile": "+27821234567" },
  "options": { "sendEmail": true, "sendSms": true, "expiryTime": 4320 },
  "checkout": { "tokeniseCard": true, "paymentType": "PA",
                 "defaultPaymentMethod": "CARD", "forceDefaultMethod": true }
}
```

- Zero-amount requires `PA` + tokenisation — exactly this combination is the documented carve-out
  for `amount: 0`.
- On the **`completed` webhook** (Payment Links events arrive JSON-signed — `../webhooks.md`
  Scheme B): read `checkout.registrationId` (+ `paymentBrand`, last4 if present). **Links deliver
  `registrationId` only on `completed`** — don't wait for any other event.
- Swap sequence (one transaction): insert new registration for customer → mark old registration
  superseded (don't deregister yet — see below) → reschedule the failed debit as an MIT on the NEW
  token → email "payment method updated; your subscription continues".
- Charge instead of authorise? Some products prefer a small `DB` link (e.g. R1) to also validate
  collectability — acceptable variant; then apply it against the invoice or refund it.

### Alternatives (when links don't fit)

| Surface | How | Use when |
|---|---|---|
| Embedded one-click re-auth | Render Checkout with the customer present (CIT `mode:REPEATED`) + `createRegistration:true` — a fresh token replaces the old | customer is in your app right now |
| Customer portal page | A "update payment method" page that creates a zero-amount PA checkout + `createRegistration:true` | you have a logged-in portal |
| MOTO | Dashboard virtual terminal + "Create registration" | phone-based support flows only — no 3DS, you carry chargeback liability, needs permission |
| Network tokens | Enabled upfront: issuer auto-updates many reissued cards — debits keep succeeding silently | prevention, not cure (enable via support) |

## Detection wiring (make it automatic)

1. **Pre-emptive scan** — monthly job: `expiryMonth/Year` vs next scheduled debit + 1 month
   buffer → proactive link email ("your card ending 4242 expires next month").
2. **Post-failure classification** — on debit webhook/status, pull
   `resultDetails.MerchantAdviceCode` (`../result-codes.md`) + code family:
   - `800.100.1xx` + expiry match → expired-card path
   - `800.100.196`/`…194`-family "card blocked/reissued" hints → replaced-card path
   - insufficient funds (`800.100.203` = "insufficient funds") → NOT a card problem — dunning ladder only, no
     retokenization link (annoying and useless)
   - ⚠️ `800.100.501` = "cardholder stopped all recurring payments" (revoked mandate) → STOP billing
     entirely; do NOT retry or send update-card links — the shopper has cancelled at issuer level
3. **Deregistration events** — if you wired `onRemoveCard`/`cardRemovalUrl`, a removal during an
   active subscription is itself a trigger.

## Metrics that prove this works

- Recovery rate: % of `PAST_DUE` subscriptions back to `ACTIVE` within 14 days (target >40% with
  links in the first email).
- Time-to-recover median; involuntary-churn rate per 100 active subs/month; link click→completed
  conversion.

## Traps

- Retokenizing but keeping the OLD `initialTransactionId` with the NEW registration — the MIT
  trace must come from the new CIT; store the fresh `schemeTransactionId`/`initialTransactionId`
  with the swap.
- Deregistering the old token at swap time — if the swap webhook hasn't landed or the new debit
  fails, you've burned the fallback. Supersede now, deregister after first successful debit.
- Zero-amount link with `paymentType: "DB"` → rejected; `0` needs `PA` (+ tokenisation).
- Links are single-payment and non-editable — if it expires, generate a new one (`expiryTime`
   5–43200 min; default 30 days is usually too long for dunning, use ~3 days).
- Customer pays the SAME failed invoice manually via the link while your scheduler also retries
  the old token → double collection. Suppress scheduled retries for that period once the
  retokenization `completed` event lands (idempotency key: customerId + period).
- `registrationId` never arriving because you listened for the wrong event (Links emit it only on
  `completed`, and only for card brands).
- Forgetting wallets: a subscription tokenised on Apple Pay can't be "updated" via card link —
  route wallet-token customers to re-auth in-app (CIT) instead.
