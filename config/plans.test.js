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
