const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('../lib/db');
const { requireValidCsrf } = require('../lib/csrf');
const { requireAdmin } = require('../middleware/adminAuth');
const { formatNgn, formatDate, formatDateTime } = require('../lib/format');
const { nextInvoiceNumber } = require('../lib/invoiceNumber');
const { validateUploadedFile } = require('../lib/uploadGuard');
const { notifyMember } = require('../lib/notifications');
const { logActivity } = require('../lib/activity');
const {
  getSettingsMap,
  setSetting,
  invalidateSettingsCache,
} = require('../lib/portalSettings');
const {
  sendInvoiceCreatedEmail,
  sendServiceStatusEmail,
  sendSupportReplyEmail,
} = require('../lib/mail');

const router = express.Router();
router.use(requireAdmin);

const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '../data/uploads');
const maxMb = Number(process.env.MAX_UPLOAD_MB) || 10;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxMb * 1024 * 1024 },
});

async function ensureUploadRoot() {
  await fs.mkdir(uploadDir, { recursive: true });
}

router.get('/', async (req, res) => {
  const members = await pool.query(
    `SELECT COUNT(*)::int AS c FROM members WHERE deleted_at IS NULL`
  );
  const activePlans = await pool.query(
    `SELECT COUNT(*)::int AS c FROM member_plans WHERE deleted_at IS NULL AND status = 'active'`
  );
  const pendingSvc = await pool.query(
    `SELECT COUNT(*)::int AS c FROM service_requests WHERE deleted_at IS NULL AND status IN ('Submitted','Under Review')`
  );
  const unpaid = await pool.query(
    `SELECT COALESCE(SUM(total_cents),0)::bigint AS t FROM invoices WHERE deleted_at IS NULL AND status IN ('unpaid','sent','overdue')`
  );
  const openTickets = await pool.query(
    `SELECT COUNT(*)::int AS c FROM support_tickets WHERE deleted_at IS NULL AND status IN ('Open','In Progress')`
  );
  const queueNewSvc = await pool.query(
    `SELECT sr.*, m.full_name, m.email, sv.name AS service_name
     FROM service_requests sr
     JOIN members m ON m.id = sr.member_id
     JOIN services sv ON sv.id = sr.service_id
     WHERE sr.deleted_at IS NULL AND sr.status = 'Submitted'
     ORDER BY sr.created_at DESC LIMIT 10`
  );
  const queueBank = await pool.query(
    `SELECT i.*, m.full_name FROM invoices i
     JOIN members m ON m.id = i.member_id
     WHERE i.deleted_at IS NULL AND i.status = 'awaiting_confirmation'
     ORDER BY i.updated_at DESC LIMIT 10`
  );
  const queueTickets = await pool.query(
    `SELECT t.*, m.full_name FROM support_tickets t
     JOIN members m ON m.id = t.member_id
     WHERE t.deleted_at IS NULL AND t.status IN ('Open','In Progress')
     ORDER BY t.created_at DESC LIMIT 10`
  );
  const queueRooms = await pool.query(
    `SELECT b.*, m.full_name FROM meeting_room_bookings b
     JOIN members m ON m.id = b.member_id
     WHERE b.deleted_at IS NULL AND b.status = 'pending'
     ORDER BY b.starts_at ASC LIMIT 10`
  );
  res.render('admin/dashboard', {
    layout: 'layouts/admin',
    title: 'Admin dashboard',
    stats: {
      members: members.rows[0].c,
      activePlans: activePlans.rows[0].c,
      pendingSvc: pendingSvc.rows[0].c,
      unpaidCents: Number(unpaid.rows[0].t),
      openTickets: openTickets.rows[0].c,
    },
    queueNewSvc: queueNewSvc.rows,
    queueBank: queueBank.rows,
    queueTickets: queueTickets.rows,
    queueRooms: queueRooms.rows,
    formatNgn,
    formatDateTime,
  });
});

router.get('/members', async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  let sql = `SELECT m.*, mp.status AS plan_status, mt.name AS tier_name
     FROM members m
     LEFT JOIN member_plans mp ON mp.member_id = m.id AND mp.deleted_at IS NULL AND mp.status = 'active'
     LEFT JOIN membership_tiers mt ON mt.id = mp.tier_id
     WHERE m.deleted_at IS NULL`;
  const params = [];
  if (q) {
    params.push('%' + q + '%');
    sql += ` AND (lower(m.email) LIKE $1 OR lower(m.full_name) LIKE $1)`;
  }
  sql += ' ORDER BY m.created_at DESC LIMIT 200';
  const { rows } = await pool.query(sql, params);
  res.render('admin/members', {
    layout: 'layouts/admin',
    title: 'Members',
    members: rows,
    formatDate,
    query: req.query,
  });
});

router.get('/members/new', async (req, res) => {
  res.render('admin/member-new', { layout: 'layouts/admin', title: 'Add member' });
});

router.post('/members/new', requireValidCsrf, async (req, res) => {
  const email = String(req.body.email || '')
    .trim()
    .toLowerCase();
  const full_name = String(req.body.full_name || '').trim();
  const phone = String(req.body.phone || '').trim();
  const password = String(req.body.password || '') || crypto.randomBytes(8).toString('hex');
  const hash = await bcrypt.hash(password, 10);
  try {
    await pool.query(
      `INSERT INTO members (email, password_hash, full_name, phone, email_verified_at)
       VALUES ($1, $2, $3, $4, now())`,
      [email, hash, full_name, phone]
    );
    res.redirect('/admin/members?msg=created');
  } catch (e) {
    res.redirect('/admin/members/new?err=1');
  }
});

router.get('/members/:id', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM members WHERE id = $1 AND deleted_at IS NULL`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).send('Not found');
  const m = rows[0];
  const plans = await pool.query(
    `SELECT mp.*, mt.name FROM member_plans mp JOIN membership_tiers mt ON mt.id = mp.tier_id
     WHERE mp.member_id = $1 AND mp.deleted_at IS NULL ORDER BY mp.started_at DESC`,
    [m.id]
  );
  const svc = await pool.query(
    `SELECT sr.*, sv.name AS service_name FROM service_requests sr
     JOIN services sv ON sv.id = sr.service_id WHERE sr.member_id = $1 AND sr.deleted_at IS NULL ORDER BY sr.created_at DESC`,
    [m.id]
  );
  const inv = await pool.query(
    `SELECT * FROM invoices WHERE member_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`,
    [m.id]
  );
  const docs = await pool.query(
    `SELECT * FROM member_documents WHERE member_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`,
    [m.id]
  );
  const tickets = await pool.query(
    `SELECT * FROM support_tickets WHERE member_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`,
    [m.id]
  );
  const tiers = await pool.query(`SELECT * FROM membership_tiers ORDER BY sort_order`);
  res.render('admin/member-detail', {
    layout: 'layouts/admin',
    title: m.full_name,
    m,
    plans: plans.rows,
    svc: svc.rows,
    inv: inv.rows,
    docs: docs.rows,
    tickets: tickets.rows,
    tiers: tiers.rows,
    formatDate,
    formatDateTime,
    formatNgn,
  });
});

router.post('/members/:id/note', requireValidCsrf, async (req, res) => {
  const note = String(req.body.internal_notes || '');
  await pool.query(
    `UPDATE members SET internal_notes = $2, updated_at = now() WHERE id = $1`,
    [req.params.id, note]
  );
  res.redirect(`/admin/members/${req.params.id}`);
});

router.post('/members/:id/suspend', requireValidCsrf, async (req, res) => {
  await pool.query(
    `UPDATE members SET suspended_at = now(), updated_at = now() WHERE id = $1`,
    [req.params.id]
  );
  res.redirect(`/admin/members/${req.params.id}`);
});

router.post('/members/:id/reactivate', requireValidCsrf, async (req, res) => {
  await pool.query(
    `UPDATE members SET suspended_at = NULL, updated_at = now() WHERE id = $1`,
    [req.params.id]
  );
  res.redirect(`/admin/members/${req.params.id}`);
});

router.post('/members/:id/notify', requireValidCsrf, async (req, res) => {
  const title = String(req.body.title || '').trim();
  const message = String(req.body.message || '').trim();
  const link = String(req.body.link_url || '').trim() || null;
  if (title && message) {
    await notifyMember({
      memberId: req.params.id,
      title,
      message,
      linkUrl: link,
    });
  }
  res.redirect(`/admin/members/${req.params.id}`);
});

router.post('/members/:id/plan', requireValidCsrf, async (req, res) => {
  const tierId = Number(req.body.tier_id);
  const status = String(req.body.status || 'active');
  const started = req.body.started_at || new Date().toISOString().slice(0, 10);
  const renewal = req.body.renewal_at || null;
  await pool.query(
    `UPDATE member_plans SET deleted_at = now(), updated_at = now()
     WHERE member_id = $1 AND deleted_at IS NULL AND status = 'active'`,
    [req.params.id]
  );
  await pool.query(
    `INSERT INTO member_plans (member_id, tier_id, status, started_at, renewal_at)
     VALUES ($1, $2, $3, $4::date, $5::date)`,
    [req.params.id, tierId, status, started, renewal || null]
  );
  res.redirect(`/admin/members/${req.params.id}`);
});

router.post(
  '/members/:id/documents',
  upload.single('file'),
  requireValidCsrf,
  async (req, res) => {
    const memberId = req.params.id;
    const adminId = res.locals.currentAdmin.id;
    if (!req.file || !req.file.buffer) return res.redirect(`/admin/members/${memberId}?err=file`);
    const v = validateUploadedFile({
      buffer: req.file.buffer,
      reportedMime: req.file.mimetype,
    });
    if (!v.ok) return res.redirect(`/admin/members/${memberId}?err=type`);
    await ensureUploadRoot();
    const memberDir = path.join(uploadDir, String(memberId));
    await fs.mkdir(memberDir, { recursive: true });
    const fname = `${crypto.randomUUID()}${path.extname(req.file.originalname || '') || '.bin'}`;
    const storagePath = path.join(memberDir, fname);
    await fs.writeFile(storagePath, req.file.buffer);
    await pool.query(
      `INSERT INTO member_documents (member_id, uploaded_by_type, uploaded_by_admin_id, original_name, storage_path, mime_type, size_bytes, category, is_admin_shared)
       VALUES ($1, 'admin', $2, $3, $4, $5, $6, 'admin_share', true)`,
      [
        memberId,
        adminId,
        req.file.originalname || 'file',
        storagePath,
        v.mime,
        req.file.size,
      ]
    );
    await notifyMember({
      memberId,
      title: 'New document',
      message: 'EmergeHub shared a document with you.',
      linkUrl: '/documents',
    });
    await logActivity({
      memberId,
      eventType: 'document',
      title: 'Document from EmergeHub',
      body: req.file.originalname,
      entityType: 'document',
      entityId: null,
    });
    res.redirect(`/admin/members/${memberId}`);
  }
);

router.get('/service-requests', async (req, res) => {
  const st = String(req.query.status || '');
  let sql = `SELECT sr.*, m.full_name, m.email, sv.name AS service_name
     FROM service_requests sr
     JOIN members m ON m.id = sr.member_id
     JOIN services sv ON sv.id = sr.service_id
     WHERE sr.deleted_at IS NULL`;
  const params = [];
  if (st) {
    params.push(st);
    sql += ` AND sr.status = $${params.length}`;
  }
  sql += ' ORDER BY sr.created_at DESC LIMIT 200';
  const { rows } = await pool.query(sql, params);
  res.render('admin/service-requests', {
    layout: 'layouts/admin',
    title: 'Service requests',
    rows,
    formatDateTime,
    query: req.query,
  });
});

router.get('/service-requests/:id', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT sr.*, sv.name AS service_name,
       m.id AS member_id, m.full_name AS member_name, m.email AS member_email, m.phone AS member_phone,
       m.internal_notes AS member_internal_notes
     FROM service_requests sr
     JOIN members m ON m.id = sr.member_id
     JOIN services sv ON sv.id = sr.service_id
     WHERE sr.id = $1 AND sr.deleted_at IS NULL`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).send('Not found');
  const sr = rows[0];
  const updates = await pool.query(
    `SELECT * FROM service_request_updates WHERE service_request_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
    [req.params.id]
  );
  const msgs = await pool.query(
    `SELECT * FROM service_request_messages WHERE service_request_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
    [req.params.id]
  );
  const docs = await pool.query(
    `SELECT * FROM member_documents WHERE service_request_id = $1 AND deleted_at IS NULL`,
    [req.params.id]
  );
  const admins = await pool.query(
    `SELECT id, username FROM portal_admin_users WHERE deleted_at IS NULL AND active = true`
  );
  res.render('admin/service-request-detail', {
    layout: 'layouts/admin',
    title: sr.service_name,
    sr,
    updates: updates.rows,
    msgs: msgs.rows,
    docs: docs.rows,
    admins: admins.rows,
    formatDateTime,
  });
});

router.post('/service-requests/:id/status', requireValidCsrf, async (req, res) => {
  const id = req.params.id;
  const status = String(req.body.status || '');
  const adminId = res.locals.currentAdmin.id;
  await pool.query(
    `UPDATE service_requests SET status = $2, updated_at = now(), action_required_member = $3 WHERE id = $1`,
    [id, status, req.body.action_required === '1']
  );
  await pool.query(
    `INSERT INTO service_request_updates (service_request_id, stage, note, visible_to_member, created_by_admin_id)
     VALUES ($1, $2, $3, true, $4)`,
    [id, status, String(req.body.note || '').trim() || null, adminId]
  );
  const { rows } = await pool.query(
    `SELECT m.id AS member_id, m.email, m.full_name, m.notify_email_service, sv.name AS service_name
     FROM service_requests sr
     JOIN members m ON m.id = sr.member_id
     JOIN services sv ON sv.id = sr.service_id
     WHERE sr.id = $1`,
    [id]
  );
  const r = rows[0];
  if (r && r.notify_email_service) {
    const base = process.env.BASE_URL || '';
    await sendServiceStatusEmail({
      to: r.email,
      name: r.full_name,
      serviceName: r.service_name,
      status,
      portalUrl: base,
    });
  }
  if (r) {
    await notifyMember({
      memberId: r.member_id,
      title: 'Service status updated',
      message: `${r.service_name} is now: ${status}`,
      linkUrl: `/services/${id}`,
    });
    await logActivity({
      memberId: r.member_id,
      eventType: 'service',
      title: 'Service status updated',
      body: status,
      entityType: 'service_request',
      entityId: id,
    });
  }
  res.redirect(`/admin/service-requests/${id}`);
});

router.post('/service-requests/:id/message', requireValidCsrf, async (req, res) => {
  const id = req.params.id;
  const body = String(req.body.body || '').trim();
  if (!body) return res.redirect(`/admin/service-requests/${id}`);
  await pool.query(
    `INSERT INTO service_request_messages (service_request_id, sender_type, admin_id, body)
     VALUES ($1, 'admin', $2, $3)`,
    [id, res.locals.currentAdmin.id, body]
  );
  res.redirect(`/admin/service-requests/${id}`);
});

router.post('/service-requests/:id/assign', requireValidCsrf, async (req, res) => {
  const aid = String(req.body.admin_id || '').trim() || null;
  await pool.query(
    `UPDATE service_requests SET assigned_admin_id = $2, updated_at = now() WHERE id = $1`,
    [req.params.id, aid]
  );
  res.redirect(`/admin/service-requests/${req.params.id}`);
});

router.get('/invoices', async (req, res) => {
  const st = String(req.query.status || '');
  let sql = `SELECT i.*, m.full_name, m.email FROM invoices i
     JOIN members m ON m.id = i.member_id WHERE i.deleted_at IS NULL`;
  const params = [];
  if (st) {
    params.push(st);
    sql += ` AND i.status = $${params.length}`;
  }
  sql += ' ORDER BY i.due_date ASC NULLS LAST, i.created_at DESC LIMIT 300';
  const { rows } = await pool.query(sql, params);
  res.render('admin/invoices', {
    layout: 'layouts/admin',
    title: 'Invoices',
    rows,
    formatNgn,
    formatDate,
    query: req.query,
  });
});

router.get('/invoices/new', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, full_name, email FROM members WHERE deleted_at IS NULL ORDER BY full_name LIMIT 500`
  );
  res.render('admin/invoice-new', {
    layout: 'layouts/admin',
    title: 'Create invoice',
    members: rows,
  });
});

router.post('/invoices/new', requireValidCsrf, async (req, res) => {
  const memberId = req.body.member_id;
  const dueDays = Number(req.body.due_days || 7);
  const notes = String(req.body.notes || '').trim();
  const descriptions = [].concat(req.body.line_desc || []);
  const amounts = [].concat(req.body.line_amount || []);
  let subtotal = 0;
  const items = [];
  for (let i = 0; i < descriptions.length; i++) {
    const d = String(descriptions[i] || '').trim();
    const a = Math.round(Number(amounts[i] || 0) * 100);
    if (!d || !a) continue;
    subtotal += a;
    items.push({ d, a });
  }
  if (!items.length) return res.redirect('/admin/invoices/new?err=lines');
  const invNo = await nextInvoiceNumber();
  const due = new Date();
  due.setDate(due.getDate() + dueDays);
  const client = await pool.connect();
  let invId;
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO invoices (member_id, invoice_number, status, subtotal_cents, total_cents, due_date, notes)
       VALUES ($1, $2, 'sent', $3, $3, $4::date, $5)
       RETURNING id`,
      [memberId, invNo, subtotal, due.toISOString().slice(0, 10), notes || null]
    );
    invId = ins.rows[0].id;
    let order = 0;
    for (const it of items) {
      await client.query(
        `INSERT INTO invoice_items (invoice_id, description, amount_cents, sort_order)
         VALUES ($1, $2, $3, $4)`,
        [invId, it.d, it.a, order++]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  const { rows: mem } = await pool.query(
    `SELECT full_name, email, notify_email_invoice FROM members WHERE id = $1`,
    [memberId]
  );
  if (mem[0] && mem[0].notify_email_invoice) {
    const base = process.env.BASE_URL || '';
    await sendInvoiceCreatedEmail({
      to: mem[0].email,
      name: mem[0].full_name,
      invoiceNumber: invNo,
      amount: formatNgn(subtotal),
      dueDate: due.toLocaleDateString('en-GB'),
      portalUrl: base,
    });
  }
  await notifyMember({
    memberId,
    title: 'New invoice',
    message: `Invoice ${invNo} for ${formatNgn(subtotal)}.`,
    linkUrl: '/billing',
  });
  await logActivity({
    memberId,
    eventType: 'invoice',
    title: 'New invoice',
    body: invNo,
    entityType: 'invoice',
    entityId: invId,
  });
  res.redirect('/admin/invoices');
});

router.get('/invoices/:id', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT i.*, m.full_name, m.email FROM invoices i
     JOIN members m ON m.id = i.member_id WHERE i.id = $1 AND i.deleted_at IS NULL`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).send('Not found');
  const items = await pool.query(
    `SELECT * FROM invoice_items WHERE invoice_id = $1 AND deleted_at IS NULL ORDER BY sort_order`,
    [req.params.id]
  );
  res.render('admin/invoice-detail', {
    layout: 'layouts/admin',
    title: rows[0].invoice_number,
    inv: rows[0],
    items: items.rows,
    formatNgn,
    formatDate,
  });
});

router.post('/invoices/:id/paid', requireValidCsrf, async (req, res) => {
  const id = req.params.id;
  const { rows } = await pool.query(
    `SELECT * FROM invoices WHERE id = $1`,
    [id]
  );
  const inv = rows[0];
  await pool.query(
    `UPDATE invoices SET status = 'paid', updated_at = now() WHERE id = $1`,
    [id]
  );
  await pool.query(
    `INSERT INTO payments (invoice_id, member_id, amount_cents, method, status, receipt_number)
     VALUES ($1, $2, $3, 'manual', 'completed', $4)`,
    [
      id,
      inv.member_id,
      inv.total_cents,
      `RCP-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
    ]
  );
  res.redirect(`/admin/invoices/${id}`);
});

router.post('/invoices/:id/confirm-bank', requireValidCsrf, async (req, res) => {
  const id = req.params.id;
  const { rows } = await pool.query(`SELECT * FROM invoices WHERE id = $1`, [id]);
  const inv = rows[0];
  await pool.query(
    `UPDATE invoices SET status = 'paid', updated_at = now() WHERE id = $1`,
    [id]
  );
  await pool.query(
    `INSERT INTO payments (invoice_id, member_id, amount_cents, method, status, receipt_number)
     VALUES ($1, $2, $3, 'bank_transfer', 'completed', $4)`,
    [
      id,
      inv.member_id,
      inv.total_cents,
      `RCP-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
    ]
  );
  await notifyMember({
    memberId: inv.member_id,
    title: 'Payment confirmed',
    message: `Your bank transfer for ${inv.invoice_number} was confirmed.`,
    linkUrl: '/billing',
  });
  res.redirect(`/admin/invoices/${id}`);
});

router.get('/documents', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT d.*, m.full_name, m.email FROM member_documents d
     JOIN members m ON m.id = d.member_id
     WHERE d.deleted_at IS NULL ORDER BY d.created_at DESC LIMIT 300`
  );
  res.render('admin/documents', {
    layout: 'layouts/admin',
    title: 'Documents',
    rows,
    formatDateTime,
  });
});

router.get('/documents/download/:id', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM member_documents WHERE id = $1 AND deleted_at IS NULL`,
    [req.params.id]
  );
  const d = rows[0];
  if (!d) return res.status(404).send('Not found');
  const buf = await fs.readFile(d.storage_path);
  res.setHeader('Content-Type', d.mime_type);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${encodeURIComponent(d.original_name)}"`
  );
  res.send(buf);
});

router.post('/documents/:id/delete', requireValidCsrf, async (req, res) => {
  await pool.query(
    `UPDATE member_documents SET deleted_at = now(), updated_at = now() WHERE id = $1`,
    [req.params.id]
  );
  res.redirect('/admin/documents');
});

router.get('/support', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT t.*, m.full_name FROM support_tickets t
     JOIN members m ON m.id = t.member_id
     WHERE t.deleted_at IS NULL ORDER BY t.created_at DESC LIMIT 200`
  );
  res.render('admin/support', {
    layout: 'layouts/admin',
    title: 'Support',
    rows,
    formatDateTime,
  });
});

router.get('/support/:id', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT t.*, m.full_name, m.email FROM support_tickets t
     JOIN members m ON m.id = t.member_id WHERE t.id = $1 AND t.deleted_at IS NULL`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).send('Not found');
  const msgs = await pool.query(
    `SELECT sm.*, md.original_name AS attach_name FROM support_messages sm
     LEFT JOIN member_documents md ON md.id = sm.attachment_document_id
     WHERE sm.ticket_id = $1 AND sm.deleted_at IS NULL ORDER BY sm.created_at`,
    [req.params.id]
  );
  const admins = await pool.query(
    `SELECT id, username FROM portal_admin_users WHERE deleted_at IS NULL AND active = true`
  );
  res.render('admin/support-detail', {
    layout: 'layouts/admin',
    title: rows[0].subject,
    ticket: rows[0],
    msgs: msgs.rows,
    admins: admins.rows,
    formatDateTime,
  });
});

router.post('/support/:id/reply', requireValidCsrf, async (req, res) => {
  const tid = req.params.id;
  const body = String(req.body.body || '').trim();
  const internal = req.body.internal === '1';
  if (!body) return res.redirect(`/admin/support/${tid}`);
  await pool.query(
    `INSERT INTO support_messages (ticket_id, sender_type, admin_id, body, internal_note)
     VALUES ($1, 'admin', $2, $3, $4)`,
    [tid, res.locals.currentAdmin.id, body, internal]
  );
  if (!internal) {
    const { rows } = await pool.query(
      `SELECT m.email, m.full_name, m.notify_email_support, t.subject
       FROM support_tickets t JOIN members m ON m.id = t.member_id WHERE t.id = $1`,
      [tid]
    );
    if (rows[0] && rows[0].notify_email_support) {
      const base = process.env.BASE_URL || '';
      await sendSupportReplyEmail({
        to: rows[0].email,
        name: rows[0].full_name,
        subjectLine: rows[0].subject,
        portalUrl: base,
      });
    }
    const { rows: m2 } = await pool.query(
      `SELECT member_id FROM support_tickets WHERE id = $1`,
      [tid]
    );
    if (m2[0]) {
      await notifyMember({
        memberId: m2[0].member_id,
        title: 'Support reply',
        message: 'EmergeHub replied to your ticket.',
        linkUrl: `/support/${tid}`,
      });
    }
    await pool.query(
      `UPDATE support_tickets SET status = 'In Progress', updated_at = now() WHERE id = $1`,
      [tid]
    );
  }
  res.redirect(`/admin/support/${tid}`);
});

router.post('/support/:id/status', requireValidCsrf, async (req, res) => {
  const tid = req.params.id;
  const status = String(req.body.status || '');
  if (status === 'Resolved') {
    await pool.query(
      `UPDATE support_tickets SET status = $2, resolved_at = now(),
       last_member_reopen_deadline = now() + interval '7 days', updated_at = now() WHERE id = $1`,
      [tid, status]
    );
  } else {
    await pool.query(
      `UPDATE support_tickets SET status = $2, updated_at = now() WHERE id = $1`,
      [tid, status]
    );
  }
  res.redirect(`/admin/support/${tid}`);
});

router.post('/support/:id/assign', requireValidCsrf, async (req, res) => {
  const aid = String(req.body.admin_id || '').trim() || null;
  await pool.query(
    `UPDATE support_tickets SET assigned_admin_id = $2, updated_at = now() WHERE id = $1`,
    [req.params.id, aid]
  );
  res.redirect(`/admin/support/${req.params.id}`);
});

router.get('/rooms', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT b.*, m.full_name FROM meeting_room_bookings b
     JOIN members m ON m.id = b.member_id
     WHERE b.deleted_at IS NULL AND b.starts_at >= now() - interval '1 day'
     ORDER BY b.starts_at ASC LIMIT 500`
  );
  res.render('admin/rooms', {
    layout: 'layouts/admin',
    title: 'Meeting rooms',
    rows,
    formatDateTime,
  });
});

router.post('/rooms/:id/approve', requireValidCsrf, async (req, res) => {
  await pool.query(
    `UPDATE meeting_room_bookings SET status = 'approved', admin_note = $2, updated_at = now() WHERE id = $1`,
    [req.params.id, String(req.body.note || '').trim() || null]
  );
  res.redirect('/admin/rooms');
});

router.post('/rooms/:id/reject', requireValidCsrf, async (req, res) => {
  await pool.query(
    `UPDATE meeting_room_bookings SET status = 'rejected', admin_note = $2, updated_at = now() WHERE id = $1`,
    [req.params.id, String(req.body.note || '').trim() || null]
  );
  res.redirect('/admin/rooms');
});

router.post('/rooms/new', requireValidCsrf, async (req, res) => {
  await pool.query(
    `INSERT INTO meeting_room_bookings (member_id, room_name, starts_at, ends_at, purpose, status, created_by_admin)
     VALUES ($1, $2, $3::timestamptz, $4::timestamptz, $5, 'approved', true)`,
    [
      req.body.member_id,
      String(req.body.room_name || ''),
      req.body.starts_at,
      req.body.ends_at,
      String(req.body.purpose || ''),
    ]
  );
  res.redirect('/admin/rooms');
});

router.get('/notifications', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, full_name, email FROM members WHERE deleted_at IS NULL ORDER BY full_name LIMIT 500`
  );
  res.render('admin/notifications', {
    layout: 'layouts/admin',
    title: 'Notifications',
    members: rows,
    query: req.query,
  });
});

router.post('/notifications/send', requireValidCsrf, async (req, res) => {
  const audience = String(req.body.audience || 'one');
  const title = String(req.body.title || '').trim();
  const message = String(req.body.message || '').trim();
  const link = String(req.body.link_url || '').trim() || null;
  if (!title || !message) return res.redirect('/admin/notifications?err=1');
  let memberIds = [];
  if (audience === 'one') {
    memberIds = [req.body.member_id];
  } else if (audience === 'all') {
    const { rows } = await pool.query(
      `SELECT id FROM members WHERE deleted_at IS NULL`
    );
    memberIds = rows.map((r) => r.id);
  } else if (audience === 'active_plan') {
    const { rows } = await pool.query(
      `SELECT DISTINCT member_id FROM member_plans WHERE deleted_at IS NULL AND status = 'active'`
    );
    memberIds = rows.map((r) => r.member_id);
  } else if (audience === 'unpaid') {
    const { rows } = await pool.query(
      `SELECT DISTINCT member_id FROM invoices WHERE deleted_at IS NULL AND status IN ('unpaid','sent','overdue')`
    );
    memberIds = rows.map((r) => r.member_id);
  }
  for (const mid of memberIds) {
    if (!mid) continue;
    await notifyMember({ memberId: mid, title, message, linkUrl: link });
  }
  res.redirect('/admin/notifications?msg=sent');
});

router.get('/settings', async (req, res) => {
  const map = await getSettingsMap();
  const admins = await pool.query(
    `SELECT id, username, email, active, must_change_password FROM portal_admin_users WHERE deleted_at IS NULL`
  );
  res.render('admin/settings', {
    layout: 'layouts/admin',
    title: 'Portal settings',
    map,
    admins: admins.rows,
    query: req.query,
  });
});

router.post('/settings', requireValidCsrf, async (req, res) => {
  const keys = [
    'bank_name',
    'account_name',
    'account_number',
    'default_invoice_due_days',
    'meeting_room_hours',
    'paystack_public_key',
    'paystack_secret_key',
  ];
  for (const k of keys) {
    if (req.body[k] == null) continue;
    if (k === 'paystack_secret_key' && !String(req.body[k]).trim()) continue;
    await setSetting(k, String(req.body[k]));
  }
  if (req.body.meeting_room_names != null) {
    await setSetting('meeting_room_names', String(req.body.meeting_room_names));
  }
  invalidateSettingsCache();
  res.redirect('/admin/settings?msg=1');
});

router.post('/settings/admins', requireValidCsrf, async (req, res) => {
  const username = String(req.body.username || '').trim();
  const email = String(req.body.email || '').trim();
  const password = String(req.body.password || '');
  if (username && email && password.length >= 8) {
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      `INSERT INTO portal_admin_users (username, email, password_hash, must_change_password, active)
       VALUES ($1, $2, $3, false, true)`,
      [username, email, hash]
    );
  }
  res.redirect('/admin/settings?msg=admin');
});

module.exports = router;
