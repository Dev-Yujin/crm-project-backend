import { describe, it, expect } from 'vitest';
import {
  validateSegmentContentType,
  validateSegmentSize,
  validateRecordingKey,
  checkAiNotesQuota,
} from './meetingRecordings.js';

describe('validateSegmentContentType', () => {
  it('accepts audio/webm and audio/webm;codecs=opus', () => {
    expect(() => validateSegmentContentType('audio/webm')).not.toThrow();
    expect(() => validateSegmentContentType('audio/webm;codecs=opus')).not.toThrow();
  });

  it('rejects anything else', () => {
    expect(() => validateSegmentContentType('image/png')).toThrow();
    expect(() => validateSegmentContentType('audio/mp4')).toThrow();
  });
});

describe('validateSegmentSize', () => {
  it('accepts a positive size under the ceiling', () => {
    expect(() => validateSegmentSize(1024)).not.toThrow();
  });

  it('rejects zero, negative, non-integer, or oversized', () => {
    expect(() => validateSegmentSize(0)).toThrow();
    expect(() => validateSegmentSize(-5)).toThrow();
    expect(() => validateSegmentSize(1.5)).toThrow();
    expect(() => validateSegmentSize(200 * 1024 * 1024)).toThrow();
  });
});

describe('validateRecordingKey', () => {
  it('accepts a key under the expected group/session prefix', () => {
    expect(() =>
      validateRecordingKey('meeting-recordings/g1/s1/segment-0.webm', 'g1', 's1'),
    ).not.toThrow();
  });

  it('rejects a key outside the prefix, including another group/session', () => {
    expect(() => validateRecordingKey('meeting-recordings/g2/s1/segment-0.webm', 'g1', 's1')).toThrow();
    expect(() => validateRecordingKey('meeting-recordings/g1/s2/segment-0.webm', 'g1', 's1')).toThrow();
    expect(() => validateRecordingKey('g1/s1/segment-0.webm', 'g1', 's1')).toThrow();
  });
});

describe('checkAiNotesQuota', () => {
  it('allows a new session when usage is under the limit', () => {
    expect(() => checkAiNotesQuota(3600, true, 5)).not.toThrow(); // 1hr used of 5hr limit
  });

  it('blocks a new session when usage is at or over the limit', () => {
    expect(() => checkAiNotesQuota(5 * 3600, true, 5)).toThrow();
    expect(() => checkAiNotesQuota(6 * 3600, true, 5)).toThrow();
  });

  it('never blocks a continuing session, even over quota', () => {
    expect(() => checkAiNotesQuota(10 * 3600, false, 5)).not.toThrow();
  });
});
