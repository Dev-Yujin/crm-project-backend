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

  it('returns trial-tier limits (3GB storage, 0 AI-notes hours) when status is trialing', () => {
    const result = planLimitsResponse(null, 'trialing');
    expect(result.storageGb).toBe(3);
    expect(result.aiNotesHoursPerMonth).toBe(0);
    // Everything else still reads as Starter-shaped.
    expect(result.tier).toBe('STARTER');
    expect(result.adminLimit).toBe(1);
    expect(result.memberLimit).toBe(10);
  });

  it('does not apply trial limits when status is omitted or not trialing', () => {
    expect(planLimitsResponse(null).storageGb).toBe(10);
    expect(planLimitsResponse(null).aiNotesHoursPerMonth).toBe(5);
    expect(planLimitsResponse(null, 'active').storageGb).toBe(10);
  });
});
