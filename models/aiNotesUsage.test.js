import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/supabase.js', () => ({
  pool: { query: vi.fn() },
}));

const { pool } = await import('../config/supabase.js');
const { getOrCreateAiNotesUsage, addSecondsUsed } = await import('./aiNotesUsage.js');

describe('getOrCreateAiNotesUsage', () => {
  beforeEach(() => {
    pool.query.mockReset();
  });

  it('returns the existing row when the current period has not ended', async () => {
    const periodEnd = new Date(Date.now() + 86_400_000); // 1 day from now
    pool.query.mockResolvedValueOnce({
      rows: [{ seconds_used: 1200, period_start: new Date('2026-09-01'), period_end: periodEnd }],
    });

    const result = await getOrCreateAiNotesUsage('group-1');

    expect(result).toEqual({ secondsUsed: 1200, periodStart: new Date('2026-09-01'), periodEnd });
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('lazily resets the row when the period has ended', async () => {
    const pastPeriodEnd = new Date(Date.now() - 86_400_000); // 1 day ago
    pool.query
      .mockResolvedValueOnce({
        rows: [{ seconds_used: 5000, period_start: new Date('2026-07-01'), period_end: pastPeriodEnd }],
      })
      .mockResolvedValueOnce({ rows: [{ seconds_used: 0, period_start: new Date(), period_end: new Date() }] });

    await getOrCreateAiNotesUsage('group-1');

    expect(pool.query).toHaveBeenCalledTimes(2);
    const [resetSql] = pool.query.mock.calls[1];
    expect(resetSql).toContain('UPDATE group_ai_notes_usage');
    expect(resetSql).toContain('seconds_used = 0');
  });

  it('provisions a fresh row when the group has never used AI notes', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] }) // SELECT finds nothing
      .mockResolvedValueOnce({
        rows: [{ seconds_used: 0, period_start: new Date(), period_end: new Date() }],
      }); // INSERT ... RETURNING

    const result = await getOrCreateAiNotesUsage('group-2');

    expect(result.secondsUsed).toBe(0);
    expect(pool.query).toHaveBeenCalledTimes(2);
    const [insertSql] = pool.query.mock.calls[1];
    expect(insertSql).toContain('INSERT INTO group_ai_notes_usage');
  });
});

describe('addSecondsUsed', () => {
  beforeEach(() => {
    pool.query.mockReset();
  });

  it('adds the delta to the current period after ensuring the row is fresh', async () => {
    const periodEnd = new Date(Date.now() + 86_400_000);
    pool.query
      .mockResolvedValueOnce({
        rows: [{ seconds_used: 100, period_start: new Date(), period_end: periodEnd }],
      }) // getOrCreateAiNotesUsage's read
      .mockResolvedValueOnce({ rows: [] }); // the UPDATE

    await addSecondsUsed('group-1', 300);

    expect(pool.query).toHaveBeenCalledTimes(2);
    const [updateSql, params] = pool.query.mock.calls[1];
    expect(updateSql).toContain('UPDATE group_ai_notes_usage');
    expect(updateSql).toContain('seconds_used = seconds_used + $1');
    expect(params).toEqual([300, 'group-1']);
  });
});
