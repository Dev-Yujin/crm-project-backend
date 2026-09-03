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

const { pool } = await import('../config/supabase.js');
const { comparePasswords } = await import('../utils/authUser.js');
const { loginMember } = await import('./membersFunction.js');

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
});
