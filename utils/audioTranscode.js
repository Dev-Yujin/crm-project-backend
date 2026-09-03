import { PassThrough } from 'stream';
import { finished } from 'node:stream/promises';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from '@ffmpeg-installer/ffmpeg';

ffmpeg.setFfmpegPath(ffmpegPath.path);

function isRiffWave(buffer) {
  return (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WAVE'
  );
}

// ffmpeg can't seek back on a non-seekable output pipe to patch a WAV file's
// chunk-size fields once it knows the true byte count, so it leaves the
// streaming placeholder (0xFFFFFFFF) in the RIFF chunk size and the `data`
// sub-chunk's declared size. The audio payload itself is always complete and
// correctly ordered — only these two header fields are wrong. Patch them in
// place now that the full buffer (and therefore its real length) is known.
// Assumes `buffer` has already been validated as a RIFF/WAVE buffer.
function patchWavHeaderSizes(buffer) {
  // RIFF chunk size = total file size minus the 8 bytes of the 'RIFF' id and
  // this size field itself.
  buffer.writeUInt32LE(buffer.length - 8, 4);

  // Walk the sub-chunks after the 12-byte 'RIFF'/size/'WAVE' preamble to find
  // 'data', rather than assuming a fixed offset — a WAV can carry other
  // sub-chunks (e.g. a LIST/INFO chunk) before it.
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const declaredChunkSize = buffer.readUInt32LE(offset + 4);

    if (chunkId === 'data') {
      const actualDataSize = buffer.length - (offset + 8);
      buffer.writeUInt32LE(actualDataSize, offset + 4);
      break;
    }

    // Chunk bodies are padded to an even number of bytes.
    offset += 8 + declaredChunkSize + (declaredChunkSize % 2);
  }

  return buffer;
}

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

    const fail = (err) => reject(new Error(`Audio transcoding failed: ${err.message}`));

    ffmpeg(input)
      .inputFormat('webm')
      .audioChannels(1)
      .audioFrequency(16000)
      .format('wav')
      .on('error', fail)
      .pipe(output);

    // Resolve when the piped `output` stream itself has finished delivering
    // all its data, not when fluent-ffmpeg's command-level 'end' event fires
    // (that fires on ffmpeg process exit + stderr close, which is not
    // guaranteed to line up with the output stream having flushed every
    // chunk to our 'data' listener — a known fragile pattern for piped output
    // in fluent-ffmpeg, especially for larger files).
    //
    // For invalid input, ffmpeg's stdout pipe can reach a clean end (0 bytes,
    // no error) *before* the command's 'error' event fires — 'error' needs to
    // wait on stderr/process exit, per fluent-ffmpeg's processor.js. So the
    // `finished(output)` resolution and the `fail` rejection genuinely race;
    // whichever settles the promise first wins. Guard against that by never
    // resolving with something that isn't an actual WAV: if the buffer we
    // collected isn't a valid RIFF/WAVE file (empty or garbage), treat that
    // as a failure in its own right rather than trusting stream completion.
    finished(output)
      .then(() => {
        const wav = Buffer.concat(chunks);
        if (!isRiffWave(wav)) {
          fail(new Error('ffmpeg produced no valid WAV output'));
          return;
        }
        resolve(patchWavHeaderSizes(wav));
      })
      .catch(fail);
  });
}
