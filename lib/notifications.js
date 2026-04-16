const { pool } = require('./db');

async function notifyMember(
  { memberId, title, message, linkUrl },
  client = null
) {
  const q = client || pool;
  await q.query(
    `INSERT INTO member_notifications (member_id, title, message, link_url)
     VALUES ($1, $2, $3, $4)`,
    [memberId, title, message, linkUrl || null]
  );
}

async function unreadCount(memberId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM member_notifications
     WHERE member_id = $1 AND read_at IS NULL AND deleted_at IS NULL`,
    [memberId]
  );
  return rows[0].c;
}

async function recentForMember(memberId, limit = 15) {
  const { rows } = await pool.query(
    `SELECT id, title, message, link_url, read_at, created_at
     FROM member_notifications
     WHERE member_id = $1 AND deleted_at IS NULL
     ORDER BY created_at DESC
     LIMIT $2`,
    [memberId, limit]
  );
  return rows;
}

async function markAllRead(memberId) {
  await pool.query(
    `UPDATE member_notifications SET read_at = now(), updated_at = now()
     WHERE member_id = $1 AND read_at IS NULL AND deleted_at IS NULL`,
    [memberId]
  );
}

async function markRead(memberId, id) {
  await pool.query(
    `UPDATE member_notifications SET read_at = now(), updated_at = now()
     WHERE id = $1 AND member_id = $2 AND deleted_at IS NULL`,
    [id, memberId]
  );
}

module.exports = {
  notifyMember,
  unreadCount,
  recentForMember,
  markAllRead,
  markRead,
};
