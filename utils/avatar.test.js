import { describe, it, expect } from 'vitest';
import { validateAvatarBase64 } from './avatar.js';

describe('validateAvatarBase64', () => {
  it('accepts a normal-sized data URL', () => {
    expect(() => validateAvatarBase64('data:image/jpeg;base64,' + 'a'.repeat(1000))).not.toThrow();
  });

  it('accepts null (explicit "remove the photo")', () => {
    expect(() => validateAvatarBase64(null)).not.toThrow();
  });

  it('accepts undefined ("field not provided")', () => {
    expect(() => validateAvatarBase64(undefined)).not.toThrow();
  });

  it('rejects a string over the size cap', () => {
    expect(() => validateAvatarBase64('a'.repeat(300_001))).toThrow(/too large/);
  });

  it('accepts a string exactly at the size cap', () => {
    expect(() => validateAvatarBase64('a'.repeat(300_000))).not.toThrow();
  });

  it('rejects a non-string value', () => {
    expect(() => validateAvatarBase64(12345)).toThrow(/must be a string/);
  });
});
