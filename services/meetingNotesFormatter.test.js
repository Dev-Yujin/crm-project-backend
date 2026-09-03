import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/anthropic.js', () => ({
  anthropic: {
    messages: {
      stream: vi.fn(),
    },
  },
}));

const { anthropic } = await import('../config/anthropic.js');
const { formatMeetingTranscript } = await import('./meetingNotesFormatter.js');

function mockStream(responseObject) {
  return {
    finalMessage: async () => ({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(responseObject) }],
    }),
  };
}

describe('formatMeetingTranscript', () => {
  beforeEach(() => {
    anthropic.messages.stream.mockClear();
  });

  it('parses title, summary, and cleanedTranscript from the model response', async () => {
    anthropic.messages.stream.mockReturnValueOnce(
      mockStream({
        title: 'Weekly sync',
        summary: '<p>Team discussed launch timing.</p>',
        cleanedTranscript: '<h2>Launch timing</h2><ul><li>Discussed dates.</li></ul>',
      }),
    );

    const result = await formatMeetingTranscript('some raw transcript text');

    expect(result.title).toBe('Weekly sync');
    expect(result.summary).toContain('launch timing');
    expect(result.cleanedTranscript).toContain('<h2>Launch timing</h2>');
    const [callArgs] = anthropic.messages.stream.mock.calls[0];
    expect(callArgs.model).toBe('claude-haiku-4-5-20251001');
  });

  it('strips disallowed HTML tags from the output', async () => {
    anthropic.messages.stream.mockReturnValueOnce(
      mockStream({
        title: 'Test',
        summary: '<p>ok</p><script>alert(1)</script>',
        cleanedTranscript: '<div class="x"><h2>ok</h2></div>',
      }),
    );

    const result = await formatMeetingTranscript('transcript');

    expect(result.summary).not.toContain('<script>');
    expect(result.cleanedTranscript).not.toContain('<div');
    expect(result.cleanedTranscript).toContain('<h2>ok</h2>');
  });

  it('throws when the model refuses', async () => {
    anthropic.messages.stream.mockReturnValueOnce({
      finalMessage: async () => ({ stop_reason: 'refusal', content: [] }),
    });

    await expect(formatMeetingTranscript('transcript')).rejects.toThrow();
  });

  it('throws when the response is not valid JSON', async () => {
    anthropic.messages.stream.mockReturnValueOnce({
      finalMessage: async () => ({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'not json' }],
      }),
    });

    await expect(formatMeetingTranscript('transcript')).rejects.toThrow();
  });

  it('throws without retrying when the response is valid JSON but not an object', async () => {
    anthropic.messages.stream.mockReturnValueOnce({
      finalMessage: async () => ({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify(null) }],
      }),
    });

    await expect(formatMeetingTranscript('transcript')).rejects.toThrow(/malformed/i);
    expect(anthropic.messages.stream).toHaveBeenCalledTimes(1);
  });

  it('throws without retrying when the response is valid JSON but an array', async () => {
    anthropic.messages.stream.mockReturnValueOnce({
      finalMessage: async () => ({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify(['a', 'b']) }],
      }),
    });

    await expect(formatMeetingTranscript('transcript')).rejects.toThrow(/malformed/i);
    expect(anthropic.messages.stream).toHaveBeenCalledTimes(1);
  });
});
