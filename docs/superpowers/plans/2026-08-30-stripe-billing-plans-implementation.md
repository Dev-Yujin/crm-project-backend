# Stripe Billing & Plan Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every group a plan (Starter/Business/Scale) backed by a real Stripe subscription, with a 14-day no-card trial, a Stripe-hosted checkout + billing portal, and a centralized read-only lockout when a group has no active plan.

**Architecture:** A new Postgres table (`group_billing`) tracks one billing row per group, lazily created on first read with a trial window computed from the group's real signup date. A small GraphQL surface (`myBilling`, `plans`, `createCheckoutSession`, `createBillingPortalSession`) plus a Stripe webhook route keep that row in sync with Stripe. A single Apollo Server plugin — not per-resolver edits — blocks mutations for locked groups everywhere at once. The frontend adds an admin `BillingContext` + `/app/billing` page, and a lockout banner shown to both admins and members.

**Tech Stack:** Node/Express/Apollo Server 5 backend (`crm-proj`), Postgres via `pg` (Supabase), Stripe Node SDK, Vitest (new — this repo has no test framework yet); React 19/Vite/TypeScript frontend (`crm-frontend`), no new frontend dependencies.

## Global Constraints

- Plans: Starter $28/mo (1 admin, 10 members, 10 GB, 5 AI-notes hrs/mo), Business $59/mo (3 admins, 25 members, 50 GB, 20 hrs/mo), Scale $99/mo (5 admins, 100 members, 200 GB, 50 hrs/mo).
- Trial: 14 days, no card, Starter-level limits, computed from the group's actual `groups.created_at` (not from whenever the billing row happens to be created).
- Lockout: a group is locked when `status` is `past_due`, `canceled`, or `incomplete`, or when `status = 'trialing'` and `now() > trial_ends_at`. Locked groups can still read; only mutations are blocked.
- Lockout allowlist (always permitted regardless of lock state): `registerUser`, `loginUser`, `signOutUser`, `loginMember`, `logoutMember`, `joinGroup`, `createCheckoutSession`, `createBillingPortalSession`.
- One Stripe subscription per group, not per admin. Any admin in the group can manage billing.
- Stripe env vars already set in `crm-proj/.env`: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_BUSINESS`, `STRIPE_PRICE_SCALE` (test/sandbox — "Continuum CRM sandbox").
- Spec: `docs/superpowers/specs/2026-08-30-stripe-billing-plans-design.md`.

---

## Task 1: Test framework, Stripe SDK, plan config

**Files:**
- Modify: `crm-proj/package.json`
- Create: `crm-proj/vitest.config.js`
- Create: `crm-proj/vitest.setup.js`
- Create: `crm-proj/config/plans.js`
- Test: `crm-proj/config/plans.test.js`

**Interfaces:**
- Produces: `PLANS` (object keyed by `'starter' | 'business' | 'scale'`, each `{ tier, name, priceMonthlyUsd, stripePriceId, adminLimit, memberLimit, storageGb, aiNotesHoursPerMonth }`), `planByPriceId(priceId: string): string | null`, `planLimitsResponse(planKey: string | null): { tier, name, priceMonthlyUsd, adminLimit, memberLimit, storageGb, aiNotesHoursPerMonth }` (strips `stripePriceId` for GraphQL responses; `null`/missing key defaults to `'starter'`), all from `config/plans.js`. Every later backend task imports from here — `planLimitsResponse` in particular is shared by both `models/billing.js` (Task 4) and `resolvers/billingResolvers.js` (Task 5) so the plan→response shape is defined exactly once.

- [ ] **Step 1: Install dependencies**

```bash
cd crm-proj && npm install stripe && npm install -D vitest
```

- [ ] **Step 2: Add the test script**

In `crm-proj/package.json`, replace the placeholder `test` script:

```json
"scripts": {
  "test": "vitest run",
  "dev": "nodemon server.js",
  "start": "node server.js"
},
```

- [ ] **Step 3: Add Vitest config + env setup**

`crm-proj/vitest.config.js`:

```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.js'],
  },
});
```

`crm-proj/vitest.setup.js`:

```js
import dotenv from 'dotenv';

dotenv.config();
```

- [ ] **Step 4: Write the failing test**

`crm-proj/config/plans.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { PLANS, planByPriceId, planLimitsResponse } from './plans.js';

describe('planByPriceId', () => {
  it('finds the plan key for a known price id', () => {
    expect(planByPriceId(PLANS.starter.stripePriceId)).toBe('starter');
    expect(planByPriceId(PLANS.business.stripePriceId)).toBe('business');
    expect(planByPriceId(PLANS.scale.stripePriceId)).toBe('scale');
  });

  it('returns null for an unknown price id', () => {
    expect(planByPriceId('price_doesnotexist')).toBeNull();
  });
});

describe('planLimitsResponse', () => {
  it('returns the full limits shape for a known plan key, without leaking stripePriceId', () => {
    const result = planLimitsResponse('business');
    expect(result).toEqual({
      tier: 'BUSINESS',
      name: 'Business',
      priceMonthlyUsd: 59,
      adminLimit: 3,
      memberLimit: 25,
      storageGb: 50,
      aiNotesHoursPerMonth: 20,
    });
  });

  it('defaults to Starter-level limits when planKey is null (still on trial)', () => {
    expect(planLimitsResponse(null).tier).toBe('STARTER');
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `cd crm-proj && npm test`
Expected: FAIL — `config/plans.js` does not exist yet.

- [ ] **Step 6: Write the implementation**

`crm-proj/config/plans.js`:

```js
// The three plan tiers this app sells. Static, not database-backed — there are only
// three of them and changing a limit is a deliberate code change. Prices are also
// created directly in Stripe (see docs/superpowers/specs/2026-08-30-stripe-billing-plans-design.md);
// the Price IDs below just link this config to the right Stripe object.
export const PLANS = {
  starter: {
    tier: 'STARTER',
    name: 'Starter',
    priceMonthlyUsd: 28,
    stripePriceId: process.env.STRIPE_PRICE_STARTER,
    adminLimit: 1,
    memberLimit: 10,
    storageGb: 10,
    aiNotesHoursPerMonth: 5,
  },
  business: {
    tier: 'BUSINESS',
    name: 'Business',
    priceMonthlyUsd: 59,
    stripePriceId: process.env.STRIPE_PRICE_BUSINESS,
    adminLimit: 3,
    memberLimit: 25,
    storageGb: 50,
    aiNotesHoursPerMonth: 20,
  },
  scale: {
    tier: 'SCALE',
    name: 'Scale',
    priceMonthlyUsd: 99,
    stripePriceId: process.env.STRIPE_PRICE_SCALE,
    adminLimit: 5,
    memberLimit: 100,
    storageGb: 200,
    aiNotesHoursPerMonth: 50,
  },
};

// Reverse lookup used by the Stripe webhook, which only knows a subscription's Price ID.
export function planByPriceId(priceId) {
  return Object.keys(PLANS).find((key) => PLANS[key].stripePriceId === priceId) ?? null;
}

// Shapes a plan key into the GraphQL PlanLimits response — used by both
// models/billing.js (a group's current limits) and resolvers/billingResolvers.js (the
// public plans list), so the shape is defined exactly once. Strips stripePriceId, which
// is an internal implementation detail with no place in a client-facing response.
// planKey may be null (a group still on trial has no plan chosen yet) — defaults to
// Starter-level limits, matching the trial's actual limits.
export function planLimitsResponse(planKey) {
  const config = PLANS[planKey ?? 'starter'];
  return {
    tier: config.tier,
    name: config.name,
    priceMonthlyUsd: config.priceMonthlyUsd,
    adminLimit: config.adminLimit,
    memberLimit: config.memberLimit,
    storageGb: config.storageGb,
    aiNotesHoursPerMonth: config.aiNotesHoursPerMonth,
  };
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cd crm-proj && npm test`
Expected: PASS (4 tests)

- [ ] **Step 8: Commit**

```bash
cd crm-proj && git add package.json package-lock.json vitest.config.js vitest.setup.js config/plans.js config/plans.test.js
git commit -m "Add Stripe SDK, Vitest, and the plan tier config"
```

---

## Task 2: `group_billing` table

**Files:**
- Create: `crm-proj/scripts/create-group-billing-table.js`

**Interfaces:**
- Produces: the `group_billing` Postgres table and a unique index on `groups."groupId"`, which every later task in this plan reads/writes via `pool.query`.

This runs DDL against the shared Supabase database that already backs the live app (there is no separate dev/staging database in this project) — **confirm with the user before running Step 2**, even though the change is purely additive (`IF NOT EXISTS` guards, no existing table touched).

- [ ] **Step 1: Write the migration script**

`crm-proj/scripts/create-group-billing-table.js`:

```js
// One-time setup: creates the group_billing table backing Stripe subscriptions (see
// docs/superpowers/specs/2026-08-30-stripe-billing-plans-design.md). Idempotent — safe
// to re-run; IF NOT EXISTS guards make a second run a no-op.
//
// Usage: node scripts/create-group-billing-table.js

import { pool } from "../config/supabase.js";

async function main() {
  console.log("Creating unique index on groups.groupId (if missing)...");
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS groups_group_id_unique ON groups ("groupId")');

  console.log("Creating group_billing table (if missing)...");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS group_billing (
      group_id uuid PRIMARY KEY REFERENCES groups ("groupId"),
      stripe_customer_id text UNIQUE,
      stripe_subscription_id text UNIQUE,
      plan text CHECK (plan IN ('starter', 'business', 'scale')),
      status text NOT NULL DEFAULT 'trialing'
        CHECK (status IN ('trialing', 'active', 'past_due', 'canceled', 'incomplete')),
      trial_ends_at timestamptz NOT NULL,
      current_period_end timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const check = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'group_billing'
  `);
  console.log(
    check.rows.length > 0
      ? "Done — group_billing table exists."
      : "Something went wrong — group_billing table was not found after creation.",
  );

  await pool.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it (after confirming with the user)**

Run: `cd crm-proj && node scripts/create-group-billing-table.js`
Expected: prints `Done — group_billing table exists.`

- [ ] **Step 3: Verify idempotency**

Run the same command again.
Expected: same success output, no error (proves the `IF NOT EXISTS` / IF-missing guards work).

- [ ] **Step 4: Commit**

```bash
git add scripts/create-group-billing-table.js
git commit -m "Add group_billing table migration script"
```

---

## Task 3: Pure billing logic (lock decision + Stripe status mapping)

**Files:**
- Create: `crm-proj/models/billingLogic.js`
- Test: `crm-proj/models/billingLogic.test.js`

**Interfaces:**
- Produces: `computeIsLocked(status: string, trialEndsAt: Date | string | null, now?: Date): boolean`, `mapStripeStatus(stripeStatus: string): 'active' | 'past_due' | 'canceled' | 'incomplete'`. Consumed by `models/billing.js` (Task 4).

Kept separate from `models/billing.js` (which does real Postgres I/O) specifically so this decision logic is testable with no database.

- [ ] **Step 1: Write the failing tests**

`crm-proj/models/billingLogic.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { computeIsLocked, mapStripeStatus } from './billingLogic.js';

describe('computeIsLocked', () => {
  it('locks a past_due group regardless of trial dates', () => {
    expect(computeIsLocked('past_due', null)).toBe(true);
  });

  it('locks a canceled group', () => {
    expect(computeIsLocked('canceled', new Date(Date.now() + 100000))).toBe(true);
  });

  it('locks an incomplete group', () => {
    expect(computeIsLocked('incomplete', null)).toBe(true);
  });

  it('does not lock an active group', () => {
    expect(computeIsLocked('active', null)).toBe(false);
  });

  it('does not lock a trialing group before trial_ends_at', () => {
    const now = new Date('2026-08-30T12:00:00.000Z');
    const future = new Date('2026-08-30T13:00:00.000Z');
    expect(computeIsLocked('trialing', future, now)).toBe(false);
  });

  it('does not lock a trialing group exactly at trial_ends_at', () => {
    const now = new Date('2026-08-30T12:00:00.000Z');
    expect(computeIsLocked('trialing', now, now)).toBe(false);
  });

  it('locks a trialing group one millisecond past trial_ends_at', () => {
    const trialEndsAt = new Date('2026-08-30T12:00:00.000Z');
    const now = new Date(trialEndsAt.getTime() + 1);
    expect(computeIsLocked('trialing', trialEndsAt, now)).toBe(true);
  });
});

describe('mapStripeStatus', () => {
  it('maps active and trialing to active', () => {
    expect(mapStripeStatus('active')).toBe('active');
    expect(mapStripeStatus('trialing')).toBe('active');
  });

  it('maps past_due and unpaid to past_due', () => {
    expect(mapStripeStatus('past_due')).toBe('past_due');
    expect(mapStripeStatus('unpaid')).toBe('past_due');
  });

  it('maps canceled and incomplete_expired to canceled', () => {
    expect(mapStripeStatus('canceled')).toBe('canceled');
    expect(mapStripeStatus('incomplete_expired')).toBe('canceled');
  });

  it('maps incomplete and any unrecognized status to incomplete', () => {
    expect(mapStripeStatus('incomplete')).toBe('incomplete');
    expect(mapStripeStatus('something_stripe_adds_later')).toBe('incomplete');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd crm-proj && npm test`
Expected: FAIL — `models/billingLogic.js` does not exist yet.

- [ ] **Step 3: Write the implementation**

`crm-proj/models/billingLogic.js`:

```js
// Pure functions, no I/O — see billingLogic.test.js. billing.js (real Postgres/Stripe
// I/O) imports these rather than duplicating the decision logic.

const LOCKED_STATUSES = new Set(['past_due', 'canceled', 'incomplete']);

// Whether a group's writes should be blocked: its subscription has lapsed, or it's
// still on trial and the trial has ended with no plan chosen. `now` is injectable for
// testing; defaults to the real current time in production use.
export function computeIsLocked(status, trialEndsAt, now = new Date()) {
  if (LOCKED_STATUSES.has(status)) return true;
  if (status === 'trialing') {
    if (!trialEndsAt) return false;
    return now.getTime() > new Date(trialEndsAt).getTime();
  }
  return false;
}

// Maps a Stripe Subscription's `status` to this app's internal status. This app never
// sets trial_period_days on a Stripe subscription — our 14-day trial is tracked
// entirely in group_billing before any Stripe subscription exists — so Stripe's
// 'trialing' should never actually occur here, but it's mapped defensively (to
// 'active') rather than left to fall through to 'incomplete'.
export function mapStripeStatus(stripeStatus) {
  switch (stripeStatus) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
    case 'incomplete_expired':
      return 'canceled';
    case 'incomplete':
    default:
      return 'incomplete';
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd crm-proj && npm test`
Expected: PASS (15 tests total, including Task 1's)

- [ ] **Step 5: Commit**

```bash
git add models/billingLogic.js models/billingLogic.test.js
git commit -m "Add pure billing lock/status logic with tests"
```

---

## Task 4: Billing data access (`models/billing.js`)

**Files:**
- Create: `crm-proj/models/billing.js`

**Interfaces:**
- Consumes: `planByPriceId`, `planLimitsResponse` (Task 1); `computeIsLocked`, `mapStripeStatus` (Task 3); `pool` from `crm-proj/config/supabase.js` (existing).
- Produces: `getOrCreateBilling(groupId: string): Promise<Billing>` where `Billing = { groupId, status, plan: string|null, limits: {tier,name,priceMonthlyUsd,adminLimit,memberLimit,storageGb,aiNotesHoursPerMonth}, trialEndsAt: string|null, currentPeriodEnd: string|null, isLocked: boolean }`; `isGroupLocked(groupId: string): Promise<boolean>`; `getStripeCustomerId(groupId: string): Promise<string|null>`; `getOrCreateStripeCustomerId(groupId: string, createCustomerFn: () => Promise<string>): Promise<string>`; `upsertBillingFromSubscription(subscription: Stripe.Subscription): Promise<void>`. Consumed by `resolvers/billingResolvers.js` (Task 5), `utils/billingLockPlugin.js` (Task 6), `routes/stripeWebhook.js` (Task 7).

No isolated automated test here — every function needs a live Postgres connection, and this repo has no test-database harness (out of scope for this spec). Correctness is verified end-to-end in Task 8 against the real (single, shared) database, same as the rest of this codebase's existing manual-verification convention.

- [ ] **Step 1: Write the implementation**

`crm-proj/models/billing.js`:

```js
import { pool } from '../config/supabase.js';
import { planByPriceId, planLimitsResponse } from '../config/plans.js';
import { computeIsLocked, mapStripeStatus } from './billingLogic.js';

const TRIAL_DAYS = 14;

function mapRow(row) {
  return {
    groupId: row.group_id,
    status: row.status,
    plan: row.plan ? row.plan.toUpperCase() : null,
    limits: planLimitsResponse(row.plan),
    trialEndsAt: row.trial_ends_at ? row.trial_ends_at.toISOString() : null,
    currentPeriodEnd: row.current_period_end ? row.current_period_end.toISOString() : null,
    isLocked: computeIsLocked(row.status, row.trial_ends_at),
  };
}

// Reads a group's billing row, lazily provisioning a 14-day trial the first time it's
// ever read — trial_ends_at is computed from the group's actual signup date, not from
// whenever this function first happens to run.
export async function getOrCreateBilling(groupId) {
  const existing = await pool.query('SELECT * FROM group_billing WHERE group_id = $1', [groupId]);
  if (existing.rows.length > 0) {
    return mapRow(existing.rows[0]);
  }

  const groupCreated = await pool.query(
    'SELECT MIN(created_at) AS created_at FROM groups WHERE "groupId" = $1',
    [groupId],
  );
  const createdAt = groupCreated.rows[0]?.created_at ?? new Date();

  const inserted = await pool.query(
    `INSERT INTO group_billing (group_id, status, trial_ends_at)
     VALUES ($1, 'trialing', $2::timestamptz + make_interval(days => $3))
     ON CONFLICT (group_id) DO NOTHING
     RETURNING *`,
    [groupId, createdAt, TRIAL_DAYS],
  );

  if (inserted.rows.length > 0) {
    return mapRow(inserted.rows[0]);
  }

  // Lost the insert race — a concurrent request created the row first.
  const raced = await pool.query('SELECT * FROM group_billing WHERE group_id = $1', [groupId]);
  return mapRow(raced.rows[0]);
}

export async function isGroupLocked(groupId) {
  const billing = await getOrCreateBilling(groupId);
  return billing.isLocked;
}

export async function getStripeCustomerId(groupId) {
  const result = await pool.query(
    'SELECT stripe_customer_id FROM group_billing WHERE group_id = $1',
    [groupId],
  );
  return result.rows[0]?.stripe_customer_id ?? null;
}

// Gets the group's Stripe customer id, creating the group_billing row (if this is the
// group's first-ever billing interaction) and the Stripe customer itself (via the
// caller-supplied createCustomerFn, so this module never has to import the Stripe SDK)
// if neither exists yet.
export async function getOrCreateStripeCustomerId(groupId, createCustomerFn) {
  await getOrCreateBilling(groupId);

  const existing = await getStripeCustomerId(groupId);
  if (existing) return existing;

  const customerId = await createCustomerFn();
  await pool.query(
    'UPDATE group_billing SET stripe_customer_id = $1, updated_at = now() WHERE group_id = $2',
    [customerId, groupId],
  );
  return customerId;
}

// Applied from a Stripe customer.subscription.created|updated|deleted webhook event —
// all three carry a full Subscription object with a status, so one function handles them.
export async function upsertBillingFromSubscription(subscription) {
  const customerId =
    typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
  const priceId = subscription.items?.data?.[0]?.price?.id ?? null;
  const planKey = priceId ? planByPriceId(priceId) : null;
  const status = mapStripeStatus(subscription.status);
  const currentPeriodEnd = subscription.current_period_end
    ? new Date(subscription.current_period_end * 1000)
    : null;

  await pool.query(
    `UPDATE group_billing
     SET stripe_subscription_id = $1, plan = $2, status = $3, current_period_end = $4, updated_at = now()
     WHERE stripe_customer_id = $5`,
    [subscription.id, planKey, status, currentPeriodEnd, customerId],
  );
}
```

- [ ] **Step 2: Sanity-check it loads correctly**

Run: `cd crm-proj && node -e "import('./models/billing.js').then(() => console.log('module loads OK'))"`
Expected: `module loads OK` (confirms no syntax errors and the `pool` import resolves; no query is executed by this check).

- [ ] **Step 3: Commit**

```bash
git add models/billing.js
git commit -m "Add billing data access module"
```

---

## Task 5: GraphQL schema + resolvers

**Files:**
- Create: `crm-proj/typedefs/billingTypeDefs.js`
- Create: `crm-proj/resolvers/billingResolvers.js`

**Interfaces:**
- Consumes: `requireGroup`, `requireCallerGroupId` from `crm-proj/utils/requireUser.js` (existing); `PLANS`, `planLimitsResponse` (Task 1); `getOrCreateBilling`, `getOrCreateStripeCustomerId`, `getStripeCustomerId` (Task 4); `stripe` client — **created in this task** at `crm-proj/config/stripe.js` (needed by the resolvers, small enough not to warrant its own task).
- Produces: default-exported `billingTypeDefs` and `billingResolvers`, wired into `server.js` in Task 8.

- [ ] **Step 1: Add the Stripe client**

`crm-proj/config/stripe.js`:

```js
import Stripe from 'stripe';

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error('Missing STRIPE_SECRET_KEY environment variable');
}

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
```

- [ ] **Step 2: Write the typedefs**

`crm-proj/typedefs/billingTypeDefs.js`:

```js
const billingTypeDefs = `#graphql
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

  "One per group. status is one of: trialing, active, past_due, canceled, incomplete."
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
    "Resolves for both an admin (Supabase session) and a member (cookie/token) caller."
    myBilling: Billing!
    "No auth required — also used on the public pricing page."
    plans: [PlanLimits!]!
  }

  type Mutation {
    "Admin-only. Returns a Stripe Checkout URL to redirect the browser to."
    createCheckoutSession(plan: PlanTier!): CheckoutSession!
    "Admin-only. Returns a Stripe Billing Portal URL to redirect the browser to."
    createBillingPortalSession: PortalSession!
  }
`;

export default billingTypeDefs;
```

- [ ] **Step 3: Write the resolvers**

`crm-proj/resolvers/billingResolvers.js`:

```js
import { GraphQLError } from 'graphql';
import { requireGroup, requireCallerGroupId } from '../utils/requireUser.js';
import { PLANS, planLimitsResponse } from '../config/plans.js';
import { stripe } from '../config/stripe.js';
import {
  getOrCreateBilling,
  getOrCreateStripeCustomerId,
  getStripeCustomerId,
} from '../models/billing.js';

function frontendOrigin() {
  return (process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173').split(',')[0].trim();
}

const billingResolvers = {
  Query: {
    myBilling: async (_, __, context) => {
      const groupId = requireCallerGroupId(context);
      return getOrCreateBilling(groupId);
    },
    plans: () => Object.keys(PLANS).map(planLimitsResponse),
  },
  Mutation: {
    createCheckoutSession: async (_, { plan }, context) => {
      const groupId = requireGroup(context);
      const planKey = plan.toLowerCase();

      if (!PLANS[planKey]) {
        throw new GraphQLError('Unknown plan', { extensions: { code: 'BAD_USER_INPUT' } });
      }

      const customerId = await getOrCreateStripeCustomerId(groupId, async () => {
        const customer = await stripe.customers.create({ metadata: { groupId } });
        return customer.id;
      });

      const origin = frontendOrigin();
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: customerId,
        line_items: [{ price: PLANS[planKey].stripePriceId, quantity: 1 }],
        success_url: `${origin}/app/billing?checkout=success`,
        cancel_url: `${origin}/app/billing?checkout=cancel`,
        subscription_data: { metadata: { groupId } },
        allow_promotion_codes: true,
      });

      return { url: session.url };
    },
    createBillingPortalSession: async (_, __, context) => {
      const groupId = requireGroup(context);
      const customerId = await getStripeCustomerId(groupId);

      if (!customerId) {
        throw new GraphQLError('Choose a plan before managing billing.', {
          extensions: { code: 'NO_STRIPE_CUSTOMER' },
        });
      }

      const portalSession = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: `${frontendOrigin()}/app/billing`,
      });

      return { url: portalSession.url };
    },
  },
};

export default billingResolvers;
```

- [ ] **Step 4: Sanity-check both modules load**

Run: `cd crm-proj && node -e "Promise.all([import('./typedefs/billingTypeDefs.js'), import('./resolvers/billingResolvers.js')]).then(() => console.log('modules load OK'))"`
Expected: `modules load OK`

- [ ] **Step 5: Commit**

```bash
git add config/stripe.js typedefs/billingTypeDefs.js resolvers/billingResolvers.js
git commit -m "Add billing GraphQL schema and resolvers"
```

---

## Task 6: Apollo lockout plugin

**Files:**
- Create: `crm-proj/utils/billingLockPlugin.js`
- Test: `crm-proj/utils/billingLockPlugin.test.js`

**Interfaces:**
- Consumes: `requireCallerGroupId` from `crm-proj/utils/requireUser.js` (existing); `isGroupLocked` (Task 4).
- Produces: `shouldBypassLock(fieldNames: string[]): boolean`; default export `billingLockPlugin`, an Apollo Server plugin object. Registered into `server.js`'s `plugins` array in Task 8.

- [ ] **Step 1: Write the failing tests**

`crm-proj/utils/billingLockPlugin.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { shouldBypassLock } from './billingLockPlugin.js';

describe('shouldBypassLock', () => {
  it('bypasses a single allowlisted mutation', () => {
    expect(shouldBypassLock(['loginUser'])).toBe(true);
  });

  it('bypasses a request naming only allowlisted mutations', () => {
    expect(shouldBypassLock(['createCheckoutSession'])).toBe(true);
  });

  it('does not bypass a non-allowlisted mutation', () => {
    expect(shouldBypassLock(['addTask'])).toBe(false);
  });

  it('does not bypass a mix of allowed and non-allowed mutations', () => {
    expect(shouldBypassLock(['loginUser', 'addTask'])).toBe(false);
  });

  it('treats an empty selection as bypassed (nothing to block)', () => {
    expect(shouldBypassLock([])).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd crm-proj && npm test`
Expected: FAIL — `utils/billingLockPlugin.js` does not exist yet.

- [ ] **Step 3: Write the implementation**

`crm-proj/utils/billingLockPlugin.js`:

```js
import { GraphQLError } from 'graphql';
import { requireCallerGroupId } from './requireUser.js';
import { isGroupLocked } from '../models/billing.js';

// Mutations that must always work even for a locked group — signing in/out, joining a
// group, and the billing actions themselves (an admin has to be able to pay their way
// out of lockout).
const ALLOWED_WHEN_LOCKED = new Set([
  'registerUser',
  'loginUser',
  'signOutUser',
  'loginMember',
  'logoutMember',
  'joinGroup',
  'createCheckoutSession',
  'createBillingPortalSession',
]);

export function shouldBypassLock(fieldNames) {
  return fieldNames.every((name) => ALLOWED_WHEN_LOCKED.has(name));
}

// Apollo Server plugin: blocks every mutation for a locked group's caller, except the
// allowlisted ones above. Centralized here — specs building on top of this one (seat
// limits, storage, AI-notes metering) never need to add their own lockout check to a
// new resolver, since this plugin already covers every mutation in the schema.
const billingLockPlugin = {
  async requestDidStart() {
    return {
      async didResolveOperation({ operation, contextValue }) {
        if (!operation || operation.operation !== 'mutation') return;

        const fieldNames = operation.selectionSet.selections
          .filter((selection) => selection.kind === 'Field')
          .map((selection) => selection.name.value);

        if (shouldBypassLock(fieldNames)) return;

        let groupId;
        try {
          groupId = requireCallerGroupId(contextValue);
        } catch {
          return; // unauthenticated / no group — the resolver itself enforces auth
        }

        if (await isGroupLocked(groupId)) {
          throw new GraphQLError(
            'This workspace is locked — an admin needs to subscribe to a plan to continue.',
            { extensions: { code: 'BILLING_LOCKED' } },
          );
        }
      },
    };
  },
};

export default billingLockPlugin;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd crm-proj && npm test`
Expected: PASS (20 tests total)

- [ ] **Step 5: Commit**

```bash
git add utils/billingLockPlugin.js utils/billingLockPlugin.test.js
git commit -m "Add Apollo plugin enforcing billing lockout on mutations"
```

---

## Task 7: Stripe webhook route

**Files:**
- Create: `crm-proj/routes/stripeWebhook.js`
- Test: `crm-proj/routes/stripeWebhook.test.js`

**Interfaces:**
- Consumes: `stripe` (Task 5); `upsertBillingFromSubscription` (Task 4).
- Produces: `stripeWebhookHandler(req, res): Promise<void>`, an Express handler. Mounted in `server.js` in Task 8, on a route registered with `express.raw({ type: 'application/json' })`.

- [ ] **Step 1: Write the implementation**

`crm-proj/routes/stripeWebhook.js`:

```js
import { stripe } from '../config/stripe.js';
import { upsertBillingFromSubscription } from '../models/billing.js';

const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);

// Express handler. The route this is mounted on MUST use express.raw({ type:
// 'application/json' }) — Stripe's signature check needs the exact raw request bytes,
// not a re-serialized JSON.parse of them.
export async function stripeWebhookHandler(req, res) {
  const signature = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  if (SUBSCRIPTION_EVENTS.has(event.type)) {
    try {
      await upsertBillingFromSubscription(event.data.object);
    } catch (err) {
      console.error('Failed to apply Stripe webhook event:', err);
      res.status(500).send('Webhook handler failed');
      return;
    }
  }

  res.json({ received: true });
}
```

- [ ] **Step 2: Write the tests**

`crm-proj/routes/stripeWebhook.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { stripeWebhookHandler } from './stripeWebhook.js';
import { stripe } from '../config/stripe.js';
import { upsertBillingFromSubscription } from '../models/billing.js';

vi.mock('../models/billing.js', () => ({
  upsertBillingFromSubscription: vi.fn(),
}));

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

describe('stripeWebhookHandler', () => {
  beforeEach(() => {
    upsertBillingFromSubscription.mockReset();
  });

  it('rejects a request with an invalid signature', async () => {
    const req = { headers: { 'stripe-signature': 'bad' }, body: Buffer.from('{}') };
    const res = mockRes();

    await stripeWebhookHandler(req, res);

    expect(res.statusCode).toBe(400);
    expect(upsertBillingFromSubscription).not.toHaveBeenCalled();
  });

  it('applies a valid customer.subscription.updated event', async () => {
    const subscription = {
      id: 'sub_123',
      customer: 'cus_123',
      status: 'active',
      items: { data: [{ price: { id: 'price_starter' } }] },
      current_period_end: 1893456000,
    };
    const payload = JSON.stringify({
      id: 'evt_123',
      type: 'customer.subscription.updated',
      data: { object: subscription },
    });
    const header = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: process.env.STRIPE_WEBHOOK_SECRET,
    });

    const req = { headers: { 'stripe-signature': header }, body: Buffer.from(payload) };
    const res = mockRes();

    await stripeWebhookHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(upsertBillingFromSubscription).toHaveBeenCalledWith(subscription);
  });

  it('ignores an event type it does not handle', async () => {
    const payload = JSON.stringify({ id: 'evt_456', type: 'invoice.paid', data: { object: {} } });
    const header = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: process.env.STRIPE_WEBHOOK_SECRET,
    });

    const req = { headers: { 'stripe-signature': header }, body: Buffer.from(payload) };
    const res = mockRes();

    await stripeWebhookHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(upsertBillingFromSubscription).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd crm-proj && npm test`
Expected: PASS (23 tests total). If the signature tests fail, confirm `STRIPE_WEBHOOK_SECRET` is set in `.env` (Vitest loads it via `vitest.setup.js` from Task 1).

- [ ] **Step 4: Commit**

```bash
git add routes/stripeWebhook.js routes/stripeWebhook.test.js
git commit -m "Add Stripe webhook route with tests"
```

---

## Task 8: Wire billing into `server.js`

**Files:**
- Modify: `crm-proj/server.js`

**Interfaces:**
- Consumes: `billingTypeDefs`, `billingResolvers` (Task 5); `billingLockPlugin` (Task 6); `stripeWebhookHandler` (Task 7).
- Produces: a running server with the full billing surface live — end-to-end verification target for this task and the point from which Task 4/5's manual checks become exercisable.

- [ ] **Step 1: Add imports**

In `crm-proj/server.js`, add alongside the existing typedef/resolver imports (near line 26–27):

```js
import billingTypeDefs from './typedefs/billingTypeDefs.js';
import billingResolvers from './resolvers/billingResolvers.js';
import billingLockPlugin from './utils/billingLockPlugin.js';
import { stripeWebhookHandler } from './routes/stripeWebhook.js';
```

- [ ] **Step 2: Register the typedefs, resolvers, and plugin**

Change the `ApolloServer` construction (currently around line 38–42):

```js
const server = new ApolloServer({
  typeDefs: [userTypeDefs, memberTypeDefs, clientTypeDefs, taskTypeDefs, departmentTypeDefs, serviceTypeDefs, recurringTaskTypeDefs, taskStatusTypeDefs, groupTypeDefs, emailCredentialsTypeDefs, billingTypeDefs],
  resolvers: [userResolvers, memberResolvers, clientResolvers, taskResolvers, departmentResolvers, serviceResolvers, recurringTaskResolvers, taskStatusResolvers, groupResolvers, emailCredentialsResolvers, billingResolvers],
  plugins: [ApolloServerPluginDrainHttpServer({ httpServer }), billingLockPlugin],
});
```

- [ ] **Step 3: Register the webhook route**

In `crm-proj/server.js`, add this **before** the existing `app.use(express.json(), expressMiddleware(server, ...))` line (currently around line 154), after the `/auth/google/callback` route:

```js
// Stripe needs the exact raw request bytes to verify the signature — express.raw here,
// NOT express.json(), and this must be registered before the app-wide express.json()
// below or that would consume/reparse the body first.
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), stripeWebhookHandler);
```

- [ ] **Step 4: Start the dev server**

Run: `cd crm-proj && npm run dev`
Expected: `🚀 Server ready at http://localhost:4000/` with no errors.

- [ ] **Step 5: Manually verify `plans` (no auth required)**

Run:

```bash
curl -s -X POST http://localhost:4000/ -H 'Content-Type: application/json' \
  -d '{"query":"{ plans { tier name priceMonthlyUsd adminLimit memberLimit storageGb aiNotesHoursPerMonth } }"}'
```

Expected: JSON with all three plans and the exact numbers from Global Constraints above.

- [ ] **Step 6: Manually verify the webhook end-to-end via the Stripe CLI**

In a separate terminal (server still running from Step 4):

```bash
stripe trigger customer.subscription.updated
```

Expected: the server's console logs no error, and `stripe listen`'s own terminal (started earlier during Stripe setup) shows the event forwarded with a `200` response.

- [ ] **Step 7: Commit**

```bash
git add server.js
git commit -m "Wire billing GraphQL, lockout plugin, and Stripe webhook into the server"
```

---

## Task 9: Frontend types + GraphQL queries

**Files:**
- Modify: `crm-frontend/src/types/index.ts`
- Modify: `crm-frontend/src/lib/queries.ts`

**Interfaces:**
- Produces: `PlanTier`, `PlanLimits`, `Billing` types; `MY_BILLING`, `PLANS`, `CREATE_CHECKOUT_SESSION`, `CREATE_BILLING_PORTAL_SESSION` query strings. Consumed by Tasks 10, 11, 14.

- [ ] **Step 1: Add the types**

In `crm-frontend/src/types/index.ts`, add after the `Group` interface (after line 30):

```ts
// --- Billing ---
export type PlanTier = 'STARTER' | 'BUSINESS' | 'SCALE';

export interface PlanLimits {
  tier: PlanTier;
  name: string;
  priceMonthlyUsd: number;
  adminLimit: number;
  memberLimit: number;
  storageGb: number;
  aiNotesHoursPerMonth: number;
}

// status is one of: trialing, active, past_due, canceled, incomplete.
export interface Billing {
  groupId: string;
  status: string;
  plan: PlanTier | null;
  limits: PlanLimits;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  isLocked: boolean;
}
```

- [ ] **Step 2: Add the queries**

In `crm-frontend/src/lib/queries.ts`, add after the `JOIN_GROUP` export (after line 33):

```ts
// --- Billing ---
// Works for both an admin (Supabase session) and a member (cookie/token) caller — the
// backend resolves groupId from whichever session is present.
export const MY_BILLING = `
  query MyBilling {
    myBilling {
      groupId
      status
      plan
      trialEndsAt
      currentPeriodEnd
      isLocked
      limits { tier name priceMonthlyUsd adminLimit memberLimit storageGb aiNotesHoursPerMonth }
    }
  }
`;

// No auth required — also used on the public pricing/landing page.
export const PLANS = `
  query Plans {
    plans { tier name priceMonthlyUsd adminLimit memberLimit storageGb aiNotesHoursPerMonth }
  }
`;

// Redirects the browser to Stripe Checkout. Admin-only.
export const CREATE_CHECKOUT_SESSION = `
  mutation CreateCheckoutSession($plan: PlanTier!) {
    createCheckoutSession(plan: $plan) { url }
  }
`;

// Redirects the browser to the Stripe Billing Portal. Admin-only.
export const CREATE_BILLING_PORTAL_SESSION = `
  mutation CreateBillingPortalSession {
    createBillingPortalSession { url }
  }
`;
```

- [ ] **Step 3: Verify it compiles**

Run: `cd crm-frontend && npx tsc -b`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd crm-frontend && git add src/types/index.ts src/lib/queries.ts
git commit -m "Add billing types and GraphQL query strings"
```

---

## Task 10: `BillingContext` (admin side)

**Files:**
- Create: `crm-frontend/src/context/BillingContext.tsx`

**Interfaces:**
- Consumes: `Billing` type, `MY_BILLING` query (Task 9); `graphqlRequest` (existing `src/lib/graphql.ts`); `useAuth` (existing `src/context/AuthContext.tsx`).
- Produces: `BillingProvider` (component), `useBilling(): { billing: Billing | null, loading: boolean, error: string | null, refetch: () => Promise<void> }`. Consumed by Tasks 11 and 13.

Mirrors `GroupContext.tsx`'s existing pattern exactly (see `crm-frontend/src/context/GroupContext.tsx`), so it stays scoped to the admin app only — the member portal fetches billing separately in Task 14, since nothing else on that side needs to share the value.

- [ ] **Step 1: Write the implementation**

`crm-frontend/src/context/BillingContext.tsx`:

```tsx
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { graphqlRequest } from '../lib/graphql';
import { MY_BILLING } from '../lib/queries';
import type { Billing } from '../types';
import { useAuth } from './AuthContext';

interface BillingContextValue {
  billing: Billing | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

const BillingContext = createContext<BillingContextValue | null>(null);

export function BillingProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const [billing, setBilling] = useState<Billing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const hasLoaded = useRef(false);

  const refetch = useCallback(async () => {
    if (!user) {
      setBilling(null);
      setLoading(false);
      return;
    }
    if (!hasLoaded.current) setLoading(true);
    setError(null);
    try {
      const { myBilling } = await graphqlRequest<{ myBilling: Billing }>(MY_BILLING);
      setBilling(myBilling);
      hasLoaded.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load billing status.');
      if (!hasLoaded.current) setBilling(null);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (authLoading) return;
    refetch();
  }, [authLoading, refetch]);

  return (
    <BillingContext.Provider value={{ billing, loading: loading || authLoading, error, refetch }}>
      {children}
    </BillingContext.Provider>
  );
}

export function useBilling() {
  const ctx = useContext(BillingContext);
  if (!ctx) throw new Error('useBilling must be used within BillingProvider');
  return ctx;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd crm-frontend && npx tsc -b`
Expected: no errors (it isn't imported anywhere yet, but it must type-check standalone).

- [ ] **Step 3: Commit**

```bash
git add src/context/BillingContext.tsx
git commit -m "Add BillingContext for the admin app"
```

---

## Task 11: `Billing` page

**Files:**
- Create: `crm-frontend/src/pages/Billing.tsx`

**Interfaces:**
- Consumes: `useBilling` (Task 10); `PlanLimits`, `PlanTier` types, `PLANS`, `CREATE_CHECKOUT_SESSION`, `CREATE_BILLING_PORTAL_SESSION` queries (Task 9); existing `useQuery`, `graphqlRequest`, and UI components (`PageHeader`, `Card`, `Button`, `Banner`, `PageLoader`).
- Produces: `Billing` page component, routed at `/app/billing` in Task 13.

- [ ] **Step 1: Write the implementation**

`crm-frontend/src/pages/Billing.tsx`:

```tsx
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../components/ui/PageHeader';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Banner } from '../components/ui/Banner';
import { PageLoader } from '../components/ui/Spinner';
import { useQuery } from '../hooks/useQuery';
import { useBilling } from '../context/BillingContext';
import { graphqlRequest } from '../lib/graphql';
import { PLANS, CREATE_CHECKOUT_SESSION, CREATE_BILLING_PORTAL_SESSION } from '../lib/queries';
import type { PlanLimits, PlanTier } from '../types';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export function Billing() {
  const { billing, loading: billingLoading, refetch } = useBilling();
  const { data: plansData, loading: plansLoading } = useQuery<{ plans: PlanLimits[] }>(() =>
    graphqlRequest(PLANS),
  );
  const [searchParams, setSearchParams] = useSearchParams();
  const [pendingPlan, setPendingPlan] = useState<PlanTier | null>(null);
  const [portalPending, setPortalPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const checkoutResult = searchParams.get('checkout');

  async function choosePlan(tier: PlanTier) {
    setActionError(null);
    setPendingPlan(tier);
    try {
      const { createCheckoutSession } = await graphqlRequest<{
        createCheckoutSession: { url: string };
      }>(CREATE_CHECKOUT_SESSION, { plan: tier });
      window.location.href = createCheckoutSession.url;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not start checkout.');
      setPendingPlan(null);
    }
  }

  async function manageBilling() {
    setActionError(null);
    setPortalPending(true);
    try {
      const { createBillingPortalSession } = await graphqlRequest<{
        createBillingPortalSession: { url: string };
      }>(CREATE_BILLING_PORTAL_SESSION);
      window.location.href = createBillingPortalSession.url;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not open the billing portal.');
      setPortalPending(false);
    }
  }

  if (billingLoading || plansLoading) return <PageLoader />;

  return (
    <div>
      <PageHeader title="Billing" description="Manage your workspace's plan and subscription." />

      {checkoutResult === 'success' && (
        <div className="mb-6">
          <Banner tone="success">
            Subscription started. It may take a few seconds to reflect below —{' '}
            <button
              onClick={() => {
                refetch();
                setSearchParams({});
              }}
              className="underline underline-offset-2"
            >
              refresh
            </button>
            .
          </Banner>
        </div>
      )}
      {checkoutResult === 'cancel' && (
        <div className="mb-6">
          <Banner tone="info">Checkout was canceled — no changes were made.</Banner>
        </div>
      )}
      {actionError && (
        <div className="mb-6">
          <Banner tone="error">{actionError}</Banner>
        </div>
      )}

      <Card className="mb-6 p-6">
        <p className="text-[13px] font-medium uppercase tracking-wide text-ink/40 dark:text-white/40">
          Current status
        </p>
        <p className="mt-1 text-[17px] font-semibold text-ink dark:text-white">
          {billing?.plan ? billing.limits.name : 'Trial'} — {billing?.status}
        </p>
        {billing?.status === 'trialing' && (
          <p className="mt-1 text-sm text-ink/55 dark:text-white/55">
            Trial ends {formatDate(billing.trialEndsAt)}.
          </p>
        )}
        {billing?.currentPeriodEnd && (
          <p className="mt-1 text-sm text-ink/55 dark:text-white/55">
            Renews {formatDate(billing.currentPeriodEnd)}.
          </p>
        )}
        {billing?.plan && (
          <div className="mt-4">
            <Button variant="secondary" onClick={manageBilling} loading={portalPending}>
              Manage billing
            </Button>
          </div>
        )}
      </Card>

      <div className="grid gap-4 sm:grid-cols-3">
        {(plansData?.plans ?? []).map((plan) => (
          <Card key={plan.tier} className="flex flex-col p-6">
            <p className="text-[17px] font-semibold text-ink dark:text-white">{plan.name}</p>
            <p className="mt-1 text-[26px] font-semibold text-ink dark:text-white">
              ${plan.priceMonthlyUsd}
              <span className="text-[14px] font-normal text-ink/45 dark:text-white/45">/mo</span>
            </p>
            <ul className="mt-4 flex-1 space-y-1.5 text-sm text-ink/65 dark:text-white/65">
              <li>
                {plan.adminLimit} admin{plan.adminLimit === 1 ? '' : 's'}
              </li>
              <li>{plan.memberLimit} members</li>
              <li>{plan.storageGb} GB storage</li>
              <li>{plan.aiNotesHoursPerMonth} hrs/mo AI meeting notes</li>
            </ul>
            <Button
              className="mt-5"
              variant={billing?.plan === plan.tier ? 'secondary' : 'primary'}
              disabled={billing?.plan === plan.tier}
              loading={pendingPlan === plan.tier}
              onClick={() => choosePlan(plan.tier)}
            >
              {billing?.plan === plan.tier ? 'Current plan' : 'Choose plan'}
            </Button>
          </Card>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd crm-frontend && npx tsc -b`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/pages/Billing.tsx
git commit -m "Add the Billing page"
```

---

## Task 12: `LockoutBanner` component

**Files:**
- Create: `crm-frontend/src/components/layout/LockoutBanner.tsx`

**Interfaces:**
- Consumes: `Billing` type (Task 9); existing `Banner` UI component.
- Produces: `LockoutBanner({ billing, isAdmin }: { billing: Billing | null; isAdmin: boolean })`. Consumed by Tasks 13 (AppShell) and 14 (MemberShell).

- [ ] **Step 1: Write the implementation**

`crm-frontend/src/components/layout/LockoutBanner.tsx`:

```tsx
import { Link } from 'react-router-dom';
import { Banner } from '../ui/Banner';
import type { Billing } from '../../types';

// Shown when the caller's group has no active plan — either the trial ran out or the
// subscription lapsed (past_due/canceled/incomplete). Existing data stays visible; the
// backend's Apollo plugin is what actually blocks writes, this is just the signal.
export function LockoutBanner({ billing, isAdmin }: { billing: Billing | null; isAdmin: boolean }) {
  if (!billing?.isLocked) return null;

  return (
    <Banner tone="error">
      This workspace is locked.{' '}
      {isAdmin ? (
        <>
          Your trial or subscription has ended —{' '}
          <Link to="/app/billing" className="underline underline-offset-2">
            choose a plan
          </Link>{' '}
          to keep creating and editing.
        </>
      ) : (
        'Ask an admin to choose a plan to keep creating and editing.'
      )}
    </Banner>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd crm-frontend && npx tsc -b`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/layout/LockoutBanner.tsx
git commit -m "Add LockoutBanner component"
```

---

## Task 13: Wire the admin side (route, nav, banner)

**Files:**
- Modify: `crm-frontend/src/App.tsx`
- Modify: `crm-frontend/src/components/layout/Sidebar.tsx`
- Modify: `crm-frontend/src/components/layout/AppShell.tsx`
- Modify: `crm-frontend/src/components/layout/icons.tsx`

**Interfaces:**
- Consumes: `BillingProvider` (Task 10), `Billing` page (Task 11), `LockoutBanner` (Task 12), `useBilling` (Task 10).

- [ ] **Step 1: Add a billing icon**

In `crm-frontend/src/components/layout/icons.tsx`, add after `IconServices` (matching the existing stroke-icon pattern):

```tsx
export const IconBilling = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <rect x="3" y="5.5" width="18" height="13" rx="2.5" />
    <path d="M3 9.5h18" />
    <path d="M6.5 14.5h4" />
  </svg>
);
```

- [ ] **Step 2: Add the nav entry**

In `crm-frontend/src/components/layout/Sidebar.tsx`, add `IconBilling` to the icon import list (line 2–17), and add a `Billing` entry to the `Workspace` group (after line 63, `{ to: '/app/team', ... }`):

```ts
      { to: '/app/team', label: 'Team', icon: IconUser },
      { to: '/app/billing', label: 'Billing', icon: IconBilling },
```

- [ ] **Step 3: Wrap `/app` with `BillingProvider` and add the route**

In `crm-frontend/src/App.tsx`, import `BillingProvider` and `Billing`:

```tsx
import { BillingProvider } from './context/BillingContext';
import { Billing } from './pages/Billing';
```

Change the `/app` route element (lines 45–51) to wrap `AppShell` with `BillingProvider`:

```tsx
            <Route
              path="/app"
              element={
                <ProtectedRoute>
                  <BillingProvider>
                    <AppShell />
                  </BillingProvider>
                </ProtectedRoute>
              }
            >
```

Add the nested route (after line 66, `<Route path="team" element={<Team />} />`):

```tsx
              <Route path="billing" element={<Billing />} />
```

- [ ] **Step 4: Render the banner in `AppShell`**

In `crm-frontend/src/components/layout/AppShell.tsx`, import `useBilling` and `LockoutBanner`:

```tsx
import { useBilling } from '../../context/BillingContext';
import { LockoutBanner } from './LockoutBanner';
```

Inside the `AppShell` function, add:

```tsx
  const { billing } = useBilling();
```

Then render the banner at the top of `<main>`, just before the animated page wrapper (before line 62's `<div key={location.pathname} ...>`):

```tsx
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-6xl px-4 pt-4 sm:px-6 lg:px-10 lg:pt-6">
            <LockoutBanner billing={billing} isAdmin />
          </div>
          {/* Keyed by path so each page change replays the entrance animation. */}
          <div
            key={location.pathname}
            className="animate-page-in mx-auto max-w-6xl px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-6 lg:px-10 lg:pb-10 lg:pt-8"
          >
            <Outlet />
          </div>
        </main>
```

(The extra wrapper div only renders when `billing?.isLocked` is true, since `LockoutBanner` returns `null` otherwise — no empty spacing shows up when the group isn't locked.)

- [ ] **Step 5: Verify it compiles**

Run: `cd crm-frontend && npx tsc -b`
Expected: no errors.

- [ ] **Step 6: Manual verification**

Run: `cd crm-frontend && npm run dev`, then in a browser log in as an admin and open `/app/billing`. Expected: the page loads, shows "Trial — trialing" and a trial end date, and the three plan cards show the correct prices/limits from Global Constraints. Click "Choose plan" on Starter with a fresh trial account and confirm it redirects to a real Stripe Checkout page (sandbox) showing $28.00/month.

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx src/components/layout/Sidebar.tsx src/components/layout/AppShell.tsx src/components/layout/icons.tsx
git commit -m "Wire billing into the admin app: route, nav, lockout banner"
```

---

## Task 14: Wire the member side (lockout banner)

**Files:**
- Create: `crm-frontend/src/hooks/useMemberBilling.ts`
- Modify: `crm-frontend/src/components/member/MemberShell.tsx`

**Interfaces:**
- Consumes: `Billing` type, `MY_BILLING` query (Task 9); `LockoutBanner` (Task 12); existing `useQuery`, `graphqlRequest`, `useMemberSession`.

A plain hook rather than a context, since `MemberShell` is the only consumer on the member side — no sibling component needs the same value shared, unlike the admin side's `BillingContext`.

- [ ] **Step 1: Write the hook**

`crm-frontend/src/hooks/useMemberBilling.ts`:

```ts
import { useQuery } from './useQuery';
import { graphqlRequest } from '../lib/graphql';
import { MY_BILLING } from '../lib/queries';
import type { Billing } from '../types';
import { useMemberSession } from '../context/MemberSessionContext';

// Member-portal counterpart to BillingContext (see context/BillingContext.tsx) — a
// plain hook since MemberShell is the only consumer here, just the lockout banner.
// Safe to fire unconditionally: MemberShell only ever renders inside
// MemberProtectedRoute, so a member session is always present by the time this runs.
export function useMemberBilling() {
  const { member } = useMemberSession();
  const { data, loading } = useQuery<{ myBilling: Billing }>(
    () => graphqlRequest(MY_BILLING),
    [member?.uuid],
  );
  return { billing: data?.myBilling ?? null, loading };
}
```

- [ ] **Step 2: Render the banner in `MemberShell`**

In `crm-frontend/src/components/member/MemberShell.tsx`, import the hook and `LockoutBanner`:

```tsx
import { useMemberBilling } from '../../hooks/useMemberBilling';
import { LockoutBanner } from '../layout/LockoutBanner';
```

Inside the `MemberShell` function, add:

```tsx
  const { billing } = useMemberBilling();
```

Render it just after the `<header>` closes (after line 44), before `<main>`:

```tsx
      </header>

      {billing?.isLocked && (
        <div className="mx-auto max-w-6xl px-4 pt-4 sm:px-6">
          <LockoutBanner billing={billing} isAdmin={false} />
        </div>
      )}

      <main className="mx-auto max-w-6xl px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-6 sm:py-8">
```

- [ ] **Step 3: Verify it compiles**

Run: `cd crm-frontend && npx tsc -b`
Expected: no errors.

- [ ] **Step 4: Manual verification**

With the same dev server running, log in to `/portal/login` as a member of a group whose trial has been made to look expired (temporarily, via SQL: `UPDATE group_billing SET trial_ends_at = now() - interval '1 day' WHERE group_id = '<a test group id>';`, then revert the row afterward). Expected: the member portal shows the "Ask an admin..." banner, and the admin app for the same group shows the "choose a plan" banner and a real `addTask` (or similar) mutation attempt fails with `BILLING_LOCKED`. Revert the test row: `UPDATE group_billing SET trial_ends_at = now() + interval '14 days' WHERE group_id = '<same id>';`.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useMemberBilling.ts src/components/member/MemberShell.tsx
git commit -m "Wire billing lockout banner into the member portal"
```

---

## Self-Review Notes

- **Spec coverage:** plans/pricing (Task 1), trial computed from real signup date (Task 4), `group_billing` schema incl. the new unique index (Task 2), checkout/portal/webhook (Tasks 5, 7, 8), centralized lockout plugin with the exact allowlist (Task 6), frontend billing page + lockout banners for both admin and member (Tasks 9–14). All spec sections have a corresponding task.
- **Type consistency checked:** `Billing`/`PlanLimits` field names match exactly across the GraphQL schema (Task 5), the backend `mapRow`/`planLimitsResponse` shape (Task 1, consumed by Tasks 4–5), the frontend TypeScript types (Task 9), and every query string/component that reads them (Tasks 10–14) — `groupId`, `status`, `plan`, `limits.{tier,name,priceMonthlyUsd,adminLimit,memberLimit,storageGb,aiNotesHoursPerMonth}`, `trialEndsAt`, `currentPeriodEnd`, `isLocked` used identically everywhere.
- **Duplication caught in pre-flight scan (fixed before dispatch):** Tasks 4 and 5 originally each defined their own copy of the plan→response shaping function. Consolidated into `planLimitsResponse` in `config/plans.js` (Task 1), imported by both.
- **No placeholders:** every step has real, complete code — no TBD/TODO, no "similar to Task N" shortcuts.
