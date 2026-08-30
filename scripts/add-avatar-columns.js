// One-time setup: adds the avatar_base64 columns backing the admin/member profile-picture
// feature (see docs/superpowers/specs/2026-08-30-profile-avatar-design.md). Idempotent —
// IF NOT EXISTS guards make a second run a no-op.
//
// Usage: node scripts/add-avatar-columns.js

import { pool } from "../config/supabase.js";

async function main() {
  console.log("Adding groups.avatar_base64 (if missing)...");
  await pool.query('ALTER TABLE groups ADD COLUMN IF NOT EXISTS avatar_base64 text');

  console.log("Adding members.avatar_base64 (if missing)...");
  await pool.query('ALTER TABLE members ADD COLUMN IF NOT EXISTS avatar_base64 text');

  const check = await pool.query(`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'avatar_base64'
    ORDER BY table_name
  `);
  console.log(
    "avatar_base64 now present on:",
    check.rows.map((r) => r.table_name).join(', ') || '(none — something went wrong)',
  );

  await pool.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
