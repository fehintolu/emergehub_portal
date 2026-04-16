const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { pool } = require('../lib/db');
const { requireValidCsrf } = require('../lib/csrf');
const {
  sendVerificationEmail,
  sendPasswordResetEmail,
} = require('../lib/mail');
const { unreadCount } = require('../lib/notifications');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
});

router.get('/login', loginLimiter, (req, res) => {
  if (req.session.memberId) return res.redirect('/dashboard');
  res.render('auth/login', {
    layout: 'layouts/auth',
    title: 'Member sign in',
    error: null,
    next: req.query.next || '',
  });
});

router.post('/login', loginLimiter, requireValidCsrf, async (req, res) => {
  const email = String(req.body.email || '')
    .trim()
    .toLowerCase();
  const password = String(req.body.password || '');
  const next = String(req.body.next || '/dashboard');
  try {
    const { rows } = await pool.query(
      `SELECT * FROM members WHERE lower(email) = $1 AND deleted_at IS NULL`,
      [email]
    );
    const m = rows[0];
    if (!m || !(await bcrypt.compare(password, m.password_hash))) {
      return res.status(401).render('auth/login', {
        layout: 'layouts/auth',
        title: 'Member sign in',
        error: 'Invalid email or password.',
        next,
      });
    }
    if (m.suspended_at) {
      return res.status(403).render('auth/login', {
        layout: 'layouts/auth',
        title: 'Member sign in',
        error: 'This account is suspended.',
        next,
      });
    }
    req.session.memberId = m.id;
    return res.redirect(next.startsWith('/') ? next : '/dashboard');
  } catch (e) {
    console.error(e);
    return res.status(500).render('auth/login', {
      layout: 'layouts/auth',
      title: 'Member sign in',
      error: 'Something went wrong. Try again.',
      next,
    });
  }
});

router.post('/logout', requireValidCsrf, (req, res) => {
  const sid = req.sessionID;
  req.session.destroy(async () => {
    if (sid) {
      await pool
        .query('DELETE FROM member_tracked_sessions WHERE session_sid = $1', [
          sid,
        ])
        .catch(() => {});
    }
    res.clearCookie('portal.member.sid');
    res.redirect('/auth/login');
  });
});

router.get('/register', registerLimiter, (req, res) => {
  if (req.session.memberId) return res.redirect('/dashboard');
  res.render('auth/register', {
    layout: 'layouts/auth',
    title: 'Create account',
    error: null,
    values: {},
  });
});

router.post('/register', registerLimiter, requireValidCsrf, async (req, res) => {
  const full_name = String(req.body.full_name || '').trim();
  const email = String(req.body.email || '')
    .trim()
    .toLowerCase();
  const phone = String(req.body.phone || '').trim();
  const business_name = String(req.body.business_name || '').trim() || null;
  const password = String(req.body.password || '');
  const values = { full_name, email, phone, business_name };

  if (password.length < 8) {
    return res.status(400).render('auth/register', {
      layout: 'layouts/auth',
      title: 'Create account',
      error: 'Password must be at least 8 characters.',
      values,
    });
  }
  if (!full_name || !email || !phone) {
    return res.status(400).render('auth/register', {
      layout: 'layouts/auth',
      title: 'Create account',
      error: 'Please fill all required fields.',
      values,
    });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 48 * 3600 * 1000);
  const hash = await bcrypt.hash(password, 10);

  try {
    const { rows } = await pool.query(
      `INSERT INTO members (email, password_hash, full_name, phone, business_name, email_verification_token, email_verification_expires)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [email, hash, full_name, phone, business_name, token, expires]
    );
    const base = process.env.BASE_URL || '';
    await sendVerificationEmail({
      to: email,
      name: full_name,
      verifyUrl: `${base}/auth/verify?token=${encodeURIComponent(token)}`,
    });
    return res.render('auth/register-done', {
      layout: 'layouts/auth',
      title: 'Check your email',
    });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(400).render('auth/register', {
        layout: 'layouts/auth',
        title: 'Create account',
        error: 'An account with this email already exists.',
        values,
      });
    }
    console.error(e);
    return res.status(500).render('auth/register', {
      layout: 'layouts/auth',
      title: 'Create account',
      error: 'Could not create account. Try again later.',
      values,
    });
  }
});

router.get('/verify', async (req, res) => {
  const token = String(req.query.token || '');
  if (!token) return res.redirect('/auth/login');
  const { rows } = await pool.query(
    `SELECT id FROM members
     WHERE email_verification_token = $1 AND email_verification_expires > now() AND deleted_at IS NULL`,
    [token]
  );
  if (!rows[0]) {
    return res.render('auth/message', {
      layout: 'layouts/auth',
      title: 'Invalid link',
      message: 'This verification link is invalid or has expired.',
    });
  }
  await pool.query(
    `UPDATE members SET email_verified_at = now(), email_verification_token = NULL,
     email_verification_expires = NULL, updated_at = now() WHERE id = $1`,
    [rows[0].id]
  );
  return res.render('auth/message', {
    layout: 'layouts/auth',
    title: 'Email verified',
    message: 'Your email is verified. You can sign in.',
    link: '/auth/login',
    linkLabel: 'Sign in',
  });
});

router.get('/verify-required', async (req, res) => {
  if (!req.session.memberId) return res.redirect('/auth/login');
  let notifCount = 0;
  try {
    notifCount = await unreadCount(req.session.memberId);
  } catch {
    /* ignore */
  }
  res.render('auth/verify-required', {
    layout: 'layouts/member',
    title: 'Verify your email',
    mail: req.query.mail || '',
    code: String(req.query.code || ''),
    notifCount,
  });
});

router.post('/resend-verification', requireValidCsrf, async (req, res) => {
  if (!req.session.memberId) return res.redirect('/auth/login');
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 48 * 3600 * 1000);
  const { rows } = await pool.query(
    `UPDATE members SET email_verification_token = $2, email_verification_expires = $3, updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING email, full_name`,
    [req.session.memberId, token, expires]
  );
  const m = rows[0];
  if (!m) {
    return res.redirect('/auth/verify-required?mail=fail&code=no_member');
  }
  const base = process.env.BASE_URL || '';
  try {
    const result = await sendVerificationEmail({
      to: m.email,
      name: m.full_name,
      verifyUrl: `${base}/auth/verify?token=${encodeURIComponent(token)}`,
    });
    if (!result || result.sent === false) {
      return res.redirect('/auth/verify-required?mail=fail&code=not_configured');
    }
    return res.redirect('/auth/verify-required?mail=sent');
  } catch (e) {
    const msg = String(e.message || e).toLowerCase();
    console.error('[auth] resend verification email', e.message || e);
    if (msg.includes('not verified') || msg.includes('domain')) {
      return res.redirect('/auth/verify-required?mail=fail&code=domain');
    }
    return res.redirect('/auth/verify-required?mail=fail&code=send');
  }
});

router.get('/forgot-password', (req, res) => {
  res.render('auth/forgot', {
    layout: 'layouts/auth',
    title: 'Forgot password',
    error: null,
    sent: false,
  });
});

router.post('/forgot-password', loginLimiter, requireValidCsrf, async (req, res) => {
  const email = String(req.body.email || '')
    .trim()
    .toLowerCase();
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 60 * 60 * 1000);
  await pool.query(
    `UPDATE members SET password_reset_token = $2, password_reset_expires = $3, updated_at = now()
     WHERE lower(email) = $1 AND deleted_at IS NULL`,
    [email, token, expires]
  );
  const { rows } = await pool.query(
    `SELECT full_name FROM members WHERE lower(email) = $1 AND deleted_at IS NULL`,
    [email]
  );
  if (rows[0]) {
    const base = process.env.BASE_URL || '';
    await sendPasswordResetEmail({
      to: email,
      name: rows[0].full_name,
      resetUrl: `${base}/auth/reset-password?token=${encodeURIComponent(token)}`,
    });
  }
  return res.render('auth/forgot', {
    layout: 'layouts/auth',
    title: 'Forgot password',
    error: null,
    sent: true,
  });
});

router.get('/reset-password', (req, res) => {
  res.render('auth/reset', {
    layout: 'layouts/auth',
    title: 'Set new password',
    error: null,
    token: req.query.token || '',
  });
});

router.post('/reset-password', loginLimiter, requireValidCsrf, async (req, res) => {
  const token = String(req.body.token || '');
  const password = String(req.body.password || '');
  if (password.length < 8) {
    return res.status(400).render('auth/reset', {
      layout: 'layouts/auth',
      title: 'Set new password',
      error: 'Password must be at least 8 characters.',
      token,
    });
  }
  const { rows } = await pool.query(
    `SELECT id FROM members WHERE password_reset_token = $1 AND password_reset_expires > now() AND deleted_at IS NULL`,
    [token]
  );
  if (!rows[0]) {
    return res.status(400).render('auth/reset', {
      layout: 'layouts/auth',
      title: 'Set new password',
      error: 'This reset link is invalid or has expired.',
      token,
    });
  }
  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    `UPDATE members SET password_hash = $2, password_reset_token = NULL, password_reset_expires = NULL, updated_at = now()
     WHERE id = $1`,
    [rows[0].id, hash]
  );
  return res.render('auth/message', {
    layout: 'layouts/auth',
    title: 'Password updated',
    message: 'You can now sign in with your new password.',
    link: '/auth/login',
    linkLabel: 'Sign in',
  });
});

module.exports = router;
