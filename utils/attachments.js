export const ALLOWED_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

export const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100MB

export function validateContentType(contentType) {
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new Error(`Content type "${contentType}" is not allowed for task attachments.`);
  }
}

export function validateFileSize(sizeBytes) {
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
    throw new Error('File size must be a positive integer number of bytes.');
  }
  if (sizeBytes > MAX_FILE_SIZE_BYTES) {
    throw new Error(`File is too large (${sizeBytes} bytes, max ${MAX_FILE_SIZE_BYTES}).`);
  }
}

// storageGbLimit is the plan's storageGb (e.g. 10, 50, 200) — converted here rather
// than at every call site so the GB-to-bytes conversion lives in exactly one place.
export function checkStorageQuota(bytesUsed, incomingSizeBytes, storageGbLimit) {
  const limitBytes = storageGbLimit * 1024 ** 3;
  if (bytesUsed + incomingSizeBytes > limitBytes) {
    throw new Error(
      `This upload would exceed your plan's storage quota (${storageGbLimit}GB). Remove some files or upgrade your plan.`,
    );
  }
}

// Enforces the R2 key namespace requestTaskUploadUrl builds (`${groupId}/${taskId}/...`).
// confirmTaskAttachment must call this before trusting a client-supplied key for anything —
// without it, a caller could point a task's attachment at an arbitrary object, including
// one belonging to a different group's task.
export function validateAttachmentKey(key, groupId, taskId) {
  const prefix = `${groupId}/${taskId}/`;
  if (typeof key !== 'string' || !key.startsWith(prefix)) {
    throw new Error('Invalid upload key for this task.');
  }
}

// A task holds at most this many attachments. Enforced in requestTaskUploadUrls
// (before any bytes move) and again, authoritatively, inside the
// confirmTaskAttachment transaction so parallel confirms can't overshoot it.
export const MAX_ATTACHMENTS_PER_TASK = 5;

// Id given to the pre-multi-attachment `task.attachment` field when it's read
// through normalizeAttachments below. Tasks written before multi-file support
// still have their one file there until it's migrated into `attachments`.
export const LEGACY_ATTACHMENT_ID = 'legacy';

export function checkAttachmentCount(existingCount, incomingCount) {
  if (existingCount + incomingCount > MAX_ATTACHMENTS_PER_TASK) {
    const remaining = Math.max(0, MAX_ATTACHMENTS_PER_TASK - existingCount);
    throw new Error(
      remaining === 0
        ? `This task already has the maximum of ${MAX_ATTACHMENTS_PER_TASK} attachments. Remove one first.`
        : `A task can have up to ${MAX_ATTACHMENTS_PER_TASK} attachments — you can add ${remaining} more.`,
    );
  }
}

// Firebase push-style ids only — attachmentId ends up in an RTDB path, so it
// must never be able to contain '/', '.', '#', '$', '[' or ']'.
export function validateAttachmentId(attachmentId) {
  if (typeof attachmentId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(attachmentId)) {
    throw new Error('Invalid attachment id.');
  }
}

// Returns every attachment on a task as an array (oldest first), each with its
// `id`. Reads the `attachments` map plus the legacy single `attachment` field.
export function normalizeAttachments(task) {
  const list = [];
  const map = task?.attachments;
  if (map && typeof map === 'object') {
    for (const [id, value] of Object.entries(map)) {
      if (value && typeof value === 'object' && value.key) list.push({ ...value, id });
    }
  }
  const legacy = task?.attachment;
  if (legacy && typeof legacy === 'object' && legacy.key && !list.some((a) => a.key === legacy.key)) {
    list.push({ ...legacy, id: LEGACY_ATTACHMENT_ID });
  }
  return list.sort((a, b) => String(a.uploadedAt ?? '').localeCompare(String(b.uploadedAt ?? '')));
}
