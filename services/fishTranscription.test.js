import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../utils/audioTranscode.js', () => ({
  webmToWav: vi.fn(async () => Buffer.from('fake-wav-bytes')),
}));

const originalFetch = global.fetch;

describe('transcribeSegment', () => {
  beforeEach(() => {
    process.env.FISH_API_KEY = 'test-fish-key';
    global.fetch = vi.fn();
  });

  it('returns text and duration on a successful call', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: 'Hello world', duration: 12.5 }),
    });

    const { transcribeSegment } = await import('./fishTranscription.js');
    const result = await transcribeSegment(Buffer.from('webm-bytes'), 0);

    expect(result).toEqual({ text: 'Hello world', durationSeconds: 12.5 });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.fish.audio/v1/asr',
      expect.objectContaining({ method: 'POST' }),
    );
    const [, options] = global.fetch.mock.calls[0];
    expect(options.headers.Authorization).toBe('Bearer test-fish-key');
  });

  it('retries once on a transient failure then succeeds', async () => {
    global.fetch
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ text: 'ok', duration: 1 }) });

    const { transcribeSegment } = await import('./fishTranscription.js');
    const result = await transcribeSegment(Buffer.from('webm-bytes'), 0);

    expect(result.text).toBe('ok');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry on a 401 (rejected key)', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });

    const { transcribeSegment } = await import('./fishTranscription.js');
    await expect(transcribeSegment(Buffer.from('webm-bytes'), 0)).rejects.toThrow(/rejected/i);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });
});
