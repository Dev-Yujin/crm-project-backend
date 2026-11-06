import { describe, it, expect } from 'vitest';
import {
  validateContentType,
  validateFileSize,
  checkStorageQuota,
  validateAttachmentKey,
  MAX_FILE_SIZE_BYTES,
  MAX_ATTACHMENTS_PER_TASK,
  LEGACY_ATTACHMENT_ID,
  checkAttachmentCount,
  validateAttachmentId,
  normalizeAttachments,
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

describe('checkAttachmentCount', () => {
  it('allows filling up to the cap', () => {
    expect(() => checkAttachmentCount(0, MAX_ATTACHMENTS_PER_TASK)).not.toThrow();
    expect(() => checkAttachmentCount(3, 2)).not.toThrow();
  });

  it('rejects going over the cap', () => {
    expect(() => checkAttachmentCount(3, 3)).toThrow(/add 2 more/i);
    expect(() => checkAttachmentCount(MAX_ATTACHMENTS_PER_TASK, 1)).toThrow(/maximum/i);
  });
});

describe('validateAttachmentId', () => {
  it('accepts a push-style id', () => {
    expect(() => validateAttachmentId('-NxAbc_123')).not.toThrow();
  });

  it('rejects path characters', () => {
    expect(() => validateAttachmentId('../x')).toThrow();
    expect(() => validateAttachmentId('a/b')).toThrow();
    expect(() => validateAttachmentId('')).toThrow();
  });
});

describe('normalizeAttachments', () => {
  it('returns an empty list for a task with no files', () => {
    expect(normalizeAttachments({})).toEqual([]);
  });

  it('includes the legacy single attachment with the legacy id', () => {
    const result = normalizeAttachments({ attachment: { key: 'k0', uploadedAt: '2026-01-01' } });
    expect(result).toEqual([{ key: 'k0', uploadedAt: '2026-01-01', id: LEGACY_ATTACHMENT_ID }]);
  });

  it('merges the map and legacy field, oldest first, without duplicating a migrated legacy file', () => {
    const result = normalizeAttachments({
      attachment: { key: 'k0', uploadedAt: '2026-01-01' },
      attachments: {
        b: { key: 'k2', uploadedAt: '2026-03-01' },
        a: { key: 'k1', uploadedAt: '2026-02-01' },
        legacy: { key: 'k0', uploadedAt: '2026-01-01' },
      },
    });
    expect(result.map((a) => a.id)).toEqual(['legacy', 'a', 'b']);
  });
});
