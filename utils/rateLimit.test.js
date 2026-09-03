import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkRateLimit } from './rateLimit.js';

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
});
