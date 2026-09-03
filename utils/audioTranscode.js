import { PassThrough } from 'stream';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from '@ffmpeg-installer/ffmpeg';

ffmpeg.setFfmpegPath(ffmpegPath.path);

// Converts a WebM/Opus buffer (what MediaRecorder produces client-side) into 16kHz
// mono WAV — the shape Fish Audio's ASR actually accepts (it rejects WebM outright).
// Matches the target sample rate the old client-side audioEncoding.ts used, for the
// same reason: 16kHz is the standard input for speech recognition, and anything higher
// is bytes the recognizer discards.
export function webmToWav(webmBuffer) {
  return new Promise((resolve, reject) => {
    const input = new PassThrough();
    input.end(webmBuffer);

    const chunks = [];
    const output = new PassThrough();
    output.on('data', (chunk) => chunks.push(chunk));

    ffmpeg(input)
      .inputFormat('webm')
      .audioChannels(1)
      .audioFrequency(16000)
      .format('wav')
      .on('error', (err) => reject(new Error(`Audio transcoding failed: ${err.message}`)))
      .on('end', () => resolve(Buffer.concat(chunks)))
      .pipe(output);
  });
}
