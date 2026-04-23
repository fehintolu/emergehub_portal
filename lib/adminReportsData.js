/**
 * Shared SQL helpers and data loaders for admin Operations + Finance reports.
 * Every query MUST exclude test members: m.is_test_account IS NOT TRUE (via member join).
 */
const { formatNgn, formatDate } = require('./format');

const HUB_TZ = () => process.env.PORTAL_TZ || 'Africa/Lagos';

async function hubToday(pool) {
  const tz = HUB_TZ();
  const { rows } = await pool.query(`SELECT (timezone($1::text, now()))::date AS d`, [tz]);
  return { tz, today: rows[0].d };
}

/**
 * Last 6 calendar months of collected revenue (completed payments), bucketed per payment row.
 * Returns array: { month, workspace_plans, virtual_office, professional_services, room_bookings, community_and_events, total }
 */
async function revenueLast6MonthBuckets(pool) {
  const tz = HUB_TZ();
  const { rows } = await pool.query(
    `WITH pay AS (
       SELECT
         p.amount_cents,
         date_trunc('month', timezone($1::text, p.created_at))::date AS month_start,
         i.id AS invoice_id,
         i.service_request_id,
         (SELECT rb.id FROM room_bookings rb
            WHERE rb.invoice_id = i.id AND rb.deleted_at IS NULL LIMIT 1) AS room_booking_id,
         (SELECT c.slug FROM invoice_service_links isl
            JOIN service_requests sr2 ON sr2.id = isl.service_request_id AND sr2.deleted_at IS NULL
            JOIN services sv2 ON sv2.id = sr2.service_id AND sv2.deleted_at IS NULL
            JOIN service_categories c ON c.id = sv2.category_id
           WHERE isl.invoice_id = i.id AND isl.deleted_at IS NULL
           ORDER BY isl.sort_order, isl.created_at LIMIT 1) AS link_cat_slug,
         c_direct.slug AS direct_cat_slug
       FROM payments p
       JOIN invoices i ON i.id = p.invoice_id AND i.deleted_at IS NULL
       JOIN members m ON m.id = i.member_id AND m.deleted_at IS NULL AND (m.is_test_account IS NOT TRUE)
       LEFT JOIN service_requests sr0 ON sr0.id = i.service_request_id AND sr0.deleted_at IS NULL
       LEFT JOIN services sv0 ON sv0.id = sr0.service_id AND sv0.deleted_at IS NULL
       LEFT JOIN service_categories c_direct ON c_direct.id = sv0.category_id
       WHERE p.deleted_at IS NULL AND p.status = 'completed'
         AND timezone($1::text, p.created_at) >= date_trunc('month', timezone($1::text, now())) - interval '5 months'
     ),
     tagged AS (
       SELECT
         month_start,
         amount_cents,
         CASE
           WHEN room_booking_id IS NOT NULL THEN 'room_bookings'
           WHEN COALESCE(link_cat_slug, direct_cat_slug) = 'core-workspace' THEN 'workspace_plans'
           WHEN COALESCE(link_cat_slug, direct_cat_slug) = 'virtual-remote' THEN 'virtual_office'
           WHEN COALESCE(link_cat_slug, direct_cat_slug) ~* 'community|event' THEN 'community_and_events'
           ELSE 'professional_services'
         END AS bucket
       FROM pay
     ),
     agg AS (
       SELECT
         month_start,
         COALESCE(SUM(amount_cents) FILTER (WHERE bucket = 'workspace_plans'), 0)::bigint AS workspace_plans,
         COALESCE(SUM(amount_cents) FILTER (WHERE bucket = 'virtual_office'), 0)::bigint AS virtual_office,
         COALESCE(SUM(amount_cents) FILTER (WHERE bucket = 'professional_services'), 0)::bigint AS professional_services,
         COALESCE(SUM(amount_cents) FILTER (WHERE bucket = 'room_bookings'), 0)::bigint AS room_bookings,
         COALESCE(SUM(amount_cents) FILTER (WHERE bucket = 'community_and_events'), 0)::bigint AS community_and_events
       FROM tagged
       GROUP BY month_start
     ),
     months AS (
       SELECT generate_series(
         (date_trunc('month', timezone($1::text, now())) - interval '5 months')::date,
         (date_trunc('month', timezone($1::text, now())))::date,
         interval '1 month'
       )::date AS month_start
     )
     SELECT
       m.month_start,
       COALESCE(a.workspace_plans, 0)::bigint AS workspace_plans,
       COALESCE(a.virtual_office, 0)::bigint AS virtual_office,
       COALESCE(a.professional_services, 0)::bigint AS professional_services,
       COALESCE(a.room_bookings, 0)::bigint AS room_bookings,
       COALESCE(a.community_and_events, 0)::bigint AS community_and_events
     FROM months m
     LEFT JOIN agg a ON a.month_start = m.month_start
     ORDER BY m.month_start ASC`,
    [tz]
  );
  return rows.map((r) => {
    const wp = Number(r.workspace_plans) || 0;
    const vo = Number(r.virtual_office) || 0;
    const pr = Number(r.professional_services) || 0;
    const rb = Number(r.room_bookings) || 0;
    const ce = Number(r.community_and_events) || 0;
    return {
      month_start: r.month_start,
      workspace_plans: wp,
      virtual_office: vo,
      professional_services: pr,
      room_bookings: rb,
      community_and_events: ce,
      total: wp + vo + pr + rb + ce,
    };
  });
}

async function sumPaymentsBetween(pool, startDate, endDateExclusive) {
  const tz = HUB_TZ();
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(p.amount_cents), 0)::bigint AS t
     FROM payments p
     JOIN invoices i ON i.id = p.invoice_id AND i.deleted_at IS NULL
     JOIN members m ON m.id = i.member_id AND m.deleted_at IS NULL AND (m.is_test_account IS NOT TRUE)
     WHERE p.deleted_at IS NULL AND p.status = 'completed'
       AND (timezone($1::text, p.created_at))::date >= $2::date
       AND (timezone($1::text, p.created_at))::date < $3::date`,
    [tz, startDate, endDateExclusive]
  );
  return Number(rows[0].t) || 0;
}

async function activeMemberCountToday(pool, todayStr) {
  const { rows } = await pool.query(
    `SELECT COUNT(DISTINCT m.id)::int AS c
     FROM members m
     WHERE m.deleted_at IS NULL AND (m.is_test_account IS NOT TRUE)
       AND (
         EXISTS (
           SELECT 1 FROM member_plans mp
           JOIN membership_tiers mt ON mt.id = mp.tier_id
           JOIN service_plans sp ON sp.id = mt.service_plan_id AND sp.deleted_at IS NULL
           WHERE mp.member_id = m.id AND mp.deleted_at IS NULL AND mp.status = 'active'
             AND COALESCE(mp.started_at, DATE '1970-01-01') <= $1::date
             AND (mp.renewal_at IS NULL OR mp.renewal_at >= $1::date)
             AND sp.plan_kind = 'workspace_day'
         )
         OR EXISTS (
           SELECT 1 FROM member_space_assignments msa
           WHERE msa.member_id = m.id AND msa.deleted_at IS NULL AND msa.ended_at IS NULL
             AND (msa.ends_at IS NULL OR msa.ends_at >= $1::date)
         )
       )`,
    [todayStr]
  );
  return rows[0].c || 0;
}

async function needsActionServiceRequestCount(pool, todayStr) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c
     FROM service_requests sr
     JOIN members m ON m.id = sr.member_id AND m.deleted_at IS NULL AND (m.is_test_account IS NOT TRUE)
     WHERE sr.deleted_at IS NULL
       AND (
         (sr.status = 'Submitted' AND sr.assigned_admin_id IS NULL)
         OR (sr.action_required_member = TRUE OR sr.status = 'Action Required')
         OR (
           sr.service_end_date IS NOT NULL
           AND sr.service_end_date < $1::date
           AND sr.status NOT IN ('Completed', 'Cancelled')
         )
       )`,
    [todayStr]
  );
  return rows[0].c || 0;
}

function monthlyEquivalentCents(plan) {
  const du = String(plan.duration_unit || '');
  const dv = Number(plan.duration_value) || 0;
  const pk = String(plan.plan_kind || '');
  const price = Number(plan.price_cents) || 0;
  if (du === 'month' && dv === 1) return price;
  if (du === 'month' && dv === 12) return Math.round(price / 12);
  if (pk === 'workspace_day') return 0;
  if (du === 'hour') return 0;
  return price;
}

module.exports = {
  HUB_TZ,
  hubToday,
  revenueLast6MonthBuckets,
  sumPaymentsBetween,
  activeMemberCountToday,
  needsActionServiceRequestCount,
  monthlyEquivalentCents,
  formatNgn,
  formatDate,
};
