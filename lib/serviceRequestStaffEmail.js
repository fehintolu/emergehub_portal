const { sendServiceRequestStaffActivityEmails } = require('./mail');

/**
 * Emails for super_admins, managers, and the assigned consultant (if any).
 */
async function collectStaffEmails(pool, assignedAdminId) {
  const { rows: roleRows } = await pool.query(
    `SELECT lower(trim(email)) AS e
     FROM portal_admin_users
     WHERE deleted_at IS NULL AND active = true
       AND role IN ('super_admin', 'manager')
       AND trim(coalesce(email, '')) <> ''`
  );
  const set = new Set(roleRows.map((r) => r.e).filter(Boolean));
  if (assignedAdminId) {
    const { rows } = await pool.query(
      `SELECT lower(trim(email)) AS e
       FROM portal_admin_users
       WHERE id = $1 AND deleted_at IS NULL AND active = true
         AND trim(coalesce(email, '')) <> ''`,
      [assignedAdminId]
    );
    if (rows[0]?.e) set.add(rows[0].e);
  }
  return [...set];
}

async function notifyStaffCustomerServiceRequestActivity(pool, params) {
  const {
    serviceRequestId,
    serviceName,
    memberName,
    memberEmail,
    summaryLine,
    assignedAdminId,
  } = params;
  const recipients = await collectStaffEmails(pool, assignedAdminId);
  if (!recipients.length) return;
  const sub = `[EmergeHub] Customer activity: ${serviceName || 'Service request'}`;
  const lines = [
    summaryLine || 'The customer interacted with a service request.',
    memberName ? `Member: ${memberName}` : null,
    memberEmail ? `Email: ${memberEmail}` : null,
  ];
  await sendServiceRequestStaffActivityEmails({
    recipients,
    subject: sub,
    lines,
    adminOpenPath: `/admin/service-requests/${serviceRequestId}`,
  });
}

module.exports = {
  collectStaffEmails,
  notifyStaffCustomerServiceRequestActivity,
};
