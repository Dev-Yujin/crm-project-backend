import { anthropic } from '../config/anthropic.js';

const MODEL = 'claude-haiku-4-5-20251001';

const ALLOWED_TAGS = new Set(['h2', 'h3', 'p', 'ul', 'ol', 'li', 'b', 'i', 'u', 'br']);

const SYSTEM_PROMPT = `You clean up and summarize a meeting transcript produced by automatic speech recognition.

Produce two things:
1. A short summary (2-4 sentences, as a single <p>) capturing the meeting's overall
   purpose and outcome.
2. A cleaned-up, CHRONOLOGICAL outline of the full discussion, following the meeting's
   actual order. Do not reorganize into categories like "decisions" or "action items" —
   the sequence in which things were discussed is the point.

Outline structure:
- One <h2> per topic, in the order the topic came up.
- Nested <ul>/<li> beneath each heading for the substance of that discussion.
- <b> for decisions, commitments, owners, and agreed next steps.
- <i> only for questions the speakers themselves left open, in their words.

Write only what was said:
- Never invent content, and never speculate about what a speaker meant, why they said
  it, or what they might do next.
- Never comment on the recording or the transcript itself — no remarks about audio
  quality, length, or what is missing.
- Keep both the summary and the outline proportional to the actual content. A short
  discussion produces a short write-up.
- Transcripts come from automatic speech recognition and contain errors. Read through
  obvious mistranscriptions where the intent is clear; leave ambiguous wording as-is.
- There are no speaker labels. Attribute something to a person only when the transcript
  names them out loud.
- Drop filler, false starts, and small talk.

Output HTML using ONLY these tags in both fields: <h2> <h3> <p> <ul> <ol> <li> <b> <i> <u> <br>
No attributes, no <div>, no <span>, no class names, no inline styles, no markdown fences.`;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Short descriptive note title, 3-8 words. No date, no quotes.' },
    summary: { type: 'string', description: 'A short 2-4 sentence summary as a single <p>.' },
    cleanedTranscript: { type: 'string', description: 'The chronological outline as HTML.' },
  },
  required: ['title', 'summary', 'cleanedTranscript'],
  additionalProperties: false,
};

function enforceTagAllowlist(html) {
  return html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (match, rawTag) => {
    const tag = rawTag.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return '';
    return match.startsWith('</') ? `</${tag}>` : `<${tag}>`;
  });
}

async function callHaiku(transcript) {
  const stream = anthropic.messages.stream({
    model: MODEL,
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: `Here is the meeting transcript.\n\n<transcript>\n${transcript}\n</transcript>` },
    ],
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
    },
  });

  const message = await stream.finalMessage();

  if (message.stop_reason === 'refusal') {
    throw new Error('The transcript could not be processed.');
  }

  const textBlock = message.content.find((block) => block.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No note content was returned.');
  }

  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch {
    throw new Error('Note content was malformed.');
  }

  return {
    title: (parsed.title ?? '').trim() || 'Meeting notes',
    summary: enforceTagAllowlist(parsed.summary ?? ''),
    cleanedTranscript: enforceTagAllowlist(parsed.cleanedTranscript ?? ''),
  };
}

// Retries transient failures (a dropped call here loses the whole meeting's write-up,
// worth a few attempts) — same shape as the old client-side transcribeSegmentWithRetry.
// A refusal or malformed response won't fix itself on retry, so those are not retried.
export async function formatMeetingTranscript(transcript, attempts = 3) {
  let lastError = new Error('Could not format the transcript.');

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await callHaiku(transcript);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error('Could not format the transcript.');
      if (/could not be processed|was malformed|No note content/i.test(lastError.message)) break;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
      }
    }
  }

  throw lastError;
}
