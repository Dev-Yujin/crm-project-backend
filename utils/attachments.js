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
