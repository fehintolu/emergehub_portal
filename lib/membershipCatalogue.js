const { formatNgn } = require('./format');

const CORE_WORKSPACE_SLUG = 'core-workspace';

function isUuidString(s) {
  return (
    typeof s === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s)
  );
}

/**
 * Core Workspace services that use plan booking (same catalogue as member /workspace "Core workspace access").
 */
async function loadCoreWorkspacePlanCatalogue(pool) {
  const bookableSvcs = await pool.query(
    `SELECT s.*, c.name AS category_name
     FROM services s
     JOIN service_categories c ON c.id = s.category_id
     WHERE s.deleted_at IS NULL AND s.portal_active = true AND s.booking_mode = 'plan_booking'
       AND c.slug = $1
     ORDER BY c.sort_order, s.sort_order, s.id`,
    [CORE_WORKSPACE_SLUG]
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
  return { bookableServices: bookableSvcs.rows, plansByService };
}

function tierHoursLabelFromPlan(p) {
  const w = Number(p.weekly_access_sessions);
  if (w > 0) return `${w} visits per week`;
  return '';
}

/** Stable URL-safe slug; membership_tiers.slug is NOT NULL UNIQUE (marketing CMS schema). */
function baseSlugForCataloguePlan(plan, servicePlanId) {
  const fromSlug = String(plan.plan_slug || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (fromSlug) return fromSlug.slice(0, 96);
  const c = String(servicePlanId).replace(/-/g, '');
  return `catalogue-${c.slice(0, 8)}-${c.slice(-8)}`.slice(0, 96);
}

async function allocateUniqueTierSlug(pool, base) {
  const root = base.slice(0, 88) || 'tier';
  for (let n = 0; n < 100; n++) {
    const candidate = n === 0 ? root : `${root}-${n}`;
    const { rows } = await pool.query(
      `SELECT 1 FROM membership_tiers WHERE lower(trim(slug)) = lower(trim($1)) LIMIT 1`,
      [candidate]
    );
    if (!rows[0]) return candidate;
  }
  return `${root}-${Date.now()}`;
}

/**
 * Validates that the plan belongs to Core Workspace plan_booking catalogue.
 */
async function fetchValidatedCoreWorkspacePlan(pool, servicePlanId) {
  const { rows } = await pool.query(
    `SELECT sp.*, s.id AS catalogue_service_id, s.name AS catalogue_service_name
     FROM service_plans sp
     JOIN services s ON s.id = sp.service_id AND s.deleted_at IS NULL
     JOIN service_categories c ON c.id = s.category_id
     WHERE sp.id = $1::uuid AND sp.deleted_at IS NULL AND sp.active = true
       AND s.portal_active = true AND s.booking_mode = 'plan_booking'
       AND c.slug = $2`,
    [servicePlanId, CORE_WORKSPACE_SLUG]
  );
  return rows[0] || null;
}

/**
 * Resolves membership_tiers.id for a catalogue plan so member_plans inherit service_plans benefits
 * (meeting credits, weekly sessions, etc.) via mt.service_plan_id → service_plans.
 * Creates a tier row when none exists yet (e.g. new plan before seed links run).
 */
async function resolveTierIdForServicePlan(pool, servicePlanId) {
  if (!isUuidString(servicePlanId)) return { ok: false, code: 'invalid_plan' };

  const plan = await fetchValidatedCoreWorkspacePlan(pool, servicePlanId);
  if (!plan) return { ok: false, code: 'invalid_plan' };

  const ex = await pool.query(
    `SELECT id FROM membership_tiers WHERE service_plan_id = $1::uuid LIMIT 1`,
    [servicePlanId]
  );
  if (ex.rows[0]) return { ok: true, tierId: ex.rows[0].id, plan };

  const priceDisp = formatNgn(plan.price_cents);
  const hours = tierHoursLabelFromPlan(plan);
  const description = String(plan.description || '').trim();
  const slug = await allocateUniqueTierSlug(pool, baseSlugForCataloguePlan(plan, servicePlanId));

  try {
    const ins = await pool.query(
      `INSERT INTO membership_tiers (
         slug, name, price_display, hours, description, features, featured, sort_order, service_plan_id
       ) VALUES (
         $1, $2, $3, $4, $5, $6::text[], false,
         COALESCE((SELECT MAX(sort_order) + 1 FROM membership_tiers), 0),
         $7::uuid
       ) RETURNING id`,
      [slug, plan.title, priceDisp, hours, description, [], servicePlanId]
    );
    return { ok: true, tierId: ins.rows[0].id, plan };
  } catch (e) {
    console.error('resolveTierIdForServicePlan insert membership_tiers', e.code, e.message);
    return { ok: false, code: 'tier_create_failed', plan };
  }
}

module.exports = {
  CORE_WORKSPACE_SLUG,
  isUuidString,
  loadCoreWorkspacePlanCatalogue,
  fetchValidatedCoreWorkspacePlan,
  resolveTierIdForServicePlan,
};
