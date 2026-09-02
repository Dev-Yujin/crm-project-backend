# Paddle Billing Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Continuum CRM's Stripe billing (checkout, portal, webhook) with Paddle, across both `crm-proj` (backend) and `crm-frontend` (frontend), sandbox environment only.

**Architecture:** Backend swaps `config/stripe.js`/`routes/stripeWebhook.js`/Stripe-shaped resolver logic for Paddle equivalents (`@paddle/paddle-node-sdk`), and `group_billing`'s Stripe columns are renamed to Paddle ones. Frontend drops the server-redirect checkout flow entirely — `Billing.tsx` now calls `Paddle.PricePreview()` for localized totals and `Paddle.Checkout.open()` for an in-page overlay checkout (`@paddle/paddle-js`), with the backend finding out about a new subscription only via webhook.

**Tech Stack:** `@paddle/paddle-node-sdk@3.10.0` (backend), `@paddle/paddle-js@1.6.5` (frontend), existing Express/Apollo Server/Postgres/React 19/Vite stack.

**Spec:** `docs/superpowers/specs/2026-09-02-paddle-billing-migration-design.md`

## Global Constraints

- No live subscribers exist — this is a clean swap, not a data migration. (spec: Problem)
- Sandbox only this pass. `PADDLE_ENVIRONMENT` (backend) / `VITE_PADDLE_ENVIRONMENT` (frontend) must be read explicitly and must throw if unset or not exactly `sandbox`/`production` — never silently defaulted. (spec: Goals)
- Pricing: Starter $29/mo, $290/yr; Business $59/mo, $590/yr; Scale $99/mo, $990/yr (2 months free). (spec: Pricing)
- No server-side geo detection for pricing — `Paddle.PricePreview()` is always called with no country code, relying entirely on its own IP-based auto-detection. (spec: Country-localized pricing)
- Display only `formattedTotals`/`formatted_totals` strings Paddle returns — no `Intl.NumberFormat`, no re-rounding, no re-deriving totals from `unit_price`. (spec: Frontend §Billing.tsx)
- `PADDLE_API_KEY` (backend secret key) must never enter a `VITE_`-prefixed variable or any file under `crm-frontend/src`. The frontend only ever holds the public client-side token (`test_...`).
- CSP is injected only at **build** time (`crm-frontend/vite.config.ts`'s `cspPlugin`, `apply: "build"`) — `npm run dev` has no CSP at all, so a Paddle CSP violation is invisible in the normal dev loop. Any task touching Paddle.js in the frontend must be verified with `npm run build && npm run preview`, not just `npm run dev`, before being considered done. This has bitten this exact codebase twice before (R2 upload CSP, R2 CORS) — treat it as a known trap, not a one-off.
- The `createCheckoutSession` mutation and its `ALREADY_SUBSCRIBED` server-side guard are removed, not ported. Paddle's checkout is opened entirely client-side with no backend call beforehand, so there is no request left for a backend guard to intercept. The existing frontend-only guard (`Billing.tsx`'s `disabled = isCurrentPlan || hasActiveSubscription || ...`) is the only protection against an already-subscribed group re-subscribing, same as it already was for every other button state in this file — this is a deliberate, accepted trade-off from moving to a client-driven checkout model, not an oversight.

---

## Task 1: Backend — Paddle config & dependency swap

**Files:**
- Create: `crm-proj/config/paddle.js`
- Modify: `crm-proj/package.json`
- Delete: `crm-proj/config/stripe.js` (removed in this task since nothing imports it after this point — the old webhook route and resolver still reference it until Tasks 6–7, so this task's step order matters)

**Interfaces:**
- Produces: `paddle` (a configured `Paddle` client instance) from `crm-proj/config/paddle.js`, used by Tasks 3, 5, 6, 7.

Note: `config/stripe.js` has no test file today (`npm ls` confirms no `config/stripe.test.js`), so `config/paddle.js` doesn't get one either — matches existing convention of not unit-testing fail-loud env-var config modules directly.

- [ ] **Step 1: Install the Paddle SDK, remove the Stripe SDK**

```bash
cd crm-proj
npm install @paddle/paddle-node-sdk@3.10.0
npm uninstall stripe
```

- [ ] **Step 2: Create `config/paddle.js`**

```js
import { Paddle, Environment } from '@paddle/paddle-node-sdk';

const REQUIRED_ENV_VARS = ['PADDLE_API_KEY', 'PADDLE_ENVIRONMENT', 'PADDLE_WEBHOOK_SECRET'];

for (const name of REQUIRED_ENV_VARS) {
  if (!process.env[name]) {
    throw new Error(`Missing ${name} environment variable`);
  }
}

const ENVIRONMENTS = { sandbox: Environment.sandbox, production: Environment.production };
const environment = ENVIRONMENTS[process.env.PADDLE_ENVIRONMENT];

if (!environment) {
  throw new Error(
    `PADDLE_ENVIRONMENT must be "sandbox" or "production", got "${process.env.PADDLE_ENVIRONMENT}"`,
  );
}

export const paddle = new Paddle(process.env.PADDLE_API_KEY, { environment });
```

- [ ] **Step 3: Add the required vars to `crm-proj/.env`**

Add (do not commit `.env` — it's already gitignored):
```
PADDLE_API_KEY=<the sandbox API key the user provided in chat>
PADDLE_ENVIRONMENT=sandbox
PADDLE_WEBHOOK_SECRET=<filled in by Task 13, once the webhook destination exists>
```

- [ ] **Step 4: Delete `config/stripe.js`**

This will break `models/billing.js`, `resolvers/billingResolvers.js`, `routes/stripeWebhook.js`, and their test files until Tasks 5–7 remove/replace those references. That's expected — this repo won't be in a fully working state again until Task 7 lands. Do not run the full test suite as a gate for this task; just confirm the file is gone and `node -e "import('./config/paddle.js').then(() => console.log('ok'))"` runs without throwing (given the three env vars are set).

- [ ] **Step 5: Commit**

```bash
git add config/paddle.js config/stripe.js package.json package-lock.json
git commit -m "feat: add Paddle config, remove Stripe SDK"
```

---

## Task 2: Backend — `mapPaddleStatus`

**Files:**
- Modify: `crm-proj/models/billingLogic.js`
- Test: `crm-proj/models/billingLogic.test.js`

**Interfaces:**
- Produces: `mapPaddleStatus(paddleStatus: string): 'active' | 'past_due' | 'canceled' | 'incomplete'`, used by Task 5's `upsertBillingFromSubscription`.

Paddle subscription statuses are `active`, `trialing`, `past_due`, `paused`, `canceled`. This app's own 14-day trial is tracked entirely in `group_billing` before any Paddle subscription exists (same as it was for Stripe), so Paddle's `trialing` should never actually occur here — mapped defensively to `active`, same reasoning as the existing `mapStripeStatus`. `paused` is treated as locked, same bucket as `canceled`.

- [ ] **Step 1: Write the failing tests**

Add to `crm-proj/models/billingLogic.test.js`, after the existing `mapStripeStatus` describe block:

```js
describe('mapPaddleStatus', () => {
  it('maps active and trialing to active', () => {
    expect(mapPaddleStatus('active')).toBe('active');
    expect(mapPaddleStatus('trialing')).toBe('active');
  });

  it('maps past_due to past_due', () => {
    expect(mapPaddleStatus('past_due')).toBe('past_due');
  });

  it('maps canceled and paused to canceled', () => {
    expect(mapPaddleStatus('canceled')).toBe('canceled');
    expect(mapPaddleStatus('paused')).toBe('canceled');
  });

  it('maps any unrecognized status to incomplete', () => {
    expect(mapPaddleStatus('something_paddle_adds_later')).toBe('incomplete');
  });
});
```

Update the top import line to:
```js
import { computeIsLocked, mapStripeStatus, mapPaddleStatus } from './billingLogic.js';
```

- [ ] **Step 2: Run the tests, confirm they fail**

```bash
cd crm-proj && npx vitest run models/billingLogic.test.js
```
Expected: FAIL — `mapPaddleStatus is not a function` (or `is not defined`).

- [ ] **Step 3: Implement `mapPaddleStatus`**

Add to `crm-proj/models/billingLogic.js`, after the existing `mapStripeStatus`:

```js
// Maps a Paddle Subscription's `status` to this app's internal status. Same defensive
// mapping as mapStripeStatus above and for the same reason — this app's trial is tracked
// entirely in group_billing before any Paddle subscription exists, so Paddle's 'trialing'
// should never actually occur here.
export function mapPaddleStatus(paddleStatus) {
  switch (paddleStatus) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
      return 'past_due';
    case 'canceled':
    case 'paused':
      return 'canceled';
    default:
      return 'incomplete';
  }
}
```

- [ ] **Step 4: Run the tests, confirm they pass**

```bash
cd crm-proj && npx vitest run models/billingLogic.test.js
```
Expected: PASS, all tests including the pre-existing `mapStripeStatus`/`computeIsLocked` ones.

- [ ] **Step 5: Commit**

```bash
git add models/billingLogic.js models/billingLogic.test.js
git commit -m "feat: add mapPaddleStatus alongside mapStripeStatus"
```

---

## Task 3: Backend — Paddle price catalog + `config/plans.js`

**Files:**
- Create: `crm-proj/scripts/create-paddle-catalog.js`
- Modify: `crm-proj/config/plans.js`
- Modify: `crm-proj/config/plans.test.js`

**Interfaces:**
- Consumes: `paddle` from Task 1's `config/paddle.js`.
- Produces: 6 real Paddle price IDs (one product + month/year price per tier), printed to stdout by the script and hand-copied into `config/plans.js`'s `paddlePriceId` fields in this same task. These exact 6 IDs are also needed verbatim by Task 9 (`crm-frontend/src/lib/paddleTiers.ts`) — write them down when this task's script runs; they won't be printed again without creating duplicate catalog entries.
- Produces: `planByPriceId(priceId): 'starter' | 'business' | 'scale' | null`, checking both `.month` and `.year` — used by Task 5.

This task actually calls the real Paddle sandbox API using the key already in `.env` (from Task 1). It is not idempotent — re-running it creates duplicate products/prices in the Paddle account — so run it exactly once.

- [ ] **Step 1: Update `config/plans.js`'s shape and Starter's price**

Replace `stripePriceId: process.env.STRIPE_PRICE_STARTER` (and the business/scale equivalents) with `paddlePriceId: { month: '', year: '' }` (empty for now — filled in by Step 4 below), and fix `priceMonthlyUsd` for Starter from `28` to `29`:

```js
// The three plan tiers this app sells. Static, not database-backed — there are only
// three of them and changing a limit is a deliberate code change. Prices are also
// created directly in Paddle (see docs/superpowers/specs/2026-09-02-paddle-billing-migration-design.md
// and scripts/create-paddle-catalog.js); the Price IDs below just link this config to the
// right Paddle objects. Hardcoded rather than read from env — these aren't secrets (every
// one is visible in any checkout request from the browser), and hardcoding matches the
// "easy to edit in code" convention shared with crm-frontend's src/lib/paddleTiers.ts,
// which holds the same 6 IDs for the frontend's own checkout calls. Change a price in
// Paddle, update both files.
export const PLANS = {
  starter: {
    tier: 'STARTER',
    name: 'Starter',
    priceMonthlyUsd: 29,
    paddlePriceId: { month: '', year: '' },
    adminLimit: 1,
    memberLimit: 10,
    storageGb: 10,
    aiNotesHoursPerMonth: 5,
  },
  business: {
    tier: 'BUSINESS',
    name: 'Business',
    priceMonthlyUsd: 59,
    paddlePriceId: { month: '', year: '' },
    adminLimit: 3,
    memberLimit: 25,
    storageGb: 50,
    aiNotesHoursPerMonth: 20,
  },
  scale: {
    tier: 'SCALE',
    name: 'Scale',
    priceMonthlyUsd: 99,
    paddlePriceId: { month: '', year: '' },
    adminLimit: 5,
    memberLimit: 100,
    storageGb: 200,
    aiNotesHoursPerMonth: 50,
  },
};

// Reverse lookup used by the Paddle webhook, which only knows a subscription's current
// price ID — checks both billing cycles since a customer could be on either one.
export function planByPriceId(priceId) {
  return (
    Object.keys(PLANS).find(
      (key) =>
        PLANS[key].paddlePriceId.month === priceId || PLANS[key].paddlePriceId.year === priceId,
    ) ?? null
  );
}

// Shapes a plan key into the GraphQL PlanLimits response — used by both
// models/billing.js (a group's current limits) and resolvers/billingResolvers.js (the
// public plans list), so the shape is defined exactly once. Strips paddlePriceId, which
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

- [ ] **Step 2: Write `scripts/create-paddle-catalog.js`**

```js
// One-time setup: creates the 3 Paddle products (Starter/Business/Scale) and their 6
// prices (month/year each) in whichever Paddle account config/paddle.js is pointed at.
// NOT idempotent — it does not check for existing products by name — so run it once,
// copy the printed price ids into config/plans.js's paddlePriceId fields (and into
// crm-frontend's src/lib/paddleTiers.ts), and don't run it again.
//
// Usage: node scripts/create-paddle-catalog.js

import { paddle } from '../config/paddle.js';
import { PLANS } from '../config/plans.js';

async function createTierCatalog(key, plan) {
  const product = await paddle.products.create({
    name: `Continuum CRM — ${plan.name}`,
    taxCategory: 'saas',
  });

  const monthly = await paddle.prices.create({
    description: `${plan.name} monthly`,
    productId: product.id,
    unitPrice: { amount: String(plan.priceMonthlyUsd * 100), currencyCode: 'USD' },
    billingCycle: { interval: 'month', frequency: 1 },
    taxMode: 'account_setting',
  });

  const yearlyUsd = plan.priceMonthlyUsd * 10; // 2 months free, per spec
  const yearly = await paddle.prices.create({
    description: `${plan.name} yearly`,
    productId: product.id,
    unitPrice: { amount: String(yearlyUsd * 100), currencyCode: 'USD' },
    billingCycle: { interval: 'year', frequency: 1 },
    taxMode: 'account_setting',
  });

  return { key, productId: product.id, month: monthly.id, year: yearly.id };
}

async function main() {
  const results = [];
  for (const [key, plan] of Object.entries(PLANS)) {
    results.push(await createTierCatalog(key, plan));
  }

  console.log('\nCreated Paddle catalog — paste these into config/plans.js\'s paddlePriceId');
  console.log('fields, and into crm-frontend/src/lib/paddleTiers.ts (Task 9):\n');
  for (const r of results) {
    console.log(`${r.key}: month=${r.month} year=${r.year}  (product ${r.productId})`);
  }
}

main().catch((err) => {
  console.error('Catalog creation failed:', err);
  process.exit(1);
});
```

- [ ] **Step 3: Run it against the real Paddle sandbox account**

```bash
cd crm-proj && node scripts/create-paddle-catalog.js
```

Expected: prints 3 lines, one per tier, each with a `month=pri_...` and `year=pri_...` id. If it throws an auth or validation error, check `PADDLE_API_KEY`/`PADDLE_ENVIRONMENT` in `.env` and that `taxCategory: 'saas'` is accepted (Paddle's allowed `tax_category` values are: `digital-goods`, `ebooks`, `implementation-services`, `professional-services`, `saas`, `software-programming-services`, `standard`, `training-services`, `website-hosting` — `saas` should be valid, but if the sandbox account rejects it, `standard` is a safe fallback).

- [ ] **Step 4: Paste the printed IDs into `config/plans.js`**

Replace each tier's `paddlePriceId: { month: '', year: '' }` with the real values printed in Step 3.

- [ ] **Step 5: Update `config/plans.test.js`**

```js
import { describe, it, expect } from 'vitest';
import { PLANS, planByPriceId, planLimitsResponse } from './plans.js';

describe('planByPriceId', () => {
  it('finds the plan key for a known monthly price id', () => {
    expect(planByPriceId(PLANS.starter.paddlePriceId.month)).toBe('starter');
    expect(planByPriceId(PLANS.business.paddlePriceId.month)).toBe('business');
    expect(planByPriceId(PLANS.scale.paddlePriceId.month)).toBe('scale');
  });

  it('finds the plan key for a known yearly price id', () => {
    expect(planByPriceId(PLANS.starter.paddlePriceId.year)).toBe('starter');
    expect(planByPriceId(PLANS.business.paddlePriceId.year)).toBe('business');
    expect(planByPriceId(PLANS.scale.paddlePriceId.year)).toBe('scale');
  });

  it('returns null for an unknown price id', () => {
    expect(planByPriceId('pri_doesnotexist')).toBeNull();
  });
});

describe('planLimitsResponse', () => {
  it('returns the full limits shape for a known plan key, without leaking paddlePriceId', () => {
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

  it('reflects the corrected Starter price', () => {
    expect(planLimitsResponse('starter').priceMonthlyUsd).toBe(29);
  });
});
```

- [ ] **Step 6: Run the tests, confirm they pass**

```bash
cd crm-proj && npx vitest run config/plans.test.js
```
Expected: PASS. (This is a run-after-implement check, not a strict red/green TDD cycle — the price IDs only exist after Step 3 runs against the real API, so there's nothing meaningful to fail against beforehand.)

- [ ] **Step 7: Commit**

```bash
git add scripts/create-paddle-catalog.js config/plans.js config/plans.test.js
git commit -m "feat: create Paddle price catalog, switch config/plans.js to Paddle price ids"
```

---

## Task 4: Backend — rename `group_billing`'s Stripe columns

**Files:**
- Create: `crm-proj/scripts/rename-billing-columns-to-paddle.js`

**Interfaces:**
- Produces: `group_billing.paddle_customer_id`, `group_billing.paddle_subscription_id` columns, used by Task 5.

No live subscriber data exists (confirmed during brainstorming), so this is a plain rename, not a backfill.

- [ ] **Step 1: Write the migration script**

```js
// One-time migration: renames group_billing's Stripe-era columns to their Paddle
// equivalents. Safe to re-run — the column-existence check makes a second run a no-op.
// There is no live subscriber data to preserve (confirmed pre-migration), so this is a
// plain rename, not a backfill.
//
// Usage: node scripts/rename-billing-columns-to-paddle.js

import { pool } from "../config/supabase.js";

async function columnExists(column) {
  const result = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'group_billing' AND column_name = $1`,
    [column],
  );
  return result.rows.length > 0;
}

async function main() {
  console.log("Renaming group_billing's Stripe columns to Paddle...");

  if (await columnExists("stripe_customer_id")) {
    await pool.query("ALTER TABLE group_billing RENAME COLUMN stripe_customer_id TO paddle_customer_id");
    console.log("Renamed stripe_customer_id -> paddle_customer_id");
  } else {
    console.log("stripe_customer_id already renamed or absent — skipping");
  }

  if (await columnExists("stripe_subscription_id")) {
    await pool.query(
      "ALTER TABLE group_billing RENAME COLUMN stripe_subscription_id TO paddle_subscription_id",
    );
    console.log("Renamed stripe_subscription_id -> paddle_subscription_id");
  } else {
    console.log("stripe_subscription_id already renamed or absent — skipping");
  }

  const check = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'group_billing' AND column_name IN ('paddle_customer_id', 'paddle_subscription_id')
  `);
  console.log(
    check.rows.length === 2
      ? "Done — both Paddle columns exist."
      : "Something went wrong — expected both Paddle columns to exist after migration.",
  );

  await pool.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it against the real database**

```bash
cd crm-proj && node scripts/rename-billing-columns-to-paddle.js
```
Expected: "Renamed stripe_customer_id -> paddle_customer_id", "Renamed stripe_subscription_id -> paddle_subscription_id", "Done — both Paddle columns exist."

- [ ] **Step 3: Commit**

```bash
git add scripts/rename-billing-columns-to-paddle.js
git commit -m "feat: rename group_billing's Stripe columns to Paddle equivalents"
```

---

## Task 5: Backend — `models/billing.js` rewrite

**Files:**
- Modify: `crm-proj/models/billing.js`
- Test: Create `crm-proj/models/billing.test.js` (no test file exists for this module today — `upsertBillingFromSubscription`'s Paddle-shaped rewrite is exactly the kind of pure-mapping logic worth covering directly, even though the module also does I/O; the DB calls are exercised indirectly through the existing `paddleWebhook` integration test in Task 6, so this test only covers the parts of `upsertBillingFromSubscription` that don't need a real DB: the argument shapes passed to `pool.query`. Mock `pool`.)

**Interfaces:**
- Consumes: `planByPriceId` (Task 3), `mapPaddleStatus` (Task 2).
- Produces: `getOrCreateBilling(groupId)` (unchanged signature), `isGroupLocked(groupId)` (unchanged), `getPaddleBillingIds(groupId): Promise<{ customerId: string | null, subscriptionId: string | null }>` (new, used by Task 7's `createBillingPortalSession`), `upsertBillingFromSubscription(subscription)` (new Paddle-shaped signature, used by Task 6's webhook handler).

- [ ] **Step 1: Write the failing test**

Create `crm-proj/models/billing.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/supabase.js', () => ({
  pool: { query: vi.fn() },
}));
vi.mock('../config/plans.js', async () => {
  const actual = await vi.importActual('../config/plans.js');
  return {
    ...actual,
    planByPriceId: vi.fn((priceId) => (priceId === 'pri_starter_month' ? 'starter' : null)),
  };
});

const { pool } = await import('../config/supabase.js');
const { upsertBillingFromSubscription } = await import('./billing.js');

describe('upsertBillingFromSubscription', () => {
  beforeEach(() => {
    pool.query.mockReset();
  });

  it('updates by paddle_customer_id when a matching row exists', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const subscription = {
      id: 'sub_123',
      customerId: 'ctm_123',
      status: 'active',
      items: [{ price: { id: 'pri_starter_month' } }],
      currentBillingPeriod: { endsAt: '2026-12-01T00:00:00.000Z' },
      customData: null,
    };

    await upsertBillingFromSubscription(subscription);

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('WHERE paddle_customer_id = $5');
    expect(params).toEqual(['sub_123', 'starter', 'active', new Date('2026-12-01T00:00:00.000Z'), 'ctm_123']);
  });

  it('falls back to customData.groupId when no row matches by customer id', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 0 }) // by-customer update finds nothing
      .mockResolvedValueOnce({ rowCount: 1 }); // by-metadata update succeeds

    const subscription = {
      id: 'sub_456',
      customerId: 'ctm_new',
      status: 'active',
      items: [{ price: { id: 'pri_starter_month' } }],
      currentBillingPeriod: { endsAt: '2026-12-01T00:00:00.000Z' },
      customData: { groupId: 'group-abc' },
    };

    await upsertBillingFromSubscription(subscription);

    expect(pool.query).toHaveBeenCalledTimes(2);
    const [sql, params] = pool.query.mock.calls[1];
    expect(sql).toContain('WHERE group_id = $6');
    expect(params).toEqual([
      'ctm_new',
      'sub_456',
      'starter',
      'active',
      new Date('2026-12-01T00:00:00.000Z'),
      'group-abc',
    ]);
  });

  it('does nothing further when there is no customer match and no customData.groupId', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0 });

    const subscription = {
      id: 'sub_789',
      customerId: 'ctm_unmatched',
      status: 'active',
      items: [{ price: { id: 'pri_starter_month' } }],
      currentBillingPeriod: { endsAt: null },
      customData: null,
    };

    await upsertBillingFromSubscription(subscription);

    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test, confirm it fails**

```bash
cd crm-proj && npx vitest run models/billing.test.js
```
Expected: FAIL — `upsertBillingFromSubscription` still reads `subscription.customer`/Stripe shapes, so the assertions on SQL/params mismatch (or it throws on `subscription.items?.data?.[0]`, which no longer matches the new test's `items[0]` shape).

- [ ] **Step 3: Rewrite `models/billing.js`**

```js
import { pool } from '../config/supabase.js';
import { planByPriceId, planLimitsResponse } from '../config/plans.js';
import { computeIsLocked, mapPaddleStatus } from './billingLogic.js';

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
    'SELECT GREATEST(MIN(created_at), now()) AS trial_start FROM groups WHERE "groupId" = $1',
    [groupId],
  );
  const trialStart = groupCreated.rows[0].trial_start;

  const inserted = await pool.query(
    `INSERT INTO group_billing (group_id, status, trial_ends_at)
     VALUES ($1, 'trialing', $2::timestamptz + make_interval(days => $3))
     ON CONFLICT (group_id) DO NOTHING
     RETURNING *`,
    [groupId, trialStart, TRIAL_DAYS],
  );

  if (inserted.rows.length > 0) {
    return mapRow(inserted.rows[0]);
  }

  const raced = await pool.query('SELECT * FROM group_billing WHERE group_id = $1', [groupId]);
  return mapRow(raced.rows[0]);
}

export async function isGroupLocked(groupId) {
  const billing = await getOrCreateBilling(groupId);
  return billing.isLocked;
}

// Returns the group's Paddle customer + subscription ids for building a customer-portal
// session. Both are null until the group's first successful checkout's webhook lands —
// there is no backend pre-creation step for a Paddle customer the way Stripe had one,
// since Paddle's client-driven checkout creates the customer itself.
export async function getPaddleBillingIds(groupId) {
  const result = await pool.query(
    'SELECT paddle_customer_id, paddle_subscription_id FROM group_billing WHERE group_id = $1',
    [groupId],
  );
  return {
    customerId: result.rows[0]?.paddle_customer_id ?? null,
    subscriptionId: result.rows[0]?.paddle_subscription_id ?? null,
  };
}

// Applied from a Paddle subscription.created|updated|canceled webhook event — all three
// carry a full Subscription object with a status, so one function handles them. Resolves
// the group primarily by paddle_customer_id (the normal, expected path once a customer
// already has one on file); if that doesn't match — the very first event for a
// brand-new Paddle customer, so no group_billing row has this customer id yet — falls
// back to the groupId Billing.tsx stamped into the checkout's customData at open time.
// If neither matches, the event isn't ours — logged and ignored rather than treated as
// an error (the caller responds 200, not 500 — Paddle should not retry an event that
// will never match).
export async function upsertBillingFromSubscription(subscription) {
  const customerId = subscription.customerId;
  const priceId = subscription.items?.[0]?.price?.id ?? null;
  const planKey = priceId ? planByPriceId(priceId) : null;
  const status = mapPaddleStatus(subscription.status);
  const periodEndRaw = subscription.currentBillingPeriod?.endsAt ?? null;
  const currentPeriodEnd = periodEndRaw ? new Date(periodEndRaw) : null;

  const byCustomer = await pool.query(
    `UPDATE group_billing
     SET paddle_subscription_id = $1, plan = $2, status = $3, current_period_end = $4, updated_at = now()
     WHERE paddle_customer_id = $5`,
    [subscription.id, planKey, status, currentPeriodEnd, customerId],
  );

  if (byCustomer.rowCount > 0) return;

  const metadataGroupId = subscription.customData?.groupId ?? null;
  if (!metadataGroupId) {
    return;
  }

  const byMetadata = await pool.query(
    `UPDATE group_billing
     SET paddle_customer_id = $1, paddle_subscription_id = $2, plan = $3, status = $4, current_period_end = $5, updated_at = now()
     WHERE group_id = $6`,
    [customerId, subscription.id, planKey, status, currentPeriodEnd, metadataGroupId],
  );

  if (byMetadata.rowCount === 0) {
    console.error(
      `Paddle subscription ${subscription.id} has customData.groupId ${metadataGroupId} but no matching group_billing row exists.`,
    );
  }
}
```

- [ ] **Step 4: Run the test, confirm it passes**

```bash
cd crm-proj && npx vitest run models/billing.test.js
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add models/billing.js models/billing.test.js
git commit -m "feat: rewrite models/billing.js for Paddle's client-driven checkout model"
```

---

## Task 6: Backend — Paddle webhook route

**Files:**
- Create: `crm-proj/routes/paddleWebhook.js`
- Create: `crm-proj/routes/paddleWebhook.test.js`
- Delete: `crm-proj/routes/stripeWebhook.js`, `crm-proj/routes/stripeWebhook.test.js`

**Interfaces:**
- Consumes: `paddle` (Task 1), `upsertBillingFromSubscription` (Task 5).
- Produces: `paddleWebhookHandler(req, res)` (Express handler), used by Task 7's `server.js` wiring.

Paddle signs webhooks as `Paddle-Signature: ts=<unix_seconds>;h1=<hex hmac-sha256 of "${ts}:${rawBody}">`. There's no SDK test helper for generating one (unlike Stripe's `generateTestHeaderString`), so the test signs its own payload with the same algorithm, using Node's built-in `crypto`.

**Note on field casing:** `paddle.webhooks.unmarshal()`'s parsed event object is expected to use camelCase (`eventType`, `data.customerId`, `data.currentBillingPeriod.endsAt`, `data.customData`) — consistent with the rest of the `@paddle/paddle-node-sdk`'s request/response typing (`unitPrice`, `billingCycle`, `productId` elsewhere in this SDK). If Step 4's test run fails specifically on the `toHaveBeenCalledWith(subscription)` assertion (not the signature-verification ones), the SDK's real field names differ from this assumption — temporarily add `console.log(JSON.stringify(eventData))` right after `unmarshal()` resolves, rerun the failing test, read the actual shape from the log, adjust the test's expected `subscription` object (and, if needed, `models/billing.js`'s field access from Task 5) to match, then remove the debug log.

- [ ] **Step 1: Write the failing tests**

Create `crm-proj/routes/paddleWebhook.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { paddleWebhookHandler } from './paddleWebhook.js';
import { upsertBillingFromSubscription } from '../models/billing.js';

vi.mock('../models/billing.js', () => ({
  upsertBillingFromSubscription: vi.fn(),
}));

function signPaddlePayload(payload, secret) {
  const ts = Math.floor(Date.now() / 1000);
  const hmac = crypto.createHmac('sha256', secret).update(`${ts}:${payload}`).digest('hex');
  return `ts=${ts};h1=${hmac}`;
}

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

describe('paddleWebhookHandler', () => {
  beforeEach(() => {
    upsertBillingFromSubscription.mockReset();
  });

  it('rejects a request with an invalid signature', async () => {
    const req = { headers: { 'paddle-signature': 'ts=1;h1=bad' }, body: Buffer.from('{}') };
    const res = mockRes();

    await paddleWebhookHandler(req, res);

    expect(res.statusCode).toBe(400);
    expect(upsertBillingFromSubscription).not.toHaveBeenCalled();
  });

  it('applies a valid subscription.updated event', async () => {
    const subscription = {
      id: 'sub_123',
      customerId: 'ctm_123',
      status: 'active',
      items: [{ price: { id: 'pri_starter_month' } }],
      currentBillingPeriod: { endsAt: '2026-12-01T00:00:00.000Z' },
      customData: null,
    };
    const payload = JSON.stringify({
      event_id: 'evt_123',
      event_type: 'subscription.updated',
      data: subscription,
    });
    const header = signPaddlePayload(payload, process.env.PADDLE_WEBHOOK_SECRET);

    const req = { headers: { 'paddle-signature': header }, body: Buffer.from(payload) };
    const res = mockRes();

    await paddleWebhookHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(upsertBillingFromSubscription).toHaveBeenCalledWith(subscription);
  });

  it('ignores an event type it does not handle', async () => {
    const payload = JSON.stringify({
      event_id: 'evt_456',
      event_type: 'transaction.completed',
      data: {},
    });
    const header = signPaddlePayload(payload, process.env.PADDLE_WEBHOOK_SECRET);

    const req = { headers: { 'paddle-signature': header }, body: Buffer.from(payload) };
    const res = mockRes();

    await paddleWebhookHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(upsertBillingFromSubscription).not.toHaveBeenCalled();
  });

  it('responds 500 when upsertBillingFromSubscription throws', async () => {
    upsertBillingFromSubscription.mockRejectedValueOnce(new Error('boom'));

    const subscription = {
      id: 'sub_789',
      customerId: 'ctm_789',
      status: 'active',
      items: [{ price: { id: 'pri_starter_month' } }],
      currentBillingPeriod: { endsAt: null },
      customData: null,
    };
    const payload = JSON.stringify({
      event_id: 'evt_789',
      event_type: 'subscription.created',
      data: subscription,
    });
    const header = signPaddlePayload(payload, process.env.PADDLE_WEBHOOK_SECRET);

    const req = { headers: { 'paddle-signature': header }, body: Buffer.from(payload) };
    const res = mockRes();

    await paddleWebhookHandler(req, res);

    expect(res.statusCode).toBe(500);
  });
});
```

- [ ] **Step 2: Run the tests, confirm they fail**

```bash
cd crm-proj && npx vitest run routes/paddleWebhook.test.js
```
Expected: FAIL — `routes/paddleWebhook.js` doesn't exist yet.

- [ ] **Step 3: Write `routes/paddleWebhook.js`**

```js
import { EventName } from '@paddle/paddle-node-sdk';
import { paddle } from '../config/paddle.js';
import { upsertBillingFromSubscription } from '../models/billing.js';

const SUBSCRIPTION_EVENTS = new Set([
  EventName.SubscriptionCreated,
  EventName.SubscriptionUpdated,
  EventName.SubscriptionCanceled,
]);

// Express handler. The route this is mounted on MUST use express.raw({ type:
// 'application/json' }) — Paddle's signature check needs the exact raw request bytes,
// not a re-serialized JSON.parse of them.
export async function paddleWebhookHandler(req, res) {
  const signature = req.headers['paddle-signature'] ?? '';
  const rawRequestBody = req.body.toString();
  let eventData;

  try {
    eventData = await paddle.webhooks.unmarshal(
      rawRequestBody,
      process.env.PADDLE_WEBHOOK_SECRET,
      signature,
    );
  } catch (err) {
    console.error('Paddle webhook signature verification failed:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  if (SUBSCRIPTION_EVENTS.has(eventData.eventType)) {
    try {
      await upsertBillingFromSubscription(eventData.data);
    } catch (err) {
      console.error('Failed to apply Paddle webhook event:', err);
      res.status(500).send('Webhook handler failed');
      return;
    }
  }

  res.json({ received: true });
}
```

- [ ] **Step 4: Run the tests, confirm they pass**

```bash
cd crm-proj && npx vitest run routes/paddleWebhook.test.js
```
Expected: PASS. If the second test fails only on the `toHaveBeenCalledWith` assertion, follow the field-casing note above.

- [ ] **Step 5: Delete the old Stripe webhook route and its test**

```bash
cd crm-proj
git rm routes/stripeWebhook.js routes/stripeWebhook.test.js
```

- [ ] **Step 6: Commit**

```bash
git add routes/paddleWebhook.js routes/paddleWebhook.test.js
git commit -m "feat: add Paddle webhook route, remove Stripe webhook route"
```

---

## Task 7: Backend — resolvers, typedefs, `server.js` wiring

**Files:**
- Modify: `crm-proj/typedefs/billingTypeDefs.js`
- Modify: `crm-proj/resolvers/billingResolvers.js`
- Modify: `crm-proj/server.js`

**Interfaces:**
- Consumes: `paddle` (Task 1), `getOrCreateBilling`/`getPaddleBillingIds` (Task 5), `paddleWebhookHandler` (Task 6).
- Produces: GraphQL `createBillingPortalSession` mutation (unchanged name/shape), used by `crm-frontend`'s existing `CREATE_BILLING_PORTAL_SESSION` call (Task 10 leaves this one alone).

This is the task where `createCheckoutSession` actually disappears (see Global Constraints) and the repo becomes fully working again on Paddle.

- [ ] **Step 1: Update `typedefs/billingTypeDefs.js`**

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
    storageBytesUsed: Float!
  }

  type PortalSession { url: String! }

  type Query {
    "Resolves for both an admin (Supabase session) and a member (cookie/token) caller."
    myBilling: Billing!
    "No auth required — also used on the public pricing page."
    plans: [PlanLimits!]!
  }

  type Mutation {
    "Admin-only. Returns a Paddle customer-portal URL to redirect the browser to."
    createBillingPortalSession: PortalSession!
  }
`;

export default billingTypeDefs;
```

- [ ] **Step 2: Update `resolvers/billingResolvers.js`**

```js
import { GraphQLError } from 'graphql';
import { requireGroup, requireCallerGroupId } from '../utils/requireUser.js';
import { PLANS, planLimitsResponse } from '../config/plans.js';
import { paddle } from '../config/paddle.js';
import { getOrCreateBilling, getPaddleBillingIds } from '../models/billing.js';
import { getOrCreateStorageUsage } from '../models/storage.js';

const billingResolvers = {
  Query: {
    myBilling: async (_, __, context) => {
      const groupId = requireCallerGroupId(context);
      const [billing, storageBytesUsed] = await Promise.all([
        getOrCreateBilling(groupId),
        getOrCreateStorageUsage(groupId),
      ]);
      return { ...billing, storageBytesUsed };
    },
    plans: () => Object.keys(PLANS).map(planLimitsResponse),
  },
  Mutation: {
    createBillingPortalSession: async (_, __, context) => {
      const groupId = requireGroup(context);
      const { customerId, subscriptionId } = await getPaddleBillingIds(groupId);

      if (!customerId) {
        throw new GraphQLError('Choose a plan before managing billing.', {
          extensions: { code: 'NO_PADDLE_CUSTOMER' },
        });
      }

      const session = await paddle.customerPortalSessions.create(
        customerId,
        subscriptionId ? [subscriptionId] : [],
      );

      return { url: session.urls.general.overview };
    },
  },
};

export default billingResolvers;
```

- [ ] **Step 3: Update `server.js`**

Replace the import:
```js
import { stripeWebhookHandler } from './routes/stripeWebhook.js';
```
with:
```js
import { paddleWebhookHandler } from './routes/paddleWebhook.js';
```

Replace the route mount:
```js
// Stripe needs the exact raw request bytes to verify the signature — express.raw here,
// NOT express.json(), and this must be registered before the app-wide express.json()
// below or that would consume/reparse the body first.
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), stripeWebhookHandler);
```
with:
```js
// Paddle needs the exact raw request bytes to verify the signature — express.raw here,
// NOT express.json(), and this must be registered before the app-wide express.json()
// below or that would consume/reparse the body first.
app.post('/webhooks/paddle', express.raw({ type: 'application/json' }), paddleWebhookHandler);
```

- [ ] **Step 4: Run the full backend test suite**

```bash
cd crm-proj && npm test
```
Expected: PASS, no `stripe`/Stripe references left failing to resolve.

- [ ] **Step 5: Start the server locally and smoke-check it boots**

```bash
cd crm-proj && npm run dev
```
Expected: `🚀 Server ready at http://localhost:4000/` with no startup errors (this also exercises `config/paddle.js`'s fail-loud env check for real). Stop it with Ctrl+C once confirmed.

- [ ] **Step 6: Commit**

```bash
git add typedefs/billingTypeDefs.js resolvers/billingResolvers.js server.js
git commit -m "feat: retarget billing resolvers and webhook route at Paddle"
```

---

## Task 8: Frontend — Paddle.js dependency & init helper

**Files:**
- Modify: `crm-frontend/package.json`
- Create: `crm-frontend/src/lib/paddle.ts`
- Modify: `crm-frontend/.env.example`

**Interfaces:**
- Produces: `getPaddle(): Promise<Paddle>` from `src/lib/paddle.ts`, used by Task 11's `Billing.tsx`.

- [ ] **Step 1: Install `@paddle/paddle-js`**

```bash
cd crm-frontend && npm install @paddle/paddle-js@1.6.5
```

- [ ] **Step 2: Add the Paddle vars to `.env.example` and to `crm-frontend/.env`**

Append to `crm-frontend/.env.example`:
```
VITE_PADDLE_ENVIRONMENT=sandbox
VITE_PADDLE_CLIENT_TOKEN=your-paddle-sandbox-client-token
```

Add the real values to `crm-frontend/.env` (gitignored) — `VITE_PADDLE_ENVIRONMENT=sandbox` now; `VITE_PADDLE_CLIENT_TOKEN` once the user provides the `test_...` token created in the Paddle dashboard (Developer Tools → Authentication — this cannot be created via API, see spec §Paddle-side setup).

- [ ] **Step 3: Write `src/lib/paddle.ts`**

```ts
import { initializePaddle, type Paddle } from '@paddle/paddle-js';

const ENVIRONMENT = import.meta.env.VITE_PADDLE_ENVIRONMENT as string | undefined;
const CLIENT_TOKEN = import.meta.env.VITE_PADDLE_CLIENT_TOKEN as string | undefined;

let initPromise: Promise<Paddle> | null = null;

// Fails loudly rather than silently no-oping — same requirement as the backend's
// config/paddle.js, so a missing env var can never quietly point this at the wrong
// Paddle account (or none at all). VITE_PADDLE_CLIENT_TOKEN is the public client-side
// token — safe in the bundle by design, unlike the backend's PADDLE_API_KEY, which must
// never appear here.
function requireConfig(): { environment: 'sandbox' | 'production'; token: string } {
  if (!ENVIRONMENT) throw new Error('VITE_PADDLE_ENVIRONMENT is not set.');
  if (!CLIENT_TOKEN) throw new Error('VITE_PADDLE_CLIENT_TOKEN is not set.');
  if (ENVIRONMENT !== 'sandbox' && ENVIRONMENT !== 'production') {
    throw new Error(
      `VITE_PADDLE_ENVIRONMENT must be "sandbox" or "production", got "${ENVIRONMENT}"`,
    );
  }
  return { environment: ENVIRONMENT, token: CLIENT_TOKEN };
}

// Paddle.js fetches its real client library from Paddle's own CDN the first time this
// resolves — lazy + memoized so that only ever happens once, on first actual use, rather
// than on every app load regardless of whether the Billing page is visited.
export function getPaddle(): Promise<Paddle> {
  if (initPromise) return initPromise;
  const { environment, token } = requireConfig();
  initPromise = initializePaddle({ environment, token }).then((paddle) => {
    if (!paddle) throw new Error('Paddle.js failed to initialize.');
    return paddle;
  });
  return initPromise;
}
```

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/lib/paddle.ts .env.example
git commit -m "feat: add Paddle.js dependency and init helper"
```

---

## Task 9: Frontend — tier config

**Files:**
- Create: `crm-frontend/src/lib/paddleTiers.ts`

**Interfaces:**
- Consumes: the 6 Paddle price IDs produced by Task 3 — replace the `'pri_...'` placeholders below with the real values (do not leave them as-is; this file is non-functional until they're filled in).
- Produces: `TIERS: Tier[]`, used by Task 11's `Billing.tsx`.

- [ ] **Step 1: Write `src/lib/paddleTiers.ts`**

```ts
export interface Tier {
  name: 'Starter' | 'Business' | 'Scale';
  description: string;
  features: string[];
  priceId: { month: string; year: string };
}

// Price ids come from crm-proj's scripts/create-paddle-catalog.js (run once, see
// docs/superpowers/plans/2026-09-02-paddle-billing-migration.md Task 3). Kept here
// rather than fetched from the backend because Paddle's checkout is opened entirely
// client-side (Paddle.Checkout.open in Billing.tsx) — there's no server round-trip in
// that flow for this file to piggyback on. crm-proj's config/plans.js holds the same 6
// ids for the backend's own price -> plan lookup on webhook events. There is no shared
// source across the two repos; if you change a price in Paddle, update both files.
export const TIERS: Tier[] = [
  {
    name: 'Starter',
    description: 'For small teams getting started.',
    features: ['1 admin', '10 members', '10 GB storage', '5 hrs/mo AI meeting notes'],
    priceId: { month: 'pri_...', year: 'pri_...' },
  },
  {
    name: 'Business',
    description: 'For growing teams that need more room to work.',
    features: ['3 admins', '25 members', '50 GB storage', '20 hrs/mo AI meeting notes'],
    priceId: { month: 'pri_...', year: 'pri_...' },
  },
  {
    name: 'Scale',
    description: 'For larger teams running at full scale.',
    features: ['5 admins', '100 members', '200 GB storage', '50 hrs/mo AI meeting notes'],
    priceId: { month: 'pri_...', year: 'pri_...' },
  },
];
```

- [ ] **Step 2: Fill in the real price IDs from Task 3**

Replace every `'pri_...'` above with the actual id printed by `create-paddle-catalog.js`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/paddleTiers.ts
git commit -m "feat: add Paddle tier config"
```

---

## Task 10: Frontend — remove `CREATE_CHECKOUT_SESSION`

**Files:**
- Modify: `crm-frontend/src/lib/queries.ts`

**Interfaces:**
- Produces: `queries.ts` with no `CREATE_CHECKOUT_SESSION` export — Task 11's `Billing.tsx` must not import it.

- [ ] **Step 1: Remove the query and its stale comment**

Delete these lines from `src/lib/queries.ts`:
```ts
// Redirects the browser to Stripe Checkout. Admin-only.
export const CREATE_CHECKOUT_SESSION = `
  mutation CreateCheckoutSession($plan: PlanTier!) {
    createCheckoutSession(plan: $plan) { url }
  }
`;
```

Update the comment directly above `CREATE_BILLING_PORTAL_SESSION` from `// Redirects the browser to the Stripe Billing Portal. Admin-only.` to `// Redirects the browser to the Paddle customer portal. Admin-only.`.

- [ ] **Step 2: Confirm nothing else references it**

```bash
cd crm-frontend && grep -rn "CREATE_CHECKOUT_SESSION" src/
```
Expected: no output (Task 11 removes `Billing.tsx`'s only other reference in the same pass — if this task runs before Task 11, one hit in `Billing.tsx` is expected and fine).

- [ ] **Step 3: Commit**

```bash
git add src/lib/queries.ts
git commit -m "feat: remove CREATE_CHECKOUT_SESSION query"
```

---

## Task 11: Frontend — `Billing.tsx` checkout rewrite + CSP

**Files:**
- Modify: `crm-frontend/src/pages/Billing.tsx`
- Modify: `crm-frontend/vite.config.ts`

**Interfaces:**
- Consumes: `getPaddle` (Task 8), `TIERS`/`Tier` (Task 9), `useAuth` (existing, for email prefill).

This is the task most exposed to the CSP trap called out in Global Constraints — Paddle.js loads its real client library from `cdn.paddle.com` at runtime and opens its checkout overlay as an iframe from Paddle's own domain, neither of which the current CSP allows. `npm run dev` will look fine and hide this completely.

- [ ] **Step 1: Add Paddle's origins to the CSP**

In `crm-frontend/vite.config.ts`, inside `cspPlugin`, add a `paddleOrigin` block near the existing `r2Origin` definition:

```js
  // Paddle.js loads its real client library from Paddle's CDN at runtime (script-src),
  // opens checkout as an iframe hosted on Paddle's own domain (frame-src), and the
  // PricePreview/Checkout calls themselves go to Paddle's API (connect-src). This list is
  // the starting point from Paddle's own documented domains — if npm run build && npm run
  // preview still shows a CSP violation in the console for some other paddle.com
  // subdomain, add it here too. Sandbox and live share the same cdn/buy/api hosts.
  const paddle = {
    script: ["https://cdn.paddle.com"],
    frame: ["https://buy.paddle.com", "https://sandbox-buy.paddle.com"],
    connect: [
      "https://api.paddle.com",
      "https://sandbox-api.paddle.com",
      "https://checkout-service.paddle.com",
      "https://sandbox-checkout-service.paddle.com",
    ],
  }
```

Add `...paddle.connect` to the `connect` array:

```js
  const connect = [
    "'self'",
    ...cloudflare.connect,
    ...origin(env.VITE_SUPABASE_URL),
    ...origin(env.VITE_GRAPHQL_URL),
    ...origin(env.VITE_FIREBASE_DATABASE_URL),
    r2Origin,
    ...paddle.connect,
    // Firebase RTDB negotiates through these regardless of the database host.
    "https://*.firebaseio.com",
    "wss://*.firebaseio.com",
    "https://*.firebasedatabase.app",
    "wss://*.firebasedatabase.app",
    "https://firebaseinstallations.googleapis.com",
    "https://firebaseremoteconfig.googleapis.com",
    "https://www.googleapis.com",
    ...analytics.connect,
  ]
```

And update the `script-src`/`frame-src` policy lines to include the new sets:

```js
        `script-src 'self' ${[...hashes, ...analytics.script, ...cloudflare.script, ...firebaseRtdb.script, ...paddle.script].join(" ")}`.trim(),
```
```js
        `frame-src 'self' ${r2Origin} ${paddle.frame.join(" ")}`,
```

- [ ] **Step 2: Rewrite `Billing.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/ui/PageHeader';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Banner } from '../components/ui/Banner';
import { PageLoader } from '../components/ui/Spinner';
import { useQuery } from '../hooks/useQuery';
import { useBilling } from '../context/BillingContext';
import { useGroupUsers } from '../hooks/useGroupUsers';
import { useAuth } from '../context/AuthContext';
import { graphqlRequest } from '../lib/graphql';
import { CREATE_BILLING_PORTAL_SESSION, TASK_STORAGE_BREAKDOWN } from '../lib/queries';
import { StorageBreakdownChart } from '../components/billing/StorageBreakdownChart';
import { formatSize } from '../lib/formatSize';
import { getPaddle } from '../lib/paddle';
import { TIERS } from '../lib/paddleTiers';
import type { PlanTier, StorageBreakdown } from '../types';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

type Cycle = 'month' | 'year';

export function Billing() {
  const { billing, loading: billingLoading, error: billingError, refetch } = useBilling();
  const { user } = useAuth();
  const {
    data: breakdownData,
    refetch: refetchBreakdown,
  } = useQuery<{ taskStorageBreakdown: StorageBreakdown }>(() =>
    graphqlRequest(TASK_STORAGE_BREAKDOWN),
  );
  const { users: groupUsers } = useGroupUsers();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [portalPending, setPortalPending] = useState(false);
  const [checkoutPendingTier, setCheckoutPendingTier] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmTimedOut, setConfirmTimedOut] = useState(false);
  const [cycle, setCycle] = useState<Cycle>('month');
  const [totals, setTotals] = useState<Record<string, string> | null>(null);
  const [totalsError, setTotalsError] = useState<string | null>(null);

  const checkoutResult = searchParams.get('checkout');
  const hasActiveSubscription = !!billing?.plan && billing?.status !== 'canceled';

  useEffect(() => {
    if (checkoutResult !== 'success') return;
    if (billing?.plan) {
      setSearchParams({});
      setConfirmTimedOut(false);
      return;
    }
    setConfirmTimedOut(false);
    const interval = setInterval(() => {
      refetch();
    }, 2000);
    const timeout = setTimeout(() => {
      clearInterval(interval);
      setConfirmTimedOut(true);
    }, 15000);
    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [checkoutResult, billing?.plan, refetch, setSearchParams]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      refetch();
      refetchBreakdown();
    }, 15000);
    return () => clearInterval(interval);
  }, [refetch, refetchBreakdown]);

  // Localized totals for the active billing cycle, sourced from Paddle.PricePreview —
  // re-run whenever the toggle changes. No country code is passed; PricePreview detects
  // location from the visitor's IP (see spec: Country-localized pricing). Only
  // formattedTotals strings are kept — no re-formatting, no re-deriving from unit prices.
  useEffect(() => {
    let cancelled = false;
    setTotalsError(null);
    getPaddle()
      .then((paddle) =>
        paddle.PricePreview({
          items: TIERS.map((tier) => ({ priceId: tier.priceId[cycle], quantity: 1 })),
          ...(user?.email ? { customer: { email: user.email } } : {}),
        }),
      )
      .then((preview) => {
        if (cancelled) return;
        const byPriceId: Record<string, string> = {};
        for (const item of preview.data.details.lineItems) {
          byPriceId[item.price.id] = item.formattedTotals.total;
        }
        setTotals(byPriceId);
      })
      .catch((err) => {
        if (cancelled) return;
        setTotalsError(err instanceof Error ? err.message : 'Could not load prices.');
      });
    return () => {
      cancelled = true;
    };
  }, [cycle, user?.email]);

  async function choosePlan(tier: (typeof TIERS)[number]) {
    setActionError(null);
    setCheckoutPendingTier(tier.name);
    try {
      const paddle = await getPaddle();
      paddle.Checkout.open({
        items: [{ priceId: tier.priceId[cycle], quantity: 1 }],
        ...(user?.email ? { customer: { email: user.email } } : {}),
        customData: { groupId: billing?.groupId ?? '' },
        settings: { displayMode: 'overlay', variant: 'one-page' },
        eventCallback: (event) => {
          if (event.name === 'checkout.completed') {
            navigate('/app/welcome');
          }
        },
      });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not open checkout.');
    } finally {
      setCheckoutPendingTier(null);
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

  if (billingLoading) return <PageLoader />;

  return (
    <div>
      <PageHeader title="Billing" description="Manage your workspace's plan and subscription." />

      {checkoutResult === 'success' && (
        <div className="mb-6">
          {billing?.plan ? (
            <Banner tone="success">Subscription active — thank you for subscribing.</Banner>
          ) : confirmTimedOut ? (
            <Banner tone="info">
              Payment received — this is taking a little longer than usual to confirm.{' '}
              <button
                type="button"
                onClick={() => {
                  setConfirmTimedOut(false);
                  refetch();
                }}
                className="font-medium underline underline-offset-2"
              >
                Check again
              </button>
              , or check back in a minute.
            </Banner>
          ) : (
            <Banner tone="success">Subscription started — confirming with Paddle…</Banner>
          )}
        </div>
      )}
      {checkoutResult === 'cancel' && (
        <div className="mb-6">
          <Banner tone="info">Checkout was canceled — no changes were made.</Banner>
        </div>
      )}
      {billingError && (
        <div className="mb-6">
          <Banner tone="error">Could not load billing status: {billingError}</Banner>
        </div>
      )}
      {totalsError && (
        <div className="mb-6">
          <Banner tone="error">Could not load plan prices: {totalsError}</Banner>
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
        {billing?.status === 'active' && billing?.currentPeriodEnd && (
          <p className="mt-1 text-sm text-ink/55 dark:text-white/55">
            Renews {formatDate(billing.currentPeriodEnd)}.
          </p>
        )}
        {billing?.plan && (
          <div className="mt-5 border-t border-ink/[0.06] pt-4 dark:border-white/10">
            <p className="text-[13px] font-medium uppercase tracking-wide text-ink/40 dark:text-white/40">
              Usage
            </p>
            <p className="mt-1 text-sm text-ink/70 dark:text-white/70">
              {groupUsers.length} of {billing.limits.adminLimit} admin
              {billing.limits.adminLimit === 1 ? '' : 's'} used
            </p>
            <p className="mt-1 text-sm text-ink/70 dark:text-white/70">
              {formatSize(billing.storageBytesUsed)} of {formatSize(billing.limits.storageGb * 1024 ** 3)} storage used
            </p>
            {breakdownData?.taskStorageBreakdown && (
              <div className="mt-4">
                <StorageBreakdownChart
                  breakdown={breakdownData.taskStorageBreakdown}
                  storageGb={billing.limits.storageGb}
                />
              </div>
            )}
          </div>
        )}
        {billing?.plan && (
          <div className="mt-4">
            <Button
              variant="secondary"
              onClick={manageBilling}
              loading={portalPending}
              disabled={checkoutPendingTier !== null}
            >
              Manage billing
            </Button>
          </div>
        )}
      </Card>

      <div className="mb-4 inline-flex items-center gap-1 rounded-full border border-ink/[0.08] p-1 dark:border-white/10">
        <button
          type="button"
          onClick={() => setCycle('month')}
          className={`rounded-full px-3 py-1 text-[13px] font-medium ${cycle === 'month' ? 'bg-ink text-white dark:bg-white dark:text-ink' : 'text-ink/60 dark:text-white/60'}`}
        >
          Monthly
        </button>
        <button
          type="button"
          onClick={() => setCycle('year')}
          className={`rounded-full px-3 py-1 text-[13px] font-medium ${cycle === 'year' ? 'bg-ink text-white dark:bg-white dark:text-ink' : 'text-ink/60 dark:text-white/60'}`}
        >
          Yearly
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {TIERS.map((tier) => {
          const tierName = tier.name.toUpperCase() as PlanTier;
          const isCurrentPlan = hasActiveSubscription && billing?.plan === tierName;
          const disabled =
            isCurrentPlan || hasActiveSubscription || checkoutPendingTier !== null || portalPending;
          const total = totals?.[tier.priceId[cycle]];

          return (
            <Card key={tier.name} className="flex flex-col p-6">
              <p className="text-[17px] font-semibold text-ink dark:text-white">{tier.name}</p>
              <p className="mt-1 text-sm text-ink/55 dark:text-white/55">{tier.description}</p>
              <p className="mt-3 text-[26px] font-semibold text-ink dark:text-white">
                {total ?? '—'}
                <span className="text-[14px] font-normal text-ink/45 dark:text-white/45">
                  /{cycle === 'month' ? 'mo' : 'yr'}
                </span>
              </p>
              <ul className="mt-4 flex-1 space-y-1.5 text-sm text-ink/65 dark:text-white/65">
                {tier.features.map((feature) => (
                  <li key={feature}>{feature}</li>
                ))}
              </ul>
              <Button
                className="mt-5"
                variant={isCurrentPlan ? 'secondary' : 'primary'}
                disabled={disabled}
                loading={checkoutPendingTier === tier.name}
                onClick={() => choosePlan(tier)}
              >
                {isCurrentPlan ? 'Current plan' : hasActiveSubscription ? 'Manage billing to change' : 'Choose plan'}
              </Button>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Build and preview with real CSP, verify no console errors**

```bash
cd crm-frontend && npm run build && npm run preview
```
Then open the preview URL's `/app/billing` route in a browser with dev tools open (use the `preview_start`/browser tools rather than a manual step where possible), sign in, and check `read_console_messages` / `read_network_requests` for any CSP violation naming a `paddle.com` subdomain not already in Step 1's list. Add any missing domain to the matching directive in `vite.config.ts` and rebuild until the pricing cards show real totals and clicking "Choose plan" opens the overlay with no console errors.

- [ ] **Step 4: Verify `PricePreview`'s actual response shape matches the code above**

While the browser is open from Step 3, use `javascript_tool` to log the raw resolved value of a `Paddle.PricePreview(...)` call (or inspect a network request/response body for the pricing-preview API call) and confirm the path `data.details.lineItems[].price.id` / `.formattedTotals.total` is correct. If the SDK's real shape differs (e.g. snake_case `line_items`/`formatted_totals`), fix the `.then((preview) => ...)` block in `Billing.tsx` to match what's actually observed, not what's written above.

- [ ] **Step 5: Commit**

```bash
cd crm-frontend
git add src/pages/Billing.tsx vite.config.ts
git commit -m "feat: rewrite Billing.tsx checkout for Paddle overlay, extend CSP"
```

---

## Task 12: Frontend — `/app/welcome` page

**Files:**
- Create: `crm-frontend/src/pages/Welcome.tsx`
- Modify: `crm-frontend/src/App.tsx`

**Interfaces:**
- Consumes: nothing beyond existing UI components (`Card`, `Button`, `IconCheck`).

Nested under the existing `/app` protected route block (same as `/app/billing`) rather than a bare top-level `/welcome` — every other authenticated destination in this app lives under `/app`, and only a signed-in admin who just finished checkout should land here.

- [ ] **Step 1: Write `src/pages/Welcome.tsx`**

```tsx
import { Link } from 'react-router-dom';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { IconCheck } from '../components/layout/icons';

export function Welcome() {
  return (
    <div className="mx-auto max-w-lg py-12 text-center">
      <Card className="p-8">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400">
          <IconCheck className="h-6 w-6" />
        </div>
        <h1 className="mt-4 text-[20px] font-semibold text-ink dark:text-white">You're subscribed</h1>
        <p className="mt-2 text-sm text-ink/60 dark:text-white/60">
          Your subscription is active. It can take a few seconds for your plan to show up
          everywhere in the app.
        </p>
        <Link to="/app">
          <Button className="mt-6">Go to dashboard</Button>
        </Link>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Wire the route in `src/App.tsx`**

Add the import alongside the other page imports:
```tsx
import { Welcome } from './pages/Welcome';
```

Add the route inside the existing `/app` protected block, alongside `billing`:
```tsx
              <Route path="billing" element={<Billing />} />
              <Route path="welcome" element={<Welcome />} />
```

- [ ] **Step 3: Verify in the browser**

```bash
cd crm-frontend && npm run dev
```
Navigate to `/app/welcome` while signed in, confirm the confirmation card renders and "Go to dashboard" navigates to `/app`.

- [ ] **Step 4: Commit**

```bash
git add src/pages/Welcome.tsx src/App.tsx
git commit -m "feat: add post-checkout /app/welcome page"
```

---

## Task 13: Paddle webhook destination + full end-to-end sandbox verification

**Files:** none (account configuration + manual/browser verification only)

This task is performed by whoever is running the plan directly — not handed to a fresh subagent without oversight — because creating a webhook/notification destination is a standing integration change on the user's Paddle account (see spec: Paddle-side setup, and this codebase's own operating rules on persistent third-party configuration).

- [ ] **Step 1: Confirm the webhook URL with the user before creating anything**

Ask the user to confirm the exact URL the webhook should point at — almost certainly `https://api.continuumcrm.app/webhooks/paddle` (the deployed backend, same host pattern as the old `/webhooks/stripe`), but confirm rather than assume, since a wrong destination silently means no subscription ever gets applied.

- [ ] **Step 2: Create the notification destination via the Paddle API**

Once confirmed, run this one-off script (delete it afterward — it's not meant to be re-run, same as `create-paddle-catalog.js`):

```js
// One-time setup: creates the Paddle webhook notification destination pointed at this
// backend's /webhooks/paddle route. Run once, copy the printed secret into
// PADDLE_WEBHOOK_SECRET, then delete this file — re-running creates a duplicate
// destination rather than updating the existing one.
//
// Usage: node scripts/create-paddle-webhook-destination.js <confirmed-url>

import { paddle } from '../config/paddle.js';

async function main() {
  const destination = process.argv[2];
  if (!destination) {
    console.error('Usage: node scripts/create-paddle-webhook-destination.js <url>');
    process.exit(1);
  }

  const setting = await paddle.notificationSettings.create({
    description: 'Continuum CRM subscription billing',
    type: 'url',
    destination,
    subscribedEvents: ['subscription.created', 'subscription.updated', 'subscription.canceled'],
  });

  console.log('Created notification destination:', setting.id);
  console.log('PADDLE_WEBHOOK_SECRET=' + setting.endpointSecretKey);
}

main().catch((err) => {
  console.error('Failed to create notification destination:', err);
  process.exit(1);
});
```

```bash
cd crm-proj && node scripts/create-paddle-webhook-destination.js https://api.continuumcrm.app/webhooks/paddle
```

Expected: prints the destination id and a `PADDLE_WEBHOOK_SECRET=pdl_ntfset_...` line. If `subscribedEvents` values are rejected, check the exact event-type strings against the account's available events in the Paddle dashboard (Developer Tools → Notifications) and adjust.

- [ ] **Step 3: Set `PADDLE_WEBHOOK_SECRET` and delete the one-off script**

Add the real secret from Step 2's output to `crm-proj`'s `.env` (the placeholder from Task 1 gets replaced here) and to the deployed backend's environment configuration on Hostinger, then `git rm scripts/create-paddle-webhook-destination.js` and commit.

- [ ] **Step 4: Remind the user of the two dashboard-only steps from the spec**

- Client-side token (`test_...`) — Developer Tools → Authentication — needed for Task 8's `VITE_PADDLE_CLIENT_TOKEN` if not already provided.
- Default payment link — Checkout → Checkout settings — pointed at the sandbox checkout page or `localhost:5173` for local dev. Checkout will not render without this.

- [ ] **Step 5: End-to-end sandbox verification**

With both repos' dev servers running and all env vars set:
1. Open `/app/billing`, confirm `PricePreview` shows real localized totals for all 3 tiers, both cycles (toggle and confirm totals change).
2. Click "Choose plan" on one tier, confirm the overlay opens for the exact price shown.
3. Complete checkout with Paddle's sandbox test card (`4242 4242 4242 4242`, any future expiry/CVC — confirm this is still Paddle's current documented sandbox test card at the time this step runs).
4. Confirm the browser redirects to `/app/welcome`.
5. Confirm the webhook fires (check backend logs or Paddle's dashboard event log) and `group_billing.plan`/`status` update correctly — refresh `/app/billing` and confirm it now shows the subscribed plan.
6. Click "Manage billing", confirm it opens Paddle's customer portal for the right customer.

- [ ] **Step 6: Report results to the user**

Summarize what was verified and flag anything that didn't work as expected before considering the migration done.
