const { pool } = require('../lib/db');

async function loadAdmin(req, res, next) {
  if (!req.session.adminId) {
    res.locals.currentAdmin = null;
    return next();
  }
  const { rows } = await pool.query(
    `SELECT id, username, email, must_change_password, active
     FROM portal_admin_users WHERE id = $1 AND deleted_at IS NULL`,
    [req.session.adminId]
  );
  res.locals.currentAdmin = rows[0] || null;
  if (res.locals.currentAdmin && !res.locals.currentAdmin.active) {
    res.locals.currentAdmin = null;
    req.session.adminId = null;
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.adminId || !res.locals.currentAdmin) {
    return res.redirect('/admin/login?next=' + encodeURIComponent(req.originalUrl || '/admin'));
  }
  if (res.locals.currentAdmin.must_change_password) {
    const p = req.path || '';
    if (p === '/change-password' || p === '/logout') return next();
    return res.redirect('/admin/change-password');
  }
  next();
}

module.exports = { loadAdmin, requireAdmin };
