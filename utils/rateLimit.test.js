import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkRateLimit, _resetRateLimitStateForTests } from './rateLimit.js';

describe('checkRateLimit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows calls under the limit', () => {
    const key = `test-under-${Math.random()}`;
    for (let i = 0; i < 4; i++) {
      expect(() => checkRateLimit(key, { max: 5, windowMs: 1000 })).not.toThrow();
    }
  });

  it('throws with the default message once max is reached', () => {
    const key = `test-default-msg-${Math.random()}`;
    for (let i = 0; i < 5; i++) {
      checkRateLimit(key, { max: 5, windowMs: 1000 });
    }
    expect(() => checkRateLimit(key, { max: 5, windowMs: 1000 })).toThrow(
      'Too many attempts. Please try again later.',
    );
  });

  it('throws with a custom message when provided', () => {
    const key = `test-custom-msg-${Math.random()}`;
    for (let i = 0; i < 2; i++) {
      checkRateLimit(key, { max: 2, windowMs: 1000, message: 'Slow down.' });
    }
    expect(() => checkRateLimit(key, { max: 2, windowMs: 1000, message: 'Slow down.' })).toThrow(
      'Slow down.',
    );
  });

  it('sets extensions.code to RATE_LIMITED', () => {
    const key = `test-code-${Math.random()}`;
    checkRateLimit(key, { max: 1, windowMs: 1000 });
    try {
      checkRateLimit(key, { max: 1, windowMs: 1000 });
      throw new Error('expected checkRateLimit to throw');
    } catch (err) {
      expect(err.extensions.code).toBe('RATE_LIMITED');
    }
  });

  it('resets and allows again after windowMs elapses', () => {
    const key = `test-reset-${Math.random()}`;
    checkRateLimit(key, { max: 1, windowMs: 1000 });
    expect(() => checkRateLimit(key, { max: 1, windowMs: 1000 })).toThrow();

    vi.advanceTimersByTime(1001);

    expect(() => checkRateLimit(key, { max: 1, windowMs: 1000 })).not.toThrow();
  });

  it('does not let two different keys interfere with each other', () => {
    const keyA = `test-key-a-${Math.random()}`;
    const keyB = `test-key-b-${Math.random()}`;
    checkRateLimit(keyA, { max: 1, windowMs: 1000 });
    expect(() => checkRateLimit(keyA, { max: 1, windowMs: 1000 })).toThrow();
    expect(() => checkRateLimit(keyB, { max: 1, windowMs: 1000 })).not.toThrow();
  });

  describe('stale-key sweep', () => {
    // attemptsByKey is module-private (not exported), so we can't directly assert it
    // shrinks. Instead, prove the sweep is behaviorally inert from the caller's
    // perspective: allow-under-limit, block-at-limit, and reset-after-window all still
    // hold correctly even when many sweep-triggering calls (Math.random forced to 0,
    // guaranteeing the ~1% sweep branch runs on every call) are interspersed among them.
    let randomSpy;

    afterEach(() => {
      randomSpy?.mockRestore();
    });

    it('does not change allow/block/reset behavior when the sweep runs on every call', () => {
      randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

      const key = 'test-sweep-behavior-key';

      // Allows calls under the limit even while sweeping every time.
      for (let i = 0; i < 4; i++) {
        expect(() => checkRateLimit(key, { max: 5, windowMs: 1000 })).not.toThrow();
      }
      // Blocks at the limit.
      checkRateLimit(key, { max: 5, windowMs: 1000 });
      expect(() => checkRateLimit(key, { max: 5, windowMs: 1000 })).toThrow();

      // Resets after the window elapses.
      vi.advanceTimersByTime(1001);
      expect(() => checkRateLimit(key, { max: 5, windowMs: 1000 })).not.toThrow();
    });

    it('sweeping does not evict a key whose window has not yet expired, even when triggered by other keys', () => {
      randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

      const targetKey = `test-sweep-survivor-${Math.random()}`;
      checkRateLimit(targetKey, { max: 2, windowMs: 60_000 });

      // Advance partway through the target key's window (still within it), then fire off
      // many other calls — each forces a sweep pass — using a windowMs at least as long as
      // the elapsed time, so the sweep (which evicts using the *triggering* call's
      // windowMs) has no basis to consider the target key stale yet.
      vi.advanceTimersByTime(30_000);
      for (let i = 0; i < 50; i++) {
        checkRateLimit(`test-sweep-other-${i}`, { max: 5, windowMs: 60_000 });
      }

      // The target key's single prior attempt should still count — it must still allow
      // exactly one more call before blocking (max: 2), proving it wasn't evicted early.
      expect(() => checkRateLimit(targetKey, { max: 2, windowMs: 60_000 })).not.toThrow();
      expect(() => checkRateLimit(targetKey, { max: 2, windowMs: 60_000 })).toThrow();
    });
  });
});

describe('_resetRateLimitStateForTests', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('clears state in a non-production environment', () => {
    process.env.NODE_ENV = 'test';
    const key = `test-reset-hook-${Math.random()}`;
    checkRateLimit(key, { max: 1, windowMs: 1000 });
    expect(() => checkRateLimit(key, { max: 1, windowMs: 1000 })).toThrow();

    _resetRateLimitStateForTests();

    expect(() => checkRateLimit(key, { max: 1, windowMs: 1000 })).not.toThrow();
  });

  it('is a loud no-op when NODE_ENV is production', () => {
    process.env.NODE_ENV = 'production';
    const key = `test-reset-hook-prod-${Math.random()}`;
    checkRateLimit(key, { max: 1, windowMs: 1000 });
    expect(() => checkRateLimit(key, { max: 1, windowMs: 1000 })).toThrow();

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    _resetRateLimitStateForTests();
    errorSpy.mockRestore();

    // State must NOT have been cleared — the key is still rate-limited.
    expect(() => checkRateLimit(key, { max: 1, windowMs: 1000 })).toThrow();
  });
});
