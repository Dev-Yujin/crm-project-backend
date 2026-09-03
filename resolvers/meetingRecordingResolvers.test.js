import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config/r2.js', () => ({
  createUploadUrl: vi.fn(async () => 'https://r2.example/presigned'),
  createDownloadUrl: vi.fn(async () => 'https://r2.example/download'),
  headR2ObjectSize: vi.fn(async () => 512000),
}));
vi.mock('../models/aiNotesUsage.js', () => ({
  getOrCreateAiNotesUsage: vi.fn(async () => ({ secondsUsed: 0, periodStart: new Date(), periodEnd: new Date(Date.now() + 86400000) })),
  addSecondsUsed: vi.fn(async () => {}),
}));
vi.mock('../models/meetingRecording.js', () => ({
  getOrCreateSession: vi.fn(async (sessionId, groupId, createdBy) => ({ sessionId, groupId, createdBy, status: 'recording' })),
  insertSegment: vi.fn(async () => {}),
  getSessionWithSegments: vi.fn(async () => ({
    session: { sessionId: 's1', groupId: 'g1', status: 'recording' },
    segments: [{ segmentIndex: 0, r2Key: 'meeting-recordings/g1/s1/segment-0.webm', sizeBytes: 100, durationSeconds: 900 }],
  })),
  markSessionStatus: vi.fn(async () => {}),
}));
vi.mock('../services/fishTranscription.js', () => ({
  transcribeSegment: vi.fn(async () => ({ text: 'hello world', durationSeconds: 900 })),
}));
vi.mock('../services/meetingNotesFormatter.js', () => ({
  formatMeetingTranscript: vi.fn(async () => ({
    title: 'Test meeting',
    summary: '<p>Summary</p>',
    cleanedTranscript: '<h2>Topic</h2><p>Content</p>',
  })),
}));
vi.mock('../models/billing.js', () => ({
  getOrCreateBilling: vi.fn(async () => ({ limits: { tier: 'STARTER', aiNotesHoursPerMonth: 5 } })),
}));

const { createUploadUrl } = await import('../config/r2.js');
const { getOrCreateAiNotesUsage, addSecondsUsed } = await import('../models/aiNotesUsage.js');
const { getOrCreateSession, insertSegment, getSessionWithSegments, markSessionStatus } = await import('../models/meetingRecording.js');
const { transcribeSegment } = await import('../services/fishTranscription.js');
const { formatMeetingTranscript } = await import('../services/meetingNotesFormatter.js');
const meetingRecordingResolvers = (await import('./meetingRecordingResolvers.js')).default;

const context = { user: { id: 'u1' }, groupId: 'g1', member: null };
const originalFetch = global.fetch;

describe('requestMeetingRecordingUploadUrl', () => {
  beforeEach(() => vi.clearAllMocks());

  it('issues an upload URL for segment 0 of a new session', async () => {
    const result = await meetingRecordingResolvers.Mutation.requestMeetingRecordingUploadUrl(
      null,
      { sessionId: 's1', segmentIndex: 0, contentType: 'audio/webm', sizeBytes: 1024 },
      context,
    );

    expect(result.key).toContain('meeting-recordings/g1/s1/');
    expect(createUploadUrl).toHaveBeenCalledWith(expect.stringContaining('meeting-recordings/g1/s1/segment-0'), 'audio/webm');
    expect(getOrCreateSession).toHaveBeenCalledWith('s1', 'g1', 'admin:u1');
  });

  it('rejects a new session when the group is already at quota', async () => {
    getOrCreateAiNotesUsage.mockResolvedValueOnce({ secondsUsed: 5 * 3600, periodStart: new Date(), periodEnd: new Date() });

    await expect(
      meetingRecordingResolvers.Mutation.requestMeetingRecordingUploadUrl(
        null,
        { sessionId: 's2', segmentIndex: 0, contentType: 'audio/webm', sizeBytes: 1024 },
        context,
      ),
    ).rejects.toThrow(/quota|hrs/i);
  });

  it('does not check quota for segment 1+ of an existing session', async () => {
    getOrCreateSession.mockResolvedValueOnce({ sessionId: 's1', groupId: 'g1', createdBy: 'admin:u1', status: 'recording' });
    getOrCreateAiNotesUsage.mockResolvedValueOnce({ secondsUsed: 100 * 3600, periodStart: new Date(), periodEnd: new Date() });

    await expect(
      meetingRecordingResolvers.Mutation.requestMeetingRecordingUploadUrl(
        null,
        { sessionId: 's1', segmentIndex: 1, contentType: 'audio/webm', sizeBytes: 1024 },
        context,
      ),
    ).resolves.toBeDefined();
  });
});

describe('confirmMeetingRecordingSegment', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records the segment with the server-verified size', async () => {
    const result = await meetingRecordingResolvers.Mutation.confirmMeetingRecordingSegment(
      null,
      { sessionId: 's1', segmentIndex: 0, key: 'meeting-recordings/g1/s1/segment-0.webm', sizeBytes: 1024, durationSeconds: 900 },
      context,
    );

    expect(result.durationSeconds).toBe(900);
    expect(insertSegment).toHaveBeenCalledWith('s1', 'g1', 0, 'meeting-recordings/g1/s1/segment-0.webm', 512000, 900);
  });

  it('rejects a key outside this group/session prefix', async () => {
    await expect(
      meetingRecordingResolvers.Mutation.confirmMeetingRecordingSegment(
        null,
        { sessionId: 's1', segmentIndex: 0, key: 'meeting-recordings/other-group/s1/segment-0.webm', sizeBytes: 1024, durationSeconds: 900 },
        context,
      ),
    ).rejects.toThrow();
  });
});

describe('finishMeetingRecording', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // finishMeetingRecording fetches each segment's bytes from its R2 download URL —
    // mock that HTTP call so tests never make a real network request.
    global.fetch = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    }));
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('runs the full pipeline and returns the finished note', async () => {
    const result = await meetingRecordingResolvers.Mutation.finishMeetingRecording(
      null,
      { sessionId: 's1' },
      context,
    );

    expect(result.title).toBe('Test meeting');
    expect(result.durationSeconds).toBe(900);
    expect(result.warnings).toEqual([]);
    expect(markSessionStatus).toHaveBeenCalledWith('s1', 'processing', null);
    expect(markSessionStatus).toHaveBeenCalledWith('s1', 'completed', 900);
    expect(addSecondsUsed).toHaveBeenCalledWith('g1', 900);
  });

  it('rejects reprocessing an already-completed session', async () => {
    getSessionWithSegments.mockResolvedValueOnce({
      session: { sessionId: 's1', groupId: 'g1', status: 'completed' },
      segments: [],
    });

    await expect(
      meetingRecordingResolvers.Mutation.finishMeetingRecording(null, { sessionId: 's1' }, context),
    ).rejects.toThrow(/already/i);
  });

  it('warns and continues when one segment fails transcription, of several', async () => {
    getSessionWithSegments.mockResolvedValueOnce({
      session: { sessionId: 's1', groupId: 'g1', status: 'recording' },
      segments: [
        { segmentIndex: 0, r2Key: 'k0', sizeBytes: 100, durationSeconds: 900 },
        { segmentIndex: 1, r2Key: 'k1', sizeBytes: 100, durationSeconds: 900 },
      ],
    });
    transcribeSegment
      .mockResolvedValueOnce({ text: 'segment one', durationSeconds: 900 })
      .mockRejectedValueOnce(new Error('boom'));

    const result = await meetingRecordingResolvers.Mutation.finishMeetingRecording(
      null,
      { sessionId: 's1' },
      context,
    );

    expect(result.warnings.length).toBe(1);
    expect(formatMeetingTranscript).toHaveBeenCalledWith(expect.stringContaining('segment one'));
  });

  it('throws when every segment fails transcription', async () => {
    getSessionWithSegments.mockResolvedValueOnce({
      session: { sessionId: 's1', groupId: 'g1', status: 'recording' },
      segments: [{ segmentIndex: 0, r2Key: 'k0', sizeBytes: 100, durationSeconds: 900 }],
    });
    transcribeSegment.mockRejectedValueOnce(new Error('boom'));

    await expect(
      meetingRecordingResolvers.Mutation.finishMeetingRecording(null, { sessionId: 's1' }, context),
    ).rejects.toThrow();
    expect(markSessionStatus).toHaveBeenCalledWith('s1', 'failed', null);
  });
});
