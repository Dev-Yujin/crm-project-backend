import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/supabase.js', () => ({
  pool: { query: vi.fn() },
}));
vi.mock('../config/plans.js', async () => {
  const actual = await vi.importActual('../config/plans.js');
  return {
    ...actual,
    planByPriceId: vi.fn((priceId) => (priceId === 'pri_starter_month' ? 'starter' : null)),
  };
});

const { pool } = await import('../config/supabase.js');
const { upsertBillingFromSubscription } = await import('./billing.js');

describe('upsertBillingFromSubscription', () => {
  beforeEach(() => {
    pool.query.mockReset();
  });

  it('updates by paddle_customer_id when a matching row exists', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const subscription = {
      id: 'sub_123',
      customerId: 'ctm_123',
      status: 'active',
      items: [{ price: { id: 'pri_starter_month' } }],
      currentBillingPeriod: { endsAt: '2026-12-01T00:00:00.000Z' },
      customData: null,
    };

    await upsertBillingFromSubscription(subscription);

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('WHERE paddle_customer_id = $5');
    expect(params).toEqual(['sub_123', 'starter', 'active', new Date('2026-12-01T00:00:00.000Z'), 'ctm_123']);
  });

  it('falls back to customData.groupId when no row matches by customer id', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 0 }) // by-customer update finds nothing
      .mockResolvedValueOnce({ rowCount: 1 }); // by-metadata update succeeds

    const subscription = {
      id: 'sub_456',
      customerId: 'ctm_new',
      status: 'active',
      items: [{ price: { id: 'pri_starter_month' } }],
      currentBillingPeriod: { endsAt: '2026-12-01T00:00:00.000Z' },
      customData: { groupId: 'group-abc' },
    };

    await upsertBillingFromSubscription(subscription);

    expect(pool.query).toHaveBeenCalledTimes(2);
    const [sql, params] = pool.query.mock.calls[1];
    expect(sql).toContain('WHERE group_id = $6');
    expect(params).toEqual([
      'ctm_new',
      'sub_456',
      'starter',
      'active',
      new Date('2026-12-01T00:00:00.000Z'),
      'group-abc',
    ]);
  });

  it('does nothing further when there is no customer match and no customData.groupId', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0 });

    const subscription = {
      id: 'sub_789',
      customerId: 'ctm_unmatched',
      status: 'active',
      items: [{ price: { id: 'pri_starter_month' } }],
      currentBillingPeriod: { endsAt: null },
      customData: null,
    };

    await upsertBillingFromSubscription(subscription);

    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});
