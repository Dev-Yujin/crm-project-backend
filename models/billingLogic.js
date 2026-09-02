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
