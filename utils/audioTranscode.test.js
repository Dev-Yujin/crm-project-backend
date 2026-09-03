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

    // RIFF chunk size must be the real file size, not ffmpeg's streaming
    // placeholder (0xFFFFFFFF) left behind when it can't seek back on a pipe.
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);

    // fmt chunk: PCM, mono, 16kHz.
    const numChannels = wav.readUInt16LE(22);
    const sampleRate = wav.readUInt32LE(24);
    expect(numChannels).toBe(1);
    expect(sampleRate).toBe(16000);

    // `data` sub-chunk's declared size must match the real payload length —
    // this is exactly the field ffmpeg leaves as a placeholder on a pipe.
    // Don't assume a fixed offset: ffmpeg's wav muxer inserts a `LIST` chunk
    // between `fmt ` and `data` (confirmed empirically — `data` lands at
    // offset 70 for this fixture, not the naively-assumed 36), so walk the
    // sub-chunks to find it, the same way the implementation does.
    let offset = 12;
    let dataChunkOffset = -1;
    while (offset + 8 <= wav.length) {
      const chunkId = wav.toString('ascii', offset, offset + 4);
      const chunkSize = wav.readUInt32LE(offset + 4);
      if (chunkId === 'data') {
        dataChunkOffset = offset;
        break;
      }
      offset += 8 + chunkSize + (chunkSize % 2);
    }

    expect(dataChunkOffset).toBeGreaterThan(-1);
    const declaredDataSize = wav.readUInt32LE(dataChunkOffset + 4);
    const actualDataSize = wav.length - (dataChunkOffset + 8);
    expect(declaredDataSize).toBe(actualDataSize);
    expect(declaredDataSize).toBeGreaterThan(0);
  }, 15000);

  it('rejects a buffer that is not valid audio', async () => {
    await expect(webmToWav(Buffer.from('not audio'))).rejects.toThrow();
  });
});
