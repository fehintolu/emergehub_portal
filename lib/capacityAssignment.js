const { onCapacityUnitFreed } = require('./capacityWaitlist');
const { notifyMember } = require('./notifications');

/**
 * Mark unit occupied / available (simple state; assignments are source of truth).
 */
async function syncUnitStatus(client, unitId) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS c FROM member_space_assignments
     WHERE unit_id = $1::uuid AND deleted_at IS NULL AND ended_at IS NULL`,
    [unitId]
  );
  const occ = rows[0].c > 0;
  await client.query(
    `UPDATE space_units SET status = $2, updated_at = now() WHERE id = $1::uuid AND deleted_at IS NULL`,
    [unitId, occ ? 'occupied' : 'available']
  );
}

/**
 * After invoice paid: auto-assign next free unit for capacity-limited plan.
 */
async function assignSpaceForPaidServiceRequest(client, srId, invoiceId) {
  const { rows: srRows } = await client.query(
    `SELECT sr.*, sp.is_capacity_limited, sp.plan_kind, sp.id AS service_plan_uuid
     FROM service_requests sr
     JOIN service_plans sp ON sp.id = sr.service_plan_id AND sp.deleted_at IS NULL
     WHERE sr.id = $1::uuid AND sr.deleted_at IS NULL`,
    [srId]
  );
  const sr = srRows[0];
  if (!sr || !sr.is_capacity_limited) return;

  const { rows: profRows } = await client.query(
    `SELECT * FROM plan_capacity_profiles
     WHERE service_plan_id = $1::uuid AND deleted_at IS NULL LIMIT 1`,
    [sr.service_plan_uuid]
  );
  const profile = profRows[0];
  if (!profile || !profile.auto_assign) return;

  const { rows: have } = await client.query(
    `SELECT 1 FROM member_space_assignments msa
     JOIN space_units su ON su.id = msa.unit_id AND su.deleted_at IS NULL
     WHERE msa.member_id = $1::uuid AND msa.deleted_at IS NULL AND msa.ended_at IS NULL
       AND su.profile_id = $2::uuid
     LIMIT 1`,
    [sr.member_id, profile.id]
  );
  if (have.length) return;

  const { rows: open } = await client.query(
    `SELECT su.id FROM space_units su
     WHERE su.profile_id = $1::uuid AND su.deleted_at IS NULL AND su.status = 'available'
     ORDER BY su.label
     LIMIT 1
     FOR UPDATE OF su`,
    [profile.id]
  );
  const unitId = open[0]?.id;
  if (!unitId) return;

  const started = new Date();
  const startedStr = started.toISOString().slice(0, 10);
  const isDaily = String(sr.plan_kind || '') === 'workspace_day';
  let endsStr = null;
  if (isDaily) {
    endsStr = startedStr;
  } else if (sr.access_ends_at) {
    endsStr = new Date(sr.access_ends_at).toISOString().slice(0, 10);
  }

  await client.query(
    `INSERT INTO member_space_assignments (
       unit_id, member_id, started_at, ends_at, assignment_type, source_service_request_id, source_invoice_id
     ) VALUES ($1::uuid, $2::uuid, $3::date, $4::date, $5, $6::uuid, $7::uuid)`,
    [
      unitId,
      sr.member_id,
      startedStr,
      endsStr,
      isDaily ? 'daily_access' : 'ongoing',
      srId,
      invoiceId,
    ]
  );

  const { rows: u } = await client.query(
    `SELECT label, location_note FROM space_units WHERE id = $1::uuid`,
    [unitId]
  );
  const label = u[0]?.label || 'Unit';
  const loc = u[0]?.location_note ? ` (${u[0].location_note})` : '';

  await client.query(
    `UPDATE member_plans SET desk_or_office = $2, space_unit_id = $3::uuid, updated_at = now()
     WHERE member_id = $1::uuid AND deleted_at IS NULL AND status = 'active'`,
    [sr.member_id, `${label}${loc}`, unitId]
  );

  await syncUnitStatus(client, unitId);
}

async function processPaidInvoiceCapacity(client, invoiceId) {
  const srIdSet = new Set();
  const inv = await client.query(`SELECT service_request_id FROM invoices WHERE id = $1::uuid`, [invoiceId]);
  if (inv.rows[0]?.service_request_id) srIdSet.add(inv.rows[0].service_request_id);
  const linkQ = await client.query(
    `SELECT service_request_id FROM invoice_service_links WHERE invoice_id = $1::uuid AND deleted_at IS NULL`,
    [invoiceId]
  );
  linkQ.rows.forEach((r) => srIdSet.add(r.service_request_id));
  const revQ = await client.query(
    `SELECT id FROM service_requests WHERE invoice_id = $1::uuid AND deleted_at IS NULL`,
    [invoiceId]
  );
  revQ.rows.forEach((r) => srIdSet.add(r.id));

  for (const srId of srIdSet) {
    await assignSpaceForPaidServiceRequest(client, srId, invoiceId);
  }
}

/**
 * End daily access assignments for "yesterday" in hub TZ; free units.
 */
async function resetDailyAccessAssignments(client) {
  const tz = process.env.PORTAL_TZ || 'Africa/Lagos';
  const { rows } = await client.query(
    `SELECT msa.id, msa.unit_id
     FROM member_space_assignments msa
     WHERE msa.deleted_at IS NULL AND msa.ended_at IS NULL AND msa.assignment_type = 'daily_access'
       AND msa.started_at < (timezone($1::text, now()))::date`,
    [tz]
  );
  for (const r of rows) {
    await client.query(
      `UPDATE member_space_assignments SET ended_at = now(), ended_reason = 'daily_reset', updated_at = now()
       WHERE id = $1::uuid`,
      [r.id]
    );
    await client.query(`UPDATE space_units SET status = 'available', updated_at = now() WHERE id = $1::uuid`, [
      r.unit_id,
    ]);
    await onCapacityUnitFreed(client, r.unit_id);
  }
}

/**
 * Remind members whose space assignment ends within 7 days.
 */
async function sendAssignmentEndingReminders(client) {
  const { rows } = await client.query(
    `SELECT msa.id, msa.member_id, msa.ends_at, su.label
     FROM member_space_assignments msa
     JOIN space_units su ON su.id = msa.unit_id
     WHERE msa.deleted_at IS NULL AND msa.ended_at IS NULL AND msa.ends_at IS NOT NULL
       AND msa.ends_reminder_sent_at IS NULL
       AND msa.ends_at <= (CURRENT_DATE + interval '7 days')
       AND msa.ends_at >= CURRENT_DATE`
  );
  for (const r of rows) {
    await notifyMember(
      {
        memberId: r.member_id,
        title: 'Your workspace assignment is ending soon',
        message: `Your space (${r.label}) is scheduled to end on ${
          r.ends_at instanceof Date ? r.ends_at.toISOString().slice(0, 10) : String(r.ends_at).slice(0, 10)
        }. Please renew or contact EmergeHub.`,
        linkUrl: '/workspace',
      },
      client
    );
    await client.query(
      `UPDATE member_space_assignments SET ends_reminder_sent_at = now(), updated_at = now() WHERE id = $1::uuid`,
      [r.id]
    );
  }
}

module.exports = {
  syncUnitStatus,
  assignSpaceForPaidServiceRequest,
  processPaidInvoiceCapacity,
  resetDailyAccessAssignments,
  sendAssignmentEndingReminders,
};
