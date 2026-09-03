import { webmToWav } from '../utils/audioTranscode.js';

if (!process.env.FISH_API_KEY) {
  throw new Error('Missing FISH_API_KEY environment variable');
}

async function callFishAsr(wavBuffer, segmentIndex) {
  const form = new FormData();
  form.append('audio', new Blob([wavBuffer], { type: 'audio/wav' }), `segment-${segmentIndex}.wav`);
  form.append('language', 'en');
  form.append('ignore_timestamps', 'true');

  const response = await fetch('https://api.fish.audio/v1/asr', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.FISH_API_KEY}` },
    body: form,
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('Fish Audio rejected the API key — check FISH_API_KEY.');
    }
    let detail = '';
    try {
      const body = await response.json();
      if (body.message) detail = ` ${body.message}`;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`Transcription failed (${response.status}).${detail}`);
  }

  const result = await response.json();
  return { text: result.text ?? '', durationSeconds: result.duration ?? 0 };
}

// Converts the segment to WAV, then transcribes it via Fish Audio, retrying transient
// failures (a dropped segment costs real meeting content, worth a few attempts) but not
// a rejected key, which won't fix itself on retry.
export async function transcribeSegment(webmBuffer, segmentIndex, attempts = 3) {
  const wav = await webmToWav(webmBuffer);

  let lastError = new Error('Transcription failed.');
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await callFishAsr(wav, segmentIndex);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error('Transcription failed.');
      if (/rejected the API key/i.test(lastError.message)) break;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
      }
    }
  }
  throw lastError;
}
