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

  // GREATEST(..., now()) — not a plain MIN(created_at) — because joining a group via
  // join code re-points an existing user's row in place without changing its created_at
  // (see models/groups.js's joinGroupByCode), so an old account joining a brand-new
  // group could otherwise make MIN(created_at) resolve to that old account's signup
  // date, retroactively expiring a day-old workspace's trial. Postgres's GREATEST/LEAST
  // ignore NULL arguments (only NULL if every argument is NULL), so this also fixes
  // the case of an orphaned/invalid groupId with zero matching rows in `groups` — it
  // now cleanly falls back to now() via SQL instead of a separate JS ?? fallback.
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
// Resolves the group primarily by stripe_customer_id (the normal, expected path); if that
// doesn't match, falls back to the groupId createCheckoutSession stamped into the
// subscription's metadata at creation time. If neither matches, the event isn't ours —
// this Stripe account may have other activity outside this app — so it's logged and
// ignored rather than treated as an error (returning normally here means the webhook
// route responds 200, not 500; Stripe should not retry an event that will never match).
export async function upsertBillingFromSubscription(subscription) {
  const customerId =
    typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
  const priceId = subscription.items?.data?.[0]?.price?.id ?? null;
  const planKey = priceId ? planByPriceId(priceId) : null;
  const status = mapStripeStatus(subscription.status);
  // Stripe removed current_period_end/current_period_start from Subscription (moved to
  // SubscriptionItem) in an API version this app's pinned SDK (stripe@22.6.0) already
  // uses — read it from the first item, falling back to the legacy top-level field in
  // case an older webhook endpoint API version is ever configured on the Stripe side.
  const periodEndRaw =
    subscription.items?.data?.[0]?.current_period_end ?? subscription.current_period_end ?? null;
  const currentPeriodEnd = periodEndRaw ? new Date(periodEndRaw * 1000) : null;

  const byCustomer = await pool.query(
    `UPDATE group_billing
     SET stripe_subscription_id = $1, plan = $2, status = $3, current_period_end = $4, updated_at = now()
     WHERE stripe_customer_id = $5`,
    [subscription.id, planKey, status, currentPeriodEnd, customerId],
  );

  if (byCustomer.rowCount > 0) return;

  const metadataGroupId = subscription.metadata?.groupId ?? null;
  if (!metadataGroupId) {
    // No customer match and nothing to fall back to — this event isn't ours.
    return;
  }

  const byMetadata = await pool.query(
    `UPDATE group_billing
     SET stripe_customer_id = $1, stripe_subscription_id = $2, plan = $3, status = $4, current_period_end = $5, updated_at = now()
     WHERE group_id = $6`,
    [customerId, subscription.id, planKey, status, currentPeriodEnd, metadataGroupId],
  );

  if (byMetadata.rowCount === 0) {
    // The subscription's own metadata names a groupId this app stamped onto it at
    // checkout time, but no matching group_billing row exists — that's suspicious
    // (this app created the subscription) rather than simply "not ours," so it's worth
    // a log line even though we still don't treat it as a webhook-level failure.
    console.error(
      `Stripe subscription ${subscription.id} has metadata.groupId ${metadataGroupId} but no matching group_billing row exists.`,
    );
  }
}
