/**
 * Idempotent price schedule + catalog metadata (NGN in minor units / "cents").
 * Run: node scripts/seed-price-schedule.js
 * Safe to re-run; matches services by slug, plans by plan_slug, meeting_rooms by slug.
 */
require('dotenv').config();
const { pool } = require('../lib/db');

const FEAT_WORKSPACE_CORE =
  'Fast and reliable internet; constant power supply; receptionist and customer service; ' +
  'printing, scanning and photocopying at fifty percent of the prevailing rate; adequate parking space.';

const FEAT_SUPER_HOT =
  FEAT_WORKSPACE_CORE +
  ' Personnel to receive packages and messages; access to a desk in the shared workspace.';

const FEAT_PRIVATE =
  FEAT_SUPER_HOT +
  ' Three hours of meeting room credits per month. Each unit is a named individual office.';

const FEAT_CONFERENCE =
  'Fast and reliable internet; constant power supply; modern facilities and technology; ' +
  'printing, scanning and photocopying at fifty percent of the prevailing rate; adequate parking space.';

const FEAT_TRAINING =
  'Capacity thirty people; constant power supply; modern facilities and technology; adequate parking space.';

const FEAT_VIDEO =
  'Constant power supply; modern facilities and technology; access to meeting room, bookshelf, shared space, and reception; adequate parking space.';

const FEAT_VIRTUAL_STD =
  'Use of office as official business address; receptionist and customer service; personnel to receive packages and messages; ' +
  'ninety six hours of meeting room credits for the year (eight hours per month); adequate parking space.';

const FEAT_VIRTUAL_ENT =
  'Use of office as official business address; receptionist and customer service; personnel to receive packages and messages; ' +
  'one hundred and ninety two hours of meeting room credits for the year (sixteen hours per month); adequate parking space.';

async function categoryId(client, slug) {
  const { rows } = await client.query(
    `SELECT id FROM service_categories WHERE slug = $1 ORDER BY sort_order, id LIMIT 1`,
    [slug]
  );
  if (rows[0]) return rows[0].id;
  const f = await client.query(`SELECT id FROM service_categories ORDER BY sort_order, id LIMIT 1`);
  if (!f.rows[0]) throw new Error('No service_categories rows — cannot seed services.');
  return f.rows[0].id;
}

async function upsertService(client, { categorySlug, slug, name, description, sortOrder, portalPriceCents, bookingMode }) {
  const cid = await categoryId(client, categorySlug);
  const ex = await client.query(
    `SELECT id FROM services WHERE category_id = $1 AND slug = $2 ORDER BY (deleted_at IS NULL) DESC, id LIMIT 1`,
    [cid, slug]
  );
  if (ex.rows[0]) {
    await client.query(
      `UPDATE services SET name = $2, description = $3, sort_order = $4, portal_price_cents = $5,
         portal_active = true, booking_mode = $6, deleted_at = NULL
       WHERE id = $1`,
      [ex.rows[0].id, name, description, sortOrder, portalPriceCents, bookingMode]
    );
    return ex.rows[0].id;
  }
  const ins = await client.query(
    `INSERT INTO services (category_id, slug, name, description, sort_order, portal_price_cents, portal_active, booking_mode)
     VALUES ($1, $2, $3, $4, $5, $6, true, $7) RETURNING id`,
    [cid, slug, name, description, sortOrder, portalPriceCents, bookingMode]
  );
  return ins.rows[0].id;
}

async function upsertPlan(client, serviceId, row) {
  const {
    plan_slug,
    title,
    description,
    price_cents,
    sort_order,
    duration_value,
    duration_unit,
    monthly_meeting_credit_minutes,
    weekly_access_sessions,
    is_capacity_limited,
    plan_kind,
  } = row;
  const u = await client.query(
    `UPDATE service_plans SET title = $3, description = $4, price_cents = $5, sort_order = $6, active = true,
       duration_value = $7, duration_unit = $8, monthly_meeting_credit_minutes = COALESCE($9, 0),
       weekly_access_sessions = $10, is_capacity_limited = COALESCE($11, false), plan_kind = $12,
       plan_slug = $13, deleted_at = NULL, updated_at = now()
     WHERE service_id = $1 AND plan_slug = $2 AND deleted_at IS NULL
     RETURNING id`,
    [
      serviceId,
      plan_slug,
      title,
      description,
      price_cents,
      sort_order,
      duration_value,
      duration_unit,
      monthly_meeting_credit_minutes,
      weekly_access_sessions,
      is_capacity_limited,
      plan_kind,
      plan_slug,
    ]
  );
  if (u.rows[0]) return u.rows[0].id;
  const ins = await client.query(
    `INSERT INTO service_plans (
       service_id, title, plan_slug, description, price_cents, sort_order, active,
       duration_value, duration_unit, monthly_meeting_credit_minutes, weekly_access_sessions,
       is_capacity_limited, plan_kind
     ) VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [
      serviceId,
      title,
      plan_slug,
      description,
      price_cents,
      sort_order,
      duration_value,
      duration_unit,
      monthly_meeting_credit_minutes ?? 0,
      weekly_access_sessions,
      is_capacity_limited ?? false,
      plan_kind,
    ]
  );
  return ins.rows[0].id;
}

async function upsertMeetingRoom(client, row) {
  const {
    slug,
    name,
    description,
    capacity,
    hourly_rate_cents,
    full_day_rate_cents,
    room_product_kind,
    consumes_plan_credits,
    sort_order,
  } = row;
  const ex = await client.query(
    `SELECT id FROM meeting_rooms WHERE lower(trim(slug)) = lower(trim($1)) AND deleted_at IS NULL LIMIT 1`,
    [slug]
  );
  if (ex.rows[0]) {
    await client.query(
      `UPDATE meeting_rooms SET name = $2, description = $3, capacity = $4, hourly_rate_cents = $5,
         full_day_rate_cents = $6, room_product_kind = $7, consumes_plan_credits = $8, sort_order = $9,
         active = true, updated_at = now()
       WHERE id = $1`,
      [
        ex.rows[0].id,
        name,
        description,
        capacity,
        hourly_rate_cents,
        full_day_rate_cents,
        room_product_kind,
        consumes_plan_credits !== false,
        sort_order,
      ]
    );
    return ex.rows[0].id;
  }
  const ins = await client.query(
    `INSERT INTO meeting_rooms (
       name, description, capacity, hourly_rate_cents, slug, full_day_rate_cents, room_product_kind,
       consumes_plan_credits, active, sort_order
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9) RETURNING id`,
    [
      name,
      description,
      capacity,
      hourly_rate_cents,
      slug,
      full_day_rate_cents || null,
      room_product_kind,
      consumes_plan_credits !== false,
      sort_order,
    ]
  );
  return ins.rows[0].id;
}

async function ensureCapacityProfile(client, servicePlanId, { total_units, auto_assign, waitlist_enabled }) {
  const ex = await client.query(
    `SELECT id FROM plan_capacity_profiles WHERE service_plan_id = $1::uuid AND deleted_at IS NULL`,
    [servicePlanId]
  );
  if (ex.rows[0]) {
    await client.query(
      `UPDATE plan_capacity_profiles SET total_units = $2, auto_assign = $3, waitlist_enabled = $4, updated_at = now()
       WHERE id = $1::uuid`,
      [ex.rows[0].id, total_units, auto_assign, waitlist_enabled]
    );
    return ex.rows[0].id;
  }
  const ins = await client.query(
    `INSERT INTO plan_capacity_profiles (service_plan_id, total_units, auto_assign, waitlist_enabled)
     VALUES ($1::uuid, $2, $3, $4) RETURNING id`,
    [servicePlanId, total_units, auto_assign, waitlist_enabled]
  );
  return ins.rows[0].id;
}

async function ensureUnits(client, profileId, labels, locationNote) {
  const { rows } = await client.query(
    `SELECT label FROM space_units WHERE profile_id = $1::uuid AND deleted_at IS NULL`,
    [profileId]
  );
  const have = new Set(rows.map((r) => r.label));
  let ord = 0;
  for (const label of labels) {
    if (have.has(label)) continue;
    await client.query(
      `INSERT INTO space_units (profile_id, label, location_note, status) VALUES ($1::uuid, $2, $3, 'available')`,
      [profileId, label, locationNote || null]
    );
    ord += 1;
  }
}

async function linkTierToPlanByName(client, tierNamePattern, planId) {
  await client.query(
    `UPDATE membership_tiers SET service_plan_id = $2::uuid
     WHERE service_plan_id IS DISTINCT FROM $2::uuid AND lower(name) LIKE $1`,
    [tierNamePattern, planId]
  );
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const catCore = 'core-workspace';
    const catVirtual = 'virtual-remote';
    let catVirt = catVirtual;
    try {
      await categoryId(client, catVirtual);
    } catch {
      catVirt = catCore;
    }

    const daily = await upsertService(client, {
      categorySlug: catCore,
      slug: 'daily-access',
      name: 'Daily Access',
      description: `${FEAT_WORKSPACE_CORE} Access to a desk in the shared workspace (9am–5pm).`,
      sortOrder: 10,
      portalPriceCents: 600000,
      bookingMode: 'plan_booking',
    });
    const planDaily = await upsertPlan(client, daily, {
      plan_slug: 'daily-pass',
      title: 'Daily Access (9am–5pm)',
      description: FEAT_WORKSPACE_CORE,
      price_cents: 600000,
      sort_order: 0,
      duration_value: 1,
      duration_unit: 'day',
      monthly_meeting_credit_minutes: 0,
      weekly_access_sessions: null,
      is_capacity_limited: true,
      plan_kind: 'workspace_day',
    });
    const profDaily = await ensureCapacityProfile(client, planDaily, {
      total_units: 20,
      auto_assign: false,
      waitlist_enabled: true,
    });
    await ensureUnits(
      client,
      profDaily,
      Array.from({ length: 20 }, (_, i) => `Daily seat ${i + 1}`),
      'Shared workspace'
    );

    const superDesk = await upsertService(client, {
      categorySlug: catCore,
      slug: 'super-desk',
      name: 'Super Desk',
      description: FEAT_SUPER_HOT + ' Two visits per week.',
      sortOrder: 20,
      portalPriceCents: 3000000,
      bookingMode: 'plan_booking',
    });
    const planSuper = await upsertPlan(client, superDesk, {
      plan_slug: 'super-desk-month',
      title: 'Super Desk — two times per week',
      description: FEAT_SUPER_HOT,
      price_cents: 3000000,
      sort_order: 0,
      duration_value: 1,
      duration_unit: 'month',
      monthly_meeting_credit_minutes: 0,
      weekly_access_sessions: 2,
      is_capacity_limited: true,
      plan_kind: 'workspace_month',
    });
    const profSuper = await ensureCapacityProfile(client, planSuper, { total_units: 12, auto_assign: false, waitlist_enabled: true });
    await ensureUnits(client, profSuper, Array.from({ length: 12 }, (_, i) => `Super desk ${i + 1}`), 'Shared workspace');

    const hotDesk = await upsertService(client, {
      categorySlug: catCore,
      slug: 'hot-desk',
      name: 'Hot Desk',
      description: FEAT_SUPER_HOT + ' Three visits per week.',
      sortOrder: 30,
      portalPriceCents: 3500000,
      bookingMode: 'plan_booking',
    });
    const planHot = await upsertPlan(client, hotDesk, {
      plan_slug: 'hot-desk-month',
      title: 'Hot Desk — three times per week',
      description: FEAT_SUPER_HOT,
      price_cents: 3500000,
      sort_order: 0,
      duration_value: 1,
      duration_unit: 'month',
      monthly_meeting_credit_minutes: 0,
      weekly_access_sessions: 3,
      is_capacity_limited: true,
      plan_kind: 'workspace_month',
    });
    const profHot = await ensureCapacityProfile(client, planHot, { total_units: 10, auto_assign: false, waitlist_enabled: true });
    await ensureUnits(client, profHot, Array.from({ length: 10 }, (_, i) => `Desk ${i + 1}`), 'Shared workspace');

    const dedDesk = await upsertService(client, {
      categorySlug: catCore,
      slug: 'dedicated-desk',
      name: 'Dedicated Desk',
      description: FEAT_SUPER_HOT + ' Each unit is a named individual desk.',
      sortOrder: 40,
      portalPriceCents: 4500000,
      bookingMode: 'plan_booking',
    });
    const planDed = await upsertPlan(client, dedDesk, {
      plan_slug: 'dedicated-desk-month',
      title: 'Dedicated Desk',
      description: FEAT_SUPER_HOT,
      price_cents: 4500000,
      sort_order: 0,
      duration_value: 1,
      duration_unit: 'month',
      monthly_meeting_credit_minutes: 0,
      weekly_access_sessions: null,
      is_capacity_limited: true,
      plan_kind: 'workspace_month',
    });
    const profDed = await ensureCapacityProfile(client, planDed, { total_units: 8, auto_assign: false, waitlist_enabled: true });
    await ensureUnits(client, profDed, Array.from({ length: 8 }, (_, i) => `Dedicated ${i + 1}`), 'Shared workspace');

    const privateOffice = await upsertService(client, {
      categorySlug: catCore,
      slug: 'private-office',
      name: 'Private Office',
      description: FEAT_PRIVATE,
      sortOrder: 50,
      portalPriceCents: 0,
      bookingMode: 'plan_booking',
    });
    const planPrivS = await upsertPlan(client, privateOffice, {
      plan_slug: 'private-office-small',
      title: 'Small private office',
      description: FEAT_PRIVATE,
      price_cents: 8000000,
      sort_order: 0,
      duration_value: 1,
      duration_unit: 'month',
      monthly_meeting_credit_minutes: 180,
      weekly_access_sessions: null,
      is_capacity_limited: true,
      plan_kind: 'private_office',
    });
    const planPrivM = await upsertPlan(client, privateOffice, {
      plan_slug: 'private-office-medium',
      title: 'Medium private office',
      description: FEAT_PRIVATE,
      price_cents: 15000000,
      sort_order: 1,
      duration_value: 1,
      duration_unit: 'month',
      monthly_meeting_credit_minutes: 180,
      weekly_access_sessions: null,
      is_capacity_limited: true,
      plan_kind: 'private_office',
    });
    const planPrivB = await upsertPlan(client, privateOffice, {
      plan_slug: 'private-office-big',
      title: 'Big private office',
      description: FEAT_PRIVATE,
      price_cents: 16500000,
      sort_order: 2,
      duration_value: 1,
      duration_unit: 'month',
      monthly_meeting_credit_minutes: 180,
      weekly_access_sessions: null,
      is_capacity_limited: true,
      plan_kind: 'private_office',
    });
    for (const p of [
      { id: planPrivS, n: 3, prefix: 'Office' },
      { id: planPrivM, n: 3, prefix: 'Med office' },
      { id: planPrivB, n: 2, prefix: 'Large office' },
    ]) {
      const pr = await ensureCapacityProfile(client, p.id, { total_units: p.n, auto_assign: false, waitlist_enabled: true });
      await ensureUnits(
        client,
        pr,
        Array.from({ length: p.n }, (_, i) => `${p.prefix} ${String.fromCharCode(65 + i)}`),
        'Private wing'
      );
    }

    const conference = await upsertService(client, {
      categorySlug: catCore,
      slug: 'conference-meeting-room',
      name: 'Conference and Meeting Room',
      description: FEAT_CONFERENCE + ' Booked via meeting room calendar — no fixed unit cap.',
      sortOrder: 60,
      portalPriceCents: 0,
      bookingMode: 'request',
    });
    await upsertPlan(client, conference, {
      plan_slug: 'conference-hourly',
      title: 'Conference — hourly',
      description: FEAT_CONFERENCE,
      price_cents: 700000,
      sort_order: 0,
      duration_value: 1,
      duration_unit: 'hour',
      monthly_meeting_credit_minutes: 0,
      weekly_access_sessions: null,
      is_capacity_limited: false,
      plan_kind: 'room_rate',
    });
    await upsertPlan(client, conference, {
      plan_slug: 'conference-full-day',
      title: 'Conference — full day',
      description: FEAT_CONFERENCE,
      price_cents: 5500000,
      sort_order: 1,
      duration_value: 1,
      duration_unit: 'day',
      monthly_meeting_credit_minutes: 0,
      weekly_access_sessions: null,
      is_capacity_limited: false,
      plan_kind: 'room_rate',
    });

    const training = await upsertService(client, {
      categorySlug: catCore,
      slug: 'training-seminar-room',
      name: 'Training and Seminar Room',
      description: FEAT_TRAINING + ' Booked via meeting room calendar.',
      sortOrder: 70,
      portalPriceCents: 0,
      bookingMode: 'request',
    });
    await upsertPlan(client, training, {
      plan_slug: 'training-hourly',
      title: 'Training — hourly',
      description: FEAT_TRAINING,
      price_cents: 2000000,
      sort_order: 0,
      duration_value: 1,
      duration_unit: 'hour',
      monthly_meeting_credit_minutes: 0,
      weekly_access_sessions: null,
      is_capacity_limited: false,
      plan_kind: 'room_rate',
    });
    await upsertPlan(client, training, {
      plan_slug: 'training-full-day',
      title: 'Training — full day',
      description: FEAT_TRAINING,
      price_cents: 16000000,
      sort_order: 1,
      duration_value: 1,
      duration_unit: 'day',
      monthly_meeting_credit_minutes: 0,
      weekly_access_sessions: null,
      is_capacity_limited: false,
      plan_kind: 'room_rate',
    });

    const video = await upsertService(client, {
      categorySlug: catCore,
      slug: 'video-shoot',
      name: 'Video Shoot',
      description: FEAT_VIDEO + ' Booked via meeting room calendar.',
      sortOrder: 80,
      portalPriceCents: 0,
      bookingMode: 'request',
    });
    await upsertPlan(client, video, {
      plan_slug: 'video-shoot-hourly',
      title: 'Video shoot — hourly',
      description: FEAT_VIDEO,
      price_cents: 2000000,
      sort_order: 0,
      duration_value: 1,
      duration_unit: 'hour',
      monthly_meeting_credit_minutes: 0,
      weekly_access_sessions: null,
      is_capacity_limited: false,
      plan_kind: 'room_rate',
    });

    const virtual = await upsertService(client, {
      categorySlug: catVirt,
      slug: 'virtual-office',
      name: 'Virtual Office',
      description: 'Virtual and remote business presence at EmergeHub.',
      sortOrder: 5,
      portalPriceCents: 0,
      bookingMode: 'plan_booking',
    });
    const planVirtStd = await upsertPlan(client, virtual, {
      plan_slug: 'virtual-standard-year',
      title: 'Standard Virtual Office',
      description: FEAT_VIRTUAL_STD,
      price_cents: 15000000,
      sort_order: 0,
      duration_value: 12,
      duration_unit: 'month',
      monthly_meeting_credit_minutes: 480,
      weekly_access_sessions: null,
      is_capacity_limited: false,
      plan_kind: 'virtual',
    });
    const planVirtEnt = await upsertPlan(client, virtual, {
      plan_slug: 'virtual-enterprise-year',
      title: 'Enterprise Virtual Office',
      description: FEAT_VIRTUAL_ENT,
      price_cents: 18000000,
      sort_order: 1,
      duration_value: 12,
      duration_unit: 'month',
      monthly_meeting_credit_minutes: 960,
      weekly_access_sessions: null,
      is_capacity_limited: false,
      plan_kind: 'virtual',
    });

    await upsertMeetingRoom(client, {
      slug: 'conference-hourly',
      name: 'Conference / meeting room (hourly)',
      description: 'Hourly booking — credits apply when your plan includes meeting room hours.',
      capacity: 20,
      hourly_rate_cents: 700000,
      full_day_rate_cents: null,
      room_product_kind: 'conference',
      consumes_plan_credits: true,
      sort_order: 10,
    });
    await upsertMeetingRoom(client, {
      slug: 'conference-full-day',
      name: 'Conference / meeting room (full day)',
      description: 'Full-day flat rate for the hub day.',
      capacity: 20,
      hourly_rate_cents: 0,
      full_day_rate_cents: 5500000,
      room_product_kind: 'conference',
      consumes_plan_credits: true,
      sort_order: 11,
    });
    await upsertMeetingRoom(client, {
      slug: 'training-hourly',
      name: 'Training and seminar room (hourly)',
      description: FEAT_TRAINING,
      capacity: 30,
      hourly_rate_cents: 2000000,
      full_day_rate_cents: null,
      room_product_kind: 'training',
      consumes_plan_credits: true,
      sort_order: 20,
    });
    await upsertMeetingRoom(client, {
      slug: 'training-full-day',
      name: 'Training and seminar room (full day)',
      description: FEAT_TRAINING,
      capacity: 30,
      hourly_rate_cents: 0,
      full_day_rate_cents: 16000000,
      room_product_kind: 'training',
      consumes_plan_credits: true,
      sort_order: 21,
    });
    await upsertMeetingRoom(client, {
      slug: 'video-shoot',
      name: 'Video shoot space',
      description: FEAT_VIDEO,
      capacity: 8,
      hourly_rate_cents: 2000000,
      full_day_rate_cents: null,
      room_product_kind: 'video_shoot',
      consumes_plan_credits: false,
      sort_order: 30,
    });

    await client.query(
      `UPDATE meeting_rooms SET slug = COALESCE(nullif(trim(slug),''), 'main-meeting-room'), hourly_rate_cents = 1500000,
         full_day_rate_cents = NULL, room_product_kind = 'conference', consumes_plan_credits = true
       WHERE deleted_at IS NULL AND slug IS NULL AND name ILIKE '%main%meeting%'`
    );

    try {
      await linkTierToPlanByName(client, '%hot%desk%', planHot);
      await linkTierToPlanByName(client, '%super%desk%', planSuper);
      await linkTierToPlanByName(client, '%dedicated%', planDed);
      await linkTierToPlanByName(client, '%daily%', planDaily);
    } catch (e) {
      console.warn('membership_tiers link skipped:', e.message);
    }

    await client.query('COMMIT');
    console.log('seed-price-schedule: OK');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('seed-price-schedule failed:', e);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
