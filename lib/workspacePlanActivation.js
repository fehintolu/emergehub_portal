const { resolveTierIdForServicePlan } = require('./membershipCatalogue');
const { applyAccessWindowToServiceRequest } = require('./serviceRequestAccess');
const { processPaidInvoiceCapacity } = require('./capacityAssignment');
const { ensureCreditLedgerAfterPaidPlan } = require('./meetingCredits');
const { promoteSubmittedServiceRequestAfterPayment } = require('./serviceRequestPaymentPromote');

function parseDetailJson(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return {};
  }
}

function detailJsonIsWorkspaceBooking(detailJson) {
  const d = parseDetailJson(detailJson);
  return d.workspace_booking === true || d.workspace_booking === 'true';
}

function planHasDuration(sp) {
  if (!sp) return false;
  const v = Number(sp.duration_value) || 0;
  const u = String(sp.duration_unit || '').toLowerCase().trim();
  return v > 0 && ['hour', 'day', 'month'].includes(u);
}

/**
 * @param {import('pg').PoolClient} client
 * @param {string} invoiceId
 * @returns {Promise<object[]>}
 */
async function loadLinkedServiceRequestsForInvoice(client, invoiceId) {
  const srIdSet = new Set();
  const { rows: invRows } = await client.query(`SELECT service_request_id FROM invoices WHERE id = $1::uuid`, [
    invoiceId,
  ]);
  if (invRows[0]?.service_request_id) srIdSet.add(invRows[0].service_request_id);
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

  const ids = [...srIdSet];
  if (!ids.length) return [];

  const { rows } = await client.query(
    `SELECT sr.*, sp.duration_value, sp.duration_unit, sp.title AS plan_title
     FROM service_requests sr
     JOIN service_plans sp ON sp.id = sr.service_plan_id AND sp.deleted_at IS NULL
     WHERE sr.id = ANY($1::uuid[]) AND sr.deleted_at IS NULL`,
    [ids]
  );
  return rows;
}

function isWorkspaceDurationInvoiceServiceRequest(row) {
  return detailJsonIsWorkspaceBooking(row.detail_json) && planHasDuration(row);
}

/**
 * Paid workspace plan invoice: SR stays submitted until access starts; member_plans row tracks catalogue membership.
 * @param {import('pg').PoolClient} client
 * @param {string} invoiceId
 * @param {Date | null} accessStartsAt — null = paid but pending activation (admin bank/manual without date)
 */
/**
 * When marking paid: explicit datetime wins. If omitted, workspace catalogue bookings with a
 * duration stay unpaid-active (null) until activation; other duration-based SRs keep the old
 * behaviour of starting access immediately.
 */
async function resolveAccessStartWhenMarkingPaid(client, invoiceId, accessStartsAt) {
  const hasValid = accessStartsAt instanceof Date && !Number.isNaN(accessStartsAt.getTime());
  if (hasValid) return accessStartsAt;
  const rows = await loadLinkedServiceRequestsForInvoice(client, invoiceId);
  if (rows.some(isWorkspaceDurationInvoiceServiceRequest)) return null;
  if (rows.some((r) => planHasDuration(r))) return new Date();
  return null;
}

async function syncWorkspaceMemberPlanAfterInvoicePaid(client, invoiceId, accessStartsAt) {
  const rows = await loadLinkedServiceRequestsForInvoice(client, invoiceId);
  const targets = rows.filter(isWorkspaceDurationInvoiceServiceRequest);
  if (!targets.length) return;

  const hasStart = accessStartsAt instanceof Date && !Number.isNaN(accessStartsAt.getTime());

  for (const sr of targets) {
    const resolved = await resolveTierIdForServicePlan(client, sr.service_plan_id);
    if (!resolved.ok) continue;
    const tierId = resolved.tierId;

    const { rows: existing } = await client.query(
      `SELECT id, status FROM member_plans
       WHERE deleted_at IS NULL
         AND source_invoice_id = $1::uuid
         AND source_service_request_id = $2::uuid
       LIMIT 1`,
      [invoiceId, sr.id]
    );
    const ex = existing[0];

    if (hasStart) {
      await client.query(
        `UPDATE member_plans SET deleted_at = now(), updated_at = now()
         WHERE member_id = $1::uuid AND deleted_at IS NULL AND status = 'active'`,
        [sr.member_id]
      );

      const renewalAt = await renewalDateAfterAccessApplied(client, sr.id);

      if (ex) {
        await client.query(
          `UPDATE member_plans
           SET status = 'active',
               started_at = $2::date,
               renewal_at = $3::date,
               deleted_at = NULL,
               updated_at = now()
           WHERE id = $1::uuid`,
          [ex.id, accessStartsAt, renewalAt]
        );
      } else {
        await client.query(
          `INSERT INTO member_plans (
             member_id, tier_id, status, started_at, renewal_at,
             source_service_request_id, source_invoice_id
           ) VALUES ($1::uuid, $2, 'active', $3::date, $4::date, $5::uuid, $6::uuid)`,
          [sr.member_id, tierId, accessStartsAt, renewalAt, sr.id, invoiceId]
        );
      }
    } else {
      if (ex) continue;
      await client.query(
        `INSERT INTO member_plans (
           member_id, tier_id, status, started_at, renewal_at,
           source_service_request_id, source_invoice_id
         ) VALUES ($1::uuid, $2, 'pending_activation', NULL, NULL, $3::uuid, $4::uuid)`,
        [sr.member_id, tierId, sr.id, invoiceId]
      );
    }
  }
}

async function renewalDateAfterAccessApplied(client, srId) {
  const { rows } = await client.query(
    `SELECT access_ends_at FROM service_requests WHERE id = $1::uuid`,
    [srId]
  );
  const end = rows[0]?.access_ends_at;
  if (!end) return null;
  const d = end instanceof Date ? end : new Date(end);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/**
 * Admin or member activates a pending workspace plan row.
 * @param {import('pg').PoolClient} client
 * @param {{ memberPlanId: string, memberId: string, accessStartsAt: Date, fromMemberPortal: boolean }} opts
 */
async function activatePendingWorkspaceMemberPlan(client, opts) {
  const { memberPlanId, memberId, accessStartsAt, fromMemberPortal } = opts;
  let start = accessStartsAt;
  if (fromMemberPortal) {
    start = new Date();
  }
  if (!(start instanceof Date) || Number.isNaN(start.getTime())) {
    throw new Error('invalid_start');
  }

  const { rows: mpRows } = await client.query(
    `SELECT * FROM member_plans WHERE id = $1::uuid AND member_id = $2::uuid AND deleted_at IS NULL FOR UPDATE`,
    [memberPlanId, memberId]
  );
  const mp = mpRows[0];
  if (!mp || mp.status !== 'pending_activation') throw new Error('not_pending');

  const srId = mp.source_service_request_id;
  const invId = mp.source_invoice_id;
  if (!srId || !invId) throw new Error('missing_source');

  const { rows: invChk } = await client.query(
    `SELECT id, status FROM invoices WHERE id = $1::uuid AND deleted_at IS NULL`,
    [invId]
  );
  if (!invChk[0] || invChk[0].status !== 'paid') throw new Error('invoice_not_paid');

  const applied = await applyAccessWindowToServiceRequest(client, srId, start);
  if (!applied) throw new Error('access_window_failed');

  const renewalAt = await renewalDateAfterAccessApplied(client, srId);

  await client.query(
    `UPDATE member_plans SET deleted_at = now(), updated_at = now()
     WHERE member_id = $1::uuid AND deleted_at IS NULL AND status = 'active' AND id <> $2::uuid`,
    [memberId, memberPlanId]
  );

  await client.query(
    `UPDATE member_plans
     SET status = 'active', started_at = $2::date, renewal_at = $3::date, updated_at = now()
     WHERE id = $1::uuid`,
    [memberPlanId, start, renewalAt]
  );

  await promoteSubmittedServiceRequestAfterPayment(client, srId);
  await processPaidInvoiceCapacity(client, invId);
  await ensureCreditLedgerAfterPaidPlan(client, memberId);
}

module.exports = {
  detailJsonIsWorkspaceBooking,
  planHasDuration,
  isWorkspaceDurationInvoiceServiceRequest,
  loadLinkedServiceRequestsForInvoice,
  resolveAccessStartWhenMarkingPaid,
  syncWorkspaceMemberPlanAfterInvoicePaid,
  activatePendingWorkspaceMemberPlan,
};
