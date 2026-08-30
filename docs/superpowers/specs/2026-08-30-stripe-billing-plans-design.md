# Stripe Billing & Plan Foundation — Design

## Problem

The app has no billing, no plans, and no concept of a subscription. Every group (workspace) has unlimited admins, unlimited members, and unmetered access to the AI meeting-notes pipeline, with no way to charge for any of it. Cloudflare R2 cloud storage doesn't exist yet either.

This is the first of four planned pieces:

1. **This spec** — Stripe subscriptions and a plan/limits data model.
2. Admin/member seat-limit enforcement (reads the limits this spec produces).
3. R2 cloud storage, with per-group quota enforcement (reads the limits this spec produces).
4. AI meeting-notes usage metering, gated by plan (reads the limits this spec produces).

Specs 2–4 are out of scope here. This spec's job is narrow: define the three plans, get a group from signup to an active paid subscription via Stripe, and provide one place (`myBilling`) that every future enforcement check reads from.

## Plans

| | Starter | Business | Scale |
|---|---|---|---|
| Price | $28/mo | $59/mo | $99/mo |
| Admins | 1 | 3 | 5 |
| Members | 10 | 25 | 100 |
| Storage | 10 GB | 50 GB | 200 GB |
| AI meeting notes | 5 hrs/mo | 20 hrs/mo | 50 hrs/mo |

These limits are enforced by specs 2–4, not here — this spec only stores and surfaces them.

**Trial:** every group gets 14 days from its actual signup date, no card required, at Starter-level limits. A group past its trial with no paid plan — or whose subscription is `past_due`/`canceled`/`incomplete` — enters **read-only lockout**: existing data stays visible, but writes are blocked until an admin subscribes.

**Billing unit:** one Stripe subscription per group, not per admin. Any admin in the group can view billing and manage the subscription — there's no "owner" distinction among admins in the current schema, and this spec doesn't introduce one.

## Data model

`groups.groupId` is not unique today, and — verified against live data, not just theory — actually is duplicated: one existing group already has 3 rows sharing a `groupId` (one per admin). That rules out a unique index/FK there entirely, not just "for now": this schema has no single-row representation of "a group" to reference. `group_billing.group_id` is a plain primary key with no foreign key, matching how `members.group_id` already references a group loosely with no FK enforced either:

```sql
create table group_billing (
  group_id uuid primary key,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  plan text check (plan in ('starter', 'business', 'scale')),
  status text not null default 'trialing'
    check (status in ('trialing', 'active', 'past_due', 'canceled', 'incomplete')),
  trial_ends_at timestamptz not null,
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

The row is created lazily on first read via `getOrCreateBilling(groupId)` — but `trial_ends_at` is computed from `MIN(groups.created_at)` for that `groupId`, not from `now()`, so it reflects the group's real signup time regardless of when the row happens to get created.

Plan limits themselves are **not** in the database — they're a static config, `crm-proj/config/plans.js`, mapping tier → `{ name, priceMonthlyUsd, stripePriceId, adminLimit, memberLimit, storageGb, aiNotesHoursPerMonth }`. There are only three tiers and changing a limit is a deliberate code change, not runtime data.

## Backend

### GraphQL (`billingTypeDefs.js` / `billingResolvers.js`)

```graphql
enum PlanTier { STARTER BUSINESS SCALE }

type PlanLimits {
  tier: PlanTier!
  name: String!
  priceMonthlyUsd: Float!
  adminLimit: Int!
  memberLimit: Int!
  storageGb: Int!
  aiNotesHoursPerMonth: Int!
}

type Billing {
  groupId: ID!
  status: String!
  plan: PlanTier
  limits: PlanLimits!
  trialEndsAt: String
  currentPeriodEnd: String
  isLocked: Boolean!
}

type CheckoutSession { url: String! }
type PortalSession { url: String! }

type Query {
  myBilling: Billing!
  plans: [PlanLimits!]!
}

type Mutation {
  createCheckoutSession(plan: PlanTier!): CheckoutSession!
  createBillingPortalSession: PortalSession!
}
```

- `plans` requires no auth — it's also used on the public pricing/landing page.
- `myBilling` resolves the caller's groupId the same way for admins and members, reusing the existing `requireCallerGroupId` helper from `utils/requireUser.js` — no new auth path.
- `createCheckoutSession` / `createBillingPortalSession` require an authenticated **admin** (`requireGroup`), not a member.

### Checkout & portal

`createCheckoutSession(plan)`:
1. Get-or-create a Stripe Customer for the group (metadata `{ groupId }`), persisting `stripe_customer_id` on first creation.
2. Create a Checkout Session: `mode: 'subscription'`, the plan's Price ID from `config/plans.js`, `subscription_data.metadata.groupId` set (so webhook events on the subscription always carry the groupId).
3. Return the session's `url`; the frontend redirects the browser to it.

`createBillingPortalSession`: creates a Stripe Billing Portal session for the group's existing customer and returns its `url`.

### Webhook

`POST /webhooks/stripe` — registered with `express.raw({ type: 'application/json' })` **before** the app's `express.json()` middleware, since Stripe's signature verification needs the raw body. Verifies the signature with `STRIPE_WEBHOOK_SECRET`.

Handles `customer.subscription.created|updated|deleted`. Looks up the `group_billing` row by `stripe_customer_id` (from `event.data.object.customer`) and upserts:
- `plan` — mapped from `subscription.items.data[0].price.id` against `config/plans.js`'s Price IDs.
- `status` — mapped from Stripe's subscription status (`active`, `past_due`, `canceled`, `incomplete`, `incomplete_expired` → `canceled`, `unpaid` → `past_due`).
- `stripe_subscription_id`, `current_period_end`.

Upserts are idempotent by construction, so Stripe's automatic retries are safe.

### Enforcement — read-only lockout

A single Apollo Server plugin (`didResolveOperation` hook), not per-resolver edits. `didResolveOperation` receives the same `contextValue` the resolvers do, so the plugin calls the existing `requireCallerGroupId(context)` helper directly (wrapped so an unauthenticated/no-group caller is treated as "not locked" here — resolvers still enforce their own auth) and checks `isGroupLocked(groupId)`:

```
locked = status in ('past_due', 'canceled', 'incomplete')
      OR (status = 'trialing' AND now() > trial_ends_at)
```

If locked, the mutation is rejected with `extensions.code: 'BILLING_LOCKED'` — **unless** the mutation's top-level field name is in a fixed allowlist: `registerUser`, `loginUser`, `signOutUser`, `loginMember`, `logoutMember`, `joinGroup`, `createCheckoutSession`, `createBillingPortalSession`. Queries are never blocked — locked groups can still read their existing data.

This is deliberately centralized: specs 2–4 do **not** need to add their own lockout checks to new resolvers, since this plugin already covers every mutation in the schema, present and future.

### Config

New env vars in `crm-proj/.env` (already populated against the "Continuum CRM sandbox" Stripe test environment):
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (set via `stripe listen` in dev), `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_BUSINESS`, `STRIPE_PRICE_SCALE`.

New dependency: `stripe` (Node SDK) added to `crm-proj/package.json`.

## Frontend

- `BillingContext` / `useBilling`, mirroring the existing `GroupContext` pattern exactly (query on mount once auth settles, `{ billing, loading, error, refetch }`).
- `src/pages/Billing.tsx` at `/app/billing` (new route + `Sidebar.tsx` entry, admin-only): current plan/status/trial countdown; three plan cards rendered from the `plans` query (not hardcoded, so a future price change needs no frontend deploy); "Choose plan" → `createCheckoutSession` → `window.location.href = url`; "Manage billing" → `createBillingPortalSession` → same redirect. Handles the Checkout return URL's `?checkout=success|cancel` query param with a toast.
- `LockoutBanner`, rendered in both `AppShell` and `MemberShell` when `billing.isLocked`. Admins see a link to `/app/billing`; members see a message to contact an admin. This banner is the primary UX signal — the Apollo plugin above is the actual enforcement backstop, not something the UI needs to defensively code around on every form.

## Testing

- **Unit:** `getOrCreateBilling` / `isGroupLocked` trial-math (boundary at exactly `trial_ends_at`), the plugin's allowlist logic, and the Stripe status → internal status mapping.
- **Webhook:** handler test driven by Stripe's test-mode event fixtures — signature verification (valid/invalid), upsert correctness, idempotency on a replayed event.
- **Manual, against the Stripe sandbox:** `stripe listen --forward-to localhost:4000/webhooks/stripe` plus a test-mode card (`4242 4242 4242 4242`) through the full checkout → webhook → unlock loop; a decline card (`4000 0000 0000 9995`) to exercise `past_due` → lockout.
- **Frontend:** trial countdown display, checkout redirect, portal redirect, and the lockout banner appearing/disappearing as billing status changes.

## Rollout checklist

- [ ] Stripe sandbox: 3 Products/Prices created, secret key and Price IDs in `.env` (done)
- [ ] `group_billing` table created in Supabase
- [ ] `stripe` package installed; billing typedefs/resolvers wired into `server.js`
- [ ] `/webhooks/stripe` route registered before the JSON body parser
- [ ] Apollo lockout plugin registered
- [ ] Frontend `BillingContext`, `Billing` page, `LockoutBanner`, nav entry
- [ ] End-to-end sandbox test: signup → trial → checkout → webhook fires → `myBilling` reflects `active` → cancel via portal → webhook fires → lockout takes effect
