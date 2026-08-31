// One-time setup: creates the group_storage table backing the R2 task-attachments
// feature (see docs/superpowers/specs/2026-08-31-r2-task-attachments-design.md).
// Idempotent — IF NOT EXISTS guards make a second run a no-op.
//
// Usage: node scripts/create-group-storage-table.js

import { pool } from "../config/supabase.js";

async function main() {
  console.log("Creating group_storage table (if missing)...");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS group_storage (
      group_id uuid PRIMARY KEY,
      bytes_used bigint NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const check = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'group_storage'
  `);
  console.log(
    check.rows.length > 0
      ? "Done — group_storage table exists."
      : "Something went wrong — group_storage table was not found after creation.",
  );
  await pool.end();
}

main().catch((err) => {
  console.error("Failed to create group_storage table:", err);
  process.exit(1);
});
