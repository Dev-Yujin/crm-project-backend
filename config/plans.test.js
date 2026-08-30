import { describe, it, expect } from 'vitest';
import { PLANS, planByPriceId, planLimitsResponse } from './plans.js';

describe('planByPriceId', () => {
  it('finds the plan key for a known price id', () => {
    expect(planByPriceId(PLANS.starter.stripePriceId)).toBe('starter');
    expect(planByPriceId(PLANS.business.stripePriceId)).toBe('business');
    expect(planByPriceId(PLANS.scale.stripePriceId)).toBe('scale');
  });

  it('returns null for an unknown price id', () => {
    expect(planByPriceId('price_doesnotexist')).toBeNull();
  });
});

describe('planLimitsResponse', () => {
  it('returns the full limits shape for a known plan key, without leaking stripePriceId', () => {
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
});
