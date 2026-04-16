const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { pool } = require('../lib/db');
const { requireValidCsrf } = require('../lib/csrf');

const router = express.Router();
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 40 });

router.get('/login', limiter, (req, res) => {
  if (req.session.adminId) return res.redirect('/admin');
  res.render('admin/login', {
    layout: 'layouts/admin-auth',
    title: 'Admin sign in',
    error: null,
    next: req.query.next || '/admin',
  });
});

router.post('/login', limiter, requireValidCsrf, async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const next = String(req.body.next || '/admin');
  const { rows } = await pool.query(
    `SELECT * FROM portal_admin_users
     WHERE username = $1 AND deleted_at IS NULL AND active = true`,
    [username]
  );
  const a = rows[0];
  if (!a || !(await bcrypt.compare(password, a.password_hash))) {
    return res.status(401).render('admin/login', {
      layout: 'layouts/admin-auth',
      title: 'Admin sign in',
      error: 'Invalid credentials.',
      next,
    });
  }
  req.session.adminId = a.id;
  res.redirect(next.startsWith('/admin') ? next : '/admin');
});

router.post('/logout', requireValidCsrf, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('portal.admin.sid');
    res.redirect('/admin/login');
  });
});

router.get('/change-password', async (req, res) => {
  if (!req.session.adminId) return res.redirect('/admin/login');
  res.render('admin/change-password', {
    layout: 'layouts/admin-auth',
    title: 'Change password',
    error: null,
  });
});

router.post('/change-password', requireValidCsrf, async (req, res) => {
  if (!req.session.adminId) return res.redirect('/admin/login');
  const p1 = String(req.body.password || '');
  const p2 = String(req.body.password2 || '');
  if (p1.length < 8 || p1 !== p2) {
    return res.status(400).render('admin/change-password', {
      layout: 'layouts/admin-auth',
      title: 'Change password',
      error: 'Passwords must match and be at least 8 characters.',
    });
  }
  const hash = await bcrypt.hash(p1, 10);
  await pool.query(
    `UPDATE portal_admin_users SET password_hash = $2, must_change_password = false, updated_at = now() WHERE id = $1`,
    [req.session.adminId, hash]
  );
  res.redirect('/admin');
});

module.exports = router;
