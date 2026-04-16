const { pool } = require('./db');

async function dashboardStats(memberId) {
  const activeServices = await pool.query(
    `SELECT COUNT(*)::int AS c FROM service_requests
     WHERE member_id = $1 AND deleted_at IS NULL
     AND status NOT IN ('Completed', 'Cancelled')`,
    [memberId]
  );
  const pendingRequests = await pool.query(
    `SELECT COUNT(*)::int AS c FROM service_requests
     WHERE member_id = $1 AND deleted_at IS NULL
     AND status IN ('Submitted', 'Under Review')`,
    [memberId]
  );
  const inv = await pool.query(
    `SELECT COUNT(*)::int AS c, COALESCE(SUM(total_cents),0)::bigint AS total
     FROM invoices
     WHERE member_id = $1 AND deleted_at IS NULL
     AND status IN ('unpaid', 'sent', 'overdue')`,
    [memberId]
  );
  const plan = await pool.query(
    `SELECT mp.*, mt.name AS tier_name
     FROM member_plans mp
     JOIN membership_tiers mt ON mt.id = mp.tier_id
     WHERE mp.member_id = $1 AND mp.deleted_at IS NULL AND mp.status = 'active'
     ORDER BY mp.started_at DESC LIMIT 1`,
    [memberId]
  );
  let daysRemaining = null;
  let planLabel = 'No active plan';
  const prow = plan.rows[0];
  if (prow && prow.renewal_at) {
    const end = new Date(prow.renewal_at);
    const now = new Date();
    daysRemaining = Math.ceil((end - now) / (1000 * 60 * 60 * 24));
    planLabel = prow.tier_name;
  } else if (prow) {
    planLabel = prow.tier_name;
    daysRemaining = null;
  }
  return {
    activeServices: activeServices.rows[0].c,
    pendingRequests: pendingRequests.rows[0].c,
    unpaidCount: inv.rows[0].c,
    unpaidTotalCents: Number(inv.rows[0].total),
    daysRemaining,
    planLabel,
    hasActivePlan: Boolean(prow),
  };
}

module.exports = { dashboardStats };
