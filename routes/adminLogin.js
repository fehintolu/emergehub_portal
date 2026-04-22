const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { pool } = require('../lib/db');
const { requireValidCsrf } = require('../lib/csrf');
const { sendAdminPasswordResetEmail } = require('../lib/mail');

const router = express.Router();
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 40 });
const forgotResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

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

router.get('/forgot-password', forgotResetLimiter, (req, res) => {
  if (req.session.adminId) return res.redirect('/admin');
  res.render('admin/forgot-password', {
    layout: 'layouts/admin-auth',
    title: 'Forgot admin password',
    error: null,
    sent: false,
  });
});

router.post('/forgot-password', forgotResetLimiter, requireValidCsrf, async (req, res) => {
  if (req.session.adminId) return res.redirect('/admin');
  const identifier = String(req.body.identifier || '').trim();
  const identLower = identifier.toLowerCase();
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 60 * 60 * 1000);

  const { rows } = await pool.query(
    `SELECT id, email, username FROM portal_admin_users
     WHERE deleted_at IS NULL AND active = true
       AND (lower(trim(username)) = $1 OR lower(trim(email)) = $1)`,
    [identLower]
  );
  const a = rows[0];
  if (a) {
    await pool.query(
      `UPDATE portal_admin_users
       SET password_reset_token = $2, password_reset_expires = $3, updated_at = now()
       WHERE id = $1`,
      [a.id, token, expires]
    );
    const base = process.env.BASE_URL || '';
    await sendAdminPasswordResetEmail({
      to: a.email,
      username: a.username,
      resetUrl: `${base}/admin/reset-password?token=${encodeURIComponent(token)}`,
    });
  }

  return res.render('admin/forgot-password', {
    layout: 'layouts/admin-auth',
    title: 'Forgot admin password',
    error: null,
    sent: true,
  });
});

router.get('/reset-password', (req, res) => {
  if (req.session.adminId) return res.redirect('/admin');
  const token = String(req.query.token || '').trim();
  res.render('admin/reset-password', {
    layout: 'layouts/admin-auth',
    title: 'Set new admin password',
    error: token ? null : 'Missing reset token. Open the link from your email, or request a new reset from the sign-in page.',
    token,
  });
});

router.post('/reset-password', forgotResetLimiter, requireValidCsrf, async (req, res) => {
  if (req.session.adminId) return res.redirect('/admin');
  const token = String(req.body.token || '');
  const p1 = String(req.body.password || '');
  const p2 = String(req.body.password2 || '');
  if (p1.length < 8 || p1 !== p2) {
    return res.status(400).render('admin/reset-password', {
      layout: 'layouts/admin-auth',
      title: 'Set new admin password',
      error: 'Passwords must match and be at least 8 characters.',
      token,
    });
  }
  const { rows } = await pool.query(
    `SELECT id FROM portal_admin_users
     WHERE password_reset_token = $1 AND password_reset_expires > now() AND deleted_at IS NULL`,
    [token]
  );
  if (!rows[0]) {
    return res.status(400).render('admin/reset-password', {
      layout: 'layouts/admin-auth',
      title: 'Set new admin password',
      error: 'This reset link is invalid or has expired.',
      token,
    });
  }
  const hash = await bcrypt.hash(p1, 10);
  await pool.query(
    `UPDATE portal_admin_users
     SET password_hash = $2,
         password_reset_token = NULL,
         password_reset_expires = NULL,
         must_change_password = false,
         updated_at = now()
     WHERE id = $1`,
    [rows[0].id, hash]
  );
  return res.render('admin/reset-done', {
    layout: 'layouts/admin-auth',
    title: 'Password updated',
  });
});

module.exports = router;
