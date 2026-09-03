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
