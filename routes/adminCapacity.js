const express = require('express');
const { pool } = require('../lib/db');
const { requireValidCsrf } = require('../lib/csrf');
const { requireAdmin } = require('../middleware/adminAuth');
const { adminLayoutLocals } = require('../middleware/adminLayoutLocals');
const { formatNgn, formatDate, formatDateTime } = require('../lib/format');
const { onCapacityUnitFreed } = require('../lib/capacityWaitlist');
const { syncUnitStatus } = require('../lib/capacityAssignment');

const router = express.Router();
router.use(requireAdmin);
router.use(adminLayoutLocals);

function isUuid(s) {
  return (
    typeof s === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s)
  );
}

router.get('/space-utilization', async (req, res) => {
  const summary = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE su.deleted_at IS NULL)::int AS total_units,
       COUNT(*) FILTER (WHERE su.deleted_at IS NULL AND su.status = 'occupied')::int AS occupied_units,
       COUNT(*) FILTER (WHERE su.deleted_at IS NULL AND su.status = 'available')::int AS available_units,
       COUNT(*) FILTER (WHERE su.deleted_at IS NULL AND su.status = 'maintenance')::int AS maintenance_units
     FROM space_units su`
  );
  const unassigned = await pool.query(
    `SELECT COUNT(DISTINCT sr.member_id)::int AS c
     FROM service_requests sr
     JOIN service_plans sp ON sp.id = sr.service_plan_id AND sp.deleted_at IS NULL AND sp.is_capacity_limited = true
     JOIN invoices inv ON inv.id = sr.invoice_id AND inv.deleted_at IS NULL AND inv.status = 'paid'
     WHERE sr.deleted_at IS NULL AND sr.status IN ('In Progress', 'Submitted', 'Under Review')
       AND NOT EXISTS (
         SELECT 1 FROM member_space_assignments msa
         JOIN space_units su ON su.id = msa.unit_id AND su.deleted_at IS NULL
         JOIN plan_capacity_profiles p ON p.id = su.profile_id AND p.service_plan_id = sp.id AND p.deleted_at IS NULL
         WHERE msa.member_id = sr.member_id AND msa.deleted_at IS NULL AND msa.ended_at IS NULL
       )`
  );
  const profiles = await pool.query(
    `SELECT p.id, p.total_units, p.auto_assign, p.waitlist_enabled,
            sp.title AS plan_title, s.name AS service_name,
            (SELECT COUNT(*)::int FROM space_units su WHERE su.profile_id = p.id AND su.deleted_at IS NULL) AS unit_rows,
            (SELECT COUNT(*)::int FROM space_units su WHERE su.profile_id = p.id AND su.deleted_at IS NULL AND su.status = 'occupied') AS occ_units
     FROM plan_capacity_profiles p
     LEFT JOIN service_plans sp ON sp.id = p.service_plan_id
     LEFT JOIN services s ON s.id = sp.service_id
     WHERE p.deleted_at IS NULL
     ORDER BY s.sort_order, sp.sort_order`
  );
  const projection = await pool.query(
    `SELECT g::date AS d,
            (SELECT COUNT(*)::int FROM member_space_assignments msa
             WHERE msa.deleted_at IS NULL AND msa.ended_at IS NULL
               AND msa.ends_at IS NOT NULL AND msa.ends_at >= g::date AND msa.starts_at <= g::date) AS assigned
     FROM generate_series(current_date::date, (current_date + 29)::date, interval '1 day') AS g`
  );
  res.render('admin/space-utilization', {
    layout: 'layouts/admin',
    title: 'Space utilization',
    pageSub: 'Capacity, units, and assignments',
    summary: summary.rows[0],
    unassignedPaid: unassigned.rows[0].c,
    profiles: profiles.rows,
    projection: projection.rows,
    formatDate,
    formatDateTime,
    formatNgn,
    query: req.query,
  });
});

router.get('/capacity/profiles/:id', async (req, res) => {
  const id = req.params.id;
  if (!isUuid(id)) return res.status(404).send('Not found');
  const { rows: prof } = await pool.query(
    `SELECT p.*, sp.title AS plan_title, s.name AS service_name
     FROM plan_capacity_profiles p
     LEFT JOIN service_plans sp ON sp.id = p.service_plan_id
     LEFT JOIN services s ON s.id = sp.service_id
     WHERE p.id = $1::uuid AND p.deleted_at IS NULL`,
    [id]
  );
  if (!prof[0]) return res.status(404).send('Not found');
  const units = await pool.query(
    `SELECT su.*,
      (SELECT m.full_name FROM member_space_assignments msa
       JOIN members m ON m.id = msa.member_id
       WHERE msa.unit_id = su.id AND msa.deleted_at IS NULL AND msa.ended_at IS NULL LIMIT 1) AS occupant_name,
      (SELECT msa.started_at FROM member_space_assignments msa
       WHERE msa.unit_id = su.id AND msa.deleted_at IS NULL AND msa.ended_at IS NULL LIMIT 1) AS started_at,
      (SELECT msa.ends_at FROM member_space_assignments msa
       WHERE msa.unit_id = su.id AND msa.deleted_at IS NULL AND msa.ended_at IS NULL LIMIT 1) AS ends_at,
      (SELECT msa.id FROM member_space_assignments msa
       WHERE msa.unit_id = su.id AND msa.deleted_at IS NULL AND msa.ended_at IS NULL LIMIT 1) AS assignment_id
     FROM space_units su
     WHERE su.profile_id = $1::uuid AND su.deleted_at IS NULL
     ORDER BY su.label`,
    [id]
  );
  res.render('admin/capacity-profile', {
    layout: 'layouts/admin',
    title: prof[0].plan_title || 'Capacity profile',
    pageSub: prof[0].service_name || '',
    profile: prof[0],
    units: units.rows,
    formatDate,
    formatDateTime,
    query: req.query,
  });
});

router.post('/capacity/profiles', requireValidCsrf, async (req, res) => {
  const sp = String(req.body.service_plan_id || '').trim();
  const total = Math.max(0, Math.floor(Number(req.body.total_units || 0)));
  const auto = String(req.body.auto_assign || '') === '1';
  const wl = String(req.body.waitlist_enabled || '') !== '0';
  if (!isUuid(sp)) return res.redirect('/admin/space-utilization?err=plan');
  const ex = await pool.query(
    `SELECT id FROM plan_capacity_profiles WHERE service_plan_id = $1::uuid AND deleted_at IS NULL`,
    [sp]
  );
  if (ex.rows[0]) return res.redirect(`/admin/capacity/profiles/${ex.rows[0].id}?err=exists`);
  const ins = await pool.query(
    `INSERT INTO plan_capacity_profiles (service_plan_id, total_units, auto_assign, waitlist_enabled)
     VALUES ($1::uuid, $2, $3, $4) RETURNING id`,
    [sp, total, auto, wl]
  );
  res.redirect(`/admin/capacity/profiles/${ins.rows[0].id}?msg=created`);
});

router.post('/capacity/profiles/:id', requireValidCsrf, async (req, res) => {
  const id = req.params.id;
  if (!isUuid(id)) return res.redirect('/admin/space-utilization');
  const total = Math.max(0, Math.floor(Number(req.body.total_units || 0)));
  const auto = String(req.body.auto_assign || '') === '1';
  const wl = String(req.body.waitlist_enabled || '') !== '0';
  await pool.query(
    `UPDATE plan_capacity_profiles SET total_units = $2, auto_assign = $3, waitlist_enabled = $4, updated_at = now()
     WHERE id = $1::uuid AND deleted_at IS NULL`,
    [id, total, auto, wl]
  );
  res.redirect(`/admin/capacity/profiles/${id}?msg=saved`);
});

router.post('/capacity/units', requireValidCsrf, async (req, res) => {
  const pid = String(req.body.profile_id || '');
  const label = String(req.body.label || '').trim();
  const loc = String(req.body.location_note || '').trim();
  if (!isUuid(pid) || !label) return res.redirect('/admin/space-utilization?err=unit');
  await pool.query(
    `INSERT INTO space_units (profile_id, label, location_note, status) VALUES ($1::uuid, $2, $3, 'available')`,
    [pid, label, loc || null]
  );
  res.redirect(`/admin/capacity/profiles/${pid}?msg=unit`);
});

router.post('/capacity/units/:id/status', requireValidCsrf, async (req, res) => {
  const id = req.params.id;
  const status = String(req.body.status || '').trim();
  if (!isUuid(id) || !['available', 'occupied', 'maintenance'].includes(status)) {
    return res.redirect('/admin/space-utilization');
  }
  const { rows } = await pool.query(`SELECT profile_id FROM space_units WHERE id = $1::uuid`, [id]);
  const pid = rows[0]?.profile_id;
  await pool.query(`UPDATE space_units SET status = $2, updated_at = now() WHERE id = $1::uuid`, [id, status]);
  res.redirect(pid ? `/admin/capacity/profiles/${pid}` : '/admin/space-utilization');
});

router.post('/capacity/assignments/:id/end', requireValidCsrf, async (req, res) => {
  const id = req.params.id;
  if (!isUuid(id)) return res.redirect('/admin/space-utilization');
  const client = await pool.connect();
  let redirectTo = '/admin/space-utilization';
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE member_space_assignments SET ended_at = now(), ended_reason = $2, updated_at = now()
       WHERE id = $1::uuid AND deleted_at IS NULL AND ended_at IS NULL
       RETURNING unit_id, member_id`,
      [id, String(req.body.reason || 'admin_end')]
    );
    const u = rows[0];
    if (u?.unit_id && u?.member_id) {
      await client.query(
        `UPDATE member_plans SET space_unit_id = NULL, desk_or_office = NULL, updated_at = now()
         WHERE member_id = $1::uuid AND space_unit_id = $2::uuid AND deleted_at IS NULL`,
        [u.member_id, u.unit_id]
      );
    }
    if (u?.unit_id) {
      await syncUnitStatus(client, u.unit_id);
      await onCapacityUnitFreed(client, u.unit_id);
      const pr = await client.query(`SELECT profile_id FROM space_units WHERE id = $1::uuid`, [u.unit_id]);
      if (pr.rows[0]?.profile_id) redirectTo = `/admin/capacity/profiles/${pr.rows[0].profile_id}`;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
  } finally {
    client.release();
  }
  res.redirect(redirectTo);
});

router.post('/capacity/assign', requireValidCsrf, async (req, res) => {
  const unitId = String(req.body.unit_id || '');
  const memberId = String(req.body.member_id || '');
  if (!isUuid(unitId) || !isUuid(memberId)) return res.redirect('/admin/space-utilization?err=ids');
  const started = String(req.body.started_at || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  const ends = String(req.body.ends_at || '').trim() || null;
  const client = await pool.connect();
  let redirectTo = '/admin/space-utilization';
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO member_space_assignments (unit_id, member_id, started_at, ends_at, assignment_type)
       VALUES ($1::uuid, $2::uuid, $3::date, $4::date, 'ongoing')`,
      [unitId, memberId, started, ends || null]
    );
    const { rows: ulab } = await client.query(
      `SELECT label, location_note FROM space_units WHERE id = $1::uuid`,
      [unitId]
    );
    const lab = ulab[0]?.label || 'Unit';
    const loc = ulab[0]?.location_note ? ` (${ulab[0].location_note})` : '';
    await client.query(
      `UPDATE member_plans SET desk_or_office = $2, space_unit_id = $3::uuid, updated_at = now()
       WHERE member_id = $1::uuid AND deleted_at IS NULL AND status = 'active'`,
      [memberId, `${lab}${loc}`, unitId]
    );
    await syncUnitStatus(client, unitId);
    const pr = await client.query(`SELECT profile_id FROM space_units WHERE id = $1::uuid`, [unitId]);
    if (pr.rows[0]?.profile_id) redirectTo = `/admin/capacity/profiles/${pr.rows[0].profile_id}`;
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
  } finally {
    client.release();
  }
  res.redirect(redirectTo);
});

module.exports = router;
