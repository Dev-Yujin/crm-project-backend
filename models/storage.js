import { pool } from '../config/supabase.js';

// Reads a group's running storage usage, lazily creating the row (starting at 0
// bytes) the first time this group ever touches storage — same lazy-provision
// pattern as models/billing.js's getOrCreateBilling.
export async function getOrCreateStorageUsage(groupId) {
  const existing = await pool.query('SELECT bytes_used FROM group_storage WHERE group_id = $1', [groupId]);
  if (existing.rows.length > 0) {
    return Number(existing.rows[0].bytes_used);
  }

  const inserted = await pool.query(
    `INSERT INTO group_storage (group_id, bytes_used)
     VALUES ($1, 0)
     ON CONFLICT (group_id) DO NOTHING
     RETURNING bytes_used`,
    [groupId],
  );

  if (inserted.rows.length > 0) {
    return Number(inserted.rows[0].bytes_used);
  }

  // Lost the insert race — a concurrent request created the row first.
  const raced = await pool.query('SELECT bytes_used FROM group_storage WHERE group_id = $1', [groupId]);
  return Number(raced.rows[0].bytes_used);
}

// Adds deltaBytes (may be negative, e.g. when a file is removed or replaced with a
// smaller one) to a group's running total. Clamps at 0 — a delete racing ahead of
// its own create, or accumulated rounding, should never push this negative.
export async function adjustBytesUsed(groupId, deltaBytes) {
  await getOrCreateStorageUsage(groupId);
  await pool.query(
    `UPDATE group_storage
     SET bytes_used = GREATEST(0, bytes_used + $1), updated_at = now()
     WHERE group_id = $2`,
    [deltaBytes, groupId],
  );
}
