const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const { pool } = require('../lib/db');
const { requireValidCsrf } = require('../lib/csrf');
const { requireMember, requireVerifiedEmail } = require('../middleware/memberAuth');
const { memberLayoutLocals } = require('../middleware/memberLayoutLocals');
const { trackMemberSession } = require('../middleware/trackMemberSession');
const { dashboardStats } = require('../lib/memberStats');
const { getAvailableCreditMinutes } = require('../lib/meetingCredits');
const { recentActivityForMember } = require('../lib/activity');
const { formatNgn, formatDate, formatDateTime } = require('../lib/format');
const { nextInvoiceNumber } = require('../lib/invoiceNumber');
const { initializeTransaction } = require('../lib/paystack');
const { paystackKeys } = require('../lib/portalSettings');
const { validateUploadedFile } = require('../lib/uploadGuard');
const {
  notifyMember,
  unreadCount,
  recentForMember,
  markAllRead,
  markRead,
} = require('../lib/notifications');
const { logActivity } = require('../lib/activity');
const { getSetting } = require('../lib/portalSettings');
const {
  createServiceRequestInvoiceInTx,
  sendServiceRequestInvoiceNotifications,
} = require('../lib/serviceRequestInvoice');
const { notifyStaffCustomerServiceRequestActivity } = require('../lib/serviceRequestStaffEmail');
const { activatePendingWorkspaceMemberPlan } = require('../lib/workspacePlanActivation');
const { markdownDocToHtml } = require('../lib/knowledgeBase');

const router = express.Router();

function isUuidString(s) {
  return (
    typeof s === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s)
  );
}

router.use(
  requireMember,
  requireVerifiedEmail,
  memberLayoutLocals,
  trackMemberSession
);

const memberMeetingRooms = require('./memberMeetingRooms');
router.use(memberMeetingRooms);

const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '../data/uploads');
const maxMb = Number(process.env.MAX_UPLOAD_MB) || 10;
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: maxMb * 1024 * 1024 },
});

async function ensureUploadRoot() {
  await fs.mkdir(uploadDir, { recursive: true });
}

router.get('/help', async (req, res) => {
  const m = res.locals.currentMember;
  try {
    const contentHtml = await markdownDocToHtml('MEMBER_USER_GUIDE.md');
    const notifCount = await unreadCount(m.id);
    res.render('member/knowledge-base', {
      layout: 'layouts/member',
      title: 'Knowledge base',
      pageSub: 'How-to guides for the member portal',
      contentHtml,
      kbMode: 'main',
      notifCount,
    });
  } catch (e) {
    console.error('[member] knowledge base', e);
    res.status(500).send('Could not load the knowledge base.');
  }
});

router.get('/help/screenshots', async (req, res) => {
  const m = res.locals.currentMember;
  try {
    const contentHtml = await markdownDocToHtml('USER_GUIDE_SCREENSHOTS.md');
    const notifCount = await unreadCount(m.id);
    res.render('member/knowledge-base', {
      layout: 'layouts/member',
      title: 'Screenshot checklist',
      pageSub: 'Documentation image list (member & admin)',
      contentHtml,
      kbMode: 'screenshots',
      notifCount,
    });
  } catch (e) {
    console.error('[member] screenshot doc', e);
    res.status(500).send('Could not load this page.');
  }
});

function isUuidMember(s) {
  return (
    typeof s === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s)
  );
}

/** Summary metrics for member payments page (outstanding, due soonest, paid totals). */
function computeBillingSummary(invRows, historyRows, formatDateSafe) {
  const unpaidStatuses = ['unpaid', 'sent', 'overdue'];
  let outstandingTotalCents = 0;
  const unpaidInvs = [];
  (invRows || []).forEach((inv) => {
    const st = String(inv.status || '').toLowerCase();
    if (unpaidStatuses.includes(st)) {
      unpaidInvs.push(inv);
      outstandingTotalCents += Number(inv.total_cents || 0);
    }
  });

  let dueSoonestInv = null;
  let dueSoonestTs = null;
  unpaidInvs.forEach((inv) => {
    if (!inv.due_date) return;
    const t = new Date(inv.due_date).getTime();
    if (dueSoonestTs === null || t < dueSoonestTs) {
      dueSoonestTs = t;
      dueSoonestInv = inv;
    }
  });

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let dueSoonestLabel = null;
  let dueSoonestSub = null;
  let dueSoonHighlight = false;
  if (dueSoonestInv && dueSoonestInv.due_date) {
    const d = new Date(dueSoonestInv.due_date);
    d.setHours(0, 0, 0, 0);
    const days = Math.round((d - today) / 864e5);
    dueSoonestLabel = formatDateSafe(dueSoonestInv.due_date);
    if (days < 0) {
      dueSoonestSub = 'Overdue';
      dueSoonHighlight = true;
    } else {
      dueSoonestSub = `${days} day${days === 1 ? '' : 's'} remaining`;
      dueSoonHighlight = days <= 7;
    }
  }

  const now = new Date();
  const y = now.getFullYear();
  const mon = now.getMonth();
  let paidMonthCents = 0;
  let paidMonthCount = 0;
  let paidAllCents = 0;
  let paidAllCount = 0;
  (historyRows || []).forEach((p) => {
    if (String(p.status || '').toLowerCase() === 'completed') {
      const ac = Number(p.amount_cents || 0);
      paidAllCents += ac;
      paidAllCount += 1;
      const pc = new Date(p.created_at);
      if (pc.getFullYear() === y && pc.getMonth() === mon) {
        paidMonthCents += ac;
        paidMonthCount += 1;
      }
    }
  });

  return {
    outstandingTotalCents,
    unpaidCount: unpaidInvs.length,
    dueSoonestLabel,
    dueSoonestSub,
    dueSoonHighlight,
    paidMonthCents,
    paidMonthCount,
    paidAllCents,
    paidAllCount,
  };
}

router.get('/dashboard', async (req, res) => {
  const m = res.locals.currentMember;
  const stats = await dashboardStats(m.id);
  const activity = await recentActivityForMember(m.id, 10);
  const notifCount = await unreadCount(m.id);
  const svcHistory = await pool.query(
    `SELECT COUNT(*)::int AS c FROM service_requests WHERE member_id = $1 AND deleted_at IS NULL`,
    [m.id]
  );
  const showOnboarding =
    !stats.hasActivePlan && svcHistory.rows[0].c === 0;
  const announcements = await pool.query(
    `SELECT title, message, created_at FROM member_notifications
     WHERE member_id = $1 AND deleted_at IS NULL
     ORDER BY created_at DESC LIMIT 5`,
    [m.id]
  );
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const fmtShort = (d) =>
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  res.render('member/dashboard', {
    layout: 'layouts/member',
    title: 'Dashboard',
    pageSub: 'Your membership overview',
    stats,
    activity,
    notifCount,
    showOnboarding,
    announcements: announcements.rows,
    filterMonthStart: fmtShort(monthStart),
    filterMonthEnd: fmtShort(monthEnd),
    formatDate,
    formatDateTime,
    formatNgn,
  });
});

router.get('/workspace', async (req, res) => {
  const m = res.locals.currentMember;
  const plan = await pool.query(
    `SELECT mp.*, mt.name, mt.description, mt.price_display, mt.hours,
            sp.monthly_meeting_credit_minutes AS catalogue_meeting_credits_min,
            sp.weekly_access_sessions AS catalogue_weekly_sessions,
            sp.title AS catalogue_plan_title
     FROM member_plans mp
     JOIN membership_tiers mt ON mt.id = mp.tier_id
     LEFT JOIN service_plans sp ON sp.id = mt.service_plan_id AND sp.deleted_at IS NULL
     WHERE mp.member_id = $1 AND mp.deleted_at IS NULL AND mp.status = 'active'
     ORDER BY mp.started_at DESC NULLS LAST LIMIT 1`,
    [m.id]
  );
  const pendingWorkspacePlans = await pool.query(
    `SELECT mp.*, mt.name, mt.description, mt.price_display, mt.hours,
            sp.title AS catalogue_plan_title,
            inv.invoice_number AS source_invoice_number
     FROM member_plans mp
     JOIN membership_tiers mt ON mt.id = mp.tier_id
     LEFT JOIN service_plans sp ON sp.id = mt.service_plan_id AND sp.deleted_at IS NULL
     LEFT JOIN invoices inv ON inv.id = mp.source_invoice_id AND inv.deleted_at IS NULL
     WHERE mp.member_id = $1 AND mp.deleted_at IS NULL AND mp.status = 'pending_activation'
     ORDER BY mp.created_at DESC`,
    [m.id]
  );
  let tiers = { rows: [] };
  if (plan.rows[0]) {
    tiers = await pool.query(`SELECT * FROM membership_tiers ORDER BY sort_order ASC`);
  }
  const roomsJson = await getSetting('meeting_room_names', '[]');
  let roomNames = [];
  try {
    roomNames = JSON.parse(roomsJson) || [];
  } catch {
    roomNames = [];
  }
  const bookingsUp = await pool.query(
    `SELECT * FROM meeting_room_bookings
     WHERE member_id = $1 AND deleted_at IS NULL AND starts_at >= now()
     ORDER BY starts_at ASC LIMIT 50`,
    [m.id]
  );
  const bookingsPast = await pool.query(
    `SELECT * FROM meeting_room_bookings
     WHERE member_id = $1 AND deleted_at IS NULL AND starts_at < now()
     ORDER BY starts_at DESC LIMIT 30`,
    [m.id]
  );
  const bookableSvcs = await pool.query(
    `SELECT s.*, c.name AS category_name
     FROM services s
     JOIN service_categories c ON c.id = s.category_id
     WHERE s.deleted_at IS NULL AND s.portal_active = true AND s.booking_mode = 'plan_booking'
     ORDER BY c.sort_order, s.sort_order, s.id`
  );
  const svcIds = bookableSvcs.rows.map((r) => r.id);
  let plansByService = {};
  if (svcIds.length) {
    const pl = await pool.query(
      `SELECT * FROM service_plans
       WHERE service_id = ANY($1::int[]) AND deleted_at IS NULL AND active = true
       ORDER BY sort_order, id`,
      [svcIds]
    );
    plansByService = pl.rows.reduce((acc, p) => {
      if (!acc[p.service_id]) acc[p.service_id] = [];
      acc[p.service_id].push(p);
      return acc;
    }, {});
  }

  const { rows: capRows } = await pool.query(
    `SELECT p.id AS profile_id, p.service_plan_id, p.total_units, p.waitlist_enabled,
            (SELECT COUNT(*)::int FROM member_space_assignments msa
             JOIN space_units su ON su.id = msa.unit_id AND su.deleted_at IS NULL
             WHERE su.profile_id = p.id AND msa.deleted_at IS NULL AND msa.ended_at IS NULL) AS occupied
     FROM plan_capacity_profiles p
     WHERE p.deleted_at IS NULL`
  );
  const capacityByPlanId = {};
  for (const row of capRows) {
    const cap = Math.max(0, Number(row.total_units) || 0);
    const occ = Math.max(0, Number(row.occupied) || 0);
    const full = cap > 0 && occ >= cap;
    capacityByPlanId[row.service_plan_id] = {
      profile_id: row.profile_id,
      total_units: cap,
      occupied: occ,
      full,
      waitlist_enabled: row.waitlist_enabled !== false,
    };
  }

  const { rows: wlRows } = await pool.query(
    `SELECT profile_id, status, offer_expires_at
     FROM plan_waitlist_entries
     WHERE member_id = $1::uuid AND deleted_at IS NULL AND status IN ('waiting', 'offered')`,
    [m.id]
  );
  const waitlistByProfileId = {};
  for (const w of wlRows) {
    waitlistByProfileId[w.profile_id] = w;
  }

  let waitlistClaimBanner = null;
  const claimTok = String(req.query.waitlist_claim || '').trim();
  if (isUuidMember(claimTok)) {
    const { rows: off } = await pool.query(
      `SELECT w.id, p.service_plan_id, sp.title AS plan_title
       FROM plan_waitlist_entries w
       JOIN plan_capacity_profiles p ON p.id = w.profile_id AND p.deleted_at IS NULL
       LEFT JOIN service_plans sp ON sp.id = p.service_plan_id
       WHERE w.offer_token = $1::uuid AND w.member_id = $2::uuid AND w.deleted_at IS NULL
         AND w.status = 'offered' AND w.offer_expires_at IS NOT NULL AND w.offer_expires_at > now()`,
      [claimTok, m.id]
    );
    if (off[0]) {
      waitlistClaimBanner = {
        planTitle: off[0].plan_title || 'Workspace plan',
        servicePlanId: off[0].service_plan_id,
      };
      await pool.query(`UPDATE plan_waitlist_entries SET status = 'claimed', updated_at = now() WHERE id = $1::uuid`, [
        off[0].id,
      ]);
    }
  }

  let meetingCredits = { available: 0, granted: 0, used: 0, period_month: null };
  try {
    meetingCredits = await getAvailableCreditMinutes(pool, m.id);
  } catch {
    /* ignore */
  }

  const notifCount = await unreadCount(m.id);
  res.render('member/workspace', {
    layout: 'layouts/member',
    title: 'My Workspace',
    plan: plan.rows[0] || null,
    pendingWorkspacePlans: pendingWorkspacePlans.rows,
    tiers: tiers.rows,
    roomNames,
    bookingsUp: bookingsUp.rows,
    bookingsPast: bookingsPast.rows,
    bookableServices: bookableSvcs.rows,
    plansByService,
    capacityByPlanId,
    waitlistByProfileId,
    waitlistClaimBanner,
    meetingCredits,
    formatDate,
    formatDateTime,
    formatNgn,
    notifCount,
    query: req.query,
  });
});

router.post('/workspace/activate-plan', requireValidCsrf, async (req, res) => {
  const m = res.locals.currentMember;
  const memberPlanId = String(req.body.member_plan_id || '').trim();
  if (!isUuidMember(memberPlanId)) return res.redirect('/workspace?err=activate');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await activatePendingWorkspaceMemberPlan(client, {
      memberPlanId,
      memberId: m.id,
      accessStartsAt: null,
      fromMemberPortal: true,
    });
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('workspace activate-plan', e);
    return res.redirect('/workspace?err=activate');
  } finally {
    client.release();
  }
  return res.redirect('/workspace?msg=activated');
});

router.post('/workspace/waitlist', requireValidCsrf, async (req, res) => {
  const m = res.locals.currentMember;
  const planId = String(req.body.service_plan_id || '').trim();
  if (!isUuidMember(planId)) return res.redirect('/workspace?err=waitlist');
  const { rows: pl } = await pool.query(
    `SELECT is_capacity_limited FROM service_plans WHERE id = $1::uuid AND deleted_at IS NULL`,
    [planId]
  );
  if (!pl[0]?.is_capacity_limited) return res.redirect('/workspace?err=waitlist');
  const { rows: cap } = await pool.query(
    `SELECT p.id AS profile_id, p.total_units, p.waitlist_enabled,
            (SELECT COUNT(*)::int FROM member_space_assignments msa
             JOIN space_units su ON su.id = msa.unit_id AND su.deleted_at IS NULL
             WHERE su.profile_id = p.id AND msa.deleted_at IS NULL AND msa.ended_at IS NULL) AS occ
     FROM plan_capacity_profiles p
     WHERE p.service_plan_id = $1::uuid AND p.deleted_at IS NULL
     LIMIT 1`,
    [planId]
  );
  if (!cap[0] || cap[0].waitlist_enabled === false) return res.redirect('/workspace?err=waitlist');
  const capN = Math.max(0, Number(cap[0].total_units) || 0);
  const occ = Math.max(0, Number(cap[0].occ) || 0);
  if (!(capN > 0 && occ >= capN)) return res.redirect('/workspace?msg=not_full');
  const ex = await pool.query(
    `SELECT id FROM plan_waitlist_entries
     WHERE profile_id = $1::uuid AND member_id = $2::uuid AND deleted_at IS NULL
       AND status IN ('waiting', 'offered')
     LIMIT 1`,
    [cap[0].profile_id, m.id]
  );
  if (ex.rows[0]) return res.redirect('/workspace?msg=wl_exists');
  await pool.query(
    `INSERT INTO plan_waitlist_entries (profile_id, member_id, status, sort_key)
     VALUES ($1::uuid, $2::uuid, 'waiting', (extract(epoch from now()) * 1000)::bigint)`,
    [cap[0].profile_id, m.id]
  );
  res.redirect('/workspace?msg=wl_joined');
});

router.post('/workspace/plan-request', requireValidCsrf, async (req, res) => {
  const m = res.locals.currentMember;
  const tierId = Number(req.body.tier_id);
  const note = String(req.body.note || '').trim();
  await pool.query(
    `INSERT INTO member_plan_history (member_id, tier_id, status, note, started_at)
     VALUES ($1, $2, 'requested', $3, CURRENT_DATE)`,
    [m.id, tierId, note || null]
  );
  await logActivity({
    memberId: m.id,
    eventType: 'plan',
    title: 'Plan change requested',
    body: note,
    entityType: 'tier',
    entityId: null,
  });
  res.redirect('/workspace?msg=plan');
});

router.post('/workspace/book-room', requireValidCsrf, async (req, res) => {
  const m = res.locals.currentMember;
  const room_name = String(req.body.room_name || '');
  const starts_at = new Date(req.body.starts_at || '');
  const durationMin = Number(req.body.duration_minutes || 60);
  const purpose = String(req.body.purpose || '').trim();
  if (!room_name || Number.isNaN(starts_at.getTime())) {
    return res.redirect('/workspace?err=booking');
  }
  const ends_at = new Date(starts_at.getTime() + durationMin * 60 * 1000);
  await pool.query(
    `INSERT INTO meeting_room_bookings (member_id, room_name, starts_at, ends_at, purpose, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')`,
    [m.id, room_name, starts_at, ends_at, purpose || null]
  );
  res.redirect('/workspace?msg=booked');
});

router.post('/workspace/book-service', requireValidCsrf, async (req, res) => {
  const m = res.locals.currentMember;
  if (!m.business_name) {
    return res.redirect('/workspace?err=business');
  }
  const serviceId = Number(req.body.service_id);
  const planId = String(req.body.plan_id || '').trim();
  if (!serviceId || !planId) {
    return res.redirect('/workspace?err=book');
  }
  const { rows: chk } = await pool.query(
    `SELECT s.id, s.name, s.booking_mode, s.portal_active
     FROM services s WHERE s.id = $1 AND s.deleted_at IS NULL`,
    [serviceId]
  );
  if (!chk[0] || !chk[0].portal_active || chk[0].booking_mode !== 'plan_booking') {
    return res.redirect('/workspace?err=book');
  }
  const { rows: pl } = await pool.query(
    `SELECT * FROM service_plans
     WHERE id = $1::uuid AND service_id = $2 AND deleted_at IS NULL AND active = true`,
    [planId, serviceId]
  );
  if (!pl[0]) return res.redirect('/workspace?err=book');
  const plan = pl[0];
  const priceCents = Number(plan.price_cents || 0);
  if (priceCents <= 0) return res.redirect('/workspace?err=price');

  if (plan.is_capacity_limited) {
    const { rows: cap } = await pool.query(
      `SELECT p.total_units,
              (SELECT COUNT(*)::int FROM member_space_assignments msa
               JOIN space_units su ON su.id = msa.unit_id AND su.deleted_at IS NULL
               WHERE su.profile_id = p.id AND msa.deleted_at IS NULL AND msa.ended_at IS NULL) AS occ
       FROM plan_capacity_profiles p
       WHERE p.service_plan_id = $1::uuid AND p.deleted_at IS NULL
       LIMIT 1`,
      [plan.id]
    );
    const capN = Math.max(0, Number(cap[0]?.total_units) || 0);
    const occ = Math.max(0, Number(cap[0]?.occ) || 0);
    if (capN > 0 && occ >= capN) {
      return res.redirect('/workspace?err=full');
    }
  }

  const serviceName = chk[0].name || 'Workspace';
  const title = `${serviceName} — ${plan.title}`;
  const description = `Workspace booking: ${serviceName}. Plan: ${plan.title}. ${String(plan.description || '').trim()}`.slice(
    0,
    4000
  );
  const detail = {
    workspace_booking: true,
    plan_id: plan.id,
    plan_title: plan.title,
  };

  const dueDays = Number((await getSetting('default_invoice_due_days', '7')) || 7) || 7;
  const due = new Date();
  due.setDate(due.getDate() + dueDays);
  const dueStr = due.toISOString().slice(0, 10);
  const invNo = await nextInvoiceNumber();

  const client = await pool.connect();
  let rid;
  let invSummary = null;
  try {
    await client.query('BEGIN');
    const insR = await client.query(
      `INSERT INTO service_requests (member_id, service_id, service_plan_id, title, description, detail_json, status)
       VALUES ($1, $2, $3::uuid, $4, $5, $6::jsonb, 'Submitted')
       RETURNING id`,
      [m.id, serviceId, plan.id, title, description, JSON.stringify(detail)]
    );
    rid = insR.rows[0].id;
    await client.query(
      `INSERT INTO service_request_updates (service_request_id, stage, note, visible_to_member)
       VALUES ($1, 'Booked', 'Your workspace booking is recorded. Complete payment using the invoice below.', true)`,
      [rid]
    );
    invSummary = await createServiceRequestInvoiceInTx(client, {
      memberId: m.id,
      serviceRequestId: rid,
      serviceName,
      priceCents,
      invoiceNumber: invNo,
      dueDateStr: dueStr,
      lineDescription: `${serviceName} — ${plan.title}`,
    });
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    return res.redirect('/workspace?err=book');
  } finally {
    client.release();
  }

  await logActivity({
    memberId: m.id,
    eventType: 'service',
    title: 'Workspace booking',
    body: title,
    entityType: 'service_request',
    entityId: rid,
  });
  if (invSummary && invSummary.amount) {
    await sendServiceRequestInvoiceNotifications({
      memberId: m.id,
      memberEmail: m.email,
      memberName: m.full_name,
      notifyInvoiceEmail: m.notify_email_invoice,
      invoiceNumber: invSummary.number,
      amountCents: invSummary.amount,
      invId: invSummary.id,
      dueDateStr: dueStr,
      serviceRequestId: rid,
    });
  }
  res.redirect(`/services/${rid}`);
});

router.get('/services', async (req, res) => {
  const m = res.locals.currentMember;
  const tab = req.query.tab === 'request' ? 'request' : 'mine';
  const cats = await pool.query(
    `SELECT * FROM service_categories ORDER BY sort_order`
  );
  const services = await pool.query(
    `SELECT s.*, c.name AS category_name, c.slug AS category_slug
     FROM services s
     JOIN service_categories c ON c.id = s.category_id
     WHERE s.deleted_at IS NULL AND s.portal_active = true
     ORDER BY c.sort_order, s.sort_order`
  );
  const mine = await pool.query(
    `SELECT sr.*, sv.name AS service_name, c.name AS category_name
     FROM service_requests sr
     JOIN services sv ON sv.id = sr.service_id
     JOIN service_categories c ON c.id = sv.category_id
     WHERE sr.member_id = $1 AND sr.deleted_at IS NULL
     ORDER BY sr.created_at DESC`,
    [m.id]
  );
  const notifCount = await unreadCount(m.id);
  res.render('member/services', {
    layout: 'layouts/member',
    title: 'Services',
    tab,
    cats: cats.rows,
    services: services.rows,
    mine: mine.rows,
    formatDateTime,
    formatNgn,
    notifCount,
  });
});

router.get('/services/request/:serviceId', async (req, res) => {
  const m = res.locals.currentMember;
  const sid = Number(req.params.serviceId);
  const { rows } = await pool.query(
    `SELECT s.*, c.name AS category_name FROM services s
     JOIN service_categories c ON c.id = s.category_id
     WHERE s.id = $1 AND s.deleted_at IS NULL AND s.portal_active = true`,
    [sid]
  );
  if (!rows[0]) return res.status(404).send('Not found');
  if (rows[0].booking_mode === 'plan_booking') {
    return res.redirect('/workspace?err=book');
  }
  if (!m.business_name) {
    return res.render('member/service-request-blocked', {
      layout: 'layouts/member',
      title: 'Business details required',
      service: rows[0],
      notifCount: await unreadCount(m.id),
    });
  }
  res.render('member/service-request-form', {
    layout: 'layouts/member',
    title: rows[0].name,
    pageSub: 'Submit a request · ' + rows[0].category_name,
    service: rows[0],
    notifCount: await unreadCount(m.id),
    query: req.query,
    formatNgn,
  });
});

router.post(
  '/services/request/:serviceId',
  upload.single('attachment'),
  requireValidCsrf,
  async (req, res) => {
    const m = res.locals.currentMember;
    const sid = Number(req.params.serviceId);
    const description = String(req.body.description || '').trim();
    if (!description) return res.redirect(`/services/request/${sid}?err=1`);

    const { rows: sv } = await pool.query(
      `SELECT name, COALESCE(portal_price_cents, 0)::bigint AS portal_price_cents,
        COALESCE(portal_active, true) AS portal_active,
        COALESCE(booking_mode, 'request') AS booking_mode
       FROM services WHERE id = $1 AND deleted_at IS NULL`,
      [sid]
    );
    if (!sv[0] || !sv[0].portal_active || sv[0].booking_mode === 'plan_booking') {
      return res.redirect(`/services/request/${sid}?err=1`);
    }
    const serviceName = sv[0].name || 'Service';
    const priceCents = Number(sv[0].portal_price_cents || 0);

    let fileMeta = null;
    if (req.file && req.file.buffer) {
      const v = validateUploadedFile({
        buffer: req.file.buffer,
        reportedMime: req.file.mimetype,
      });
      if (!v.ok) return res.redirect(`/services/request/${sid}?err=upload`);
      await ensureUploadRoot();
      const memberDir = path.join(uploadDir, String(m.id));
      await fs.mkdir(memberDir, { recursive: true });
      const ext = path.extname(req.file.originalname || '') || '.bin';
      const fname = `${crypto.randomUUID()}${ext}`;
      const storagePath = path.join(memberDir, fname);
      await fs.writeFile(storagePath, req.file.buffer);
      fileMeta = {
        original: req.file.originalname || 'file',
        storagePath,
        mime: v.mime,
        size: req.file.size,
      };
    }

    const detail = {
      extra: String(req.body.extra_details || '').trim(),
    };

    const dueDays = Number((await getSetting('default_invoice_due_days', '7')) || 7) || 7;
    const due = new Date();
    due.setDate(due.getDate() + dueDays);
    const dueStr = due.toISOString().slice(0, 10);

    let invNo = null;
    if (priceCents > 0) {
      invNo = await nextInvoiceNumber();
    }

    const client = await pool.connect();
    let rid;
    let invSummary = null;
    try {
      await client.query('BEGIN');
      let docId = null;
      if (fileMeta) {
        const insDoc = await client.query(
          `INSERT INTO member_documents (member_id, uploaded_by_type, uploaded_by_member_id, original_name, storage_path, mime_type, size_bytes, category)
           VALUES ($1, 'member', $1, $2, $3, $4, $5, 'service_request')
           RETURNING id`,
          [m.id, fileMeta.original, fileMeta.storagePath, fileMeta.mime, fileMeta.size]
        );
        docId = insDoc.rows[0].id;
      }
      const insR = await client.query(
        `INSERT INTO service_requests (member_id, service_id, title, description, detail_json, status)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'Submitted')
         RETURNING id`,
        [m.id, sid, serviceName, description, JSON.stringify(detail)]
      );
      rid = insR.rows[0].id;
      if (docId) {
        await client.query(
          `UPDATE member_documents SET service_request_id = $2 WHERE id = $1`,
          [docId, rid]
        );
      }
      await client.query(
        `INSERT INTO service_request_updates (service_request_id, stage, note, visible_to_member)
         VALUES ($1, 'Submitted', 'Request received.', true)`,
        [rid]
      );
      if (priceCents > 0 && invNo) {
        invSummary = await createServiceRequestInvoiceInTx(client, {
          memberId: m.id,
          serviceRequestId: rid,
          serviceName,
          priceCents,
          invoiceNumber: invNo,
          dueDateStr: dueStr,
        });
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(e);
      return res.redirect(`/services/request/${sid}?err=1`);
    } finally {
      client.release();
    }

    await logActivity({
      memberId: m.id,
      eventType: 'service',
      title: 'Service request submitted',
      body: serviceName,
      entityType: 'service_request',
      entityId: rid,
    });
    if (invSummary && invSummary.amount) {
      await sendServiceRequestInvoiceNotifications({
        memberId: m.id,
        memberEmail: m.email,
        memberName: m.full_name,
        notifyInvoiceEmail: m.notify_email_invoice,
        invoiceNumber: invSummary.number,
        amountCents: invSummary.amount,
        invId: invSummary.id,
        dueDateStr: dueStr,
        serviceRequestId: rid,
      });
    }
    res.redirect(`/services/${rid}`);
  }
);

router.get('/services/:id', async (req, res) => {
  const m = res.locals.currentMember;
  const id = req.params.id;
  const { rows } = await pool.query(
    `SELECT sr.*, sv.name AS service_name, c.name AS category_name
     FROM service_requests sr
     JOIN services sv ON sv.id = sr.service_id
     JOIN service_categories c ON c.id = sv.category_id
     WHERE sr.id = $1 AND sr.member_id = $2 AND sr.deleted_at IS NULL`,
    [id, m.id]
  );
  if (!rows[0]) return res.status(404).send('Not found');
  const sr = rows[0];
  const invIdSet = new Set();
  if (sr.invoice_id) invIdSet.add(sr.invoice_id);
  const linkedInv = await pool.query(
    `SELECT id FROM invoices WHERE service_request_id = $1::uuid AND member_id = $2 AND deleted_at IS NULL`,
    [id, m.id]
  );
  linkedInv.rows.forEach((r) => invIdSet.add(r.id));
  const linkInv = await pool.query(
    `SELECT invoice_id FROM invoice_service_links WHERE service_request_id = $1::uuid AND deleted_at IS NULL`,
    [id]
  );
  linkInv.rows.forEach((r) => invIdSet.add(r.invoice_id));
  const invoicesWithItems = [];
  for (const invId of invIdSet) {
    const invq = await pool.query(
      `SELECT * FROM invoices WHERE id = $1 AND member_id = $2 AND deleted_at IS NULL`,
      [invId, m.id]
    );
    const inv = invq.rows[0];
    if (!inv) continue;
    const it = await pool.query(
      `SELECT * FROM invoice_items WHERE invoice_id = $1 AND deleted_at IS NULL ORDER BY sort_order, id`,
      [inv.id]
    );
    invoicesWithItems.push({ invoice: inv, items: it.rows });
  }
  invoicesWithItems.sort(
    (a, b) => new Date(a.invoice.created_at).getTime() - new Date(b.invoice.created_at).getTime()
  );
  let bookingPlan = null;
  if (sr.service_plan_id) {
    const pq = await pool.query(
      `SELECT * FROM service_plans WHERE id = $1::uuid AND deleted_at IS NULL`,
      [sr.service_plan_id]
    );
    bookingPlan = pq.rows[0] || null;
  }
  const bankName = await getSetting('bank_name');
  const accountName = await getSetting('account_name');
  const accountNumber = await getSetting('account_number');
  const updates = await pool.query(
    `SELECT * FROM service_request_updates
     WHERE service_request_id = $1 AND deleted_at IS NULL AND visible_to_member = true
     ORDER BY created_at ASC`,
    [id]
  );
  const msgs = await pool.query(
    `SELECT srm.*, md.original_name AS attachment_name
     FROM service_request_messages srm
     LEFT JOIN member_documents md ON md.id = srm.attachment_document_id
     WHERE srm.service_request_id = $1 AND srm.deleted_at IS NULL
     ORDER BY srm.created_at ASC`,
    [id]
  );
  const docs = await pool.query(
    `SELECT * FROM member_documents
     WHERE service_request_id = $1 AND deleted_at IS NULL`,
    [id]
  );
  const notifCount = await unreadCount(m.id);
  let meetingCredits = { available: 0, granted: 0, used: 0, period_month: null };
  try {
    meetingCredits = await getAvailableCreditMinutes(pool, m.id);
  } catch {
    /* ignore */
  }
  const bcLabel =
    sr.service_name && sr.service_name.length > 48 ? sr.service_name.slice(0, 45) + '…' : sr.service_name || 'Service';
  res.render('member/service-detail', {
    layout: 'layouts/member',
    title: sr.service_name,
    pageSub: sr.category_name,
    headerVariant: 'service-detail',
    breadcrumbBack: '/services?tab=mine',
    breadcrumbItems: [
      { label: 'Services', href: '/services?tab=mine' },
      { label: bcLabel },
    ],
    sr,
    bookingPlan,
    meetingCredits,
    updates: updates.rows,
    msgs: msgs.rows,
    docs: docs.rows,
    invoicesWithItems,
    bankName,
    accountName,
    accountNumber,
    formatDateTime,
    formatNgn,
    formatDate,
    notifCount,
  });
});

router.post('/services/:id/message', requireValidCsrf, async (req, res) => {
  const m = res.locals.currentMember;
  const id = req.params.id;
  const body = String(req.body.body || '').trim();
  const chk = await pool.query(
    `SELECT id FROM service_requests WHERE id = $1 AND member_id = $2 AND deleted_at IS NULL`,
    [id, m.id]
  );
  if (!chk.rows[0] || !body) return res.redirect(`/services/${id}`);
  await pool.query(
    `INSERT INTO service_request_messages (service_request_id, sender_type, member_id, body)
     VALUES ($1, 'member', $2, $3)`,
    [id, m.id, body]
  );
  try {
    const { rows: srInfo } = await pool.query(
      `SELECT sr.assigned_admin_id, sv.name AS service_name
       FROM service_requests sr
       JOIN services sv ON sv.id = sr.service_id
       WHERE sr.id = $1::uuid AND sr.member_id = $2 AND sr.deleted_at IS NULL`,
      [id, m.id]
    );
    if (srInfo[0]) {
      await notifyStaffCustomerServiceRequestActivity(pool, {
        serviceRequestId: id,
        serviceName: srInfo[0].service_name,
        memberName: m.full_name,
        memberEmail: m.email,
        summaryLine: 'The customer sent a new message on this service request.',
        assignedAdminId: srInfo[0].assigned_admin_id,
      });
    }
  } catch (e) {
    console.error('service request staff notify', e.message);
  }
  res.redirect(`/services/${id}`);
});

router.get('/billing', async (req, res) => {
  const m = res.locals.currentMember;
  const today = new Date().toISOString().slice(0, 10);
  try {
    await pool.query(
      `UPDATE invoices SET status = 'overdue', updated_at = now()
       WHERE member_id = $1 AND status IN ('unpaid','sent') AND due_date < $2::date AND deleted_at IS NULL`,
      [m.id, today]
    );
  } catch (e) {
    console.error('billing overdue stamp', e.message);
  }
  let invRows = [];
  try {
    const { rows } = await pool.query(
      `SELECT * FROM invoices
       WHERE member_id = $1 AND deleted_at IS NULL AND status IN ('unpaid','sent','overdue','awaiting_confirmation')
       ORDER BY due_date ASC`,
      [m.id]
    );
    invRows = Array.isArray(rows) ? rows : [];
  } catch (e) {
    console.error('billing invoices', e);
    return res.status(500).send('Could not load invoices. Please try again.');
  }
  const invExtras = {};
  if (invRows.length) {
    const ids = invRows.map((r) => r.id);
    try {
      const { rows: linkRows } = await pool.query(
        `SELECT isl.*, sr.title AS sr_title, sv.name AS service_name
         FROM invoice_service_links isl
         LEFT JOIN service_requests sr ON sr.id = isl.service_request_id AND sr.deleted_at IS NULL
         LEFT JOIN services sv ON sv.id = sr.service_id
         WHERE isl.invoice_id = ANY($1::uuid[]) AND isl.deleted_at IS NULL`,
        [ids]
      );
      const { rows: rbRows } = await pool.query(
        `SELECT rb.*, mr.name AS room_name
         FROM room_bookings rb
         JOIN meeting_rooms mr ON mr.id = rb.meeting_room_id
         WHERE rb.invoice_id = ANY($1::uuid[]) AND rb.deleted_at IS NULL`,
        [ids]
      );
      ids.forEach((iid) => {
        invExtras[String(iid)] = { links: [], room: null };
      });
      linkRows.forEach((l) => {
        const iid = String(l.invoice_id);
        if (!invExtras[iid]) invExtras[iid] = { links: [], room: null };
        invExtras[iid].links.push(l);
      });
      rbRows.forEach((b) => {
        const iid = String(b.invoice_id);
        if (!invExtras[iid]) invExtras[iid] = { links: [], room: null };
        invExtras[iid].room = b;
      });
    } catch (e) {
      console.error('billing invoice extras', e);
    }
  }
  let historyRows = [];
  try {
    const history = await pool.query(
      `SELECT p.*, i.invoice_number, i.notes
       FROM payments p
       JOIN invoices i ON i.id = p.invoice_id
       WHERE p.member_id = $1 AND p.deleted_at IS NULL
       ORDER BY p.created_at DESC LIMIT 100`,
      [m.id]
    );
    historyRows = Array.isArray(history.rows) ? history.rows : [];
  } catch (e) {
    if (e && e.code === '42703') {
      try {
        const { rows } = await pool.query(
          `SELECT p.*, i.invoice_number, i.notes
           FROM payments p
           JOIN invoices i ON i.id = p.invoice_id
           WHERE p.member_id = $1
           ORDER BY p.created_at DESC LIMIT 100`,
          [m.id]
        );
        historyRows = Array.isArray(rows) ? rows : [];
      } catch (e2) {
        console.error('billing payments history (no deleted_at)', e2.message);
      }
    } else {
      console.error('billing payments history', e.message);
    }
  }
  let bankName = '';
  let accountName = '';
  let accountNumber = '';
  try {
    bankName = await getSetting('bank_name');
    accountName = await getSetting('account_name');
    accountNumber = await getSetting('account_number');
  } catch (e) {
    console.error('billing portal_settings', e.message);
  }
  let notifCount = 0;
  try {
    notifCount = await unreadCount(m.id);
  } catch (e) {
    console.error('billing unreadCount', e.message);
  }
  const invoiceFocus = isUuidString(req.query.invoice) ? req.query.invoice : null;
  const bookedBanner = req.query.booked === '1';
  const bookingRef =
    typeof req.query.ref === 'string' && req.query.ref.length <= 80 ? req.query.ref : null;
  const billingSummary = computeBillingSummary(invRows, historyRows, formatDate);
  const pageSub = new Date().toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  try {
    res.render('member/billing', {
      layout: 'layouts/member',
      title: 'Payments',
      pageSub,
      outstanding: invRows,
      invExtras,
      history: historyRows,
      billingSummary,
      formatNgn,
      formatDate,
      formatDateTime,
      bankName,
      accountName,
      accountNumber,
      baseUrl: process.env.BASE_URL || '',
      notifCount,
      invoiceFocus,
      bookedBanner,
      bookingRef,
      billingMsg: req.query.msg === 'manual' ? 'manual' : null,
      billingErr: typeof req.query.err === 'string' ? req.query.err : null,
    });
  } catch (e) {
    console.error('billing render', e);
    return res.status(500).send('Could not load billing page. Please try again.');
  }
});

router.post('/billing/pay/init', requireValidCsrf, async (req, res) => {
  const m = res.locals.currentMember;
  const invoiceId = req.body.invoice_id;
  const { rows } = await pool.query(
    `SELECT * FROM invoices WHERE id = $1 AND member_id = $2 AND deleted_at IS NULL`,
    [invoiceId, m.id]
  );
  const inv = rows[0];
  const invSt = String(inv && inv.status ? inv.status : '').toLowerCase();
  if (!inv || !['unpaid', 'sent', 'overdue'].includes(invSt)) {
    return res.status(400).json({ error: 'Invalid invoice' });
  }
  const ref = `PH-${crypto.randomBytes(12).toString('hex')}`;
  const ins = await pool.query(
    `INSERT INTO payments (invoice_id, member_id, amount_cents, method, status, paystack_reference)
     VALUES ($1, $2, $3, 'paystack', 'pending', $4)
     RETURNING id`,
    [inv.id, m.id, inv.total_cents, ref]
  );
  try {
    const data = await initializeTransaction({
      email: m.email,
      amountCents: inv.total_cents,
      reference: ref,
      callbackUrl: `${process.env.BASE_URL || ''}/billing`,
      metadata: { invoice_id: inv.id, payment_id: ins.rows[0].id },
    });
    await pool.query(
      `UPDATE payments SET paystack_access_code = $2 WHERE id = $1`,
      [ins.rows[0].id, data.access_code || null]
    );
    return res.json({
      authorization_url: data.authorization_url,
      reference: ref,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Paystack error' });
  }
});

router.post('/billing/manual', upload.single('proof'), requireValidCsrf, async (req, res) => {
  const m = res.locals.currentMember;
  const invoiceId = req.body.invoice_id;
  const { rows } = await pool.query(
    `SELECT * FROM invoices WHERE id = $1 AND member_id = $2 AND deleted_at IS NULL`,
    [invoiceId, m.id]
  );
  const inv = rows[0];
  const invSt = String(inv && inv.status ? inv.status : '').toLowerCase();
  if (!inv || !['unpaid', 'sent', 'overdue'].includes(invSt)) {
    return res.redirect('/billing?err=inv');
  }
  if (!req.file || !req.file.buffer) {
    return res.redirect('/billing?err=proof');
  }
  const v = validateUploadedFile({
    buffer: req.file.buffer,
    reportedMime: req.file.mimetype,
  });
  if (!v.ok) return res.redirect('/billing?err=type');
  await ensureUploadRoot();
  const memberDir = path.join(uploadDir, String(m.id));
  await fs.mkdir(memberDir, { recursive: true });
  const fname = `${crypto.randomUUID()}${path.extname(req.file.originalname || '') || '.pdf'}`;
  const storagePath = path.join(memberDir, fname);
  await fs.writeFile(storagePath, req.file.buffer);
  const doc = await pool.query(
    `INSERT INTO member_documents (member_id, uploaded_by_type, uploaded_by_member_id, original_name, storage_path, mime_type, size_bytes, category)
     VALUES ($1, 'member', $1, $2, $3, $4, $5, 'payment_proof')
     RETURNING id`,
    [
      m.id,
      req.file.originalname || 'proof',
      storagePath,
      v.mime,
      req.file.size,
    ]
  );
  await pool.query(
    `UPDATE invoices SET status = 'awaiting_confirmation', bank_proof_document_id = $2, updated_at = now()
     WHERE id = $1`,
    [inv.id, doc.rows[0].id]
  );
  await notifyMember({
    memberId: m.id,
    title: 'Bank transfer submitted',
    message: 'We will confirm your payment shortly.',
    linkUrl: '/billing',
  });
  res.redirect('/billing?msg=manual');
});

router.get('/billing/invoices/:invoiceId/print', async (req, res) => {
  const m = res.locals.currentMember;
  const invoiceId = req.params.invoiceId;
  const { rows } = await pool.query(
    `SELECT i.*, m.full_name, m.email
     FROM invoices i
     JOIN members m ON m.id = i.member_id
     WHERE i.id = $1::uuid AND i.member_id = $2 AND i.deleted_at IS NULL`,
    [invoiceId, m.id]
  );
  if (!rows[0]) return res.status(404).send('Not found');
  const inv = rows[0];
  const items = await pool.query(
    `SELECT * FROM invoice_items WHERE invoice_id = $1::uuid AND deleted_at IS NULL ORDER BY sort_order, id`,
    [invoiceId]
  );
  const { rows: invoiceLinks } = await pool.query(
    `SELECT isl.*, sr.title AS sr_title, sv.name AS service_name
     FROM invoice_service_links isl
     JOIN service_requests sr ON sr.id = isl.service_request_id
     JOIN services sv ON sv.id = sr.service_id
     WHERE isl.invoice_id = $1::uuid AND isl.deleted_at IS NULL`,
    [invoiceId]
  );
  const { rows: rbRows } = await pool.query(
    `SELECT rb.*, mr.name AS room_name
     FROM room_bookings rb
     JOIN meeting_rooms mr ON mr.id = rb.meeting_room_id
     WHERE rb.invoice_id = $1::uuid AND rb.deleted_at IS NULL`,
    [invoiceId]
  );
  res.render('member/invoice-print', {
    layout: false,
    inv,
    items: items.rows,
    invoiceLinks: invoiceLinks.rows,
    roomBooking: rbRows[0] || null,
    formatNgn,
    formatDate,
    formatDateTime,
    memberPortalCssV: res.app.locals.memberPortalCssV,
  });
});

router.get('/billing/receipt/:paymentId', async (req, res) => {
  const m = res.locals.currentMember;
  const { rows } = await pool.query(
    `SELECT p.*, i.invoice_number, i.due_date
     FROM payments p
     JOIN invoices i ON i.id = p.invoice_id
     WHERE p.id = $1 AND p.member_id = $2 AND p.status = 'completed'`,
    [req.params.paymentId, m.id]
  );
  if (!rows[0]) return res.status(404).send('Not found');
  res.render('member/receipt', {
    layout: false,
    p: rows[0],
    formatNgn,
    formatDateTime,
  });
});

router.get('/documents', async (req, res) => {
  const m = res.locals.currentMember;
  const shared = await pool.query(
    `SELECT * FROM member_documents
     WHERE member_id = $1 AND is_admin_shared = true AND deleted_at IS NULL
     ORDER BY created_at DESC`,
    [m.id]
  );
  const mine = await pool.query(
    `SELECT * FROM member_documents
     WHERE member_id = $1 AND uploaded_by_type = 'member' AND deleted_at IS NULL
     ORDER BY created_at DESC`,
    [m.id]
  );
  const notifCount = await unreadCount(m.id);
  res.render('member/documents', {
    layout: 'layouts/member',
    title: 'Documents',
    shared: shared.rows,
    mine: mine.rows,
    formatDateTime,
    notifCount,
    query: req.query,
  });
});

router.post('/documents/upload', upload.single('file'), requireValidCsrf, async (req, res) => {
  const m = res.locals.currentMember;
  if (!req.file || !req.file.buffer) return res.redirect('/documents?err=file');
  const v = validateUploadedFile({
    buffer: req.file.buffer,
    reportedMime: req.file.mimetype,
  });
  if (!v.ok) return res.redirect('/documents?err=type');
  await ensureUploadRoot();
  const memberDir = path.join(uploadDir, String(m.id));
  await fs.mkdir(memberDir, { recursive: true });
  const fname = `${crypto.randomUUID()}${path.extname(req.file.originalname || '') || '.bin'}`;
  const storagePath = path.join(memberDir, fname);
  await fs.writeFile(storagePath, req.file.buffer);
  await pool.query(
    `INSERT INTO member_documents (member_id, uploaded_by_type, uploaded_by_member_id, original_name, storage_path, mime_type, size_bytes, category, is_admin_shared)
     VALUES ($1, 'member', $1, $2, $3, $4, $5, 'member_upload', false)`,
    [
      m.id,
      req.file.originalname || 'file',
      storagePath,
      v.mime,
      req.file.size,
    ]
  );
  await logActivity({
    memberId: m.id,
    eventType: 'document',
    title: 'Document uploaded',
    body: req.file.originalname,
    entityType: 'document',
    entityId: null,
  });
  res.redirect('/documents?msg=ok');
});

router.get('/documents/download/:id', async (req, res) => {
  const m = res.locals.currentMember;
  const { rows } = await pool.query(
    `SELECT * FROM member_documents WHERE id = $1 AND member_id = $2 AND deleted_at IS NULL`,
    [req.params.id, m.id]
  );
  const d = rows[0];
  if (!d) return res.status(404).send('Not found');
  try {
    const buf = await fs.readFile(d.storage_path);
    res.setHeader('Content-Type', d.mime_type);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(d.original_name)}"`
    );
    res.send(buf);
  } catch {
    res.status(404).send('Missing file');
  }
});

router.get('/support', async (req, res) => {
  const m = res.locals.currentMember;
  const { rows } = await pool.query(
    `SELECT * FROM support_tickets WHERE member_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`,
    [m.id]
  );
  const notifCount = await unreadCount(m.id);
  res.render('member/support-list', {
    layout: 'layouts/member',
    title: 'Support',
    tickets: rows,
    formatDateTime,
    notifCount,
  });
});

router.get('/support/new', async (req, res) => {
  const m = res.locals.currentMember;
  res.render('member/support-new', {
    layout: 'layouts/member',
    title: 'New ticket',
    notifCount: await unreadCount(m.id),
  });
});

router.post(
  '/support/new',
  upload.single('attachment'),
  requireValidCsrf,
  async (req, res) => {
    const m = res.locals.currentMember;
    const subject = String(req.body.subject || '').trim();
    const category = String(req.body.category || 'General Enquiry');
    const description = String(req.body.description || '').trim();
    if (!subject || !description) return res.redirect('/support/new?err=1');
    const ins = await pool.query(
      `INSERT INTO support_tickets (member_id, subject, category, status)
       VALUES ($1, $2, $3, 'Open')
       RETURNING id`,
      [m.id, subject, category]
    );
    const tid = ins.rows[0].id;
    let attId = null;
    if (req.file && req.file.buffer) {
      const v = validateUploadedFile({
        buffer: req.file.buffer,
        reportedMime: req.file.mimetype,
      });
      if (v.ok) {
        await ensureUploadRoot();
        const memberDir = path.join(uploadDir, String(m.id));
        await fs.mkdir(memberDir, { recursive: true });
        const fname = `${crypto.randomUUID()}${path.extname(req.file.originalname || '') || '.bin'}`;
        const storagePath = path.join(memberDir, fname);
        await fs.writeFile(storagePath, req.file.buffer);
        const doc = await pool.query(
          `INSERT INTO member_documents (member_id, uploaded_by_type, uploaded_by_member_id, original_name, storage_path, mime_type, size_bytes, category, support_ticket_id)
           VALUES ($1, 'member', $1, $2, $3, $4, $5, 'support', $6)
           RETURNING id`,
          [
            m.id,
            req.file.originalname || 'file',
            storagePath,
            v.mime,
            req.file.size,
            tid,
          ]
        );
        attId = doc.rows[0].id;
      }
    }
    await pool.query(
      `INSERT INTO support_messages (ticket_id, sender_type, member_id, body, attachment_document_id)
       VALUES ($1, 'member', $2, $3, $4)`,
      [tid, m.id, description, attId]
    );
    res.redirect(`/support/${tid}`);
  }
);

router.get('/support/:id', async (req, res) => {
  const m = res.locals.currentMember;
  const { rows } = await pool.query(
    `SELECT * FROM support_tickets WHERE id = $1 AND member_id = $2 AND deleted_at IS NULL`,
    [req.params.id, m.id]
  );
  if (!rows[0]) return res.status(404).send('Not found');
  const msgs = await pool.query(
    `SELECT sm.*, md.original_name AS attach_name
     FROM support_messages sm
     LEFT JOIN member_documents md ON md.id = sm.attachment_document_id
     WHERE sm.ticket_id = $1 AND sm.deleted_at IS NULL AND sm.internal_note = false
     ORDER BY sm.created_at ASC`,
    [req.params.id]
  );
  let canReopenTicket = false;
  const t0 = rows[0];
  if (t0.status === 'Resolved' && t0.last_member_reopen_deadline) {
    canReopenTicket = new Date(t0.last_member_reopen_deadline) > new Date();
  }
  res.render('member/support-detail', {
    layout: 'layouts/member',
    title: rows[0].subject,
    pageSub: rows[0].category,
    ticket: rows[0],
    msgs: msgs.rows,
    formatDateTime,
    notifCount: await unreadCount(m.id),
    canReopenTicket,
  });
});

router.post('/support/:id/reply', upload.single('attachment'), requireValidCsrf, async (req, res) => {
  const m = res.locals.currentMember;
  const tid = req.params.id;
  const body = String(req.body.body || '').trim();
  const chk = await pool.query(
    `SELECT * FROM support_tickets WHERE id = $1 AND member_id = $2 AND deleted_at IS NULL`,
    [tid, m.id]
  );
  if (!chk.rows[0]) return res.status(404).send('Not found');
  if (!body) return res.redirect(`/support/${tid}`);
  let attId = null;
  if (req.file && req.file.buffer) {
    const v = validateUploadedFile({
      buffer: req.file.buffer,
      reportedMime: req.file.mimetype,
    });
    if (v.ok) {
      await ensureUploadRoot();
      const memberDir = path.join(uploadDir, String(m.id));
      await fs.mkdir(memberDir, { recursive: true });
      const fname = `${crypto.randomUUID()}${path.extname(req.file.originalname || '') || '.bin'}`;
      const storagePath = path.join(memberDir, fname);
      await fs.writeFile(storagePath, req.file.buffer);
      const doc = await pool.query(
        `INSERT INTO member_documents (member_id, uploaded_by_type, uploaded_by_member_id, original_name, storage_path, mime_type, size_bytes, category, support_ticket_id)
         VALUES ($1, 'member', $1, $2, $3, $4, $5, 'support', $6)
         RETURNING id`,
        [m.id, req.file.originalname || 'file', storagePath, v.mime, req.file.size, tid]
      );
      attId = doc.rows[0].id;
    }
  }
  await pool.query(
    `INSERT INTO support_messages (ticket_id, sender_type, member_id, body, attachment_document_id)
     VALUES ($1, 'member', $2, $3, $4)`,
    [tid, m.id, body, attId]
  );
  await pool.query(
    `UPDATE support_tickets SET status = 'Open', updated_at = now() WHERE id = $1 AND status != 'Closed'`,
    [tid]
  );
  res.redirect(`/support/${tid}`);
});

router.post('/support/:id/reopen', requireValidCsrf, async (req, res) => {
  const m = res.locals.currentMember;
  const tid = req.params.id;
  const { rows } = await pool.query(
    `SELECT * FROM support_tickets WHERE id = $1 AND member_id = $2 AND deleted_at IS NULL`,
    [tid, m.id]
  );
  const t = rows[0];
  if (!t || t.status !== 'Resolved') return res.redirect(`/support/${tid}`);
  if (!t.last_member_reopen_deadline || new Date(t.last_member_reopen_deadline) < new Date()) {
    return res.redirect(`/support/${tid}?err=reopen`);
  }
  await pool.query(
    `UPDATE support_tickets SET status = 'Open', resolved_at = NULL, last_member_reopen_deadline = NULL, updated_at = now() WHERE id = $1`,
    [tid]
  );
  res.redirect(`/support/${tid}`);
});

router.get('/settings', async (req, res) => {
  const m = res.locals.currentMember;
  res.redirect('/settings/profile');
});

router.get('/settings/:tab', async (req, res) => {
  const m = res.locals.currentMember;
  const tab = req.params.tab;
  if (!['profile', 'business', 'notifications', 'security'].includes(tab)) {
    return res.redirect('/settings/profile');
  }
  const sessions = await pool.query(
    `SELECT * FROM member_tracked_sessions WHERE member_id = $1 ORDER BY last_seen_at DESC`,
    [m.id]
  );
  res.render('member/settings', {
    layout: 'layouts/member',
    title: 'Settings',
    pageSub: 'Account, business, notifications, and security',
    tab,
    sessions: sessions.rows,
    formatDateTime,
    notifCount: await unreadCount(m.id),
    currentMember: m,
    query: req.query,
  });
});

router.post('/settings/profile', requireValidCsrf, upload.single('photo'), async (req, res) => {
  const m = res.locals.currentMember;
  const full_name = String(req.body.full_name || '').trim();
  const phone = String(req.body.phone || '').trim();
  let email = String(req.body.email || '')
    .trim()
    .toLowerCase();
  const emailChanged = email !== m.email;

  const opt = (name) => String(req.body[name] || '').trim() || null;
  const salutation = opt('salutation');
  const first_name = opt('first_name');
  const last_name = opt('last_name');
  const contact_name = opt('contact_name');
  const contact_type = opt('contact_type');
  const billing_state = opt('billing_state');
  const billing_country = opt('billing_country');
  const mobile_phone = opt('mobile_phone');
  const crm_product = opt('crm_product');

  const profileExtras = [
    salutation,
    first_name,
    last_name,
    contact_name,
    contact_type,
    billing_state,
    billing_country,
    mobile_phone,
    crm_product,
  ];

  if (emailChanged) {
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 48 * 3600 * 1000);
    await pool.query(
      `UPDATE members SET full_name = $2, phone = $3, email = $4,
       salutation = $5, first_name = $6, last_name = $7, contact_name = $8, contact_type = $9,
       billing_state = $10, billing_country = $11, mobile_phone = $12, crm_product = $13,
       email_verified_at = NULL, email_verification_token = $14, email_verification_expires = $15, updated_at = now()
       WHERE id = $1`,
      [m.id, full_name, phone, email, ...profileExtras, token, expires]
    );
    const { sendVerificationEmail } = require('../lib/mail');
    const base = process.env.BASE_URL || '';
    await sendVerificationEmail({
      to: email,
      name: full_name,
      verifyUrl: `${base}/auth/verify?token=${encodeURIComponent(token)}`,
    });
  } else {
    await pool.query(
      `UPDATE members SET full_name = $2, phone = $3,
       salutation = $4, first_name = $5, last_name = $6, contact_name = $7, contact_type = $8,
       billing_state = $9, billing_country = $10, mobile_phone = $11, crm_product = $12,
       updated_at = now() WHERE id = $1`,
      [m.id, full_name, phone, ...profileExtras]
    );
  }
  if (req.file && req.file.buffer) {
    const v = validateUploadedFile({
      buffer: req.file.buffer,
      reportedMime: req.file.mimetype,
    });
    if (v.ok && (v.mime === 'image/jpeg' || v.mime === 'image/png')) {
      await ensureUploadRoot();
      const memberDir = path.join(uploadDir, String(m.id));
      await fs.mkdir(memberDir, { recursive: true });
      const fname = `avatar-${crypto.randomUUID()}${path.extname(req.file.originalname || '') || '.jpg'}`;
      const storagePath = path.join(memberDir, fname);
      await fs.writeFile(storagePath, req.file.buffer);
      await pool.query(
        `UPDATE members SET profile_photo_path = $2 WHERE id = $1`,
        [m.id, storagePath]
      );
    }
  }
  res.redirect('/settings/profile?msg=1');
});

router.post('/settings/business', requireValidCsrf, async (req, res) => {
  const m = res.locals.currentMember;
  await pool.query(
    `UPDATE members SET business_name = $2, business_type = $3, cac_number = $4, industry = $5, website = $6, updated_at = now()
     WHERE id = $1`,
    [
      m.id,
      String(req.body.business_name || '').trim() || null,
      String(req.body.business_type || '').trim() || null,
      String(req.body.cac_number || '').trim() || null,
      String(req.body.industry || '').trim() || null,
      String(req.body.website || '').trim() || null,
    ]
  );
  res.redirect('/settings/business?msg=1');
});

router.post('/settings/notifications', requireValidCsrf, async (req, res) => {
  const m = res.locals.currentMember;
  const on = (name) => req.body[name] === '1' || req.body[name] === 'on';
  await pool.query(
    `UPDATE members SET
     notify_email_invoice = $2, notify_email_service = $3, notify_email_support = $4,
     notify_email_announcements = $5, notify_sms = $6, updated_at = now()
     WHERE id = $1`,
    [
      m.id,
      on('notify_email_invoice'),
      on('notify_email_service'),
      on('notify_email_support'),
      on('notify_email_announcements'),
      on('notify_sms'),
    ]
  );
  res.redirect('/settings/notifications?msg=1');
});

router.post('/settings/password', requireValidCsrf, async (req, res) => {
  const m = res.locals.currentMember;
  const bcrypt = require('bcryptjs');
  const oldp = String(req.body.current_password || '');
  const p1 = String(req.body.password || '');
  const p2 = String(req.body.password2 || '');
  if (!(await bcrypt.compare(oldp, m.password_hash))) {
    return res.redirect('/settings/security?err=old');
  }
  if (p1.length < 8 || p1 !== p2) {
    return res.redirect('/settings/security?err=pw');
  }
  const hash = await bcrypt.hash(p1, 10);
  await pool.query(
    `UPDATE members SET password_hash = $2, updated_at = now() WHERE id = $1`,
    [m.id, hash]
  );
  res.redirect('/settings/security?msg=1');
});

router.post('/settings/session-revoke', requireValidCsrf, async (req, res) => {
  const m = res.locals.currentMember;
  const sid = String(req.body.session_sid || '');
  if (sid === req.sessionID) {
    return res.redirect('/settings/security?err=self');
  }
  await pool.query(
    `DELETE FROM member_sessions WHERE sid = $1`,
    [sid]
  );
  await pool.query(
    `DELETE FROM member_tracked_sessions WHERE session_sid = $1 AND member_id = $2`,
    [sid, m.id]
  );
  res.redirect('/settings/security?msg=revoked');
});

router.get('/notifications', async (req, res) => {
  const m = res.locals.currentMember;
  const rows = await recentForMember(m.id, 50);
  res.render('member/notifications', {
    layout: 'layouts/member',
    title: 'Notifications',
    rows,
    formatDateTime,
    notifCount: await unreadCount(m.id),
  });
});

router.post('/notifications/mark-all', requireValidCsrf, async (req, res) => {
  await markAllRead(res.locals.currentMember.id);
  res.redirect(req.get('referer') || '/dashboard');
});

router.post('/notifications/:id/read', requireValidCsrf, async (req, res) => {
  await markRead(res.locals.currentMember.id, req.params.id);
  res.redirect(req.get('referer') || '/notifications');
});

module.exports = router;
