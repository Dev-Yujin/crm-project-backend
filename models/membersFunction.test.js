import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/supabase.js', () => ({
  pool: { query: vi.fn() },
}));
vi.mock('../utils/authUser.js', () => ({
  hashPassword: vi.fn(),
  comparePasswords: vi.fn(async () => false),
  generateMemberToken: vi.fn(() => 'fake-token'),
  verifyMemberToken: vi.fn(),
}));

vi.mock('./task.js', () => ({
  validateMembersExist: vi.fn(async () => {}),
}));
vi.mock('./memberAssignments.js', () => ({
  countMemberAssignments: vi.fn(),
  reassignMemberAssignments: vi.fn(),
}));

const { pool } = await import('../config/supabase.js');
const { comparePasswords } = await import('../utils/authUser.js');
const { validateMembersExist } = await import('./task.js');
const { countMemberAssignments, reassignMemberAssignments } = await import('./memberAssignments.js');
const { loginMember, deleteMember } = await import('./membersFunction.js');

describe('loginMember rate limiting', () => {
  beforeEach(() => {
    pool.query.mockReset();
    comparePasswords.mockReset();
    comparePasswords.mockResolvedValue(false);
    // Every attempt finds no matching row, so the function fails fast on
    // "Member not found" after the rate-limit check — that's fine, the
    // rate limiter runs before the DB query either way.
    pool.query.mockResolvedValue({ rows: [] });
  });

  it('rejects the 6th attempt for the same email within the window, regardless of IP', async () => {
    const email = `rl-email-test-${Math.random()}@example.com`;
    for (let i = 0; i < 5; i++) {
      await expect(loginMember(email, 'wrong', `1.2.3.${i}`)).rejects.toThrow();
    }
    await expect(loginMember(email, 'wrong', '9.9.9.9')).rejects.toThrow(/too many attempts/i);
  });

  it('rejects the 21st attempt from the same IP within the window, across different emails', async () => {
    const ip = `10.0.0.${Math.floor(Math.random() * 1000)}`;
    for (let i = 0; i < 20; i++) {
      await expect(loginMember(`rl-ip-test-${i}@example.com`, 'wrong', ip)).rejects.toThrow();
    }
    await expect(loginMember('rl-ip-test-final@example.com', 'wrong', ip)).rejects.toThrow(
      /too many attempts/i,
    );
  });

  it('does not rate-limit a different IP making its own first attempt', async () => {
    await expect(
      loginMember('rl-unrelated@example.com', 'wrong', `203.0.113.${Math.floor(Math.random() * 1000)}`),
    ).rejects.toThrow(/member not found/i);
  });

  it('does not collapse everyone into one shared bucket when ip is undefined', async () => {
    // req.ip can legitimately be undefined (e.g. aborted/destroyed connections). If the
    // IP-keyed limiter were not skipped in that case, the key would interpolate to the
    // literal string "loginMember-ip:undefined" and 20+ such calls would rate-limit every
    // member across every group system-wide. Use a fresh email each call so the per-email
    // limiter (max 5) never trips, and confirm none of the 25 calls throw a rate-limit
    // error — they should all fail with the underlying "Member not found" instead.
    for (let i = 0; i < 25; i++) {
      await expect(
        loginMember(`rl-undefined-ip-test-${i}-${Math.random()}@example.com`, 'wrong', undefined),
      ).rejects.toThrow(/member not found/i);
    }
  });
});

describe('deleteMember', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    validateMembersExist.mockResolvedValue(undefined);
    countMemberAssignments.mockResolvedValue({ taskCount: 0, recurringTaskCount: 0 });
    reassignMemberAssignments.mockResolvedValue({ tasksTransferred: 0, recurringTasksTransferred: 0 });
    pool.query.mockResolvedValue({
      rows: [{ uuid: 'm1', username: 'old', email: 'old@x.com', group_id: 'g1', created_at: new Date() }],
    });
  });

  it('deletes normally when the member has no assignments', async () => {
    const result = await deleteMember('m1', 'g1');
    expect(result.uuid).toBe('m1');
    expect(reassignMemberAssignments).not.toHaveBeenCalled();
  });

  it('blocks the delete with MEMBER_HAS_ASSIGNMENTS when the member has assignments and no reassignTo', async () => {
    countMemberAssignments.mockResolvedValue({ taskCount: 3, recurringTaskCount: 1 });

    await expect(deleteMember('m1', 'g1')).rejects.toMatchObject({
      extensions: { code: 'MEMBER_HAS_ASSIGNMENTS', taskCount: 3, recurringTaskCount: 1 },
    });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('reassigns then deletes when a valid reassignTo is given', async () => {
    reassignMemberAssignments.mockResolvedValue({ tasksTransferred: 3, recurringTasksTransferred: 1 });

    const result = await deleteMember('m1', 'g1', 'm2');

    expect(validateMembersExist).toHaveBeenCalledWith(['m2'], 'g1');
    expect(reassignMemberAssignments).toHaveBeenCalledWith('m1', 'm2', 'g1');
    expect(countMemberAssignments).not.toHaveBeenCalled();
    expect(result.uuid).toBe('m1');
  });

  it('rejects reassigning to the member being deleted', async () => {
    await expect(deleteMember('m1', 'g1', 'm1')).rejects.toThrow(
      'Cannot reassign to the member being deleted',
    );
    expect(reassignMemberAssignments).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('rejects a reassignTo that does not exist or belongs to another group', async () => {
    validateMembersExist.mockRejectedValue(new Error('Member(s) not found: m2'));

    await expect(deleteMember('m1', 'g1', 'm2')).rejects.toThrow('Member(s) not found: m2');
    expect(reassignMemberAssignments).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });
});
