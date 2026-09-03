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
