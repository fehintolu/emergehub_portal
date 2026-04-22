const { notifyMember } = require('./notifications');
const { logActivity } = require('./activity');
const { sendServicePaymentInitiatedEmail } = require('./mail');

function parseDetailJson(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return {};
  }
}

/**
 * Workspace catalogue booking with a timed plan: until access starts, defer "In Progress" and credits.
 * Expects `sr` to include duration_value, duration_unit (join service_plans).
 */
function deferWorkspacePromotionUntilAccess(sr) {
  const d = parseDetailJson(sr.detail_json);
  const isWs = d.workspace_booking === true || d.workspace_booking === 'true';
  if (!isWs) return false;
  const v = Number(sr.duration_value) || 0;
  const u = String(sr.duration_unit || '').toLowerCase().trim();
  const hasDur = v > 0 && ['hour', 'day', 'month'].includes(u);
  if (!hasDur) return false;
  return sr.access_started_at == null;
}

/**
 * Move a submitted/under-review SR to In Progress after payment (idempotent for status).
 * @param {import('pg').PoolClient} client
 * @param {string} srId
 */
async function promoteSubmittedServiceRequestAfterPayment(client, srId) {
  const base = process.env.BASE_URL || '';
  const { rows: srRows } = await client.query(
    `SELECT sr.*, sv.name AS service_name
     FROM service_requests sr
     JOIN services sv ON sv.id = sr.service_id
     WHERE sr.id = $1::uuid AND sr.deleted_at IS NULL`,
    [srId]
  );
  const sr = srRows[0];
  if (!sr) return;
  if (!['Submitted', 'Under Review'].includes(sr.status)) return;

  await client.query(`UPDATE service_requests SET status = 'In Progress', updated_at = now() WHERE id = $1::uuid`, [
    srId,
  ]);
  await client.query(
    `INSERT INTO service_request_updates (service_request_id, stage, note, visible_to_member)
     VALUES ($1::uuid, 'In Progress', $2, true)`,
    [srId, 'Payment confirmed. Service has been initiated.']
  );

  await notifyMember(
    {
      memberId: sr.member_id,
      title: 'Service in progress',
      message: `Your ${sr.service_name || 'service'} request is now in progress.`,
      linkUrl: `/services/${srId}`,
    },
    client
  );
  await logActivity(
    {
      memberId: sr.member_id,
      eventType: 'service',
      title: 'Payment confirmed — service started',
      body: sr.service_name || 'Service',
      entityType: 'service_request',
      entityId: srId,
    },
    client
  );

  const { rows: memRows } = await client.query(
    `SELECT email, full_name, notify_email_service FROM members WHERE id = $1`,
    [sr.member_id]
  );
  const mem = memRows[0];
  if (mem && mem.email && mem.notify_email_service) {
    try {
      await sendServicePaymentInitiatedEmail({
        to: mem.email,
        name: mem.full_name,
        serviceName: sr.service_name || 'Service',
        serviceRequestId: srId,
        portalUrl: base,
      });
    } catch (e) {
      console.error('sendServicePaymentInitiatedEmail', e.message);
    }
  }
}

module.exports = {
  deferWorkspacePromotionUntilAccess,
  promoteSubmittedServiceRequestAfterPayment,
};
