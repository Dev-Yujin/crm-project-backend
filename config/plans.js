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
    paddlePriceId: { month: 'pri_01m1rv7jyazx12drcfrsefk5sr', year: 'pri_01m1rv7k7g59sgzxkn9k0nn2sy' },
    adminLimit: 1,
    memberLimit: 10,
    storageGb: 10,
    aiNotesHoursPerMonth: 5,
  },
  business: {
    tier: 'BUSINESS',
    name: 'Business',
    priceMonthlyUsd: 59,
    paddlePriceId: { month: 'pri_01m1rv7kvvswrn2425037n9vee', year: 'pri_01m1rv7m5fh78n5jmgcf65dsez' },
    adminLimit: 3,
    memberLimit: 25,
    storageGb: 50,
    aiNotesHoursPerMonth: 20,
  },
  scale: {
    tier: 'SCALE',
    name: 'Scale',
    priceMonthlyUsd: 99,
    paddlePriceId: { month: 'pri_01m1rv7mrws95ajbr16fqkbkg9', year: 'pri_01m1rv7n1hb03e0gg7e863xsyq' },
    adminLimit: 5,
    memberLimit: 100,
    storageGb: 200,
    aiNotesHoursPerMonth: 50,
  },
};

// Trial groups get these two limits instead of falling back to Starter's real
// values — AI Meeting Notes is fully blocked (not a reduced quota), and storage
// is capped well below Starter's paid tier. Everything else about a trial
// group (seat counts, tier/name shape) still reads as Starter-shaped.
export const TRIAL_LIMITS = { storageGb: 3, aiNotesHoursPerMonth: 0 };

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
export function planLimitsResponse(planKey, status) {
  const config = PLANS[planKey ?? 'starter'];
  const isTrialing = status === 'trialing';
  return {
    tier: config.tier,
    name: config.name,
    priceMonthlyUsd: config.priceMonthlyUsd,
    adminLimit: config.adminLimit,
    memberLimit: config.memberLimit,
    storageGb: isTrialing ? TRIAL_LIMITS.storageGb : config.storageGb,
    aiNotesHoursPerMonth: isTrialing ? TRIAL_LIMITS.aiNotesHoursPerMonth : config.aiNotesHoursPerMonth,
  };
}
