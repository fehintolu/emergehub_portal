const { pool } = require('../lib/db');

function trackMemberSession(req, res, next) {
  if (!req.sessionID || !req.session.memberId) return next();
  const sid = req.sessionID;
  const memberId = req.session.memberId;
  const ua = req.get('user-agent') || '';
  const ip = req.ip || '';
  pool
    .query(
      `INSERT INTO member_tracked_sessions (member_id, session_sid, user_agent, ip_address)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (session_sid) DO UPDATE SET last_seen_at = now()`,
      [memberId, sid, ua, ip]
    )
    .catch(() => {});
  next();
}

module.exports = { trackMemberSession };
