import { describe, it, expect } from 'vitest';
import { computeIsLocked, mapStripeStatus, mapPaddleStatus } from './billingLogic.js';

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
