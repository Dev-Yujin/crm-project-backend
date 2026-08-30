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

  const result = await pool.query(
    `UPDATE group_billing
     SET stripe_subscription_id = $1, plan = $2, status = $3, current_period_end = $4, updated_at = now()
     WHERE stripe_customer_id = $5`,
    [subscription.id, planKey, status, currentPeriodEnd, customerId],
  );

  if (result.rowCount === 0) {
    throw new Error(`No group_billing row found for Stripe customer ${customerId}`);
  }
}
