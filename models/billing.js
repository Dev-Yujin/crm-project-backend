import { pool } from '../config/supabase.js';
import { planByPriceId, planLimitsResponse } from '../config/plans.js';
import { computeIsLocked, mapPaddleStatus } from './billingLogic.js';

const TRIAL_DAYS = 14;

function mapRow(row) {
  return {
    groupId: row.group_id,
    status: row.status,
    plan: row.plan ? row.plan.toUpperCase() : null,
    limits: planLimitsResponse(row.plan, row.status),
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
    // No customer match and nothing to fall back to — this event isn't ours.
    return;
  }

  const byMetadata = await pool.query(
    `UPDATE group_billing
     SET paddle_customer_id = $1, paddle_subscription_id = $2, plan = $3, status = $4, current_period_end = $5, updated_at = now()
     WHERE group_id = $6`,
    [customerId, subscription.id, planKey, status, currentPeriodEnd, metadataGroupId],
  );

  if (byMetadata.rowCount === 0) {
    // The subscription's own customData names a groupId this app stamped onto it at
    // checkout time, but no matching group_billing row exists — that's suspicious
    // (this app created the checkout) rather than simply "not ours," so it's worth
    // a log line even though we still don't treat it as a webhook-level failure.
    console.error(
      `Paddle subscription ${subscription.id} has customData.groupId ${metadataGroupId} but no matching group_billing row exists.`,
    );
  }
}
