import { describe, it, expect } from 'vitest';
import { shouldBypassLock } from './billingLockPlugin.js';

describe('shouldBypassLock', () => {
  it('bypasses a single allowlisted mutation', () => {
    expect(shouldBypassLock(['loginUser'])).toBe(true);
  });

  it('bypasses a request naming only allowlisted mutations', () => {
    expect(shouldBypassLock(['createCheckoutSession'])).toBe(true);
  });

  it('does not bypass a non-allowlisted mutation', () => {
    expect(shouldBypassLock(['addTask'])).toBe(false);
  });

  it('does not bypass a mix of allowed and non-allowed mutations', () => {
    expect(shouldBypassLock(['loginUser', 'addTask'])).toBe(false);
  });

  it('treats an empty selection as bypassed (nothing to block)', () => {
    expect(shouldBypassLock([])).toBe(true);
  });
});
