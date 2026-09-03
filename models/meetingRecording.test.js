import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/supabase.js', () => ({
  pool: { query: vi.fn() },
}));

const { pool } = await import('../config/supabase.js');
const {
  getOrCreateSession,
  insertSegment,
  getSessionWithSegments,
  markSessionStatus,
} = await import('./meetingRecording.js');

describe('getOrCreateSession', () => {
  beforeEach(() => pool.query.mockReset());

  it('returns the existing session when one already exists', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ session_id: 's1', group_id: 'g1', created_by: 'admin:u1', status: 'recording' }],
    });

    const result = await getOrCreateSession('s1', 'g1', 'admin:u1');

    expect(result.status).toBe('recording');
    expect(result.created).toBe(false);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('creates a new session when none exists yet', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ session_id: 's2', group_id: 'g1', created_by: 'admin:u1', status: 'recording' }],
      });

    const result = await getOrCreateSession('s2', 'g1', 'admin:u1');

    expect(result.status).toBe('recording');
    expect(result.created).toBe(true);
    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query.mock.calls[1][0]).toContain('INSERT INTO meeting_recording_sessions');
  });

  it('marks created:false when the insert loses the race to a concurrent request', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] }) // SELECT finds nothing
      .mockResolvedValueOnce({ rows: [] }) // INSERT ... ON CONFLICT DO NOTHING returns nothing
      .mockResolvedValueOnce({
        rows: [{ session_id: 's3', group_id: 'g1', created_by: 'admin:u2', status: 'recording' }],
      }); // fallback SELECT

    const result = await getOrCreateSession('s3', 'g1', 'admin:u1');

    expect(result.created).toBe(false);
    expect(pool.query).toHaveBeenCalledTimes(3);
  });
});

describe('insertSegment', () => {
  beforeEach(() => pool.query.mockReset());

  it('inserts a segment row with the given fields', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await insertSegment('s1', 'g1', 0, 'meeting-recordings/g1/s1/segment-0.webm', 512000, 900);

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO meeting_recording_segments');
    expect(sql).toContain('ON CONFLICT (session_id, segment_index) DO UPDATE');
    expect(params).toEqual(['s1', 0, 'g1', 'meeting-recordings/g1/s1/segment-0.webm', 512000, 900]);
  });

  it('updates the row instead of throwing when re-confirming the same (sessionId, segmentIndex)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await expect(
      insertSegment('s1', 'g1', 0, 'meeting-recordings/g1/s1/segment-0.webm', 999, 800),
    ).resolves.not.toThrow();

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('DO UPDATE');
    expect(params).toEqual(['s1', 0, 'g1', 'meeting-recordings/g1/s1/segment-0.webm', 999, 800]);
  });
});

describe('getSessionWithSegments', () => {
  beforeEach(() => pool.query.mockReset());

  it('returns the session and its segments ordered by segment_index', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{ session_id: 's1', group_id: 'g1', created_by: 'admin:u1', status: 'recording' }],
      })
      .mockResolvedValueOnce({
        rows: [
          { segment_index: 0, r2_key: 'k0', size_bytes: 100, duration_seconds: 900 },
          { segment_index: 1, r2_key: 'k1', size_bytes: 200, duration_seconds: 450 },
        ],
      });

    const result = await getSessionWithSegments('s1', 'g1');

    expect(result.session.status).toBe('recording');
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].r2Key).toBe('k0');
    const [segSql, segParams] = pool.query.mock.calls[1];
    expect(segSql).toContain('ORDER BY segment_index');
    expect(segSql).toContain('group_id = $2');
    expect(segParams).toEqual(['s1', 'g1']);
  });

  it('throws when the session belongs to a different group', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await expect(getSessionWithSegments('s1', 'wrong-group')).rejects.toThrow();
  });
});

describe('markSessionStatus', () => {
  beforeEach(() => pool.query.mockReset());

  it('updates status without a duration', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await markSessionStatus('s1', 'processing');
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('SET status = $1');
    expect(params).toEqual(['processing', null, 's1']);
  });

  it('updates status with a total duration and completed_at', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await markSessionStatus('s1', 'completed', 1350);
    const [, params] = pool.query.mock.calls[0];
    expect(params).toEqual(['completed', 1350, 's1']);
  });
});
