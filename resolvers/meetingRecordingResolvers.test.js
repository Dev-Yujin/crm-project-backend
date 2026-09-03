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
  getOrCreateSession: vi.fn(async (sessionId, groupId, createdBy) => ({ sessionId, groupId, createdBy, status: 'recording', created: true })),
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
const { checkRateLimit, _resetRateLimitStateForTests } = await import('../utils/rateLimit.js');
const { getOrCreateBilling } = await import('../models/billing.js');
const { getOrCreateAiNotesUsage, addSecondsUsed } = await import('../models/aiNotesUsage.js');
const { getOrCreateSession, insertSegment, getSessionWithSegments, markSessionStatus } = await import('../models/meetingRecording.js');
const { transcribeSegment } = await import('../services/fishTranscription.js');
const { formatMeetingTranscript } = await import('../services/meetingNotesFormatter.js');
const meetingRecordingResolvers = (await import('./meetingRecordingResolvers.js')).default;

const context = { user: { id: 'u1' }, groupId: 'g1', member: null };
const originalFetch = global.fetch;

describe('requestMeetingRecordingUploadUrl', () => {
  beforeEach(() => {
    // vi.resetAllMocks() (rather than vi.clearAllMocks()) so that a `mockResolvedValueOnce`
    // queued by one test but never consumed (e.g. because that test's code path skips the
    // call it was meant to stub — see the "does not check quota for a continuing session"
    // test below) can't leak into a later test's first call to the same mock. resetAllMocks
    // drains any such leftover queued value and restores each mock's original vi.fn(...)
    // factory implementation from the vi.mock() blocks above, so behavior is unchanged for
    // every test that doesn't itself call mockResolvedValueOnce/mockReturnValueOnce.
    vi.resetAllMocks();
    // The rate limiter added in this task holds real, non-mocked, process-lifetime
    // state keyed by groupId. Several tests below reuse the same shared `context`
    // (groupId 'g1'); without a reset, calls made by earlier tests in this block
    // would count against later ones (and vice versa), making pass/fail depend on
    // run order. This has no effect on the two new rate-limit tests below, which
    // each use their own fresh, randomized groupId anyway.
    _resetRateLimitStateForTests();
  });

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

  it('does not check quota for a continuing session (created: false), regardless of segmentIndex', async () => {
    getOrCreateSession.mockResolvedValueOnce({ sessionId: 's1', groupId: 'g1', createdBy: 'admin:u1', status: 'recording', created: false });
    getOrCreateAiNotesUsage.mockResolvedValueOnce({ secondsUsed: 100 * 3600, periodStart: new Date(), periodEnd: new Date() });

    await expect(
      meetingRecordingResolvers.Mutation.requestMeetingRecordingUploadUrl(
        null,
        { sessionId: 's1', segmentIndex: 1, contentType: 'audio/webm', sizeBytes: 1024 },
        context,
      ),
    ).resolves.toBeDefined();
  });

  it('checks quota even when a client requests upload URLs starting at a non-zero segmentIndex, as long as the session was actually just created', async () => {
    // Regression test for the segmentIndex-spoofing bypass: quota gating must be driven
    // by getOrCreateSession's real `created` flag, not by the client-controlled segmentIndex.
    getOrCreateSession.mockResolvedValueOnce({ sessionId: 's9', groupId: 'g1', createdBy: 'admin:u1', status: 'recording', created: true });
    getOrCreateAiNotesUsage.mockResolvedValueOnce({ secondsUsed: 5 * 3600, periodStart: new Date(), periodEnd: new Date() });

    await expect(
      meetingRecordingResolvers.Mutation.requestMeetingRecordingUploadUrl(
        null,
        { sessionId: 's9', segmentIndex: 1, contentType: 'audio/webm', sizeBytes: 1024 },
        context,
      ),
    ).rejects.toThrow(/quota|hrs/i);
  });

  it('rejects when the resolved session belongs to a different group (cross-tenant reference)', async () => {
    getOrCreateSession.mockResolvedValueOnce({ sessionId: 's1', groupId: 'other-group', createdBy: 'admin:other', status: 'recording', created: false });

    await expect(
      meetingRecordingResolvers.Mutation.requestMeetingRecordingUploadUrl(
        null,
        { sessionId: 's1', segmentIndex: 1, contentType: 'audio/webm', sizeBytes: 1024 },
        context,
      ),
    ).rejects.toThrow(/invalid recording session/i);
  });

  it('rejects a trialing group even for a continuing session (created: false)', async () => {
    getOrCreateBilling.mockResolvedValueOnce({ status: 'trialing', limits: { aiNotesHoursPerMonth: 0 } });

    await expect(
      meetingRecordingResolvers.Mutation.requestMeetingRecordingUploadUrl(
        null,
        { sessionId: 's1', segmentIndex: 1, contentType: 'audio/webm', sizeBytes: 1024 },
        context,
      ),
    ).rejects.toThrow(/paid plan/i);
  });

  it('rejects a trialing group before ever fetching quota usage', async () => {
    getOrCreateBilling.mockResolvedValueOnce({ status: 'trialing', limits: { aiNotesHoursPerMonth: 0 } });

    await expect(
      meetingRecordingResolvers.Mutation.requestMeetingRecordingUploadUrl(
        null,
        { sessionId: 's1', segmentIndex: 0, contentType: 'audio/webm', sizeBytes: 1024 },
        context,
      ),
    ).rejects.toThrow(/paid plan/i);
    expect(getOrCreateAiNotesUsage).not.toHaveBeenCalled();
  });

  it('rejects the 11th upload-URL request for one group within a minute', async () => {
    const groupId = `rl-upload-test-${Math.random()}`;
    const localContext = { user: { id: 'u1' }, groupId, member: null };
    for (let i = 0; i < 10; i++) {
      await meetingRecordingResolvers.Mutation.requestMeetingRecordingUploadUrl(
        null,
        { sessionId: `s-${i}`, segmentIndex: 0, contentType: 'audio/webm', sizeBytes: 1024 },
        localContext,
      );
    }
    await expect(
      meetingRecordingResolvers.Mutation.requestMeetingRecordingUploadUrl(
        null,
        { sessionId: 's-11', segmentIndex: 0, contentType: 'audio/webm', sizeBytes: 1024 },
        localContext,
      ),
    ).rejects.toThrow(/too many recording requests/i);
  });

  it('does not rate-limit a different group', async () => {
    const groupId = `rl-upload-other-${Math.random()}`;
    const localContext = { user: { id: 'u1' }, groupId, member: null };
    await expect(
      meetingRecordingResolvers.Mutation.requestMeetingRecordingUploadUrl(
        null,
        { sessionId: 's-solo', segmentIndex: 0, contentType: 'audio/webm', sizeBytes: 1024 },
        localContext,
      ),
    ).resolves.toBeDefined();
  });
});

describe('confirmMeetingRecordingSegment', () => {
  beforeEach(() => {
    // vi.resetAllMocks() (rather than vi.clearAllMocks()), matching the
    // requestMeetingRecordingUploadUrl and finishMeetingRecording blocks above: it drains
    // any leftover queued mockResolvedValueOnce/mockReturnValueOnce value and restores each
    // mock's original vi.fn(...) factory implementation from the vi.mock() blocks above, so
    // a persistent override left by an earlier test (e.g. on getSessionWithSegments) can't
    // leak into a later test's first call to the same mock, regardless of run order.
    vi.resetAllMocks();
  });

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

  it('rejects a negative or bogus durationSeconds', async () => {
    await expect(
      meetingRecordingResolvers.Mutation.confirmMeetingRecordingSegment(
        null,
        { sessionId: 's1', segmentIndex: 0, key: 'meeting-recordings/g1/s1/segment-0.webm', sizeBytes: 1024, durationSeconds: -900 },
        context,
      ),
    ).rejects.toThrow();
    expect(insertSegment).not.toHaveBeenCalled();
  });

  it('rejects when the session being confirmed against belongs to a different group (cross-tenant write)', async () => {
    getOrCreateSession.mockResolvedValueOnce({ sessionId: 's1', groupId: 'other-group', createdBy: 'admin:other', status: 'recording', created: false });

    await expect(
      meetingRecordingResolvers.Mutation.confirmMeetingRecordingSegment(
        null,
        { sessionId: 's1', segmentIndex: 0, key: 'meeting-recordings/g1/s1/segment-0.webm', sizeBytes: 1024, durationSeconds: 900 },
        context,
      ),
    ).rejects.toThrow(/invalid recording session/i);
    expect(insertSegment).not.toHaveBeenCalled();
  });
});

describe('finishMeetingRecording', () => {
  beforeEach(() => {
    // vi.resetAllMocks() (rather than vi.clearAllMocks()) so that a `mockResolvedValue`
    // set by one test (e.g. the "rejects the 6th finish request for one group within a
    // minute" test below) can't leak into a later test's calls to the same mock.
    // resetAllMocks drains any such leftover queued/persistent value and restores each
    // mock's original vi.fn(...) factory implementation from the vi.mock() blocks above,
    // so behavior is unchanged for every test that doesn't itself override a mock.
    vi.resetAllMocks();
    // finishMeetingRecording fetches each segment's bytes from its R2 download URL —
    // mock that HTTP call so tests never make a real network request.
    global.fetch = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    }));
    // See the matching comment in the requestMeetingRecordingUploadUrl block above:
    // this block also reuses the shared `context` (groupId 'g1') across many tests,
    // so the real rate limiter's state must be reset between tests to keep them
    // order-independent.
    _resetRateLimitStateForTests();
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

  it('marks the session failed when formatMeetingTranscript throws', async () => {
    getSessionWithSegments.mockResolvedValueOnce({
      session: { sessionId: 's1', groupId: 'g1', status: 'recording' },
      segments: [{ segmentIndex: 0, r2Key: 'k0', sizeBytes: 100, durationSeconds: 900 }],
    });
    formatMeetingTranscript.mockRejectedValueOnce(new Error('Anthropic API error: retries exhausted'));

    await expect(
      meetingRecordingResolvers.Mutation.finishMeetingRecording(null, { sessionId: 's1' }, context),
    ).rejects.toThrow(/could not organize/i);
    expect(markSessionStatus).toHaveBeenCalledWith('s1', 'processing', null);
    expect(markSessionStatus).toHaveBeenCalledWith('s1', 'failed', null);
    expect(markSessionStatus).not.toHaveBeenCalledWith('s1', 'completed', expect.anything());
  });

  it('meters usage off the server-observed duration from transcribeSegment, not the client-declared segment.durationSeconds', async () => {
    // The stored segment claims a wildly different duration than Fish's own ASR
    // response — metering must follow the server-observed value, making a lying
    // client's declared duration unreachable as a metering input.
    getSessionWithSegments.mockResolvedValueOnce({
      session: { sessionId: 's1', groupId: 'g1', status: 'recording' },
      segments: [{ segmentIndex: 0, r2Key: 'k0', sizeBytes: 100, durationSeconds: 999999 }],
    });
    transcribeSegment.mockResolvedValueOnce({ text: 'hello world', durationSeconds: 42 });

    const result = await meetingRecordingResolvers.Mutation.finishMeetingRecording(
      null,
      { sessionId: 's1' },
      context,
    );

    expect(result.durationSeconds).toBe(42);
    expect(addSecondsUsed).toHaveBeenCalledWith('g1', 42);
    expect(markSessionStatus).toHaveBeenCalledWith('s1', 'completed', 42);
  });

  it('filters empty/whitespace-only transcript segments before formatting', async () => {
    getSessionWithSegments.mockResolvedValueOnce({
      session: { sessionId: 's1', groupId: 'g1', status: 'recording' },
      segments: [
        { segmentIndex: 0, r2Key: 'k0', sizeBytes: 100, durationSeconds: 900 },
        { segmentIndex: 1, r2Key: 'k1', sizeBytes: 100, durationSeconds: 900 },
      ],
    });
    transcribeSegment
      .mockResolvedValueOnce({ text: '   ', durationSeconds: 900 })
      .mockResolvedValueOnce({ text: 'real content', durationSeconds: 900 });

    const result = await meetingRecordingResolvers.Mutation.finishMeetingRecording(
      null,
      { sessionId: 's1' },
      context,
    );

    expect(result.warnings).toEqual([]);
    expect(formatMeetingTranscript).toHaveBeenCalledWith('real content');
  });

  it('treats an all-silent recording (every segment empty) the same as total transcription failure', async () => {
    getSessionWithSegments.mockResolvedValueOnce({
      session: { sessionId: 's1', groupId: 'g1', status: 'recording' },
      segments: [{ segmentIndex: 0, r2Key: 'k0', sizeBytes: 100, durationSeconds: 900 }],
    });
    transcribeSegment.mockResolvedValueOnce({ text: '', durationSeconds: 900 });

    await expect(
      meetingRecordingResolvers.Mutation.finishMeetingRecording(null, { sessionId: 's1' }, context),
    ).rejects.toThrow(/transcribed/i);
    expect(markSessionStatus).toHaveBeenCalledWith('s1', 'failed', null);
    expect(formatMeetingTranscript).not.toHaveBeenCalled();
  });

  it('marks the session failed (not completed) when addSecondsUsed throws, so it stays retryable and is not silently completed unbilled', async () => {
    getSessionWithSegments.mockResolvedValueOnce({
      session: { sessionId: 's1', groupId: 'g1', status: 'recording' },
      segments: [{ segmentIndex: 0, r2Key: 'k0', sizeBytes: 100, durationSeconds: 900 }],
    });
    addSecondsUsed.mockRejectedValueOnce(new Error('db unavailable'));

    await expect(
      meetingRecordingResolvers.Mutation.finishMeetingRecording(null, { sessionId: 's1' }, context),
    ).rejects.toThrow();
    expect(markSessionStatus).toHaveBeenCalledWith('s1', 'failed', null);
    expect(markSessionStatus).not.toHaveBeenCalledWith('s1', 'completed', expect.anything());
  });

  it('marks the session failed when markSessionStatus("completed", ...) itself throws', async () => {
    getSessionWithSegments.mockResolvedValueOnce({
      session: { sessionId: 's1', groupId: 'g1', status: 'recording' },
      segments: [{ segmentIndex: 0, r2Key: 'k0', sizeBytes: 100, durationSeconds: 900 }],
    });
    markSessionStatus
      .mockResolvedValueOnce(undefined) // 'processing'
      .mockRejectedValueOnce(new Error('db unavailable')) // 'completed' throws
      .mockResolvedValueOnce(undefined); // 'failed', from the catch

    await expect(
      meetingRecordingResolvers.Mutation.finishMeetingRecording(null, { sessionId: 's1' }, context),
    ).rejects.toThrow();
    expect(markSessionStatus).toHaveBeenCalledWith('s1', 'failed', null);
  });

  it('rejects a trialing group before touching the session', async () => {
    getOrCreateBilling.mockResolvedValueOnce({ status: 'trialing', limits: { aiNotesHoursPerMonth: 0 } });

    await expect(
      meetingRecordingResolvers.Mutation.finishMeetingRecording(null, { sessionId: 's1' }, context),
    ).rejects.toThrow(/paid plan/i);
    expect(getSessionWithSegments).not.toHaveBeenCalled();
  });

  it('rejects the 6th finish request for one group within a minute', async () => {
    const groupId = `rl-finish-test-${Math.random()}`;
    const localContext = { user: { id: 'u1' }, groupId, member: null };
    getSessionWithSegments.mockResolvedValue({
      session: { sessionId: 's1', groupId, status: 'recording' },
      segments: [],
    });
    for (let i = 0; i < 5; i++) {
      // transcriptParts stays empty (no segments), so each call fails with
      // TRANSCRIPTION_FAILED after the rate-limit check passes — that's fine,
      // the rate limiter runs before any of that logic.
      await expect(
        meetingRecordingResolvers.Mutation.finishMeetingRecording(null, { sessionId: 's1' }, localContext),
      ).rejects.toThrow();
    }
    await expect(
      meetingRecordingResolvers.Mutation.finishMeetingRecording(null, { sessionId: 's1' }, localContext),
    ).rejects.toThrow(/too many recording requests/i);
  });
});
