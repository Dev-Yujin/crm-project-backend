# AI meeting notes pipeline — fix, persist, meter

## Problem

Continuum CRM's meeting-notes recorder (mic + optional tab audio → live per-segment
transcription via Fish Audio → Claude-formatted note) is fully built on the frontend but
**cannot work in production**. Both external API calls (`fetch('/api/fish/v1/asr')`,
the Anthropic SDK pointed at `/api/anthropic`) depend on Vite's dev-server proxy to
inject `FISH_API_KEY`/`ANTHROPIC_API_KEY` — a proxy that only exists under `npm run
dev`. A production build is static assets with no server behind those paths. This is
already documented as a known bug (`BACKEND_CONFERENCING.md`, `docs/superpowers/specs/
2026-08-14-meeting-notes-transcription-design.md`), just never fixed.

Separately, recordings are never persisted anywhere — only the finished note's HTML
survives, in Firebase. And `aiNotesHoursPerMonth` (`config/plans.js`) is a purely
decorative number: nothing tracks or enforces actual usage, and nothing even displays
it today.

This redesign fixes all three at once, since they're the same pipeline: move
transcription server-side (fixing the production bug in the process, without needing
the generic passthrough-proxy approach `BACKEND_CONFERENCING.md` proposed), persist the
raw recording to R2, and meter real usage against the plan limit.

## Goals

- Recording works end-to-end on the deployed production app, not just `npm run dev`.
- The raw recording is durably stored in R2 (`meeting-recordings/{groupId}/{sessionId}/segment-{n}.webm`).
- Transcription (Fish Audio) and cleanup+summarization (Claude Haiku) run entirely
  server-side — `FISH_API_KEY`/`ANTHROPIC_API_KEY` never touch the browser.
- Actual recording duration is tracked per group per month and enforced against
  `aiNotesHoursPerMonth` — hard block on starting a new recording once over quota.
- Usage is visible: shown on `Billing.tsx` and in the recording UI itself.

## Non-goals

- `meetingToken`/LiveKit live conferencing (`BACKEND_CONFERENCING.md` §2) — a separate,
  unbuilt feature bundled in the same doc for an unrelated reason (both need a
  secret-holding backend). Untouched by this work.
- The generic `/api/fish/*`/`/api/anthropic/*` passthrough-proxy design from
  `BACKEND_CONFERENCING.md` §1 — superseded by the narrower, purpose-built pipeline
  below, which achieves the same "keys never reach the browser" goal while also solving
  persistence and quota enforcement in one design instead of two.
- Moving meeting *notes* themselves (title/html) into Postgres — they stay
  frontend-written Firebase records, same as today. Only the *recording* and its
  *usage accounting* move server-side.
- Live, mid-recording transcription. The user explicitly chose the sequential
  server-side pipeline over keeping today's live per-segment transcription — the note
  is now ready shortly after the user stops recording, not near-instantly.
- A hard cutoff mid-recording when a group crosses its quota mid-session. Enforcement
  gates *starting* a new recording, not an in-progress one — same enforcement point the
  existing storage quota uses.

## Architecture

### Recording capture (frontend)

`useMeetingRecorder.ts` keeps its existing mic + optional tab-audio mixing
(`getUserMedia`/`getDisplayMedia` → `AudioContext` mix), but drops all live-transcription
logic (`enqueueSegment`, the Fish/Anthropic calls, `formatTranscript`/`formatChunk` are
deleted from this file — the pipeline moves to the backend, see below).

On starting a recording, the client generates `sessionId = crypto.randomUUID()`. The
`MediaRecorder` rolls over every 15 minutes (`SEGMENT_MS`, up from today's 5 — there's
no longer a live-transcription reason to keep segments short; 15 minutes means most
meetings produce exactly one segment, while still bounding per-blob memory and
crash-loss risk). Each finished segment is uploaded straight to R2 via a presigned URL
the moment it's ready — not held in memory until the recording ends. A browser
crash mid-meeting loses at most the current unfinished segment.

`recordingBuffer.ts`'s IndexedDB buffer changes purpose: instead of buffering
transcript text, it now buffers the session's state (`sessionId`, confirmed segment
keys, start time) so a reload can offer "resume this session" (keep recording, appending
new segments to the same `sessionId`) or "finish with what's already uploaded."

On Stop, the client calls `finishMeetingRecording(sessionId)` and shows a "processing…"
state (this can take tens of seconds — real transcription + LLM calls, not instant).
The response opens as an unsaved draft note for review, exactly as today —
`openGeneratedNote` and the Firebase save flow are unchanged.

### Processing pipeline (backend, new)

`finishMeetingRecording(sessionId)`:
1. Load the session row; reject if status is already `processing` or `completed`
   (idempotency guard — a retry must not reprocess and double-charge usage).
2. Mark `processing`. Load all confirmed segments for this session, ordered by
   `segment_index`.
3. For each segment: fetch the object from R2, POST it to Fish Audio's ASR endpoint
   (same multipart request shape `meetingTranscription.ts` already builds — that logic
   moves here, backend-side, largely unchanged). A segment's Fish failure is skipped
   with a warning, not a hard failure (see Error handling).
4. Concatenate the successful segments' transcript text in order (trivial and lossless
   — unlike stitching audio, stitching recognized text is just string concatenation).
5. Send the full transcript to Claude Haiku (`claude-haiku-4-5-20251001`) with a prompt
   that produces both a short summary and a cleaned-up full transcript in one call.
6. Sum segment durations, write `total_duration_seconds` and `status = 'completed'` on
   the session, and add that duration to `group_ai_notes_usage.seconds_used`.
7. Return `{ title, summary, cleanedTranscript, durationSeconds, warnings }`.

### Storage

Recordings live in the existing `continuum-crm-files` R2 bucket (not a new bucket),
under a `meeting-recordings/{groupId}/{sessionId}/segment-{n}.webm` prefix — same
bucket, same presigned-PUT-then-confirm pattern task attachments already use
(`config/r2.js`, `utils/attachments.js`), just a different key prefix and no
association with a `Task` row. WebM/Opus is stored as-is (MediaRecorder's native
output) — no transcoding to WAV for storage; the transient WAV conversion
(`audioEncoding.ts`'s `toWav()`) still happens, but now server-side, immediately before
each segment is sent to Fish (Fish rejects WebM directly, per the existing code's own
comment), not client-side.

### Usage tracking

New `group_ai_notes_usage` table, mirroring `group_storage`'s lazy-provision +
delta-adjust pattern:

```sql
CREATE TABLE group_ai_notes_usage (
  group_id uuid PRIMARY KEY,
  seconds_used integer NOT NULL DEFAULT 0,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

`getOrCreateAiNotesUsage(groupId)` lazily provisions the row on first use (calendar
month: `period_start` = start of current month, `period_end` = start of next month), and
lazily *resets* it (zeroes `seconds_used`, rolls the period forward) whenever
`now() > period_end` on read — same pattern as `group_billing`'s trial provisioning, no
cron job needed for the monthly reset.

`requestMeetingRecordingUploadUrl` is the enforcement checkpoint: on segment 0 of a new
session (i.e., starting a new recording), it checks `seconds_used >=
PLANS[tier].aiNotesHoursPerMonth * 3600` and rejects with an upgrade-plan error
(`extensions.code: 'AI_NOTES_QUOTA_EXCEEDED'`) if so. Segments 1+ of an
already-in-progress session are never blocked by this check — a recording that started
under quota is allowed to finish even if its own duration pushes the group over.

## Data model / GraphQL

```graphql
type MeetingRecordingUploadTarget {
  uploadUrl: String!
  key: String!
}

type MeetingRecordingSegment {
  key: String!
  durationSeconds: Int!
}

type MeetingRecordingResult {
  title: String!
  summary: String!
  cleanedTranscript: String!
  durationSeconds: Int!
  warnings: [String!]!
}

type AiNotesUsage {
  secondsUsed: Int!
  secondsLimit: Int!
  periodEnd: String!
}

type Mutation {
  "Admin-only. First call for a new sessionId is the quota checkpoint."
  requestMeetingRecordingUploadUrl(
    sessionId: ID!
    segmentIndex: Int!
    contentType: String!
    sizeBytes: Int!
  ): MeetingRecordingUploadTarget!

  "Admin-only. Records a segment's real R2 size/duration after upload."
  confirmMeetingRecordingSegment(
    sessionId: ID!
    segmentIndex: Int!
    key: String!
    sizeBytes: Int!
    durationSeconds: Int!
  ): MeetingRecordingSegment!

  "Admin-only. Runs the full Fish -> Haiku pipeline and returns the finished note."
  finishMeetingRecording(sessionId: ID!): MeetingRecordingResult!
}

type Query {
  "Admin-only. Current month's AI meeting-notes usage against the plan limit."
  myAiNotesUsage: AiNotesUsage!
}
```

Auth: `requireGroup` (admin-only via Supabase session) on all three mutations and the
query — matching the existing recorder UI's admin-only gate (`Notes.tsx` passes
`canRecord`, `MemberNotesView` does not). Not the dual admin/member pattern tasks use;
members were never able to record today and this doesn't change that.

`meeting_recording_sessions` and `meeting_recording_segments` (Postgres, schema per
Architecture above) exist purely to drive this pipeline — they are not meeting *records*
in the `BACKEND_CONFERENCING.md` sense (no relation to that doc's unbuilt
`/meetings/{meetingId}` Firebase concept, hence the deliberately different name
`sessionId`).

## Error handling

- A segment's Fish transcription fails → skip it, continue with the rest, append a
  human-readable line to `warnings` (e.g. "1 of 3 segments could not be transcribed").
  All segments failing → the mutation throws (nothing to summarize), session marked
  `failed`.
- Claude Haiku call fails → retry with backoff (same shape as today's
  `transcribeSegmentWithRetry`: a few attempts, exponential backoff), then throw if still
  failing — session marked `failed`. No partial note without a summary step.
- A segment's R2 object is missing/unreadable → same skip-and-warn treatment as a Fish
  failure.
- `requestMeetingRecordingUploadUrl` at quota → `GraphQLError` with
  `extensions.code: 'AI_NOTES_QUOTA_EXCEEDED'`, message names the plan's limit so the
  frontend can show an upgrade-plan prompt (same UX shape as `ALREADY_SUBSCRIBED`/other
  existing billing errors).

**Trust boundary, deliberate:** `confirmMeetingRecordingSegment`'s `sizeBytes` is
re-verified server-side against R2's own object metadata (`headR2ObjectSize`, same as
task attachments — never trust a client-declared size). `durationSeconds` is *not*
independently verified — doing so would mean parsing the WebM container server-side
(ffprobe-equivalent), a new dependency this spec doesn't take on. Since this feature is
admin-only and internal-facing, a client misreporting its own recording's duration is
the same trust level as any other admin-supplied field elsewhere in this app — accepted,
not a gap worth closing here.

## UI additions

- `Billing.tsx`'s existing Usage section gets a third line alongside admins-used and
  storage-used: "X of Y hrs used this month" (formatted from `myAiNotesUsage`).
- The recording UI (`RecordingPanel.tsx`) shows the same figure before a new recording
  starts, so an admin sees the block coming rather than hitting it cold mid-click.

## Testing

- Pure logic — quota math, transcript concatenation order, the lazy monthly-reset
  calculation — gets real unit tests against a mocked `pool`, same style as
  `models/billing.test.js`.
- Resolver tests mock the Fish Audio HTTP call and the Anthropic SDK call — never hit
  either real API in automated test runs.
- The actual pipeline's output quality (does Haiku's cleanup/summary read well against
  real ASR output) needs a real manual test recording against the live Fish/Anthropic
  APIs, the same way Paddle's sandbox checkout needed a real live test — not something a
  unit test can substitute for.
