const { pool } = require('../lib/db');

/**
 * Sets path + optional counts for member shell (sidebar active state, badges).
 */
async function memberLayoutLocals(req, res, next) {
  res.locals.memberPath = req.path || '';
  const m = res.locals.currentMember;
  if (!m) return next();
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS c FROM service_requests
       WHERE member_id = $1 AND deleted_at IS NULL
       AND status NOT IN ('Completed','Cancelled')`,
      [m.id]
    );
    res.locals.serviceNavBadge = rows[0].c;
  } catch {
    res.locals.serviceNavBadge = 0;
  }
  next();
}

module.exports = { memberLayoutLocals };
