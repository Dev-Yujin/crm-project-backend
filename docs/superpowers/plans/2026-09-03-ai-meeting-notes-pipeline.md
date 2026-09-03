# AI Meeting Notes Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Continuum CRM's meeting-notes transcription entirely server-side (fixing a production bug where it only works under `npm run dev`), persist recordings to R2, and meter real usage against `aiNotesHoursPerMonth`.

**Architecture:** The frontend keeps its mic+tab-audio capture but drops all live Fish/Claude calls, uploading each ~15-minute WebM segment straight to R2 via a presigned URL. On Stop, one new mutation (`finishMeetingRecording`) runs the whole pipeline server-side: fetch each segment from R2, transcode WebM→WAV via ffmpeg (Fish rejects WebM), send to Fish Audio ASR, concatenate the transcript text, send it to Claude Haiku for cleanup+summary, meter the duration, and return the finished note for the frontend to open as a draft (still saved into Firebase by the frontend, unchanged).

**Tech Stack:** `@anthropic-ai/sdk@^0.117.1`, `fluent-ffmpeg@2.1.3` + `@ffmpeg-installer/ffmpeg@1.1.0` (backend, new), existing `@aws-sdk/client-s3`/R2 setup, existing Express/Apollo/Postgres/React 19/Vite stack.

**Spec:** `docs/superpowers/specs/2026-09-03-ai-meeting-notes-pipeline-design.md`

## Global Constraints

- Recording is admin-only (`requireGroup`), matching the existing recorder UI's gate — not the dual admin/member pattern tasks use.
- `sessionId` is a client-generated UUID (`crypto.randomUUID()`), scoping R2 keys as `meeting-recordings/{groupId}/{sessionId}/segment-{n}.webm`. It has no relation to the unbuilt `BACKEND_CONFERENCING.md` `meetingId` concept — do not conflate the two.
- Quota enforcement happens once, at `requestMeetingRecordingUploadUrl` for segment 0 of a new session — rejects if the group is already at/over `PLANS[tier].aiNotesHoursPerMonth` for the current calendar month. Segments 1+ of an already-started session are never blocked.
- `group_ai_notes_usage`'s period resets lazily (calendar month) on read/write when `now() > period_end` — no cron job.
- Claude model is `claude-haiku-4-5-20251001` (not the frontend's old `claude-opus-5`).
- `durationSeconds` reported by the client per segment is trusted, not independently verified server-side (would require parsing the WebM container) — `sizeBytes` IS re-verified against R2 via `headR2ObjectSize`, same as task attachments.
- The `/api/fish/*`/`/api/anthropic/*` Vite dev-proxy and `FISH_API_KEY`/`ANTHROPIC_API_KEY` frontend references are removed entirely — both keys now live only in `crm-proj`'s backend env, used directly (no proxy needed once the backend itself is the caller).
- No new R2 bucket — reuses the existing `continuum-crm-files` bucket with a new `meeting-recordings/` key prefix.
- No live/pipelined transcription — the note is ready shortly after Stop, not near-instantly. This is a deliberate, already-approved trade-off.

---

## Task 1: Backend — Anthropic config + Postgres tables

**Files:**
- Create: `crm-proj/config/anthropic.js`
- Create: `crm-proj/scripts/create-meeting-recording-tables.js`
- Modify: `crm-proj/package.json`

**Interfaces:**
- Produces: `anthropic` (a configured `Anthropic` client instance) from `config/anthropic.js`, used by Task 8.
- Produces: `meeting_recording_sessions`, `meeting_recording_segments`, `group_ai_notes_usage` tables, used by Tasks 3–4 and Task 9.

- [ ] **Step 1: Add the Anthropic SDK dependency**

```bash
cd crm-proj
npm install @anthropic-ai/sdk@0.117.1
```

- [ ] **Step 2: Create `config/anthropic.js`**

Mirrors `config/paddle.js`'s fail-loud pattern exactly (self-loads dotenv, same as that file after its own fix earlier this project):

```js
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const REQUIRED_ENV_VARS = ['ANTHROPIC_API_KEY'];

for (const name of REQUIRED_ENV_VARS) {
  if (!process.env[name]) {
    throw new Error(`Missing ${name} environment variable`);
  }
}

export const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
```

`FISH_API_KEY` doesn't get its own config module — it's a single header value used
directly in Task 7's fetch call, checked there with the same fail-loud style.

- [ ] **Step 3: Write the Postgres migration script**

```js
// One-time setup: creates the three tables backing the AI meeting-notes pipeline (see
// docs/superpowers/specs/2026-09-03-ai-meeting-notes-pipeline-design.md). Idempotent —
// safe to re-run; IF NOT EXISTS guards make a second run a no-op.
//
// Usage: node scripts/create-meeting-recording-tables.js

import { pool } from "../config/supabase.js";

async function main() {
  console.log("Creating meeting-recording tables (if missing)...");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS meeting_recording_sessions (
      session_id uuid PRIMARY KEY,
      group_id uuid NOT NULL,
      created_by text NOT NULL,
      status text NOT NULL DEFAULT 'recording'
        CHECK (status IN ('recording', 'processing', 'completed', 'failed')),
      total_duration_seconds integer,
      created_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS meeting_recording_segments (
      session_id uuid NOT NULL REFERENCES meeting_recording_sessions(session_id),
      segment_index integer NOT NULL,
      group_id uuid NOT NULL,
      r2_key text NOT NULL,
      size_bytes bigint NOT NULL,
      duration_seconds integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (session_id, segment_index)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS group_ai_notes_usage (
      group_id uuid PRIMARY KEY,
      seconds_used integer NOT NULL DEFAULT 0,
      period_start timestamptz NOT NULL,
      period_end timestamptz NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const check = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('meeting_recording_sessions', 'meeting_recording_segments', 'group_ai_notes_usage')
  `);
  console.log(
    check.rows.length === 3
      ? "Done — all three tables exist."
      : `Something went wrong — expected 3 tables, found ${check.rows.length}.`,
  );

  await pool.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
```

- [ ] **Step 4: Run it against the real database**

```bash
cd crm-proj && node scripts/create-meeting-recording-tables.js
```

Expected: "Done — all three tables exist."

- [ ] **Step 5: Verify `config/anthropic.js` loads**

```bash
node -e "import('./config/anthropic.js').then(() => console.log('ok')).catch(e => { console.error('FAILED:', e.message); process.exit(1); })"
```

Expected: `ok` (requires `ANTHROPIC_API_KEY` already in `.env` — it already is, from the
existing dev-proxy setup this feature is replacing).

- [ ] **Step 6: Commit**

```bash
git add config/anthropic.js scripts/create-meeting-recording-tables.js package.json package-lock.json
git commit -m "feat: add Anthropic config and meeting-recording Postgres tables"
```

---

## Task 2: Backend — `group_ai_notes_usage` model

**Files:**
- Create: `crm-proj/models/aiNotesUsage.js`
- Test: `crm-proj/models/aiNotesUsage.test.js`

**Interfaces:**
- Consumes: `pool` from `config/supabase.js`.
- Produces: `getOrCreateAiNotesUsage(groupId): Promise<{ secondsUsed, periodStart, periodEnd }>`, `addSecondsUsed(groupId, deltaSeconds): Promise<void>`, used by Task 9's resolvers.

- [ ] **Step 1: Write the failing tests**

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/supabase.js', () => ({
  pool: { query: vi.fn() },
}));

const { pool } = await import('../config/supabase.js');
const { getOrCreateAiNotesUsage, addSecondsUsed } = await import('./aiNotesUsage.js');

describe('getOrCreateAiNotesUsage', () => {
  beforeEach(() => {
    pool.query.mockReset();
  });

  it('returns the existing row when the current period has not ended', async () => {
    const periodEnd = new Date(Date.now() + 86_400_000); // 1 day from now
    pool.query.mockResolvedValueOnce({
      rows: [{ seconds_used: 1200, period_start: new Date('2026-09-01'), period_end: periodEnd }],
    });

    const result = await getOrCreateAiNotesUsage('group-1');

    expect(result).toEqual({ secondsUsed: 1200, periodStart: new Date('2026-09-01'), periodEnd });
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('lazily resets the row when the period has ended', async () => {
    const pastPeriodEnd = new Date(Date.now() - 86_400_000); // 1 day ago
    pool.query
      .mockResolvedValueOnce({
        rows: [{ seconds_used: 5000, period_start: new Date('2026-07-01'), period_end: pastPeriodEnd }],
      })
      .mockResolvedValueOnce({ rows: [{ seconds_used: 0, period_start: new Date(), period_end: new Date() }] });

    await getOrCreateAiNotesUsage('group-1');

    expect(pool.query).toHaveBeenCalledTimes(2);
    const [resetSql] = pool.query.mock.calls[1];
    expect(resetSql).toContain('UPDATE group_ai_notes_usage');
    expect(resetSql).toContain('seconds_used = 0');
  });

  it('provisions a fresh row when the group has never used AI notes', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] }) // SELECT finds nothing
      .mockResolvedValueOnce({
        rows: [{ seconds_used: 0, period_start: new Date(), period_end: new Date() }],
      }); // INSERT ... RETURNING

    const result = await getOrCreateAiNotesUsage('group-2');

    expect(result.secondsUsed).toBe(0);
    expect(pool.query).toHaveBeenCalledTimes(2);
    const [insertSql] = pool.query.mock.calls[1];
    expect(insertSql).toContain('INSERT INTO group_ai_notes_usage');
  });
});

describe('addSecondsUsed', () => {
  beforeEach(() => {
    pool.query.mockReset();
  });

  it('adds the delta to the current period after ensuring the row is fresh', async () => {
    const periodEnd = new Date(Date.now() + 86_400_000);
    pool.query
      .mockResolvedValueOnce({
        rows: [{ seconds_used: 100, period_start: new Date(), period_end: periodEnd }],
      }) // getOrCreateAiNotesUsage's read
      .mockResolvedValueOnce({ rows: [] }); // the UPDATE

    await addSecondsUsed('group-1', 300);

    expect(pool.query).toHaveBeenCalledTimes(2);
    const [updateSql, params] = pool.query.mock.calls[1];
    expect(updateSql).toContain('UPDATE group_ai_notes_usage');
    expect(updateSql).toContain('seconds_used = seconds_used + $1');
    expect(params).toEqual([300, 'group-1']);
  });
});
```

- [ ] **Step 2: Run the tests, confirm they fail**

```bash
cd crm-proj && npx vitest run models/aiNotesUsage.test.js
```
Expected: FAIL — `models/aiNotesUsage.js` doesn't exist yet.

- [ ] **Step 3: Write `models/aiNotesUsage.js`**

```js
import { pool } from '../config/supabase.js';

function startOfCurrentMonth() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function startOfNextMonth() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

function mapRow(row) {
  return {
    secondsUsed: Number(row.seconds_used),
    periodStart: row.period_start,
    periodEnd: row.period_end,
  };
}

// Reads a group's current-month AI-notes usage, lazily provisioning the row (0 seconds,
// current calendar month) the first time this group ever records a meeting — same
// lazy-provision pattern as models/storage.js's getOrCreateStorageUsage. Also lazily
// *resets* the row (back to 0, rolled forward to the current month) whenever the stored
// period has already ended — no cron job needed for the monthly reset.
export async function getOrCreateAiNotesUsage(groupId) {
  const existing = await pool.query(
    'SELECT seconds_used, period_start, period_end FROM group_ai_notes_usage WHERE group_id = $1',
    [groupId],
  );

  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    if (new Date() > new Date(row.period_end)) {
      const reset = await pool.query(
        `UPDATE group_ai_notes_usage
         SET seconds_used = 0, period_start = $1, period_end = $2, updated_at = now()
         WHERE group_id = $3
         RETURNING seconds_used, period_start, period_end`,
        [startOfCurrentMonth(), startOfNextMonth(), groupId],
      );
      return mapRow(reset.rows[0]);
    }
    return mapRow(row);
  }

  const inserted = await pool.query(
    `INSERT INTO group_ai_notes_usage (group_id, seconds_used, period_start, period_end)
     VALUES ($1, 0, $2, $3)
     ON CONFLICT (group_id) DO NOTHING
     RETURNING seconds_used, period_start, period_end`,
    [groupId, startOfCurrentMonth(), startOfNextMonth()],
  );

  if (inserted.rows.length > 0) {
    return mapRow(inserted.rows[0]);
  }

  // Lost the insert race — a concurrent request created the row first.
  const raced = await pool.query(
    'SELECT seconds_used, period_start, period_end FROM group_ai_notes_usage WHERE group_id = $1',
    [groupId],
  );
  return mapRow(raced.rows[0]);
}

// Adds deltaSeconds to a group's running usage for the current period. Ensures the row
// is fresh (not a stale prior-month row) before adding, via getOrCreateAiNotesUsage.
export async function addSecondsUsed(groupId, deltaSeconds) {
  await getOrCreateAiNotesUsage(groupId);
  await pool.query(
    `UPDATE group_ai_notes_usage
     SET seconds_used = seconds_used + $1, updated_at = now()
     WHERE group_id = $2`,
    [deltaSeconds, groupId],
  );
}
```

- [ ] **Step 4: Run the tests, confirm they pass**

```bash
cd crm-proj && npx vitest run models/aiNotesUsage.test.js
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add models/aiNotesUsage.js models/aiNotesUsage.test.js
git commit -m "feat: add group_ai_notes_usage model with lazy monthly reset"
```

---

## Task 3: Backend — meeting recording session/segment model

**Files:**
- Create: `crm-proj/models/meetingRecording.js`
- Test: `crm-proj/models/meetingRecording.test.js`

**Interfaces:**
- Consumes: `pool` from `config/supabase.js`.
- Produces: `getOrCreateSession(sessionId, groupId, createdBy): Promise<Session>`, `insertSegment(sessionId, groupId, segmentIndex, r2Key, sizeBytes, durationSeconds): Promise<void>`, `getSessionWithSegments(sessionId, groupId): Promise<{ session, segments }>`, `markSessionStatus(sessionId, status, totalDurationSeconds?): Promise<void>`, used by Task 9's resolvers.

- [ ] **Step 1: Write the failing tests**

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/supabase.js', () => ({
  pool: { query: vi.fn() },
}));

const { pool } = await import('../config/supabase.js');
const {
  getOrCreateSession,
  insertSegment,
  getSessionWithSegments,
  markSessionStatus,
} = await import('./meetingRecording.js');

describe('getOrCreateSession', () => {
  beforeEach(() => pool.query.mockReset());

  it('returns the existing session when one already exists', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ session_id: 's1', group_id: 'g1', created_by: 'admin:u1', status: 'recording' }],
    });

    const result = await getOrCreateSession('s1', 'g1', 'admin:u1');

    expect(result.status).toBe('recording');
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('creates a new session when none exists yet', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ session_id: 's2', group_id: 'g1', created_by: 'admin:u1', status: 'recording' }],
      });

    const result = await getOrCreateSession('s2', 'g1', 'admin:u1');

    expect(result.status).toBe('recording');
    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query.mock.calls[1][0]).toContain('INSERT INTO meeting_recording_sessions');
  });
});

describe('insertSegment', () => {
  beforeEach(() => pool.query.mockReset());

  it('inserts a segment row with the given fields', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await insertSegment('s1', 'g1', 0, 'meeting-recordings/g1/s1/segment-0.webm', 512000, 900);

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO meeting_recording_segments');
    expect(params).toEqual(['s1', 0, 'g1', 'meeting-recordings/g1/s1/segment-0.webm', 512000, 900]);
  });
});

describe('getSessionWithSegments', () => {
  beforeEach(() => pool.query.mockReset());

  it('returns the session and its segments ordered by segment_index', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{ session_id: 's1', group_id: 'g1', created_by: 'admin:u1', status: 'recording' }],
      })
      .mockResolvedValueOnce({
        rows: [
          { segment_index: 0, r2_key: 'k0', size_bytes: 100, duration_seconds: 900 },
          { segment_index: 1, r2_key: 'k1', size_bytes: 200, duration_seconds: 450 },
        ],
      });

    const result = await getSessionWithSegments('s1', 'g1');

    expect(result.session.status).toBe('recording');
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].r2Key).toBe('k0');
    const [segSql, segParams] = pool.query.mock.calls[1];
    expect(segSql).toContain('ORDER BY segment_index');
    expect(segParams).toEqual(['s1']);
  });

  it('throws when the session belongs to a different group', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await expect(getSessionWithSegments('s1', 'wrong-group')).rejects.toThrow();
  });
});

describe('markSessionStatus', () => {
  beforeEach(() => pool.query.mockReset());

  it('updates status without a duration', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await markSessionStatus('s1', 'processing');
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('SET status = $1');
    expect(params).toEqual(['processing', null, 's1']);
  });

  it('updates status with a total duration and completed_at', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await markSessionStatus('s1', 'completed', 1350);
    const [, params] = pool.query.mock.calls[0];
    expect(params).toEqual(['completed', 1350, 's1']);
  });
});
```

- [ ] **Step 2: Run the tests, confirm they fail**

```bash
cd crm-proj && npx vitest run models/meetingRecording.test.js
```
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write `models/meetingRecording.js`**

```js
import { pool } from '../config/supabase.js';

function mapSession(row) {
  return {
    sessionId: row.session_id,
    groupId: row.group_id,
    createdBy: row.created_by,
    status: row.status,
    totalDurationSeconds: row.total_duration_seconds ?? null,
  };
}

function mapSegment(row) {
  return {
    segmentIndex: row.segment_index,
    r2Key: row.r2_key,
    sizeBytes: Number(row.size_bytes),
    durationSeconds: row.duration_seconds,
  };
}

// Lazily provisions a session row the first time a given sessionId is seen — the
// session isn't created by a separate "start recording" call; requestMeetingRecordingUploadUrl
// (Task 9) calls this on segment 0 of a new recording.
export async function getOrCreateSession(sessionId, groupId, createdBy) {
  const existing = await pool.query(
    'SELECT session_id, group_id, created_by, status, total_duration_seconds FROM meeting_recording_sessions WHERE session_id = $1',
    [sessionId],
  );
  if (existing.rows.length > 0) {
    return mapSession(existing.rows[0]);
  }

  const inserted = await pool.query(
    `INSERT INTO meeting_recording_sessions (session_id, group_id, created_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (session_id) DO NOTHING
     RETURNING session_id, group_id, created_by, status, total_duration_seconds`,
    [sessionId, groupId, createdBy],
  );
  if (inserted.rows.length > 0) {
    return mapSession(inserted.rows[0]);
  }

  // Lost the insert race.
  const raced = await pool.query(
    'SELECT session_id, group_id, created_by, status, total_duration_seconds FROM meeting_recording_sessions WHERE session_id = $1',
    [sessionId],
  );
  return mapSession(raced.rows[0]);
}

export async function insertSegment(sessionId, groupId, segmentIndex, r2Key, sizeBytes, durationSeconds) {
  await pool.query(
    `INSERT INTO meeting_recording_segments (session_id, segment_index, group_id, r2_key, size_bytes, duration_seconds)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [sessionId, segmentIndex, groupId, r2Key, sizeBytes, durationSeconds],
  );
}

// Fetches a session and its segments (ordered) — throws if the session doesn't exist
// or doesn't belong to groupId, so a caller can never read another group's recording.
export async function getSessionWithSegments(sessionId, groupId) {
  const sessionResult = await pool.query(
    'SELECT session_id, group_id, created_by, status, total_duration_seconds FROM meeting_recording_sessions WHERE session_id = $1 AND group_id = $2',
    [sessionId, groupId],
  );
  if (sessionResult.rows.length === 0) {
    throw new Error('Recording session not found.');
  }

  const segmentsResult = await pool.query(
    'SELECT segment_index, r2_key, size_bytes, duration_seconds FROM meeting_recording_segments WHERE session_id = $1 ORDER BY segment_index',
    [sessionId],
  );

  return {
    session: mapSession(sessionResult.rows[0]),
    segments: segmentsResult.rows.map(mapSegment),
  };
}

export async function markSessionStatus(sessionId, status, totalDurationSeconds = null) {
  await pool.query(
    `UPDATE meeting_recording_sessions
     SET status = $1, total_duration_seconds = $2,
         completed_at = CASE WHEN $1 IN ('completed', 'failed') THEN now() ELSE completed_at END
     WHERE session_id = $3`,
    [status, totalDurationSeconds, sessionId],
  );
}
```

Note: `meeting_recording_sessions` (Task 1) has no `updated_at` column — this UPDATE
deliberately doesn't set one.

- [ ] **Step 4: Run the tests, confirm they pass**

```bash
cd crm-proj && npx vitest run models/meetingRecording.test.js
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add models/meetingRecording.js models/meetingRecording.test.js
git commit -m "feat: add meeting recording session/segment model"
```

---

## Task 4: Backend — validation helpers

**Files:**
- Create: `crm-proj/utils/meetingRecordings.js`
- Test: `crm-proj/utils/meetingRecordings.test.js`

**Interfaces:**
- Produces: `validateSegmentContentType(contentType)`, `validateSegmentSize(sizeBytes)`, `validateRecordingKey(key, groupId, sessionId)`, `checkAiNotesQuota(secondsUsed, incomingSessionIsNew, aiNotesHoursPerMonth)`, used by Task 9's resolvers.

- [ ] **Step 1: Write the failing tests**

```js
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
```

- [ ] **Step 2: Run the tests, confirm they fail**

```bash
cd crm-proj && npx vitest run utils/meetingRecordings.test.js
```
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write `utils/meetingRecordings.js`**

```js
const ALLOWED_SEGMENT_CONTENT_TYPES = new Set(['audio/webm', 'audio/webm;codecs=opus']);

// Generous relative to a real 15-minute segment (~10-15MB at the recorder's 32kbps
// bitrate) — this is a sanity ceiling against a misbehaving client, not a tight limit.
const MAX_SEGMENT_SIZE_BYTES = 100 * 1024 * 1024;

export function validateSegmentContentType(contentType) {
  if (!ALLOWED_SEGMENT_CONTENT_TYPES.has(contentType)) {
    throw new Error(`Content type "${contentType}" is not allowed for meeting recordings.`);
  }
}

export function validateSegmentSize(sizeBytes) {
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
    throw new Error('Segment size must be a positive integer number of bytes.');
  }
  if (sizeBytes > MAX_SEGMENT_SIZE_BYTES) {
    throw new Error(`Segment is too large (${sizeBytes} bytes, max ${MAX_SEGMENT_SIZE_BYTES}).`);
  }
}

// Enforces the R2 key namespace requestMeetingRecordingUploadUrl builds
// (`meeting-recordings/${groupId}/${sessionId}/...`) — same cross-tenant-spoofing
// protection as validateAttachmentKey in utils/attachments.js.
export function validateRecordingKey(key, groupId, sessionId) {
  const prefix = `meeting-recordings/${groupId}/${sessionId}/`;
  if (typeof key !== 'string' || !key.startsWith(prefix)) {
    throw new Error('Invalid upload key for this recording session.');
  }
}

// Only gates starting a *new* session (isNewSession === true) — a recording already
// under way is never cut off mid-way even if its own duration pushes the group over.
export function checkAiNotesQuota(secondsUsed, isNewSession, aiNotesHoursPerMonth) {
  if (!isNewSession) return;
  const limitSeconds = aiNotesHoursPerMonth * 3600;
  if (secondsUsed >= limitSeconds) {
    throw new Error(
      `This workspace has used its ${aiNotesHoursPerMonth} hrs/month of AI meeting notes. Upgrade your plan to record more.`,
    );
  }
}
```

- [ ] **Step 4: Run the tests, confirm they pass**

```bash
cd crm-proj && npx vitest run utils/meetingRecordings.test.js
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add utils/meetingRecordings.js utils/meetingRecordings.test.js
git commit -m "feat: add meeting recording validation helpers"
```

---

## Task 5: Backend — WebM to WAV transcoding

**Files:**
- Create: `crm-proj/utils/audioTranscode.js`
- Test: `crm-proj/utils/audioTranscode.test.js`
- Modify: `crm-proj/package.json`

**Interfaces:**
- Produces: `webmToWav(webmBuffer: Buffer): Promise<Buffer>`, used by Task 7.

Fish Audio's ASR rejects WebM outright ("format not recognised" — confirmed by the
existing frontend code's own comment in `audioEncoding.ts`) but accepts WAV. The
frontend used to convert client-side via the Web Audio API (`AudioContext`), which
doesn't exist in Node — this task does the same conversion (16kHz mono WAV) server-side
via ffmpeg, using a bundled static binary so the deployed host needs nothing installed.

- [ ] **Step 1: Add the ffmpeg dependencies**

```bash
cd crm-proj
npm install fluent-ffmpeg@2.1.3 @ffmpeg-installer/ffmpeg@1.1.0
```

- [ ] **Step 2: Write the failing test**

This test generates its own tiny real WebM fixture at run time (via ffmpeg itself,
already a dependency) rather than checking in a binary audio file — a 1-second silent
Opus/WebM clip, self-contained and reproducible.

```js
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
```

- [ ] **Step 3: Run the test, confirm it fails**

```bash
cd crm-proj && npx vitest run utils/audioTranscode.test.js
```
Expected: FAIL — `utils/audioTranscode.js` doesn't exist.

- [ ] **Step 4: Write `utils/audioTranscode.js`**

```js
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
```

- [ ] **Step 5: Run the test, confirm it passes**

```bash
cd crm-proj && npx vitest run utils/audioTranscode.test.js
```
Expected: PASS. If ffmpeg itself fails to run in this environment (missing shared
libraries, etc.), the error will be explicit — report BLOCKED with the exact ffmpeg
stderr rather than guessing at a fix.

- [ ] **Step 6: Commit**

```bash
git add utils/audioTranscode.js utils/audioTranscode.test.js package.json package-lock.json
git commit -m "feat: add server-side WebM to WAV transcoding via ffmpeg"
```

---

## Task 6: Backend — Fish Audio transcription service

**Files:**
- Create: `crm-proj/services/fishTranscription.js`
- Test: `crm-proj/services/fishTranscription.test.js`

**Interfaces:**
- Consumes: `webmToWav` (Task 5).
- Produces: `transcribeSegment(webmBuffer: Buffer, segmentIndex: number): Promise<{ text: string, durationSeconds: number }>`, used by Task 9.

This is the old `meetingTranscription.ts`'s `transcribeSegment`/`transcribeSegmentWithRetry`
logic, moved server-side and simplified — no more segment-offset timestamp shifting
(that existed to support live per-segment display, which no longer happens), no retry
wrapper needed as a separate exported function (folded into one function since nothing
else calls the non-retrying version anymore).

- [ ] **Step 1: Write the failing tests**

```js
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
```

- [ ] **Step 2: Run the tests, confirm they fail**

```bash
cd crm-proj && npx vitest run services/fishTranscription.test.js
```
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write `services/fishTranscription.js`**

```js
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
```

- [ ] **Step 4: Run the tests, confirm they pass**

```bash
cd crm-proj && npx vitest run services/fishTranscription.test.js
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/fishTranscription.js services/fishTranscription.test.js
git commit -m "feat: add server-side Fish Audio transcription service"
```

---

## Task 7: Backend — Claude Haiku cleanup + summary service

**Files:**
- Create: `crm-proj/services/meetingNotesFormatter.js`
- Test: `crm-proj/services/meetingNotesFormatter.test.js`

**Interfaces:**
- Consumes: `anthropic` (Task 1).
- Produces: `formatMeetingTranscript(transcript: string): Promise<{ title: string, summary: string, cleanedTranscript: string }>`, used by Task 9.

Adapts the old `meetingTranscription.ts`'s `formatChunk` prompt/schema — same
chronological-outline philosophy, same HTML tag allowlist — but on `claude-haiku-4-5-20251001`
instead of `claude-opus-5`, and producing both a `summary` and a `cleanedTranscript`
field instead of one `html` field, per the spec's "fix it and summarize it" requirement.
No chunking for multi-hour transcripts in this task — that's Task 9's concern, since
chunking operates over multiple segments' concatenated text, which only the resolver
layer assembles.

- [ ] **Step 1: Write the failing tests**

```js
import { describe, it, expect, vi } from 'vitest';

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
});
```

- [ ] **Step 2: Run the tests, confirm they fail**

```bash
cd crm-proj && npx vitest run services/meetingNotesFormatter.test.js
```
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write `services/meetingNotesFormatter.js`**

```js
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
```

- [ ] **Step 4: Run the tests, confirm they pass**

```bash
cd crm-proj && npx vitest run services/meetingNotesFormatter.test.js
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/meetingNotesFormatter.js services/meetingNotesFormatter.test.js
git commit -m "feat: add Claude Haiku meeting-notes cleanup and summary service"
```

---

## Task 8: Backend — GraphQL schema, resolvers, server wiring

**Files:**
- Create: `crm-proj/typedefs/meetingRecordingTypeDefs.js`
- Create: `crm-proj/resolvers/meetingRecordingResolvers.js`
- Test: `crm-proj/resolvers/meetingRecordingResolvers.test.js`
- Modify: `crm-proj/server.js`

**Interfaces:**
- Consumes: `getOrCreateAiNotesUsage`/`addSecondsUsed` (Task 2), `getOrCreateSession`/`insertSegment`/`getSessionWithSegments`/`markSessionStatus` (Task 3), `validateSegmentContentType`/`validateSegmentSize`/`validateRecordingKey`/`checkAiNotesQuota` (Task 4), `transcribeSegment` (Task 6), `formatMeetingTranscript` (Task 7), `createUploadUrl`/`createDownloadUrl` (existing `config/r2.js`), `PLANS`/`getOrCreateBilling` (existing).
- Produces: the GraphQL mutations/query this whole feature exposes to the frontend, consumed by Task 9.

This is the integration task — the whole pipeline gets wired together and this repo
becomes fully working end-to-end on the backend side.

- [ ] **Step 1: Write `typedefs/meetingRecordingTypeDefs.js`**

Reuses the existing generic `UploadTarget` type from `typedefs/taskTypeDefs.js`
(`{ uploadUrl: String!, key: String! }`) rather than duplicating it — GraphQL types are
global across the schema regardless of which file declares them.

```js
const meetingRecordingTypeDefs = `#graphql
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
    "Admin-only. First call for a new sessionId is the AI-notes quota checkpoint."
    requestMeetingRecordingUploadUrl(
      sessionId: ID!
      segmentIndex: Int!
      contentType: String!
      sizeBytes: Int!
    ): UploadTarget!

    "Admin-only. Records a segment's real R2 size and reported duration."
    confirmMeetingRecordingSegment(
      sessionId: ID!
      segmentIndex: Int!
      key: String!
      sizeBytes: Int!
      durationSeconds: Int!
    ): MeetingRecordingSegment!

    "Admin-only. Runs the Fish Audio -> Claude Haiku pipeline and returns the finished note."
    finishMeetingRecording(sessionId: ID!): MeetingRecordingResult!
  }

  type Query {
    "Admin-only. Current month's AI meeting-notes usage against the plan limit."
    myAiNotesUsage: AiNotesUsage!
  }
`;

export default meetingRecordingTypeDefs;
```

- [ ] **Step 2: Write the failing resolver tests**

```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config/r2.js', () => ({
  createUploadUrl: vi.fn(async () => 'https://r2.example/presigned'),
  createDownloadUrl: vi.fn(async () => 'https://r2.example/download'),
  headR2ObjectSize: vi.fn(async () => 512000),
}));
vi.mock('../models/aiNotesUsage.js', () => ({
  getOrCreateAiNotesUsage: vi.fn(async () => ({ secondsUsed: 0, periodStart: new Date(), periodEnd: new Date(Date.now() + 86400000) })),
  addSecondsUsed: vi.fn(async () => {}),
}));
vi.mock('../models/meetingRecording.js', () => ({
  getOrCreateSession: vi.fn(async (sessionId, groupId, createdBy) => ({ sessionId, groupId, createdBy, status: 'recording' })),
  insertSegment: vi.fn(async () => {}),
  getSessionWithSegments: vi.fn(async () => ({
    session: { sessionId: 's1', groupId: 'g1', status: 'recording' },
    segments: [{ segmentIndex: 0, r2Key: 'meeting-recordings/g1/s1/segment-0.webm', sizeBytes: 100, durationSeconds: 900 }],
  })),
  markSessionStatus: vi.fn(async () => {}),
}));
vi.mock('../services/fishTranscription.js', () => ({
  transcribeSegment: vi.fn(async () => ({ text: 'hello world', durationSeconds: 900 })),
}));
vi.mock('../services/meetingNotesFormatter.js', () => ({
  formatMeetingTranscript: vi.fn(async () => ({
    title: 'Test meeting',
    summary: '<p>Summary</p>',
    cleanedTranscript: '<h2>Topic</h2><p>Content</p>',
  })),
}));
vi.mock('../models/billing.js', () => ({
  getOrCreateBilling: vi.fn(async () => ({ limits: { tier: 'STARTER', aiNotesHoursPerMonth: 5 } })),
}));

const { createUploadUrl } = await import('../config/r2.js');
const { getOrCreateAiNotesUsage, addSecondsUsed } = await import('../models/aiNotesUsage.js');
const { getOrCreateSession, insertSegment, getSessionWithSegments, markSessionStatus } = await import('../models/meetingRecording.js');
const { transcribeSegment } = await import('../services/fishTranscription.js');
const { formatMeetingTranscript } = await import('../services/meetingNotesFormatter.js');
const meetingRecordingResolvers = (await import('./meetingRecordingResolvers.js')).default;

const context = { user: { id: 'u1' }, groupId: 'g1', member: null };
const originalFetch = global.fetch;

describe('requestMeetingRecordingUploadUrl', () => {
  beforeEach(() => vi.clearAllMocks());

  it('issues an upload URL for segment 0 of a new session', async () => {
    const result = await meetingRecordingResolvers.Mutation.requestMeetingRecordingUploadUrl(
      null,
      { sessionId: 's1', segmentIndex: 0, contentType: 'audio/webm', sizeBytes: 1024 },
      context,
    );

    expect(result.key).toContain('meeting-recordings/g1/s1/');
    expect(createUploadUrl).toHaveBeenCalledWith(expect.stringContaining('meeting-recordings/g1/s1/segment-0'), 'audio/webm');
    expect(getOrCreateSession).toHaveBeenCalledWith('s1', 'g1', 'admin:u1');
  });

  it('rejects a new session when the group is already at quota', async () => {
    getOrCreateAiNotesUsage.mockResolvedValueOnce({ secondsUsed: 5 * 3600, periodStart: new Date(), periodEnd: new Date() });

    await expect(
      meetingRecordingResolvers.Mutation.requestMeetingRecordingUploadUrl(
        null,
        { sessionId: 's2', segmentIndex: 0, contentType: 'audio/webm', sizeBytes: 1024 },
        context,
      ),
    ).rejects.toThrow(/quota|hrs/i);
  });

  it('does not check quota for segment 1+ of an existing session', async () => {
    getOrCreateSession.mockResolvedValueOnce({ sessionId: 's1', groupId: 'g1', createdBy: 'admin:u1', status: 'recording' });
    getOrCreateAiNotesUsage.mockResolvedValueOnce({ secondsUsed: 100 * 3600, periodStart: new Date(), periodEnd: new Date() });

    await expect(
      meetingRecordingResolvers.Mutation.requestMeetingRecordingUploadUrl(
        null,
        { sessionId: 's1', segmentIndex: 1, contentType: 'audio/webm', sizeBytes: 1024 },
        context,
      ),
    ).resolves.toBeDefined();
  });
});

describe('confirmMeetingRecordingSegment', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records the segment with the server-verified size', async () => {
    const result = await meetingRecordingResolvers.Mutation.confirmMeetingRecordingSegment(
      null,
      { sessionId: 's1', segmentIndex: 0, key: 'meeting-recordings/g1/s1/segment-0.webm', sizeBytes: 1024, durationSeconds: 900 },
      context,
    );

    expect(result.durationSeconds).toBe(900);
    expect(insertSegment).toHaveBeenCalledWith('s1', 'g1', 0, 'meeting-recordings/g1/s1/segment-0.webm', 512000, 900);
  });

  it('rejects a key outside this group/session prefix', async () => {
    await expect(
      meetingRecordingResolvers.Mutation.confirmMeetingRecordingSegment(
        null,
        { sessionId: 's1', segmentIndex: 0, key: 'meeting-recordings/other-group/s1/segment-0.webm', sizeBytes: 1024, durationSeconds: 900 },
        context,
      ),
    ).rejects.toThrow();
  });
});

describe('finishMeetingRecording', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // finishMeetingRecording fetches each segment's bytes from its R2 download URL —
    // mock that HTTP call so tests never make a real network request.
    global.fetch = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    }));
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('runs the full pipeline and returns the finished note', async () => {
    const result = await meetingRecordingResolvers.Mutation.finishMeetingRecording(
      null,
      { sessionId: 's1' },
      context,
    );

    expect(result.title).toBe('Test meeting');
    expect(result.durationSeconds).toBe(900);
    expect(result.warnings).toEqual([]);
    expect(markSessionStatus).toHaveBeenCalledWith('s1', 'processing', null);
    expect(markSessionStatus).toHaveBeenCalledWith('s1', 'completed', 900);
    expect(addSecondsUsed).toHaveBeenCalledWith('g1', 900);
  });

  it('rejects reprocessing an already-completed session', async () => {
    getSessionWithSegments.mockResolvedValueOnce({
      session: { sessionId: 's1', groupId: 'g1', status: 'completed' },
      segments: [],
    });

    await expect(
      meetingRecordingResolvers.Mutation.finishMeetingRecording(null, { sessionId: 's1' }, context),
    ).rejects.toThrow(/already/i);
  });

  it('warns and continues when one segment fails transcription, of several', async () => {
    getSessionWithSegments.mockResolvedValueOnce({
      session: { sessionId: 's1', groupId: 'g1', status: 'recording' },
      segments: [
        { segmentIndex: 0, r2Key: 'k0', sizeBytes: 100, durationSeconds: 900 },
        { segmentIndex: 1, r2Key: 'k1', sizeBytes: 100, durationSeconds: 900 },
      ],
    });
    transcribeSegment
      .mockResolvedValueOnce({ text: 'segment one', durationSeconds: 900 })
      .mockRejectedValueOnce(new Error('boom'));

    const result = await meetingRecordingResolvers.Mutation.finishMeetingRecording(
      null,
      { sessionId: 's1' },
      context,
    );

    expect(result.warnings.length).toBe(1);
    expect(formatMeetingTranscript).toHaveBeenCalledWith(expect.stringContaining('segment one'));
  });

  it('throws when every segment fails transcription', async () => {
    getSessionWithSegments.mockResolvedValueOnce({
      session: { sessionId: 's1', groupId: 'g1', status: 'recording' },
      segments: [{ segmentIndex: 0, r2Key: 'k0', sizeBytes: 100, durationSeconds: 900 }],
    });
    transcribeSegment.mockRejectedValueOnce(new Error('boom'));

    await expect(
      meetingRecordingResolvers.Mutation.finishMeetingRecording(null, { sessionId: 's1' }, context),
    ).rejects.toThrow();
    expect(markSessionStatus).toHaveBeenCalledWith('s1', 'failed', null);
  });
});
```

- [ ] **Step 3: Run the tests, confirm they fail**

```bash
cd crm-proj && npx vitest run resolvers/meetingRecordingResolvers.test.js
```
Expected: FAIL — `resolvers/meetingRecordingResolvers.js` doesn't exist.

- [ ] **Step 4: Write `resolvers/meetingRecordingResolvers.js`**

```js
import { GraphQLError } from 'graphql';
import { requireGroup } from '../utils/requireUser.js';
import { createUploadUrl, createDownloadUrl, headR2ObjectSize } from '../config/r2.js';
import { getOrCreateBilling } from '../models/billing.js';
import { getOrCreateAiNotesUsage, addSecondsUsed } from '../models/aiNotesUsage.js';
import {
  getOrCreateSession,
  insertSegment,
  getSessionWithSegments,
  markSessionStatus,
} from '../models/meetingRecording.js';
import {
  validateSegmentContentType,
  validateSegmentSize,
  validateRecordingKey,
  checkAiNotesQuota,
} from '../utils/meetingRecordings.js';
import { transcribeSegment } from '../services/fishTranscription.js';
import { formatMeetingTranscript } from '../services/meetingNotesFormatter.js';

const meetingRecordingResolvers = {
  Query: {
    myAiNotesUsage: async (_, __, context) => {
      const groupId = requireGroup(context);
      const [usage, billing] = await Promise.all([
        getOrCreateAiNotesUsage(groupId),
        getOrCreateBilling(groupId),
      ]);
      return {
        secondsUsed: usage.secondsUsed,
        secondsLimit: billing.limits.aiNotesHoursPerMonth * 3600,
        periodEnd: usage.periodEnd.toISOString(),
      };
    },
  },
  Mutation: {
    requestMeetingRecordingUploadUrl: async (_, { sessionId, segmentIndex, contentType, sizeBytes }, context) => {
      const groupId = requireGroup(context);
      const uploadedBy = `admin:${context.user.id}`;

      validateSegmentContentType(contentType);
      validateSegmentSize(sizeBytes);

      const session = await getOrCreateSession(sessionId, groupId, uploadedBy);
      const isNewSession = segmentIndex === 0;

      if (isNewSession) {
        const [usage, billing] = await Promise.all([
          getOrCreateAiNotesUsage(groupId),
          getOrCreateBilling(groupId),
        ]);
        try {
          checkAiNotesQuota(usage.secondsUsed, true, billing.limits.aiNotesHoursPerMonth);
        } catch (err) {
          throw new GraphQLError(err.message, { extensions: { code: 'AI_NOTES_QUOTA_EXCEEDED' } });
        }
      }

      const key = `meeting-recordings/${groupId}/${session.sessionId}/segment-${segmentIndex}.webm`;
      const uploadUrl = await createUploadUrl(key, contentType);

      return { uploadUrl, key };
    },

    confirmMeetingRecordingSegment: async (_, { sessionId, segmentIndex, key, sizeBytes, durationSeconds }, context) => {
      const groupId = requireGroup(context);

      try {
        validateRecordingKey(key, groupId, sessionId);
      } catch (err) {
        throw new GraphQLError(err.message, { extensions: { code: 'BAD_USER_INPUT' } });
      }
      validateSegmentSize(sizeBytes);

      let actualSizeBytes;
      try {
        actualSizeBytes = await headR2ObjectSize(key);
        validateSegmentSize(actualSizeBytes);
      } catch (err) {
        throw new GraphQLError('The uploaded segment could not be verified — try uploading again.', {
          extensions: { code: 'UPLOAD_NOT_FOUND' },
        });
      }

      await insertSegment(sessionId, groupId, segmentIndex, key, actualSizeBytes, durationSeconds);

      return { key, durationSeconds };
    },

    finishMeetingRecording: async (_, { sessionId }, context) => {
      const groupId = requireGroup(context);

      const { session, segments } = await getSessionWithSegments(sessionId, groupId);

      if (session.status === 'processing' || session.status === 'completed') {
        throw new GraphQLError('This recording is already being processed or has finished.', {
          extensions: { code: 'ALREADY_PROCESSED' },
        });
      }

      await markSessionStatus(sessionId, 'processing', null);

      const warnings = [];
      const transcriptParts = [];
      let totalDurationSeconds = 0;

      for (const segment of segments) {
        try {
          const downloadUrl = await createDownloadUrl(segment.r2Key);
          const response = await fetch(downloadUrl);
          if (!response.ok) throw new Error(`R2 fetch failed (${response.status})`);
          const webmBuffer = Buffer.from(await response.arrayBuffer());

          const result = await transcribeSegment(webmBuffer, segment.segmentIndex);
          transcriptParts.push(result.text);
          totalDurationSeconds += segment.durationSeconds;
        } catch (err) {
          warnings.push(`Segment ${segment.segmentIndex + 1} could not be transcribed.`);
        }
      }

      if (transcriptParts.length === 0) {
        await markSessionStatus(sessionId, 'failed', null);
        throw new GraphQLError('None of the recording could be transcribed. Nothing was saved.', {
          extensions: { code: 'TRANSCRIPTION_FAILED' },
        });
      }

      const fullTranscript = transcriptParts.join('\n\n');
      const note = await formatMeetingTranscript(fullTranscript);

      await markSessionStatus(sessionId, 'completed', totalDurationSeconds);
      await addSecondsUsed(groupId, totalDurationSeconds);

      return {
        title: note.title,
        summary: note.summary,
        cleanedTranscript: note.cleanedTranscript,
        durationSeconds: totalDurationSeconds,
        warnings,
      };
    },
  },
};

export default meetingRecordingResolvers;
```

- [ ] **Step 5: Run the tests, confirm they pass**

```bash
cd crm-proj && npx vitest run resolvers/meetingRecordingResolvers.test.js
```
Expected: PASS.

- [ ] **Step 6: Wire into `server.js`**

Add the imports alongside the other typedefs/resolvers:
```js
import meetingRecordingTypeDefs from './typedefs/meetingRecordingTypeDefs.js';
import meetingRecordingResolvers from './resolvers/meetingRecordingResolvers.js';
```

Add both to the `ApolloServer` constructor's arrays:
```js
const server = new ApolloServer({
  typeDefs: [userTypeDefs, memberTypeDefs, clientTypeDefs, taskTypeDefs, departmentTypeDefs, serviceTypeDefs, recurringTaskTypeDefs, taskStatusTypeDefs, groupTypeDefs, emailCredentialsTypeDefs, billingTypeDefs, meetingRecordingTypeDefs],
  resolvers: [userResolvers, memberResolvers, clientResolvers, taskResolvers, departmentResolvers, serviceResolvers, recurringTaskResolvers, taskStatusResolvers, groupResolvers, emailCredentialsResolvers, billingResolvers, meetingRecordingResolvers],
  plugins: [ApolloServerPluginDrainHttpServer({ httpServer }), billingLockPlugin],
});
```

- [ ] **Step 7: Run the full backend test suite**

```bash
cd crm-proj && npm test
```
Expected: PASS, all suites including this new one.

- [ ] **Step 8: Commit**

```bash
git add typedefs/meetingRecordingTypeDefs.js resolvers/meetingRecordingResolvers.js resolvers/meetingRecordingResolvers.test.js server.js
git commit -m "feat: add meeting recording GraphQL schema, resolvers, and server wiring"
```

---

## Task 9: Frontend — GraphQL query strings + thin API wrapper

**Files:**
- Modify: `crm-frontend/src/lib/queries.ts`
- Create: `crm-frontend/src/lib/meetingRecordingApi.ts`

**Interfaces:**
- Produces: `requestMeetingRecordingUploadUrl(sessionId, segmentIndex, contentType, sizeBytes): Promise<{uploadUrl, key}>`, `confirmMeetingRecordingSegment(sessionId, segmentIndex, key, sizeBytes, durationSeconds): Promise<{key, durationSeconds}>`, `finishMeetingRecording(sessionId): Promise<FinishedNote>`, `getMyAiNotesUsage(): Promise<AiNotesUsage>` from `meetingRecordingApi.ts`, used by Task 10 (hook rewrite) and Task 12 (Billing usage display).

- [ ] **Step 1: Add the GraphQL query strings to `queries.ts`**

Add near the existing `--- Billing ---` section:

```ts
// --- Meeting recording (server-side pipeline) ---
export const REQUEST_MEETING_RECORDING_UPLOAD_URL = `
  mutation RequestMeetingRecordingUploadUrl($sessionId: ID!, $segmentIndex: Int!, $contentType: String!, $sizeBytes: Int!) {
    requestMeetingRecordingUploadUrl(sessionId: $sessionId, segmentIndex: $segmentIndex, contentType: $contentType, sizeBytes: $sizeBytes) {
      uploadUrl
      key
    }
  }
`;

export const CONFIRM_MEETING_RECORDING_SEGMENT = `
  mutation ConfirmMeetingRecordingSegment($sessionId: ID!, $segmentIndex: Int!, $key: String!, $sizeBytes: Int!, $durationSeconds: Int!) {
    confirmMeetingRecordingSegment(sessionId: $sessionId, segmentIndex: $segmentIndex, key: $key, sizeBytes: $sizeBytes, durationSeconds: $durationSeconds) {
      key
      durationSeconds
    }
  }
`;

export const FINISH_MEETING_RECORDING = `
  mutation FinishMeetingRecording($sessionId: ID!) {
    finishMeetingRecording(sessionId: $sessionId) {
      title
      summary
      cleanedTranscript
      durationSeconds
      warnings
    }
  }
`;

export const MY_AI_NOTES_USAGE = `
  query MyAiNotesUsage {
    myAiNotesUsage {
      secondsUsed
      secondsLimit
      periodEnd
    }
  }
`;
```

- [ ] **Step 2: Write `src/lib/meetingRecordingApi.ts`**

```ts
import { graphqlRequest } from './graphql';
import {
  REQUEST_MEETING_RECORDING_UPLOAD_URL,
  CONFIRM_MEETING_RECORDING_SEGMENT,
  FINISH_MEETING_RECORDING,
  MY_AI_NOTES_USAGE,
} from './queries';

export interface FinishedMeetingNote {
  title: string;
  summary: string;
  cleanedTranscript: string;
  durationSeconds: number;
  warnings: string[];
}

export interface AiNotesUsage {
  secondsUsed: number;
  secondsLimit: number;
  periodEnd: string;
}

export async function requestMeetingRecordingUploadUrl(
  sessionId: string,
  segmentIndex: number,
  contentType: string,
  sizeBytes: number,
): Promise<{ uploadUrl: string; key: string }> {
  const { requestMeetingRecordingUploadUrl: result } = await graphqlRequest<{
    requestMeetingRecordingUploadUrl: { uploadUrl: string; key: string };
  }>(REQUEST_MEETING_RECORDING_UPLOAD_URL, { sessionId, segmentIndex, contentType, sizeBytes });
  return result;
}

export async function confirmMeetingRecordingSegment(
  sessionId: string,
  segmentIndex: number,
  key: string,
  sizeBytes: number,
  durationSeconds: number,
): Promise<{ key: string; durationSeconds: number }> {
  const { confirmMeetingRecordingSegment: result } = await graphqlRequest<{
    confirmMeetingRecordingSegment: { key: string; durationSeconds: number };
  }>(CONFIRM_MEETING_RECORDING_SEGMENT, { sessionId, segmentIndex, key, sizeBytes, durationSeconds });
  return result;
}

export async function finishMeetingRecording(sessionId: string): Promise<FinishedMeetingNote> {
  const { finishMeetingRecording: result } = await graphqlRequest<{
    finishMeetingRecording: FinishedMeetingNote;
  }>(FINISH_MEETING_RECORDING, { sessionId });
  return result;
}

export async function getMyAiNotesUsage(): Promise<AiNotesUsage> {
  const { myAiNotesUsage } = await graphqlRequest<{ myAiNotesUsage: AiNotesUsage }>(MY_AI_NOTES_USAGE);
  return myAiNotesUsage;
}
```

- [ ] **Step 3: Verify it compiles**

```bash
cd crm-frontend && npx tsc -b --noEmit
```
Expected: no errors (there's no automated test suite for this frontend — this is the
established convention in this repo, matching `package.json`'s scripts).

- [ ] **Step 4: Commit**

```bash
git add src/lib/queries.ts src/lib/meetingRecordingApi.ts
git commit -m "feat: add GraphQL queries and API wrapper for meeting recording pipeline"
```

---

## Task 10: Frontend — recorder hook rewrite

**Files:**
- Modify: `crm-frontend/src/hooks/useMeetingRecorder.ts`
- Modify: `crm-frontend/src/lib/recordingBuffer.ts`
- Delete: `crm-frontend/src/lib/meetingTranscription.ts`
- Delete: `crm-frontend/src/lib/audioEncoding.ts`
- Modify: `crm-frontend/vite.config.ts`

**Interfaces:**
- Consumes: `requestMeetingRecordingUploadUrl`/`confirmMeetingRecordingSegment`/`finishMeetingRecording`, `FinishedMeetingNote` (Task 9).
- Produces: `useMeetingRecorder(ownerId, onComplete: (note: FinishedMeetingNote) => void)` with the same public shape as today (`status`, `elapsedMs`, `segments`, `error`, `warning`, `tabAudioCaptured`, `start`, `stop`, `cancel`, `recoverable`, `recoverBufferedSession`, `discardBufferedSession`, `clearError`) — `formatProgress` is removed (no more multi-chunk client-visible formatting progress; Task 11 adjusts `RecordingPanel.tsx` accordingly), used by Task 11.

This is the biggest frontend change — capture logic (mic/tab-audio mixing, MediaRecorder
rollover) stays as-is; everything downstream of "a segment blob is ready" changes from
"convert to WAV and transcribe live" to "upload to R2 and confirm."

- [ ] **Step 1: Repurpose `recordingBuffer.ts` to buffer session state, not transcript text**

Replace the whole file:

```ts
// Device-local scratch buffer for an in-progress recording session.
//
// Recordings are uploaded to R2 as each segment finishes — a crashed tab loses at most
// the current unfinished segment, not the whole meeting. This buffer's job is narrower
// than it used to be: remember which session is in progress and which segments already
// made it to R2, so a reload can offer "finish with what's already uploaded" instead of
// silently losing track of an in-progress recording.

const DB_NAME = 'meeting-notes';
const DB_VERSION = 2;
const STORE = 'sessions';

export interface BufferedSession {
  sessionId: string;
  ownerId: string;
  startedAt: number;
  updatedAt: number;
  confirmedSegmentIndexes: number[];
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'sessionId' });
      }
      // v1 stored { segments: BufferedSegment[] } (transcript text) under the same
      // store name — the keyPath and store name are unchanged, so existing v1 records
      // just get overwritten by the next saveBufferedSession call rather than migrated;
      // they're finished/unreachable sessions anyway (this DB only ever holds
      // *in-progress* sessions, which don't survive a schema version bump gracefully,
      // and that's fine — the fallback is simply "no recoverable session found").
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open local storage'));
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = run(transaction.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Local storage failed'));
        transaction.oncomplete = () => db.close();
      }),
  );
}

async function silently<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch {
    return null;
  }
}

export function saveBufferedSession(session: BufferedSession): Promise<unknown> {
  return silently(() => tx('readwrite', (store) => store.put(session)));
}

export function clearBufferedSession(sessionId: string): Promise<unknown> {
  return silently(() => tx('readwrite', (store) => store.delete(sessionId)));
}

export async function findRecoverableSession(ownerId: string): Promise<BufferedSession | null> {
  const all = await silently(() => tx<BufferedSession[]>('readonly', (store) => store.getAll()));
  if (!all) return null;

  const mine = all
    .filter((s) => s.ownerId === ownerId && s.confirmedSegmentIndexes.length > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return mine[0] ?? null;
}

export async function pruneStaleSessions(maxAgeMs = 7 * 24 * 60 * 60 * 1000): Promise<void> {
  const all = await silently(() => tx<BufferedSession[]>('readonly', (store) => store.getAll()));
  if (!all) return;

  const cutoff = Date.now() - maxAgeMs;
  await Promise.all(
    all.filter((s) => s.updatedAt < cutoff).map((s) => clearBufferedSession(s.sessionId)),
  );
}
```

- [ ] **Step 2: Delete the two now-unused files**

```bash
cd crm-frontend
git rm src/lib/meetingTranscription.ts src/lib/audioEncoding.ts
```

- [ ] **Step 3: Rewrite `useMeetingRecorder.ts`**

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  clearBufferedSession,
  findRecoverableSession,
  pruneStaleSessions,
  saveBufferedSession,
  type BufferedSession,
} from '../lib/recordingBuffer';
import {
  requestMeetingRecordingUploadUrl,
  confirmMeetingRecordingSegment,
  finishMeetingRecording,
  type FinishedMeetingNote,
} from '../lib/meetingRecordingApi';

// Recording rolls over to a fresh MediaRecorder on this interval. WebM can't be split
// mid-stream into independently decodable pieces, so a "segment" means stopping one
// recorder and starting another over the same source stream — permissions aren't
// re-prompted, and each rollover costs a few inaudible milliseconds.
//
// 15 minutes, not the old 5: segments no longer need to be short for live per-segment
// transcription (that no longer happens — the whole recording is processed server-side
// after Stop). Most meetings now produce exactly one segment; this just bounds
// per-blob memory and crash-loss risk for longer ones.
const SEGMENT_MS = 15 * 60 * 1000;

const AUDIO_BITS_PER_SECOND = 32_000;

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm'];

export type RecorderStatus = 'idle' | 'starting' | 'recording' | 'finishing' | 'processing';

export interface SegmentState {
  index: number;
  status: 'uploading' | 'done' | 'failed';
}

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
}

export function canRecordAudio(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined'
  );
}

export function canCaptureTabAudio(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;
}

export function useMeetingRecorder(ownerId: string, onComplete: (note: FinishedMeetingNote) => void) {
  const [status, setStatus] = useState<RecorderStatus>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [segments, setSegments] = useState<SegmentState[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [tabAudioCaptured, setTabAudioCaptured] = useState(false);
  const [recoverable, setRecoverable] = useState<BufferedSession | null>(null);

  const micStreamRef = useRef<MediaStream | null>(null);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mixedStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const rolloverRef = useRef<number | null>(null);
  const tickRef = useRef<number | null>(null);

  const stoppedRef = useRef(false);
  const finalStopRef = useRef<(() => void) | null>(null);
  const uploadsRef = useRef<Promise<unknown>[]>([]);
  const confirmedIndexesRef = useRef<number[]>([]);
  const sessionIdRef = useRef<string>('');
  const startedAtRef = useRef(0);

  useEffect(() => {
    let active = true;
    void pruneStaleSessions().then(() => findRecoverableSession(ownerId)).then((found) => {
      if (active) setRecoverable(found);
    });
    return () => {
      active = false;
    };
  }, [ownerId]);

  const persist = useCallback(() => {
    if (!sessionIdRef.current) return;
    void saveBufferedSession({
      sessionId: sessionIdRef.current,
      ownerId,
      startedAt: startedAtRef.current,
      updatedAt: Date.now(),
      confirmedSegmentIndexes: [...confirmedIndexesRef.current],
    });
  }, [ownerId]);

  const teardownCapture = useCallback(() => {
    if (rolloverRef.current !== null) window.clearTimeout(rolloverRef.current);
    if (tickRef.current !== null) window.clearInterval(tickRef.current);
    rolloverRef.current = null;
    tickRef.current = null;

    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    displayStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    displayStreamRef.current = null;

    const ctx = audioContextRef.current;
    audioContextRef.current = null;
    if (ctx && ctx.state !== 'closed') void ctx.close();

    mixedStreamRef.current = null;
    recorderRef.current = null;
  }, []);

  // Uploads a finished segment to R2 (presigned URL, same pattern as task attachments)
  // and confirms it — the upload happens in the background while recording continues,
  // so stopping doesn't mean waiting for the last segment's upload too.
  const enqueueSegment = useCallback(
    (blob: Blob, index: number, durationMs: number) => {
      if (blob.size === 0) return;
      setSegments((prev) => [...prev, { index, status: 'uploading' }]);

      const contentType = blob.type || 'audio/webm';
      const task = requestMeetingRecordingUploadUrl(sessionIdRef.current, index, contentType, blob.size)
        .then(({ uploadUrl, key }) =>
          fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': contentType }, body: blob }).then(
            (response) => {
              if (!response.ok) throw new Error('Upload to storage failed.');
              return key;
            },
          ),
        )
        .then((key) =>
          confirmMeetingRecordingSegment(sessionIdRef.current, index, key, blob.size, Math.round(durationMs / 1000)),
        )
        .then(() => {
          confirmedIndexesRef.current.push(index);
          persist();
          setSegments((prev) => prev.map((s) => (s.index === index ? { ...s, status: 'done' } : s)));
        })
        .catch(() => {
          setSegments((prev) => prev.map((s) => (s.index === index ? { ...s, status: 'failed' } : s)));
        });

      uploadsRef.current.push(task);
    },
    [persist],
  );

  const beginSegment = useCallback(
    (index: number) => {
      const stream = mixedStreamRef.current;
      if (!stream) return;

      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
      });
      recorderRef.current = recorder;

      const parts: Blob[] = [];
      const segmentStartedAt = Date.now();
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) parts.push(event.data);
      };
      recorder.onstop = () => {
        const durationMs = Date.now() - segmentStartedAt;
        enqueueSegment(new Blob(parts, { type: mimeType || 'audio/webm' }), index, durationMs);
        if (stoppedRef.current) finalStopRef.current?.();
        else beginSegment(index + 1);
      };

      recorder.start();
      rolloverRef.current = window.setTimeout(() => {
        if (recorder.state !== 'inactive') recorder.stop();
      }, SEGMENT_MS);
    },
    [enqueueSegment],
  );

  const start = useCallback(async () => {
    if (!canRecordAudio()) {
      setError('This browser cannot record audio.');
      return;
    }

    setError(null);
    setWarning(null);
    setSegments([]);
    setTabAudioCaptured(false);
    confirmedIndexesRef.current = [];
    uploadsRef.current = [];
    stoppedRef.current = false;
    sessionIdRef.current = crypto.randomUUID();
    setStatus('starting');

    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      micStreamRef.current = mic;

      let display: MediaStream | null = null;
      if (canCaptureTabAudio()) {
        try {
          display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        } catch {
          display = null;
        }
      }
      display?.getVideoTracks().forEach((track) => track.stop());

      const tabTrack = display?.getAudioTracks()[0] ?? null;
      if (display && !tabTrack) {
        display.getTracks().forEach((track) => track.stop());
        display = null;
        setWarning(
          'Tab audio was not shared, so only your microphone is being recorded. To capture remote participants, re-share and tick "Share tab audio".',
        );
      }
      displayStreamRef.current = display;
      setTabAudioCaptured(!!tabTrack);

      tabTrack?.addEventListener('ended', () => {
        setWarning('Tab audio sharing ended — still recording your microphone.');
        setTabAudioCaptured(false);
      });

      const context = new AudioContext();
      audioContextRef.current = context;
      const destination = context.createMediaStreamDestination();
      context.createMediaStreamSource(mic).connect(destination);
      if (display && tabTrack) context.createMediaStreamSource(display).connect(destination);
      mixedStreamRef.current = destination.stream;

      startedAtRef.current = Date.now();
      setElapsedMs(0);
      tickRef.current = window.setInterval(
        () => setElapsedMs(Date.now() - startedAtRef.current),
        1000,
      );

      setStatus('recording');
      beginSegment(0);
    } catch (err) {
      teardownCapture();
      setStatus('idle');
      const message =
        err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError')
          ? 'Microphone access was denied. Allow it in your browser settings to record.'
          : 'Could not start recording.';
      setError(message);
    }
  }, [beginSegment, teardownCapture]);

  const runProcessing = useCallback(
    async (sessionId: string) => {
      setStatus('processing');
      try {
        const note = await finishMeetingRecording(sessionId);
        await clearBufferedSession(sessionId);
        setRecoverable(null);
        if (note.warnings.length > 0) {
          setWarning(note.warnings.join(' '));
        }
        onComplete(note);
        setStatus('idle');
      } catch (err) {
        // The uploaded segments stay on R2 and the session stays buffered locally, so
        // this is retryable without re-recording the meeting.
        setStatus('idle');
        setError(
          err instanceof Error ? err.message : 'Could not process the recording. Your upload is saved — try again.',
        );
        void findRecoverableSession(ownerId).then(setRecoverable);
      }
    },
    [onComplete, ownerId],
  );

  const stop = useCallback(async () => {
    if (status !== 'recording') return;
    setStatus('finishing');
    stoppedRef.current = true;

    if (rolloverRef.current !== null) window.clearTimeout(rolloverRef.current);
    if (tickRef.current !== null) window.clearInterval(tickRef.current);

    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        finalStopRef.current = resolve;
        recorder.stop();
      });
    }

    teardownCapture();
    await Promise.allSettled(uploadsRef.current);

    if (confirmedIndexesRef.current.length === 0) {
      setStatus('idle');
      setError('None of the recording could be uploaded. Nothing was saved.');
      return;
    }

    const failed = uploadsRef.current.length - confirmedIndexesRef.current.length;
    if (failed > 0) {
      setWarning(
        `${failed} of ${uploadsRef.current.length} segments could not be uploaded — the notes below are missing those stretches.`,
      );
    }

    await runProcessing(sessionIdRef.current);
  }, [runProcessing, status, teardownCapture]);

  const cancel = useCallback(() => {
    stoppedRef.current = true;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    teardownCapture();
    if (sessionIdRef.current) void clearBufferedSession(sessionIdRef.current);
    confirmedIndexesRef.current = [];
    uploadsRef.current = [];
    setSegments([]);
    setElapsedMs(0);
    setStatus('idle');
  }, [teardownCapture]);

  const recoverBufferedSession = useCallback(async () => {
    if (!recoverable) return;
    sessionIdRef.current = recoverable.sessionId;
    await runProcessing(recoverable.sessionId);
  }, [recoverable, runProcessing]);

  const discardBufferedSession = useCallback(async () => {
    if (!recoverable) return;
    await clearBufferedSession(recoverable.sessionId);
    setRecoverable(null);
  }, [recoverable]);

  useEffect(() => teardownCapture, [teardownCapture]);

  return {
    status,
    elapsedMs,
    segments,
    error,
    warning,
    tabAudioCaptured,
    recoverable,
    start,
    stop,
    cancel,
    recoverBufferedSession,
    discardBufferedSession,
    clearError: () => setError(null),
  };
}
```

- [ ] **Step 4: Remove the now-unused dev proxy from `vite.config.ts`**

Remove the entire `/api/fish` proxy block and the entire `/api/anthropic` proxy block
from `server.proxy` in `vite.config.ts` (both are no longer used — Fish/Anthropic calls
happen backend-side now, not proxied through the frontend dev server). Leave the
`FISH_API_KEY`/`ANTHROPIC_API_KEY` lines in `loadEnv`'s comment context alone if that
comment references other things too; just delete the two `"/api/fish": {...}` and
`"/api/anthropic": {...}` proxy entries themselves.

- [ ] **Step 5: Verify it compiles**

```bash
cd crm-frontend && npx tsc -b --noEmit
```
Expected: errors in `RecordingPanel.tsx` (still references the old `formatProgress`
field and `FormattedNote` type) — that's expected, Task 11 fixes it. Confirm the errors
are confined to that one file.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useMeetingRecorder.ts src/lib/recordingBuffer.ts vite.config.ts
git rm src/lib/meetingTranscription.ts src/lib/audioEncoding.ts
git commit -m "feat: rewrite recorder hook for server-side transcription pipeline"
```

---

## Task 11: Frontend — `RecordingPanel.tsx` UI + usage indicator

**Files:**
- Modify: `crm-frontend/src/components/notes/RecordingPanel.tsx`
- Modify: `crm-frontend/src/components/notes/NotesView.tsx`

**Interfaces:**
- Consumes: `useMeetingRecorder` (Task 10, new `RecorderStatus`/`SegmentState` shapes), `getMyAiNotesUsage` (Task 9).

- [ ] **Step 1: Update `RecordingPanel.tsx`**

Replace the whole file:

```tsx
import { useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import { Banner } from '../ui/Banner';
import { IconMic, IconStop } from '../layout/icons';
import {
  canCaptureTabAudio,
  canRecordAudio,
  useMeetingRecorder,
} from '../../hooks/useMeetingRecorder';
import { getMyAiNotesUsage, type FinishedMeetingNote, type AiNotesUsage } from '../../lib/meetingRecordingApi';

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatHours(seconds: number): string {
  const hours = seconds / 3600;
  return hours >= 10 ? Math.round(hours).toString() : hours.toFixed(1);
}

export function RecordingPanel({
  ownerId,
  onNoteReady,
}: {
  ownerId: string;
  onNoteReady: (note: FinishedMeetingNote) => void;
}) {
  const recorder = useMeetingRecorder(ownerId, onNoteReady);
  const { status, elapsedMs, segments, error, warning, tabAudioCaptured, recoverable } = recorder;

  const [usage, setUsage] = useState<AiNotesUsage | null>(null);

  useEffect(() => {
    void getMyAiNotesUsage()
      .then(setUsage)
      .catch(() => setUsage(null));
  }, [status === 'idle']);

  if (!canRecordAudio()) return null;

  const busy = status === 'finishing' || status === 'processing';
  const done = segments.filter((s) => s.status === 'done').length;
  const failed = segments.filter((s) => s.status === 'failed').length;
  const overQuota = usage ? usage.secondsUsed >= usage.secondsLimit : false;

  return (
    <div className="mb-3 rounded-2xl border border-ink/[0.08] bg-ink/[0.02] p-3 dark:border-white/10 dark:bg-white/[0.03]">
      {status === 'idle' && (
        <>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[13.5px] font-medium text-ink dark:text-white">Record a meeting</p>
              <p className="mt-0.5 text-[12px] text-ink/45 dark:text-white/45">
                {canCaptureTabAudio()
                  ? 'Captures your mic and the meeting tab, then writes up the notes.'
                  : 'Captures your microphone, then writes up the notes.'}
              </p>
            </div>
            <Button
              size="sm"
              icon={<IconMic className="h-4 w-4" />}
              onClick={() => void recorder.start()}
              disabled={overQuota}
            >
              Record
            </Button>
          </div>

          {!canCaptureTabAudio() && (
            <p className="mt-2 text-[11.5px] text-ink/40 dark:text-white/40">
              This browser can't capture tab audio — remote participants won't be recorded. Chrome
              or Edge on desktop can.
            </p>
          )}

          {usage && (
            <p className="mt-2 text-[11.5px] text-ink/40 dark:text-white/40">
              {formatHours(usage.secondsUsed)} of {formatHours(usage.secondsLimit)} hrs used this month
              {overQuota ? ' — upgrade your plan to record more.' : ''}
            </p>
          )}
        </>
      )}

      {status === 'starting' && (
        <p className="text-[13px] text-ink/60 dark:text-white/60">Waiting for permissions…</p>
      )}

      {status === 'recording' && (
        <div>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500/60" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
              </span>
              <span className="font-mono text-[15px] font-medium tabular-nums text-ink dark:text-white">
                {formatElapsed(elapsedMs)}
              </span>
              <span className="text-[12px] text-ink/45 dark:text-white/45">
                {tabAudioCaptured ? 'Mic + tab audio' : 'Mic only'}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant="ghost" onClick={recorder.cancel}>
                Discard
              </Button>
              <Button
                size="sm"
                variant="danger"
                icon={<IconStop className="h-3.5 w-3.5" />}
                onClick={() => void recorder.stop()}
              >
                Stop
              </Button>
            </div>
          </div>

          {segments.length > 0 && (
            <p className="mt-2 text-[11.5px] text-ink/45 dark:text-white/45">
              {done} of {segments.length} segments uploaded
              {failed > 0 ? ` · ${failed} failed` : ''}
            </p>
          )}
        </div>
      )}

      {busy && (
        <div className="flex items-center gap-2.5">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent text-ink/40 dark:text-white/40" />
          <p className="text-[13px] text-ink/60 dark:text-white/60">
            {status === 'finishing' ? 'Finishing upload…' : 'Transcribing and organizing notes…'}
          </p>
        </div>
      )}

      {recoverable && status === 'idle' && (
        <div className="mt-2.5 rounded-xl bg-accent-500/10 px-3 py-2.5">
          <p className="text-[12.5px] font-medium text-accent-600 dark:text-accent-400">
            An unfinished recording from{' '}
            {new Date(recoverable.startedAt).toLocaleString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}{' '}
            is still on this device.
          </p>
          <div className="mt-2 flex gap-1.5">
            <Button size="sm" onClick={() => void recorder.recoverBufferedSession()}>
              Write it up
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void recorder.discardBufferedSession()}>
              Discard
            </Button>
          </div>
        </div>
      )}

      {warning && (
        <div className="mt-2.5">
          <Banner tone="info">{warning}</Banner>
        </div>
      )}
      {error && (
        <div className="mt-2.5">
          <Banner tone="error">{error}</Banner>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Update `NotesView.tsx`'s note-opening flow**

`openGeneratedNote` currently takes a `FormattedNote` (`{title, html}`). Update it to
take a `FinishedMeetingNote` and compose the summary + cleaned transcript into the
editor's HTML:

```tsx
import type { FinishedMeetingNote } from '../../lib/meetingRecordingApi';
```

Replace the old `import type { FormattedNote } from '../../lib/meetingTranscription';`
with the line above, and replace `openGeneratedNote`'s body:

```tsx
  function openGeneratedNote(note: FinishedMeetingNote) {
    setActiveId(NEW);
    setTitle(note.title);
    setHtml(sanitizeHtml(`${note.summary}\n${note.cleanedTranscript}`));
    setEditorKey((k) => k + 1);
    setSaveError(null);
  }
```

Update the `RecordingPanel` prop type reference (`onNoteReady={openGeneratedNote}`
already matches by inference — no change needed there since TypeScript infers the
parameter type from usage).

- [ ] **Step 3: Verify it compiles**

```bash
cd crm-frontend && npx tsc -b --noEmit
```
Expected: no errors.

- [ ] **Step 4: Verify in the browser**

```bash
cd crm-frontend && npm run dev
```
Sign in as an admin, open Meeting Notes, confirm the "Record a meeting" panel renders
with the usage line, and that clicking Record requests mic permission (full recording
verification needs a real session — Task 13 covers that).

- [ ] **Step 5: Commit**

```bash
git add src/components/notes/RecordingPanel.tsx src/components/notes/NotesView.tsx
git commit -m "feat: update recording panel UI and note-opening flow for new pipeline"
```

---

## Task 12: Frontend — Billing page usage display

**Files:**
- Modify: `crm-frontend/src/pages/Billing.tsx`

**Interfaces:**
- Consumes: `getMyAiNotesUsage` (Task 9).

- [ ] **Step 1: Add the AI-notes usage fetch and display**

Add the import:
```tsx
import { getMyAiNotesUsage, type AiNotesUsage } from '../lib/meetingRecordingApi';
```

Add state and a fetch effect near the other billing state in the `Billing` component:
```tsx
  const [aiNotesUsage, setAiNotesUsage] = useState<AiNotesUsage | null>(null);

  useEffect(() => {
    if (!billing?.plan) return;
    void getMyAiNotesUsage()
      .then(setAiNotesUsage)
      .catch(() => setAiNotesUsage(null));
  }, [billing?.plan]);
```

Add a third usage line in the existing Usage section, right after the storage-used
paragraph:
```tsx
            {aiNotesUsage && (
              <p className="mt-1 text-sm text-ink/70 dark:text-white/70">
                {(aiNotesUsage.secondsUsed / 3600).toFixed(1)} of{' '}
                {(aiNotesUsage.secondsLimit / 3600).toFixed(0)} hrs of AI meeting notes used this month
              </p>
            )}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd crm-frontend && npx tsc -b --noEmit
```
Expected: no errors.

- [ ] **Step 3: Verify in the browser**

```bash
cd crm-frontend && npm run dev
```
Sign in as an admin with an active plan, open Billing, confirm the new usage line
renders alongside admins-used and storage-used.

- [ ] **Step 4: Commit**

```bash
git add src/pages/Billing.tsx
git commit -m "feat: show AI meeting-notes usage on the Billing page"
```

---

## Task 13: End-to-end verification

**Files:** none (manual/live verification only)

This task cannot be meaningfully unit-tested — it verifies the real pipeline (real
ffmpeg transcoding, real Fish Audio ASR, real Claude Haiku call) produces a usable
result, the same way Paddle's sandbox checkout needed a real live test.

- [ ] **Step 1: Start both dev servers**

```bash
cd crm-proj && npm run dev
```
```bash
cd crm-frontend && npm run dev
```

- [ ] **Step 2: Record a short real test meeting**

Sign in as an admin, open Meeting Notes, click Record, speak a few sentences covering
2-3 distinct topics (e.g., "First, let's talk about the Q3 roadmap... Second, we need
to discuss the hiring plan... Finally, any blockers?"), then Stop.

- [ ] **Step 3: Confirm the pipeline runs end-to-end**

Confirm: the panel shows "Transcribing and organizing notes…", then a generated note
opens with a plausible title, a short summary paragraph, and a chronological outline
roughly matching what was said. Check the backend's console output for any ffmpeg or
Fish Audio errors during this run.

- [ ] **Step 4: Confirm usage was recorded**

Reopen Meeting Notes (or Billing) and confirm the usage line now shows a nonzero
duration reflecting the test recording's length.

- [ ] **Step 5: Confirm quota enforcement**

Using `psql`/the same `node -e` pattern used elsewhere in this project, manually set
that group's `group_ai_notes_usage.seconds_used` to a value at or above
`aiNotesHoursPerMonth * 3600` for its plan, then confirm clicking Record shows the
disabled state and the upgrade-plan messaging. Reset it back afterward if this was
tested against real account data.

- [ ] **Step 6: Report results**

Summarize what was verified (transcript quality, summary quality, usage tracking,
quota enforcement) and flag anything that didn't work as expected before considering
this plan done.
