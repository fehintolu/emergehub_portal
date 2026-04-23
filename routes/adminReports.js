const express = require('express');
const { pool } = require('../lib/db');
const { requireAdmin } = require('../middleware/adminAuth');
const { requireValidCsrf } = require('../lib/csrf');
const { blockViewerMutations, enforceViewerReadOnlyGet } = require('../lib/adminRbac');
const { restrictConsultantScope } = require('../middleware/consultantScope');
const { adminLayoutLocals } = require('../middleware/adminLayoutLocals');
const { notifyMember } = require('../lib/notifications');
const { sendMemberPortalNotificationEmail } = require('../lib/mail');
const {
  HUB_TZ,
  hubToday,
  revenueLast6MonthBuckets,
  sumPaymentsBetween,
  activeMemberCountToday,
  needsActionServiceRequestCount,
  monthlyEquivalentCents,
  formatNgn,
  formatDate,
} = require('../lib/adminReportsData');

const router = express.Router();
router.use(requireAdmin);
router.use(adminLayoutLocals);
router.use(restrictConsultantScope);
router.use(enforceViewerReadOnlyGet);
router.use(blockViewerMutations);

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function addDaysDateStr(isoDate, days) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function planFilterSql(planType) {
  const p = String(planType || '').trim();
  if (!p || p === 'all') return { sql: '', params: [] };
  if (p === 'daily_access') {
    return {
      sql: ` AND (sp.plan_kind = 'workspace_day' OR lower(trim(sp.plan_slug)) = 'daily-pass') `,
      params: [],
    };
  }
  if (p === 'super_desk') {
    return { sql: ` AND lower(sp.plan_slug) LIKE 'super-desk%' `, params: [] };
  }
  if (p === 'hot_desk') {
    return { sql: ` AND lower(sp.plan_slug) LIKE 'hot-desk%' `, params: [] };
  }
  if (p === 'dedicated_desk') {
    return { sql: ` AND lower(sp.plan_slug) LIKE 'dedicated-desk%' `, params: [] };
  }
  if (p === 'private_office') {
    return { sql: ` AND sp.plan_kind = 'private_office' `, params: [] };
  }
  if (p === 'virtual_office') {
    return {
      sql: ` AND (sp.plan_kind = 'virtual' OR EXISTS (
        SELECT 1 FROM services s2 JOIN service_categories c2 ON c2.id = s2.category_id
        WHERE s2.id = sp.service_id AND c2.slug = 'virtual-remote')) `,
      params: [],
    };
  }
  return { sql: '', params: [] };
}

router.get('/operations', (req, res) => {
  res.render('admin/operations-dashboard', {
    layout: 'layouts/admin',
    title: 'Operations Dashboard',
    pageSub: 'Today, members, service queue, payments due',
    formatNgn,
    formatDate,
  });
});

router.get('/finance', (req, res) => {
  res.render('admin/finance-report', {
    layout: 'layouts/admin',
    title: 'Finance Report',
    pageSub: 'Revenue, subscriptions, ledger, consultants',
    formatNgn,
    formatDate,
  });
});

/** Member-facing receipt template; admin-only guard (no test members). */
router.get('/reports/invoice-receipt/:invoiceId/:paymentId', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.*, i.invoice_number, i.due_date
     FROM payments p
     JOIN invoices i ON i.id = p.invoice_id AND i.deleted_at IS NULL
     JOIN members m ON m.id = i.member_id AND m.deleted_at IS NULL AND (m.is_test_account IS NOT TRUE)
     WHERE p.id = $1::uuid AND i.id = $2::uuid AND p.status = 'completed' AND p.deleted_at IS NULL`,
    [req.params.paymentId, req.params.invoiceId]
  );
  if (!rows[0]) return res.status(404).send('Not found');
  res.render('member/receipt', {
    layout: false,
    p: rows[0],
    formatNgn,
    formatDateTime: require('../lib/format').formatDateTime,
  });
});

router.get('/reports/api/operations-dashboard', async (req, res) => {
  const { tz, today } = await hubToday(pool);
  const todayStr =
    today instanceof Date ? today.toISOString().slice(0, 10) : String(today).slice(0, 10);

  const { rows: bounds } = await pool.query(
    `SELECT
       (date_trunc('month', timezone($1::text, now())))::date AS month_start,
       (date_trunc('month', timezone($1::text, now())) - interval '1 month')::date AS prev_month_start`,
    [tz]
  );
  const monthStart = bounds[0].month_start;
  const prevMonthStart = bounds[0].prev_month_start;
  const monthStartStr =
    monthStart instanceof Date ? monthStart.toISOString().slice(0, 10) : String(monthStart).slice(0, 10);
  const prevMonthStartStr =
    prevMonthStart instanceof Date
      ? prevMonthStart.toISOString().slice(0, 10)
      : String(prevMonthStart).slice(0, 10);

  const mtdDays = Math.floor(
    (new Date(`${todayStr}T12:00:00Z`) - new Date(`${monthStartStr}T12:00:00Z`)) / 86400000
  );
  const prevWindowEnd = addDaysDateStr(prevMonthStartStr, mtdDays);

  const revenueToday = await sumPaymentsBetween(pool, todayStr, addDaysDateStr(todayStr, 1));
  const revenueMtd = await sumPaymentsBetween(pool, monthStartStr, addDaysDateStr(todayStr, 1));
  const revenuePrevPartial = await sumPaymentsBetween(
    pool,
    prevMonthStartStr,
    addDaysDateStr(prevWindowEnd, 1)
  );
  let mtdComparePct = null;
  if (revenuePrevPartial > 0) {
    mtdComparePct = Math.round(((revenueMtd - revenuePrevPartial) / revenuePrevPartial) * 1000) / 10;
  } else if (revenueMtd > 0) {
    mtdComparePct = 100;
  } else {
    mtdComparePct = 0;
  }

  const activeToday = await activeMemberCountToday(pool, todayStr);
  const needsAction = await needsActionServiceRequestCount(pool, todayStr);

  const { rows: outstandingRows } = await pool.query(
    `SELECT COALESCE(SUM(i.total_cents), 0)::bigint AS t
     FROM invoices i
     JOIN members m ON m.id = i.member_id AND m.deleted_at IS NULL AND (m.is_test_account IS NOT TRUE)
     WHERE i.deleted_at IS NULL
       AND i.status IN ('unpaid', 'sent', 'overdue', 'awaiting_confirmation')`,
    []
  );
  const outstandingCents = Number(outstandingRows[0].t) || 0;

  const weekEndStr = addDaysDateStr(todayStr, 7);

  const { rows: dueToday } = await pool.query(
    `SELECT i.id, i.invoice_number, i.total_cents, i.due_date,
            m.id AS member_id, m.full_name AS member_name,
            (SELECT ii.description FROM invoice_items ii
              WHERE ii.invoice_id = i.id AND ii.deleted_at IS NULL
              ORDER BY ii.sort_order, ii.created_at LIMIT 1) AS line_desc
     FROM invoices i
     JOIN members m ON m.id = i.member_id AND m.deleted_at IS NULL AND (m.is_test_account IS NOT TRUE)
     WHERE i.deleted_at IS NULL
       AND i.status IN ('unpaid', 'sent', 'overdue', 'awaiting_confirmation')
       AND i.due_date = $1::date
     ORDER BY m.full_name ASC, i.invoice_number ASC`,
    [todayStr]
  );

  const { rows: dueWeek } = await pool.query(
    `SELECT i.id, i.invoice_number, i.total_cents, i.due_date,
            m.id AS member_id, m.full_name AS member_name,
            (SELECT ii.description FROM invoice_items ii
              WHERE ii.invoice_id = i.id AND ii.deleted_at IS NULL
              ORDER BY ii.sort_order, ii.created_at LIMIT 1) AS line_desc
     FROM invoices i
     JOIN members m ON m.id = i.member_id AND m.deleted_at IS NULL AND (m.is_test_account IS NOT TRUE)
     WHERE i.deleted_at IS NULL
       AND i.status IN ('unpaid', 'sent', 'overdue', 'awaiting_confirmation')
       AND i.due_date > $1::date AND i.due_date <= $2::date
     ORDER BY i.due_date ASC, m.full_name ASC`,
    [todayStr, weekEndStr]
  );

  const latestNoteSql = `(SELECT u.note FROM service_request_updates u
     WHERE u.service_request_id = sr.id AND u.deleted_at IS NULL AND u.note IS NOT NULL
     ORDER BY u.created_at DESC LIMIT 1)`;

  const { rows: awaitingAssign } = await pool.query(
    `SELECT sr.id, sr.created_at, sr.service_end_date,
            m.full_name AS member_name, sv.name AS service_name
     FROM service_requests sr
     JOIN members m ON m.id = sr.member_id AND m.deleted_at IS NULL AND (m.is_test_account IS NOT TRUE)
     JOIN services sv ON sv.id = sr.service_id
     WHERE sr.deleted_at IS NULL AND sr.status = 'Submitted' AND sr.assigned_admin_id IS NULL
     ORDER BY sr.created_at ASC`,
    []
  );

  const { rows: awaitingMember } = await pool.query(
    `SELECT sr.id, sr.created_at, sr.updated_at, sr.service_end_date,
            m.full_name AS member_name, sv.name AS service_name,
            ${latestNoteSql} AS staff_note
     FROM service_requests sr
     JOIN members m ON m.id = sr.member_id AND m.deleted_at IS NULL AND (m.is_test_account IS NOT TRUE)
     JOIN services sv ON sv.id = sr.service_id
     WHERE sr.deleted_at IS NULL AND sr.status NOT IN ('Completed', 'Cancelled')
       AND (sr.action_required_member = TRUE OR sr.status = 'Action Required')
       AND NOT (sr.status = 'Submitted' AND sr.assigned_admin_id IS NULL)
     ORDER BY sr.updated_at ASC`,
    []
  );

  const { rows: overdueSr } = await pool.query(
    `SELECT sr.id, sr.created_at, sr.service_end_date,
            m.full_name AS member_name, sv.name AS service_name,
            pa.username AS consultant_name
     FROM service_requests sr
     JOIN members m ON m.id = sr.member_id AND m.deleted_at IS NULL AND (m.is_test_account IS NOT TRUE)
     JOIN services sv ON sv.id = sr.service_id
     LEFT JOIN portal_admin_users pa ON pa.id = sr.assigned_admin_id AND pa.deleted_at IS NULL
     WHERE sr.deleted_at IS NULL
       AND sr.service_end_date IS NOT NULL AND sr.service_end_date < $1::date
       AND sr.status NOT IN ('Completed', 'Cancelled')
     ORDER BY sr.service_end_date ASC`,
    [todayStr]
  );

  const srEmpty =
    !awaitingAssign.length && !awaitingMember.length && !overdueSr.length;

  res.json({
    today: todayStr,
    revenueTodayCents: revenueToday,
    revenueMtdCents: revenueMtd,
    revenueMtdComparePct: mtdComparePct,
    revenueMtdCompareBaseCents: revenuePrevPartial,
    activeToday,
    needsAction,
    outstandingCents,
    dueToday: dueToday.map((r) => ({
      ...r,
      due_label: formatDate(r.due_date),
      amount_label: formatNgn(r.total_cents),
    })),
    dueWeek: dueWeek.map((r) => ({
      ...r,
      due_label: formatDate(r.due_date),
      amount_label: formatNgn(r.total_cents),
    })),
    awaitingAssign: awaitingAssign.map((r) => ({
      id: r.id,
      member_name: r.member_name,
      service_name: r.service_name,
      submitted_label: formatDate(r.created_at),
      days_waiting: Math.max(
        0,
        Math.floor(
          (new Date(`${todayStr}T12:00:00Z`) - new Date(r.created_at)) / 86400000
        )
      ),
    })),
    awaitingMember: awaitingMember.map((r) => ({
      id: r.id,
      member_name: r.member_name,
      service_name: r.service_name,
      staff_note: r.staff_note || '—',
      days_waiting: Math.max(
        0,
        Math.floor((new Date(`${todayStr}T12:00:00Z`) - new Date(r.updated_at || r.created_at)) / 86400000)
      ),
    })),
    overdue: overdueSr.map((r) => ({
      id: r.id,
      member_name: r.member_name,
      service_name: r.service_name,
      consultant: r.consultant_name || 'Unassigned',
      days_overdue: Math.max(
        0,
        Math.floor(
          (new Date(`${todayStr}T12:00:00Z`) -
            new Date(`${r.service_end_date}T12:00:00Z`)) /
            86400000
        )
      ),
    })),
    serviceRequestsEmpty: srEmpty,
    labels: {
      revenueToday: formatNgn(revenueToday),
      revenueMtd: formatNgn(revenueMtd),
      outstanding: formatNgn(outstandingCents),
    },
  });
});

router.get('/reports/api/operations-members', async (req, res) => {
  const { today } = await hubToday(pool);
  const todayStr =
    today instanceof Date ? today.toISOString().slice(0, 10) : String(today).slice(0, 10);
  const { sql: planSql } = planFilterSql(req.query.plan);
  const q = String(req.query.q || '')
    .trim()
    .toLowerCase();
  const nameSql = q ? ` AND lower(m.full_name) LIKE $2 ` : '';

  const { rows } = await pool.query(
    `WITH base AS (
       SELECT m.id AS member_id, m.full_name,
              sp.title AS plan_name, sp.plan_slug, sp.id AS plan_id,
              mp.started_at, mp.renewal_at,
              (SELECT su.label FROM member_space_assignments msa
                 JOIN space_units su ON su.id = msa.unit_id AND su.deleted_at IS NULL
               WHERE msa.member_id = m.id AND msa.deleted_at IS NULL AND msa.ended_at IS NULL
                 AND (msa.ends_at IS NULL OR msa.ends_at >= $1::date)
               ORDER BY msa.started_at DESC LIMIT 1) AS unit_label,
              (SELECT COALESCE(SUM(i2.total_cents), 0)::bigint FROM invoices i2
               WHERE i2.member_id = m.id AND i2.deleted_at IS NULL
                 AND i2.status IN ('unpaid', 'sent', 'overdue', 'awaiting_confirmation')) AS outstanding_cents,
              (SELECT i2.id FROM invoices i2
               WHERE i2.member_id = m.id AND i2.deleted_at IS NULL
                 AND i2.status IN ('unpaid', 'sent', 'overdue', 'awaiting_confirmation')
               ORDER BY i2.due_date ASC NULLS LAST, i2.created_at ASC LIMIT 1) AS pay_invoice_id,
              EXISTS (
                SELECT 1 FROM invoices i3
                WHERE i3.member_id = m.id AND i3.deleted_at IS NULL
                  AND i3.status IN ('unpaid', 'sent', 'overdue', 'awaiting_confirmation')
                  AND (i3.status = 'overdue' OR i3.due_date < $1::date)
              ) AS has_overdue,
              CASE WHEN mp.renewal_at IS NOT NULL AND mp.renewal_at > $1::date
                        AND mp.renewal_at <= ($1::date + interval '7 days')::date
                   THEN TRUE ELSE FALSE END AS renew_soon
       FROM member_plans mp
       JOIN members m ON m.id = mp.member_id AND m.deleted_at IS NULL AND (m.is_test_account IS NOT TRUE)
       JOIN membership_tiers mt ON mt.id = mp.tier_id
       JOIN service_plans sp ON sp.id = mt.service_plan_id AND sp.deleted_at IS NULL
       WHERE mp.deleted_at IS NULL AND mp.status = 'active'
         AND COALESCE(mp.started_at, DATE '1970-01-01') <= $1::date
         AND (mp.renewal_at IS NULL OR mp.renewal_at >= $1::date)
         ${planSql}
         ${nameSql}
     )
     SELECT * FROM base ORDER BY full_name ASC`,
    q ? [todayStr, `%${q}%`] : [todayStr]
  );

  const out = rows.map((r) => {
    let rowState = 'ok';
    if (r.has_overdue) rowState = 'overdue';
    else if (r.renew_soon) rowState = 'renew';
    const renewal = r.renewal_at;
    let daysRemaining = null;
    if (renewal) {
      daysRemaining = Math.ceil(
        (new Date(
          renewal instanceof Date ? renewal.toISOString().slice(0, 10) : String(renewal)
        ) -
          new Date(`${todayStr}T12:00:00Z`)) /
          86400000
      );
    }
    return {
      member_id: r.member_id,
      member_name: r.full_name,
      plan_name: r.plan_name,
      unit_label: r.unit_label || '',
      started_label: r.started_at ? formatDate(r.started_at) : '—',
      renewal_label: renewal ? formatDate(renewal) : '—',
      days_remaining: daysRemaining == null ? '—' : String(daysRemaining),
      outstanding_label: formatNgn(r.outstanding_cents),
      pay_href: r.pay_invoice_id ? `/admin/invoices/${r.pay_invoice_id}` : `/admin/members/${r.member_id}`,
      view_href: `/admin/members/${r.member_id}`,
      row_state: rowState,
    };
  });

  res.json({ count: out.length, rows: out });
});

router.post('/reports/service-requests/:id/remind-member', requireValidCsrf, async (req, res) => {
  const id = req.params.id;
  const { rows } = await pool.query(
    `SELECT sr.*, m.full_name, m.email, sv.name AS service_name
     FROM service_requests sr
     JOIN members m ON m.id = sr.member_id AND m.deleted_at IS NULL AND (m.is_test_account IS NOT TRUE)
     JOIN services sv ON sv.id = sr.service_id
     WHERE sr.id = $1::uuid AND sr.deleted_at IS NULL`,
    [id]
  );
  const sr = rows[0];
  if (!sr) return res.status(404).json({ ok: false });
  const base = process.env.BASE_URL || '';
  await notifyMember({
    memberId: sr.member_id,
    title: 'Action needed on your service request',
    message: `Please check your request for ${sr.service_name}.`,
    linkUrl: `/services/${sr.id}`,
  });
  try {
    if (sr.email) {
      await sendMemberPortalNotificationEmail({
        to: sr.email,
        name: sr.full_name,
        title: 'Action needed — service request',
        body: `We need your input on: ${sr.service_name}. Open your portal to continue.`,
        linkUrl: `${base}/services/${sr.id}`,
      });
    }
  } catch (e) {
    console.error('remind mail', e);
  }
  res.json({ ok: true });
});

router.post('/reports/invoices/:id/remind', requireValidCsrf, async (req, res) => {
  const id = req.params.id;
  const { rows } = await pool.query(
    `SELECT i.*, m.full_name, m.email, m.notify_email_invoice
     FROM invoices i
     JOIN members m ON m.id = i.member_id AND m.deleted_at IS NULL AND (m.is_test_account IS NOT TRUE)
     WHERE i.id = $1::uuid AND i.deleted_at IS NULL`,
    [id]
  );
  const inv = rows[0];
  if (!inv) return res.status(404).json({ ok: false });
  await notifyMember({
    memberId: inv.member_id,
    title: 'Invoice payment reminder',
    message: `Invoice ${inv.invoice_number} for ${formatNgn(inv.total_cents)} is due.`,
    linkUrl: '/billing',
  });
  const base = process.env.BASE_URL || '';
  try {
    if (inv.email && inv.notify_email_invoice) {
      await sendMemberPortalNotificationEmail({
        to: inv.email,
        name: inv.full_name,
        title: 'Payment reminder',
        body: `Invoice ${inv.invoice_number} (${formatNgn(inv.total_cents)}) — please pay or contact us if you need help.`,
        linkUrl: `${base}/billing`,
      });
    }
  } catch (e) {
    console.error('invoice remind mail', e);
  }
  res.json({ ok: true });
});

router.get('/reports/api/finance-overview', async (req, res) => {
  const { tz, today } = await hubToday(pool);
  const todayStr =
    today instanceof Date ? today.toISOString().slice(0, 10) : String(today).slice(0, 10);
  const { rows: bounds } = await pool.query(
    `SELECT
       (date_trunc('month', timezone($1::text, now())))::date AS month_start,
       (date_trunc('month', timezone($1::text, now())) - interval '1 month')::date AS prev_month_start,
       (date_trunc('week', timezone($1::text, now())))::date AS week_start`,
    [tz]
  );
  const monthStartStr = String(bounds[0].month_start).slice(0, 10);
  const prevMonthStartStr = String(bounds[0].prev_month_start).slice(0, 10);
  const weekStartStr = String(bounds[0].week_start).slice(0, 10);

  const collectionsToday = await sumPaymentsBetween(pool, todayStr, addDaysDateStr(todayStr, 1));
  const collectionsWeek = await sumPaymentsBetween(pool, weekStartStr, addDaysDateStr(todayStr, 1));
  const collectionsMonth = await sumPaymentsBetween(pool, monthStartStr, addDaysDateStr(todayStr, 1));
  const mtdDays = Math.floor(
    (new Date(`${todayStr}T12:00:00Z`) - new Date(`${monthStartStr}T12:00:00Z`)) / 86400000
  );
  const prevWindowEnd = addDaysDateStr(prevMonthStartStr, mtdDays);
  const collectionsPrevPartial = await sumPaymentsBetween(
    pool,
    prevMonthStartStr,
    addDaysDateStr(prevWindowEnd, 1)
  );
  let monthComparePct = null;
  if (collectionsPrevPartial > 0) {
    monthComparePct =
      Math.round(((collectionsMonth - collectionsPrevPartial) / collectionsPrevPartial) * 1000) / 10;
  } else if (collectionsMonth > 0) {
    monthComparePct = 100;
  } else {
    monthComparePct = 0;
  }

  const { rows: outRows } = await pool.query(
    `SELECT COALESCE(SUM(i.total_cents), 0)::bigint AS t
     FROM invoices i
     JOIN members m ON m.id = i.member_id AND m.deleted_at IS NULL AND (m.is_test_account IS NOT TRUE)
     WHERE i.deleted_at IS NULL
       AND i.status IN ('unpaid', 'sent', 'overdue', 'awaiting_confirmation')`,
    []
  );
  const outstandingCents = Number(outRows[0].t) || 0;

  const { rows: overdueRows } = await pool.query(
    `SELECT COALESCE(SUM(i.total_cents), 0)::bigint AS t
     FROM invoices i
     JOIN members m ON m.id = i.member_id AND m.deleted_at IS NULL AND (m.is_test_account IS NOT TRUE)
     WHERE i.deleted_at IS NULL
       AND i.status IN ('unpaid', 'sent', 'overdue', 'awaiting_confirmation')
       AND i.due_date < $1::date`,
    [todayStr]
  );
  const overdueCents = Number(overdueRows[0].t) || 0;

  const activeMembers = await activeMemberCountToday(pool, todayStr);
  const avgPerMember =
    activeMembers > 0 ? Math.round(collectionsMonth / activeMembers) : 0;

  const chart = await revenueLast6MonthBuckets(pool);
  const chartFormatted = chart.map((row) => ({
    ...row,
    month_label: formatDate(row.month_start),
  }));

  const { rows: mrrRows } = await pool.query(
    `SELECT
       sp.id,
       sp.title AS plan_name,
       sp.plan_slug,
       sp.price_cents,
       sp.duration_unit,
       sp.duration_value,
       sp.plan_kind,
       sp.sort_order,
       COALESCE(
         (SELECT p.total_units FROM plan_capacity_profiles p
           WHERE p.service_plan_id = sp.id AND p.deleted_at IS NULL LIMIT 1),
         0
       )::int AS total_units,
       (SELECT COUNT(DISTINCT mp.member_id) FROM member_plans mp
          JOIN members m ON m.id = mp.member_id AND m.deleted_at IS NULL AND (m.is_test_account IS NOT TRUE)
          JOIN membership_tiers mt ON mt.id = mp.tier_id AND mt.service_plan_id = sp.id
        WHERE mp.deleted_at IS NULL AND mp.status = 'active'
          AND COALESCE(mp.started_at, DATE '1970-01-01') <= $1::date
          AND (mp.renewal_at IS NULL OR mp.renewal_at >= $1::date)
       )::int AS active_members,
       (SELECT COUNT(DISTINCT msa.unit_id) FROM member_space_assignments msa
          JOIN space_units su ON su.id = msa.unit_id AND su.deleted_at IS NULL
          JOIN plan_capacity_profiles p ON p.id = su.profile_id AND p.deleted_at IS NULL AND p.service_plan_id = sp.id
          JOIN members m ON m.id = msa.member_id AND m.deleted_at IS NULL AND (m.is_test_account IS NOT TRUE)
        WHERE msa.deleted_at IS NULL AND msa.ended_at IS NULL
          AND (msa.ends_at IS NULL OR msa.ends_at >= $1::date)
       )::int AS occupied_units
     FROM service_plans sp
     WHERE sp.deleted_at IS NULL AND sp.active = TRUE
       AND (
         (SELECT COUNT(DISTINCT mp.member_id) FROM member_plans mp
            JOIN members m ON m.id = mp.member_id AND m.deleted_at IS NULL AND (m.is_test_account IS NOT TRUE)
            JOIN membership_tiers mt ON mt.id = mp.tier_id AND mt.service_plan_id = sp.id
          WHERE mp.deleted_at IS NULL AND mp.status = 'active'
            AND COALESCE(mp.started_at, DATE '1970-01-01') <= $1::date
            AND (mp.renewal_at IS NULL OR mp.renewal_at >= $1::date)
         ) > 0
         OR COALESCE(
           (SELECT p.total_units FROM plan_capacity_profiles p
             WHERE p.service_plan_id = sp.id AND p.deleted_at IS NULL LIMIT 1),
           0
         ) > 0
       )
     ORDER BY sp.sort_order, sp.title`,
    [todayStr]
  );

  let mrrTotals = 0;
  const mrrTable = mrrRows.map((r) => {
    const eq = monthlyEquivalentCents(r);
    const mems = Number(r.active_members) || 0;
    const mrr = mems * eq;
    mrrTotals += mrr;
    return {
      plan_name: r.plan_name,
      active_members: mems,
      monthly_rate_label: eq ? formatNgn(eq) : '—',
      mrr_label: formatNgn(mrr),
      available_units: r.total_units || 0,
      occupied_units: r.occupied_units || 0,
    };
  });

  const { rows: expiring } = await pool.query(
    `SELECT m.id AS member_id, m.full_name, sp.title AS plan_name, mp.renewal_at
     FROM member_plans mp
     JOIN members m ON m.id = mp.member_id AND m.deleted_at IS NULL AND (m.is_test_account IS NOT TRUE)
     JOIN membership_tiers mt ON mt.id = mp.tier_id
     JOIN service_plans sp ON sp.id = mt.service_plan_id AND sp.deleted_at IS NULL
     WHERE mp.deleted_at IS NULL AND mp.status = 'active'
       AND mp.renewal_at IS NOT NULL
       AND mp.renewal_at >= date_trunc('month', timezone($2::text, now()))::date
       AND mp.renewal_at <= (date_trunc('month', timezone($2::text, now())) + interval '1 month - 1 day')::date
     ORDER BY mp.renewal_at ASC, m.full_name ASC`,
    [todayStr, tz]
  );

  const expiringRows = expiring.map((r) => {
    const ren = r.renewal_at;
    const rs = ren instanceof Date ? ren.toISOString().slice(0, 10) : String(ren).slice(0, 10);
    const daysRemaining = Math.ceil(
      (new Date(`${rs}T12:00:00Z`) - new Date(`${todayStr}T12:00:00Z`)) / 86400000
    );
    return {
      member_id: r.member_id,
      member_name: r.full_name,
      plan_name: r.plan_name,
      expiry_label: formatDate(r.renewal_at),
      days_remaining: String(Math.max(0, daysRemaining)),
      renew_href: `/admin/members/${r.member_id}`,
    };
  });

  const { rows: categories } = await pool.query(
    `SELECT DISTINCT c.slug, c.name FROM service_categories c
     JOIN services s ON s.category_id = c.id AND s.deleted_at IS NULL
     ORDER BY c.name ASC`
  );
  const { rows: consultants } = await pool.query(
    `SELECT id, username, role FROM portal_admin_users
     WHERE deleted_at IS NULL AND active = TRUE
     ORDER BY username ASC`
  );

  res.json({
    today: todayStr,
    collectionsTodayCents: collectionsToday,
    collectionsWeekCents: collectionsWeek,
    collectionsMonthCents: collectionsMonth,
    collectionsMonthComparePct: monthComparePct,
    outstandingCents,
    overdueCents,
    avgPerActiveMemberCents: avgPerMember,
    activeMembersForAvg: activeMembers,
    chart: chartFormatted,
    mrrTable,
    mrrTotalsLabel: formatNgn(mrrTotals),
    expiring: expiringRows,
    meta: { categories, consultants },
    labels: {
      collectionsToday: formatNgn(collectionsToday),
      collectionsWeek: formatNgn(collectionsWeek),
      collectionsMonth: formatNgn(collectionsMonth),
      outstanding: formatNgn(outstandingCents),
      overdue: formatNgn(overdueCents),
      avgPerMember: formatNgn(avgPerMember),
    },
  });
});

router.get('/reports/api/finance-consultants', async (req, res) => {
  const tz = HUB_TZ();
  const { rows: bounds } = await pool.query(
    `SELECT
       COALESCE($2::date, (date_trunc('month', timezone($1::text, now())))::date) AS d_from,
       COALESCE($3::date, (timezone($1::text, now()))::date) AS d_to`,
    [tz, req.query.from || null, req.query.to || null]
  );
  const dFrom = bounds[0].d_from;
  const dTo = bounds[0].d_to;
  const dFromStr = String(dFrom).slice(0, 10);
  const dToStr = String(dTo).slice(0, 10);

  const { rows } = await pool.query(
    `WITH cohort AS (
       SELECT sr.id, sr.assigned_admin_id, sr.status, sr.service_end_date, sr.updated_at, sr.created_at,
         (SELECT COALESCE(SUM(i.total_cents), 0)::bigint
            FROM invoices i
           WHERE i.deleted_at IS NULL AND i.status <> 'cancelled'
             AND (
               i.id = sr.invoice_id
               OR EXISTS (
                 SELECT 1 FROM invoice_service_links isl
                 WHERE isl.invoice_id = i.id AND isl.service_request_id = sr.id AND isl.deleted_at IS NULL
               )
             )
         ) AS value_cents
       FROM service_requests sr
       JOIN members m ON m.id = sr.member_id AND m.deleted_at IS NULL AND (m.is_test_account IS NOT TRUE)
       WHERE sr.deleted_at IS NULL
         AND sr.assigned_admin_id IS NOT NULL
         AND (timezone($1::text, sr.created_at))::date >= $2::date
         AND (timezone($1::text, sr.created_at))::date <= $3::date
     )
     SELECT
       pa.id,
       pa.username,
       pa.role,
       (SELECT COUNT(*)::int FROM cohort c WHERE c.assigned_admin_id = pa.id) AS handled,
       (SELECT COUNT(*)::int FROM cohort c WHERE c.assigned_admin_id = pa.id AND c.status = 'Completed') AS completed,
       (SELECT COUNT(*)::int FROM cohort c
         WHERE c.assigned_admin_id = pa.id AND c.status = 'Completed'
           AND (c.service_end_date IS NULL
             OR (timezone($1::text, c.updated_at))::date <= c.service_end_date)
       ) AS on_time,
       COALESCE((SELECT SUM(c.value_cents)::bigint FROM cohort c WHERE c.assigned_admin_id = pa.id), 0)::bigint AS value_cents
     FROM portal_admin_users pa
     WHERE pa.deleted_at IS NULL AND pa.active = TRUE
       AND EXISTS (SELECT 1 FROM cohort c WHERE c.assigned_admin_id = pa.id)
     ORDER BY value_cents DESC`,
    [tz, dFromStr, dToStr]
  );

  const out = rows.map((r) => {
    const handled = Number(r.handled) || 0;
    const completed = Number(r.completed) || 0;
    const onTime = Number(r.on_time) || 0;
    const pct = completed > 0 ? Math.round((onTime / completed) * 1000) / 10 : null;
    return {
      name: r.username,
      role: String(r.role || '').replace(/_/g, ' '),
      handled,
      completed,
      on_time: onTime,
      on_time_pct: pct == null ? null : pct,
      on_time_label: pct == null ? '—' : `${pct}%`,
      rating_label: '—',
      value_label: formatNgn(r.value_cents),
      value_cents: Number(r.value_cents) || 0,
    };
  });

  const sumHandled = out.reduce((a, b) => a + b.handled, 0);
  const sumCompleted = out.reduce((a, b) => a + b.completed, 0);
  const sumOnTime = out.reduce((a, b) => a + b.on_time, 0);
  const sumValue = out.reduce((a, b) => a + b.value_cents, 0);
  const totPct = sumCompleted > 0 ? Math.round((sumOnTime / sumCompleted) * 1000) / 10 : null;

  res.json({
    rows: out,
    footer: {
      handled: sumHandled,
      completed: sumCompleted,
      on_time: sumOnTime,
      on_time_label: totPct == null ? '—' : `${totPct}%`,
      rating_label: '—',
      value_label: formatNgn(sumValue),
    },
    range: { from: dFromStr, to: dToStr },
  });
});

async function buildServiceHistoryQuery(req, { forExport, limit, offset }) {
  const tz = HUB_TZ();
  const { rows: bounds } = await pool.query(
    `SELECT
       COALESCE($2::date, (date_trunc('month', timezone($1::text, now())))::date) AS d_from,
       COALESCE($3::date, (timezone($1::text, now()))::date) AS d_to`,
    [tz, req.query.from || null, req.query.to || null]
  );
  const dFrom = String(bounds[0].d_from).slice(0, 10);
  const dTo = String(bounds[0].d_to).slice(0, 10);
  const cat = String(req.query.category || '').trim();
  const st = String(req.query.status || '').trim();
  const consult = String(req.query.consultant || '').trim();

  const conds = [
    `(timezone($1::text, sr.created_at))::date >= $2::date`,
    `(timezone($1::text, sr.created_at))::date <= $3::date`,
  ];
  const params = [tz, dFrom, dTo];
  let p = 4;
  if (cat) {
    conds.push(`c.slug = $${p}`);
    params.push(cat);
    p++;
  }
  if (st) {
    conds.push(`sr.status = $${p}`);
    params.push(st);
    p++;
  }
  if (consult && isUuid(consult)) {
    conds.push(`sr.assigned_admin_id = $${p}::uuid`);
    params.push(consult);
    p++;
  }

  const whereSql = conds.join(' AND ');
  const baseParams = params.slice();
  const limSql = forExport ? '' : ` LIMIT $${p} OFFSET $${p + 1}`;
  const listParams = forExport ? baseParams : baseParams.concat([limit, offset]);

  const q = `SELECT sr.id, sr.created_at, sr.status, m.full_name AS member_name, sv.name AS service_name,
        c.name AS category_name, c.slug AS category_slug,
        pa.username AS consultant_name,
        inv.id AS invoice_id, inv.total_cents AS invoice_cents, inv.status AS invoice_status
     FROM service_requests sr
     JOIN members m ON m.id = sr.member_id AND m.deleted_at IS NULL AND (m.is_test_account IS NOT TRUE)
     JOIN services sv ON sv.id = sr.service_id AND sv.deleted_at IS NULL
     JOIN service_categories c ON c.id = sv.category_id
     LEFT JOIN portal_admin_users pa ON pa.id = sr.assigned_admin_id AND pa.deleted_at IS NULL
     LEFT JOIN invoices inv ON inv.id = sr.invoice_id AND inv.deleted_at IS NULL
     WHERE sr.deleted_at IS NULL AND ${whereSql}
     ORDER BY sr.created_at DESC${limSql}`;

  const countQ = `SELECT COUNT(*)::int AS c, COALESCE(SUM(inv.total_cents), 0)::bigint AS inv_sum
     FROM service_requests sr
     JOIN members m ON m.id = sr.member_id AND m.deleted_at IS NULL AND (m.is_test_account IS NOT TRUE)
     JOIN services sv ON sv.id = sr.service_id AND sv.deleted_at IS NULL
     JOIN service_categories c ON c.id = sv.category_id
     LEFT JOIN invoices inv ON inv.id = sr.invoice_id AND inv.deleted_at IS NULL
     WHERE sr.deleted_at IS NULL AND ${whereSql}`;

  return { q, countQ, baseParams, listParams, dFrom, dTo };
}

function isUuid(s) {
  return (
    typeof s === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s)
  );
}

router.get('/reports/api/finance-service-history', async (req, res) => {
  const exportCsv = String(req.query.export || '') === 'csv';
  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
  const limit = 25;
  const offset = (page - 1) * limit;

  const { q, countQ, baseParams, listParams, dFrom, dTo } = await buildServiceHistoryQuery(req, {
    forExport: exportCsv,
    limit,
    offset,
  });

  if (exportCsv) {
    const { rows } = await pool.query(q, baseParams);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="service-request-history.csv"');
    const head = [
      'Date submitted',
      'Member',
      'Service',
      'Category',
      'Consultant',
      'Status',
      'Invoice amount',
      'Payment status',
    ];
    res.write(head.map(csvEscape).join(',') + '\n');
    for (const r of rows) {
      res.write(
        [
          formatDate(r.created_at),
          r.member_name,
          r.service_name,
          r.category_name,
          r.consultant_name || '—',
          r.status,
          r.invoice_cents != null ? formatNgn(r.invoice_cents) : '—',
          r.invoice_status || '—',
        ]
          .map(csvEscape)
          .join(',') + '\n'
      );
    }
    return res.end();
  }

  const { rows: countRows } = await pool.query(countQ, baseParams);
  const total = countRows[0].c || 0;
  const invSum = Number(countRows[0].inv_sum) || 0;
  const { rows } = await pool.query(q, listParams);
  res.json({
    range: { from: dFrom, to: dTo },
    total,
    invoiceSumCents: invSum,
    invoiceSumLabel: formatNgn(invSum),
    page,
    pageSize: limit,
    rows: rows.map((r) => ({
      id: r.id,
      submitted_label: formatDate(r.created_at),
      member_name: r.member_name,
      service_name: r.service_name,
      category: r.category_name,
      consultant: r.consultant_name || '—',
      status: r.status,
      invoice_label: r.invoice_cents != null ? formatNgn(r.invoice_cents) : '—',
      payment_status: r.invoice_status || '—',
      view_href: `/admin/service-requests/${r.id}`,
    })),
  });
});

router.get('/reports/api/finance-invoices', async (req, res) => {
  const tz = HUB_TZ();
  const exportCsv = String(req.query.export || '') === 'csv';
  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
  const limit = 25;
  const offset = (page - 1) * limit;

  const { rows: bounds } = await pool.query(
    `SELECT
       COALESCE($2::date, (date_trunc('month', timezone($1::text, now())))::date) AS d_from,
       COALESCE($3::date, (timezone($1::text, now()))::date) AS d_to`,
    [tz, req.query.from || null, req.query.to || null]
  );
  const dFrom = String(bounds[0].d_from).slice(0, 10);
  const dTo = String(bounds[0].d_to).slice(0, 10);
  const statusFilter = String(req.query.status || 'all').trim().toLowerCase();
  const qname = String(req.query.q || '')
    .trim()
    .toLowerCase();

  const conds = [
    `(timezone($1::text, i.created_at))::date >= $2::date`,
    `(timezone($1::text, i.created_at))::date <= $3::date`,
  ];
  const params = [tz, dFrom, dTo];
  let p = 4;
  if (statusFilter && statusFilter !== 'all') {
    conds.push(`i.status = $${p}`);
    params.push(statusFilter);
    p++;
  }
  if (qname) {
    conds.push(`lower(m.full_name) LIKE $${p}`);
    params.push(`%${qname}%`);
    p++;
  }

  const whereSql = conds.join(' AND ');
  const baseFrom = `FROM invoices i
     JOIN members m ON m.id = i.member_id AND m.deleted_at IS NULL AND (m.is_test_account IS NOT TRUE)
     LEFT JOIN LATERAL (
       SELECT p.method, p.created_at AS paid_at, p.id AS payment_id
       FROM payments p
       WHERE p.invoice_id = i.id AND p.deleted_at IS NULL AND p.status = 'completed'
       ORDER BY p.created_at DESC LIMIT 1
     ) pay ON TRUE
     LEFT JOIN LATERAL (
       SELECT ii.description FROM invoice_items ii
       WHERE ii.invoice_id = i.id AND ii.deleted_at IS NULL
       ORDER BY ii.sort_order, ii.created_at LIMIT 1
     ) li ON TRUE
     WHERE i.deleted_at IS NULL AND ${whereSql}`;

  const totQ = `SELECT
       COALESCE(SUM(i.total_cents), 0)::bigint AS invoiced,
       COALESCE(SUM(i.total_cents) FILTER (WHERE i.status = 'paid'), 0)::bigint AS collected,
       COALESCE(SUM(i.total_cents) FILTER (
         WHERE i.status IN ('unpaid','sent','overdue','awaiting_confirmation')
       ), 0)::bigint AS outstanding
     ${baseFrom}`;

  const listQ = `SELECT i.id, i.invoice_number, i.created_at, i.total_cents, i.status, i.due_date,
        m.full_name AS member_name, li.description AS line_desc,
        pay.method AS pay_method, pay.paid_at, pay.payment_id
     ${baseFrom}
     ORDER BY i.created_at DESC`;

  if (exportCsv) {
    const { rows } = await pool.query(listQ, params);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="invoice-ledger.csv"');
    const head = [
      'Invoice',
      'Issued',
      'Member',
      'Description',
      'Amount',
      'Status',
      'Payment method',
      'Date paid',
      'Receipt',
    ];
    res.write(head.map(csvEscape).join(',') + '\n');
    for (const r of rows) {
      const receiptUrl = r.payment_id
        ? `/admin/reports/invoice-receipt/${r.id}/${r.payment_id}`
        : '';
      res.write(
        [
          r.invoice_number,
          formatDate(r.created_at),
          r.member_name,
          r.line_desc || '—',
          formatNgn(r.total_cents),
          r.status,
          r.pay_method || '—',
          r.paid_at ? formatDate(r.paid_at) : '—',
          receiptUrl,
        ]
          .map(csvEscape)
          .join(',') + '\n'
      );
    }
    return res.end();
  }

  const countQ = `SELECT COUNT(*)::int AS c ${baseFrom}`;
  const { rows: totRows } = await pool.query(totQ, params);
  const { rows: countRows } = await pool.query(countQ, params);
  const total = countRows[0].c || 0;
  const limParams = params.concat([limit, offset]);
  const limIdx = p;
  const { rows } = await pool.query(`${listQ} LIMIT $${limIdx} OFFSET $${limIdx + 1}`, limParams);

  res.json({
    range: { from: dFrom, to: dTo },
    totals: {
      invoicedCents: Number(totRows[0].invoiced) || 0,
      collectedCents: Number(totRows[0].collected) || 0,
      outstandingCents: Number(totRows[0].outstanding) || 0,
      invoicedLabel: formatNgn(totRows[0].invoiced),
      collectedLabel: formatNgn(totRows[0].collected),
      outstandingLabel: formatNgn(totRows[0].outstanding),
    },
    total,
    page,
    pageSize: limit,
    rows: rows.map((r) => ({
      id: r.id,
      invoice_number: r.invoice_number,
      issued_label: formatDate(r.created_at),
      member_name: r.member_name,
      description: r.line_desc || '—',
      amount_label: formatNgn(r.total_cents),
      status: r.status,
      pay_method: r.pay_method || '—',
      paid_label: r.paid_at ? formatDate(r.paid_at) : '—',
      receipt_href: r.payment_id ? `/admin/reports/invoice-receipt/${r.id}/${r.payment_id}` : null,
      invoice_href: `/admin/invoices/${r.id}`,
    })),
  });
});

module.exports = router;
