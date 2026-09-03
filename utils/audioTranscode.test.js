import { describe, it, expect, beforeAll } from 'vitest';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from '@ffmpeg-installer/ffmpeg';
import { webmToWav } from './audioTranscode.js';

ffmpeg.setFfmpegPath(ffmpegPath.path);

function generateSilentWebm() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    ffmpeg()
      .input('anullsrc=r=48000:cl=mono')
      .inputFormat('lavfi')
      .duration(1)
      .audioCodec('libopus')
      .format('webm')
      .on('error', reject)
      .on('end', () => resolve(Buffer.concat(chunks)))
      .pipe()
      .on('data', (chunk) => chunks.push(chunk));
  });
}

describe('webmToWav', () => {
  let webmBuffer;

  beforeAll(async () => {
    webmBuffer = await generateSilentWebm();
  }, 15000);

  it('produces a valid 16kHz mono WAV buffer', async () => {
    const wav = await webmToWav(webmBuffer);

    // RIFF/WAVE header check.
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');

    // fmt chunk: PCM, mono, 16kHz.
    const numChannels = wav.readUInt16LE(22);
    const sampleRate = wav.readUInt32LE(24);
    expect(numChannels).toBe(1);
    expect(sampleRate).toBe(16000);
  }, 15000);

  it('rejects a buffer that is not valid audio', async () => {
    await expect(webmToWav(Buffer.from('not audio'))).rejects.toThrow();
  });
});
