const ALLOWED_SEGMENT_CONTENT_TYPES = new Set(['audio/webm', 'audio/webm;codecs=opus']);

// Generous relative to a real 15-minute segment (~10-15MB at the recorder's 32kbps
// bitrate) — this is a sanity ceiling against a misbehaving client, not a tight limit.
const MAX_SEGMENT_SIZE_BYTES = 100 * 1024 * 1024;

export function validateSegmentContentType(contentType) {
  if (!ALLOWED_SEGMENT_CONTENT_TYPES.has(contentType)) {
    throw new Error(`Content type "${contentType}" is not allowed for meeting recordings.`);
  }
}

export function validateSegmentSize(sizeBytes) {
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
    throw new Error('Segment size must be a positive integer number of bytes.');
  }
  if (sizeBytes > MAX_SEGMENT_SIZE_BYTES) {
    throw new Error(`Segment is too large (${sizeBytes} bytes, max ${MAX_SEGMENT_SIZE_BYTES}).`);
  }
}

// Enforces the R2 key namespace requestMeetingRecordingUploadUrl builds
// (`meeting-recordings/${groupId}/${sessionId}/...`) — same cross-tenant-spoofing
// protection as validateAttachmentKey in utils/attachments.js.
export function validateRecordingKey(key, groupId, sessionId) {
  const prefix = `meeting-recordings/${groupId}/${sessionId}/`;
  if (typeof key !== 'string' || !key.startsWith(prefix)) {
    throw new Error('Invalid upload key for this recording session.');
  }
}

// Only gates starting a *new* session (isNewSession === true) — a recording already
// under way is never cut off mid-way even if its own duration pushes the group over.
export function checkAiNotesQuota(secondsUsed, isNewSession, aiNotesHoursPerMonth) {
  if (!isNewSession) return;
  const limitSeconds = aiNotesHoursPerMonth * 3600;
  if (secondsUsed >= limitSeconds) {
    throw new Error(
      `This workspace has used its ${aiNotesHoursPerMonth} hrs/month of AI meeting notes. Upgrade your plan to record more.`,
    );
  }
}
