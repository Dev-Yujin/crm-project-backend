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
