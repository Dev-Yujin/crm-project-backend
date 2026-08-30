// One-time backfill: run this ONCE, at/immediately before deploying billing lockout
// enforcement, before any group_billing row could otherwise be lazily created (see
// models/billing.js's getOrCreateBilling) with a trial_ends_at based on a group's real,
// possibly months-old signup date. Gives every group that already exists as of this run
// a fresh 14-day trial starting now. Groups created AFTER this runs are unaffected — they
// go through the normal lazy-provisioning path, which is correct for a genuinely new group.
//
// Idempotent: ON CONFLICT (group_id) DO NOTHING, so re-running only backfills groups that
// still have no billing row (e.g. new groups created between runs, or if the first run was
// interrupted) — it never overwrites a row that already exists, whether from a prior run of
// this script or from real usage.
//
// Usage: node scripts/backfill-existing-groups-trial.js

import { pool } from "../config/supabase.js";

const TRIAL_DAYS = 14;

async function main() {
  const groups = await pool.query('SELECT DISTINCT "groupId" FROM groups');
  console.log(`Found ${groups.rows.length} distinct existing group(s).`);

  let inserted = 0;
  for (const { groupId } of groups.rows) {
    const result = await pool.query(
      `INSERT INTO group_billing (group_id, status, trial_ends_at)
       VALUES ($1, 'trialing', now() + make_interval(days => $2))
       ON CONFLICT (group_id) DO NOTHING
       RETURNING group_id`,
      [groupId, TRIAL_DAYS],
    );
    if (result.rows.length > 0) inserted++;
  }

  console.log(
    `Backfilled ${inserted} group(s) with a fresh ${TRIAL_DAYS}-day trial. ${groups.rows.length - inserted} already had a billing row (skipped).`,
  );
  await pool.end();
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
