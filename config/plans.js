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
