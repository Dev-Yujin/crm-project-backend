# Paddle billing migration

## Problem

Continuum CRM bills its tenants (admins) via Stripe: a hosted-checkout redirect flow, a Stripe billing portal for self-service management, and a webhook that keeps `group_billing` in sync. We're switching the payment provider to Paddle. There are no live subscribers today, so this is a clean swap, not a migration of existing subscription data.

Paddle's checkout model differs from Stripe's in a way that changes the architecture, not just the provider: Stripe issues a server-generated redirect URL; Paddle's checkout is opened client-side (`Paddle.Checkout.open()`) as an in-page overlay, with the backend only ever finding out the result via webhook (plus a client-side completion callback for the immediate redirect).

## Goals

- Replace Stripe with Paddle end-to-end: checkout, billing portal, webhook, plan/price config.
- 3-tier pricing UI (Starter/Business/Scale) with a monthly/yearly toggle and country-localized prices sourced from `Paddle.PricePreview()`.
- Sandbox environment only for this pass; environment is read from env vars and the app fails loudly if unset (never silently defaults).
- Tier metadata (name, description, features, price IDs) lives in one easily-edited config file per side.

## Non-goals

- Migrating any existing Stripe subscription data (none exists).
- Going live / real payments (sandbox only; live-mode wiring is a separate future pass).
- Seat-limit enforcement or AI-notes usage metering (pre-existing, unrelated deferred work).

## Pricing

| Tier | Monthly | Yearly (2 months free) |
|---|---|---|
| Starter | $29 | $290 |
| Business | $59 | $590 |
| Scale | $99 | $990 |

Limits per tier (admin/member/storage/AI-notes) are unchanged from the current `config/plans.js` — only the payment-provider fields change.

## Backend (`crm-proj`)

### `config/paddle.js` (replaces `config/stripe.js`)

Same fail-loud-on-missing-env pattern as `config/stripe.js` today. Required vars: `PADDLE_API_KEY`, `PADDLE_ENVIRONMENT` (`sandbox` — read explicitly, never defaulted), `PADDLE_WEBHOOK_SECRET`. Uses `@paddle/paddle-node-sdk`, constructed with the environment passed in explicitly (`Environment.sandbox`) so it can never silently point at production.

### `config/plans.js`

`stripePriceId` → `paddlePriceId: { month: string, year: string }` per tier. `priceMonthlyUsd` for Starter corrected to `29` (was `28`). `planByPriceId(priceId)` becomes `planByPriceId(priceId)` searching both `month` and `year` IDs — the webhook only knows a subscription's current price ID, and a customer could be on either cycle.

Price IDs are created via the Paddle API during implementation (see "Paddle-side setup" below) and hardcoded directly into this file as literal strings, same as the frontend's `paddleTiers.ts` below — not read from env vars. Price IDs aren't secrets (they're visible in every checkout request from the browser), and hardcoding matches the "easy for me to edit in code" requirement that also shapes the frontend config.

### `models/billing.js`

Same shape, retargeted:
- `stripe_customer_id`/`stripe_subscription_id` columns renamed to `paddle_customer_id`/`paddle_subscription_id` (in-place rename migration script, modeled on `scripts/create-group-billing-table.js`).
- `getOrCreateStripeCustomerId` → `getOrCreatePaddleCustomerId`, same lazy-provisioning shape, `createCustomerFn` now creates a Paddle customer.
- `upsertBillingFromSubscription` retargeted at Paddle's subscription object shape (`customer_id`, `items[].price.id`, `status`, `current_billing_period.ends_at`). Same dual resolution (by customer ID, falling back to `custom_data.groupId` metadata) and same "not ours, ignore" handling for unmatched events.

### `models/billingLogic.js`

New `mapPaddleStatus(status)` alongside the existing `mapStripeStatus`. Paddle subscription statuses (`active`, `trialing`, `past_due`, `paused`, `canceled`) map onto the same internal status set; `paused` is treated as locked, same as `canceled`.

### `resolvers/billingResolvers.js`

- `createCheckoutSession` mutation **removed** — no backend-generated checkout URL in Paddle's client-driven flow.
- `createBillingPortalSession` retargeted at Paddle's customer-portal API (create a portal session for the group's `paddle_customer_id`, return its URL). Same "no customer yet" error path.
- `myBilling`/`plans` queries unchanged in shape (still return `PlanLimits`), just sourced from the updated `config/plans.js`.

### `routes/paddleWebhook.js` (replaces `routes/stripeWebhook.js`)

Express handler, same raw-body constraint as the Stripe route (mounted with `express.raw`). Verifies via the Paddle SDK's `webhooks.unmarshal(rawBody, secret, signatureHeader)`. Handles `subscription.created`, `subscription.updated`, `subscription.canceled` → `upsertBillingFromSubscription`. Same unmatched-event tolerance (200, not 500, on no-match).

### Data model

`group_billing` table: `ALTER TABLE ... RENAME COLUMN stripe_customer_id TO paddle_customer_id`, same for `stripe_subscription_id`. No new columns needed. One-off script alongside the existing `scripts/create-group-billing-table.js`, run once against Postgres.

## Frontend (`crm-frontend`)

### `src/lib/paddleTiers.ts` (new)

```ts
export interface Tier {
  name: 'Starter' | 'Business' | 'Scale';
  description: string;
  features: string[];
  priceId: { month: string; year: string };
}

export const TIERS: Tier[] = [ /* 3 entries, price IDs filled in after Paddle-side setup */ ];
```

Kept intentionally separate from the backend's `config/plans.js` — same duplication that already exists today in spirit (limits are backend-only, checkout-facing IDs are now frontend-only, because Paddle checkout is frontend-driven). A comment on both files cross-references the other so a price change isn't made in only one place.

### Paddle.js initialization

New `src/lib/paddle.ts`: lazily initializes `@paddle/paddle-js` with `environment` and `token` from `VITE_PADDLE_ENVIRONMENT` / `VITE_PADDLE_CLIENT_TOKEN`. Throws (not silently no-ops) if either is unset — same fail-loud requirement as the backend. The client-side token is public-safe by design (Paddle's own model — the client-side token in `@paddle/paddle-js` cannot execute the API operations a server-side key can), unlike `PADDLE_API_KEY`, which stays backend-only and never enters any `VITE_`-prefixed var or client bundle.

### `src/pages/Billing.tsx`

The plan-selection card grid changes:
- Adds a monthly/yearly toggle (local component state).
- On mount and on toggle change, calls `Paddle.PricePreview()` with the 6 price IDs (all tiers, both cycles aren't both fetched at once — only the active cycle's 3 IDs) and no country code, letting Paddle auto-detect from the visitor's IP. Displays only `formattedTotals` from the response verbatim — no `Intl.NumberFormat`, no re-rounding.
- If the current admin is signed in, their email is read from the existing auth context and passed as `customer.email` to both `PricePreview()` and `Checkout.open()` to prefill it.
- "Choose plan" button calls `Paddle.Checkout.open({ items: [{ priceId, quantity: 1 }], customer: { email }, settings: { displayMode: 'overlay', variant: 'one-page' }, eventCallback })`. The callback redirects to `/welcome` on `checkout.completed`.
- `choosePlan()`'s current `graphqlRequest(CREATE_CHECKOUT_SESSION, ...)` → `window.location.href` flow is deleted entirely.
- `manageBilling()` keeps calling `CREATE_BILLING_PORTAL_SESSION` and redirecting — only the backend implementation of that mutation changes, not the frontend call site.
- The existing Stripe-webhook-lag polling/confirmation-banner pattern (`checkoutResult === 'success'`, 2s poll up to 15s) is reused as-is for anyone who lands back on `/billing` instead of `/welcome` (e.g., closes the overlay's success state without the callback firing, or opens billing in a second tab).

### `src/lib/queries.ts`

`CREATE_CHECKOUT_SESSION` removed. `CREATE_BILLING_PORTAL_SESSION` and `PLANS` unchanged.

## Country-localized pricing

No server-side geo detection. This is a static Vite SPA (no per-request server render — the same constraint that already forces CSP to be a build-time meta tag rather than a response header). `Paddle.PricePreview()` is called with no country code and relies entirely on its own IP-based auto-detection, which the original requirement already treats as the correct fallback path — here it's simply the only path.

## Paddle-side setup

Two things are created via the Paddle API during implementation, using the already-provided sandbox API key:
- **6 price objects** (3 tiers × month/year), under a new product per tier. Low-stakes, reversible (archivable in Paddle).
- **Webhook notification destination**, pointed at the deployed backend's new `/webhooks/paddle` route. This is a standing integration on a third-party account — implementation will pause and confirm the exact URL before creating it, rather than doing it silently.

Two things require the user, in the Paddle dashboard, and cannot be done via API:
- **Client-side token** (`test_...`) — Developer Tools → Authentication.
- **Default payment link** — Checkout → Checkout settings, pointed at the sandbox checkout page (or `localhost:5173` for local dev). Paddle checkout does not render without this set, even in overlay mode.

`.env.example` (both repos) gets updated with the new Paddle vars; Stripe vars are removed once the swap is verified working.

## Verification

Local dev server, sandbox mode:
1. Billing page loads, `PricePreview()` returns real localized totals for all 3 tiers, both cycles.
2. Toggling monthly/yearly updates the displayed totals.
3. "Choose plan" opens the overlay checkout for the exact tier/cycle shown.
4. Completing checkout with Paddle's sandbox test card fires `checkout.completed` and redirects to `/welcome`.
5. The webhook lands, `group_billing.plan`/`status` update correctly, `myBilling` reflects it.
6. "Manage billing" opens Paddle's customer portal for the right customer.

## Out of scope / explicitly deferred

- Live-mode Paddle setup (real domain approval, live API key/token) — a later "test and go live" pass.
- Any UI/behavior change to the storage-usage or usage-breakdown sections of the Billing page — untouched by this work.
