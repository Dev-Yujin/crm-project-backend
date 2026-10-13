// One-time setup: creates the table backing private 1:1 chat (admin↔admin, admin↔member,
// member↔member). Messages live here rather than in Firebase RTDB because RTDB is
// world-readable — only content-free "you have a new message" pings go there.
// Idempotent — IF NOT EXISTS guards make a second run a no-op.
//
// Usage: node scripts/create-direct-messages-table.js

import { pool } from "../config/supabase.js";

async function main() {
  console.log("Creating direct_messages table (if missing)...");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS direct_messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      group_id text NOT NULL,
      conversation_key text NOT NULL,
      sender_key text NOT NULL,
      recipient_key text NOT NULL,
      sender_name text NOT NULL,
      body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
      created_at timestamptz NOT NULL DEFAULT now(),
      read_at timestamptz
    )
  `);

  // Thread reads: one conversation, newest first.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS direct_messages_conversation_idx
      ON direct_messages (group_id, conversation_key, created_at DESC)
  `);

  // Unread counts: messages addressed to someone that they haven't read.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS direct_messages_unread_idx
      ON direct_messages (group_id, recipient_key)
      WHERE read_at IS NULL
  `);

  const check = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'direct_messages'
  `);
  console.log(check.rows.length === 1 ? "Done — direct_messages exists." : "Something went wrong — table not found.");

  await pool.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
