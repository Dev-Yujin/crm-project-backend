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
    paddlePriceId: { month: 'pri_01m1h07rr5cydsbrpmz5e7d8rh', year: 'pri_01m1h07s29evhqgrwfyrkngmps' },
    adminLimit: 1,
    memberLimit: 10,
    storageGb: 10,
    aiNotesHoursPerMonth: 5,
  },
  business: {
    tier: 'BUSINESS',
    name: 'Business',
    priceMonthlyUsd: 59,
    paddlePriceId: { month: 'pri_01m1h07sq120sbscgfd2kndmxn', year: 'pri_01m1h07t47trn5ym2s5ya1ve81' },
    adminLimit: 3,
    memberLimit: 25,
    storageGb: 50,
    aiNotesHoursPerMonth: 20,
  },
  scale: {
    tier: 'SCALE',
    name: 'Scale',
    priceMonthlyUsd: 99,
    paddlePriceId: { month: 'pri_01m1h07ty5frxfwpbf3tbajjr7', year: 'pri_01m1h07v8zg1hhzb9gck1z00et' },
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
