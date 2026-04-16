const { pool } = require('./db');

async function logActivity(
  { memberId, eventType, title, body, entityType, entityId },
  client = null
) {
  const q = client || pool;
  await q.query(
    `INSERT INTO portal_activity_events (member_id, event_type, title, body, entity_type, entity_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [memberId || null, eventType, title, body || null, entityType || null, entityId || null]
  );
}

async function recentActivityForMember(memberId, limit = 10) {
  const { rows } = await pool.query(
    `SELECT id, event_type, title, body, entity_type, entity_id, created_at
     FROM portal_activity_events
     WHERE member_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [memberId, limit]
  );
  return rows;
}

module.exports = { logActivity, recentActivityForMember };
