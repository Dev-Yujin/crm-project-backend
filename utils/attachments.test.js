import { describe, it, expect } from 'vitest';
import {
  validateContentType,
  validateFileSize,
  checkStorageQuota,
  validateAttachmentKey,
  MAX_FILE_SIZE_BYTES,
} from './attachments.js';

describe('validateContentType', () => {
  it('accepts an allowed image type', () => {
    expect(() => validateContentType('image/png')).not.toThrow();
  });

  it('accepts an allowed spreadsheet type', () => {
    expect(() => validateContentType('application/vnd.ms-excel')).not.toThrow();
  });

  it('rejects a disallowed type', () => {
    expect(() => validateContentType('application/x-msdownload')).toThrow(/not allowed/i);
  });
});

describe('validateFileSize', () => {
  it('accepts a size at exactly the cap', () => {
    expect(() => validateFileSize(MAX_FILE_SIZE_BYTES)).not.toThrow();
  });

  it('rejects a size one byte over the cap', () => {
    expect(() => validateFileSize(MAX_FILE_SIZE_BYTES + 1)).toThrow(/too large/i);
  });

  it('rejects a non-positive size', () => {
    expect(() => validateFileSize(0)).toThrow();
    expect(() => validateFileSize(-5)).toThrow();
  });
});

describe('checkStorageQuota', () => {
  const oneGb = 1024 ** 3;

  it('allows an upload that fits within the quota', () => {
    expect(() => checkStorageQuota(5 * oneGb, oneGb, 10)).not.toThrow();
  });

  it('allows an upload that exactly fills the quota', () => {
    expect(() => checkStorageQuota(9 * oneGb, oneGb, 10)).not.toThrow();
  });

  it('rejects an upload that would exceed the quota', () => {
    expect(() => checkStorageQuota(9 * oneGb, 2 * oneGb, 10)).toThrow(/quota/i);
  });
});

describe('validateAttachmentKey', () => {
  it('accepts a key correctly namespaced under the group and task', () => {
    expect(() => validateAttachmentKey('group1/task1/uuid-file.pdf', 'group1', 'task1')).not.toThrow();
  });

  it('rejects a key belonging to a different group', () => {
    expect(() => validateAttachmentKey('otherGroup/task1/uuid-file.pdf', 'group1', 'task1')).toThrow(/invalid/i);
  });

  it('rejects a key belonging to a different task', () => {
    expect(() => validateAttachmentKey('group1/otherTask/uuid-file.pdf', 'group1', 'task1')).toThrow(/invalid/i);
  });
});
