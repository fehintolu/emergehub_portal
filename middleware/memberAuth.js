const { pool } = require('../lib/db');

async function loadMember(req, res, next) {
  if (!req.session.memberId) {
    res.locals.currentMember = null;
    return next();
  }
  const { rows } = await pool.query(
    `SELECT * FROM members WHERE id = $1 AND deleted_at IS NULL`,
    [req.session.memberId]
  );
  res.locals.currentMember = rows[0] || null;
  next();
}

function requireMember(req, res, next) {
  if (!req.session.memberId || !res.locals.currentMember) {
    return res.redirect('/auth/login?next=' + encodeURIComponent(req.originalUrl || '/'));
  }
  if (res.locals.currentMember.suspended_at) {
    return res.status(403).send('Your account is suspended. Please contact EmergeHub.');
  }
  next();
}

function requireVerifiedEmail(req, res, next) {
  const m = res.locals.currentMember;
  if (!m) return res.redirect('/auth/login');
  if (m.email_verified_at) return next();
  const p = (req.originalUrl || req.url || '').split('?')[0];
  if (
    p.startsWith('/settings') ||
    p.startsWith('/auth/logout') ||
    p.startsWith('/auth/resend-verification') ||
    p.startsWith('/auth/verify-required')
  ) {
    return next();
  }
  return res.redirect('/auth/verify-required');
}

module.exports = { loadMember, requireMember, requireVerifiedEmail };
