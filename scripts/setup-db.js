/**
 * Idempotent portal schema for database emergehub_website.
 * Safe to re-run: CREATE IF NOT EXISTS only; does not alter legacy tables.
 */
require('dotenv').config();
const { pool } = require('../lib/db');

const statements = [
  `CREATE EXTENSION IF NOT EXISTS "pgcrypto";`,

  `CREATE TABLE IF NOT EXISTS member_sessions (
    sid varchar NOT NULL COLLATE "default",
    sess json NOT NULL,
    expire timestamp(6) NOT NULL,
    PRIMARY KEY (sid)
  );`,

  `CREATE TABLE IF NOT EXISTS portal_admin_sessions (
    sid varchar NOT NULL COLLATE "default",
    sess json NOT NULL,
    expire timestamp(6) NOT NULL,
    PRIMARY KEY (sid)
  );`,

  `CREATE INDEX IF NOT EXISTS IDX_session_expire ON member_sessions (expire);`,
  `CREATE INDEX IF NOT EXISTS IDX_admin_session_expire ON portal_admin_sessions (expire);`,

  `CREATE TABLE IF NOT EXISTS portal_admin_users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username text NOT NULL UNIQUE,
    email text NOT NULL,
    password_hash text NOT NULL,
    must_change_password boolean NOT NULL DEFAULT false,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );`,

  `CREATE TABLE IF NOT EXISTS members (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL,
    password_hash text NOT NULL,
    full_name text NOT NULL,
    phone text NOT NULL,
    business_name text,
    business_type text,
    cac_number text,
    industry text,
    website text,
    profile_photo_path text,
    email_verified_at timestamptz,
    email_verification_token text,
    email_verification_expires timestamptz,
    password_reset_token text,
    password_reset_expires timestamptz,
    suspended_at timestamptz,
    internal_notes text,
    notify_email_invoice boolean NOT NULL DEFAULT true,
    notify_email_service boolean NOT NULL DEFAULT true,
    notify_email_support boolean NOT NULL DEFAULT true,
    notify_email_announcements boolean NOT NULL DEFAULT true,
    notify_sms boolean NOT NULL DEFAULT false,
    phone_verified_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );`,

  `CREATE UNIQUE INDEX IF NOT EXISTS members_email_lower_active_idx
     ON members (lower(email)) WHERE deleted_at IS NULL;`,

  `CREATE TABLE IF NOT EXISTS member_tracked_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    session_sid varchar NOT NULL,
    user_agent text,
    ip_address text,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (session_sid)
  );`,

  `CREATE TABLE IF NOT EXISTS member_plans (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    tier_id integer NOT NULL REFERENCES membership_tiers(id),
    status text NOT NULL DEFAULT 'active',
    monthly_or_annual text,
    desk_or_office text,
    started_at date NOT NULL,
    renewal_at date,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );`,

  `CREATE TABLE IF NOT EXISTS member_plan_history (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    tier_id integer REFERENCES membership_tiers(id),
    status text NOT NULL,
    note text,
    started_at date,
    ended_at date,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );`,

  `CREATE TABLE IF NOT EXISTS support_tickets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    subject text NOT NULL,
    category text NOT NULL,
    status text NOT NULL DEFAULT 'Open',
    assigned_admin_id uuid REFERENCES portal_admin_users(id),
    resolved_at timestamptz,
    last_member_reopen_deadline timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );`,

  `CREATE TABLE IF NOT EXISTS service_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    service_id integer NOT NULL REFERENCES services(id),
    title text,
    description text NOT NULL,
    detail_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'Submitted',
    action_required_member boolean NOT NULL DEFAULT false,
    assigned_admin_id uuid REFERENCES portal_admin_users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );`,

  `CREATE TABLE IF NOT EXISTS member_documents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    uploaded_by_type text NOT NULL,
    uploaded_by_member_id uuid REFERENCES members(id),
    uploaded_by_admin_id uuid REFERENCES portal_admin_users(id),
    service_request_id uuid REFERENCES service_requests(id),
    support_ticket_id uuid REFERENCES support_tickets(id),
    original_name text NOT NULL,
    storage_path text NOT NULL,
    mime_type text NOT NULL,
    size_bytes bigint NOT NULL,
    category text NOT NULL DEFAULT 'general',
    is_admin_shared boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );`,

  `CREATE TABLE IF NOT EXISTS invoices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    invoice_number text NOT NULL,
    status text NOT NULL DEFAULT 'unpaid',
    currency text NOT NULL DEFAULT 'NGN',
    subtotal_cents bigint NOT NULL DEFAULT 0,
    total_cents bigint NOT NULL DEFAULT 0,
    due_date date NOT NULL,
    notes text,
    bank_proof_document_id uuid REFERENCES member_documents(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CONSTRAINT invoices_number_unique UNIQUE (invoice_number)
  );`,

  `CREATE TABLE IF NOT EXISTS invoice_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    description text NOT NULL,
    amount_cents bigint NOT NULL DEFAULT 0,
    sort_order int NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );`,

  `CREATE TABLE IF NOT EXISTS payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    amount_cents bigint NOT NULL,
    method text NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    paystack_reference text,
    paystack_access_code text,
    receipt_number text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );`,
  `ALTER TABLE payments ADD COLUMN IF NOT EXISTS deleted_at timestamptz;`,

  `CREATE TABLE IF NOT EXISTS service_request_updates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    service_request_id uuid NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
    stage text NOT NULL,
    note text,
    visible_to_member boolean NOT NULL DEFAULT true,
    created_by_admin_id uuid REFERENCES portal_admin_users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );`,

  `CREATE TABLE IF NOT EXISTS service_request_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    service_request_id uuid NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
    sender_type text NOT NULL,
    member_id uuid REFERENCES members(id),
    admin_id uuid REFERENCES portal_admin_users(id),
    body text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );`,

  `CREATE TABLE IF NOT EXISTS support_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    sender_type text NOT NULL,
    member_id uuid REFERENCES members(id),
    admin_id uuid REFERENCES portal_admin_users(id),
    body text NOT NULL,
    internal_note boolean NOT NULL DEFAULT false,
    attachment_document_id uuid REFERENCES member_documents(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );`,

  `CREATE TABLE IF NOT EXISTS meeting_room_bookings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    room_name text NOT NULL,
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL,
    purpose text,
    status text NOT NULL DEFAULT 'pending',
    admin_note text,
    created_by_admin boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );`,

  `CREATE TABLE IF NOT EXISTS member_notifications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    title text NOT NULL,
    message text NOT NULL,
    link_url text,
    read_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );`,
  `ALTER TABLE member_notifications ADD COLUMN IF NOT EXISTS deleted_at timestamptz;`,

  `CREATE TABLE IF NOT EXISTS portal_settings (
    key text PRIMARY KEY,
    value text,
    updated_at timestamptz NOT NULL DEFAULT now()
  );`,

  `CREATE TABLE IF NOT EXISTS portal_activity_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id uuid REFERENCES members(id) ON DELETE CASCADE,
    event_type text NOT NULL,
    title text NOT NULL,
    body text,
    entity_type text,
    entity_id uuid,
    created_at timestamptz NOT NULL DEFAULT now()
  );`,

  `CREATE INDEX IF NOT EXISTS idx_member_plans_member ON member_plans(member_id) WHERE deleted_at IS NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_service_requests_member ON service_requests(member_id) WHERE deleted_at IS NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_invoices_member ON invoices(member_id) WHERE deleted_at IS NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_support_member ON support_tickets(member_id) WHERE deleted_at IS NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_member ON member_notifications(member_id) WHERE deleted_at IS NULL AND read_at IS NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_activity_member ON portal_activity_events(member_id, created_at DESC);`,

  /* Extend shared catalogue: portal-managed price (NGN minor units). Safe if column exists. */
  `ALTER TABLE services ADD COLUMN IF NOT EXISTS portal_price_cents bigint NOT NULL DEFAULT 0;`,

  /* Link service request → auto-generated invoice */
  `ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS invoice_id uuid REFERENCES invoices(id);`,
  `CREATE INDEX IF NOT EXISTS idx_service_requests_invoice ON service_requests(invoice_id) WHERE deleted_at IS NULL AND invoice_id IS NOT NULL;`,

  `ALTER TABLE services ADD COLUMN IF NOT EXISTS portal_active boolean NOT NULL DEFAULT true;`,
  `ALTER TABLE services ADD COLUMN IF NOT EXISTS booking_mode text NOT NULL DEFAULT 'request';`,
  `ALTER TABLE services ADD COLUMN IF NOT EXISTS deleted_at timestamptz;`,

  `CREATE TABLE IF NOT EXISTS service_plans (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id integer NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    title text NOT NULL,
    description text NOT NULL DEFAULT '',
    price_cents bigint NOT NULL DEFAULT 0,
    sort_order int NOT NULL DEFAULT 0,
    active boolean NOT NULL DEFAULT true,
    duration_value integer,
    duration_unit text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );`,
  `CREATE INDEX IF NOT EXISTS idx_service_plans_service ON service_plans(service_id) WHERE deleted_at IS NULL;`,
  `ALTER TABLE service_plans ADD COLUMN IF NOT EXISTS duration_value integer;`,
  `ALTER TABLE service_plans ADD COLUMN IF NOT EXISTS duration_unit text;`,

  `ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS service_plan_id uuid REFERENCES service_plans(id) ON DELETE SET NULL;`,
  `ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS access_started_at timestamptz;`,
  `ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS access_ends_at timestamptz;`,

  `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS service_request_id uuid REFERENCES service_requests(id);`,
  `CREATE INDEX IF NOT EXISTS idx_invoices_service_request ON invoices(service_request_id) WHERE deleted_at IS NULL AND service_request_id IS NOT NULL;`,

  `ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS service_start_date date;`,
  `ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS service_end_date date;`,

  `CREATE TABLE IF NOT EXISTS meeting_rooms (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    capacity int NOT NULL DEFAULT 1,
    hourly_rate_cents bigint NOT NULL DEFAULT 0,
    amenities jsonb NOT NULL DEFAULT '[]'::jsonb,
    active boolean NOT NULL DEFAULT true,
    sort_order int NOT NULL DEFAULT 0,
    photo_path text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );`,
  `CREATE INDEX IF NOT EXISTS idx_meeting_rooms_active ON meeting_rooms(active, sort_order) WHERE deleted_at IS NULL;`,

  `CREATE TABLE IF NOT EXISTS room_availability_schedule (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_room_id uuid NOT NULL REFERENCES meeting_rooms(id) ON DELETE CASCADE,
    weekday int NOT NULL CHECK (weekday >= 0 AND weekday <= 6),
    is_open boolean NOT NULL DEFAULT true,
    opens_at time,
    closes_at time,
    effective_from date NOT NULL DEFAULT CURRENT_DATE,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );`,
  `CREATE INDEX IF NOT EXISTS idx_room_availability_room ON room_availability_schedule(meeting_room_id) WHERE deleted_at IS NULL;`,

  `CREATE TABLE IF NOT EXISTS room_blocked_slots (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_room_id uuid NOT NULL REFERENCES meeting_rooms(id) ON DELETE CASCADE,
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL,
    reason text,
    internal_note text,
    member_id uuid REFERENCES members(id) ON DELETE SET NULL,
    created_by_admin_id uuid REFERENCES portal_admin_users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );`,
  `CREATE INDEX IF NOT EXISTS idx_room_blocks_room_time ON room_blocked_slots(meeting_room_id, starts_at, ends_at) WHERE deleted_at IS NULL;`,

  `CREATE TABLE IF NOT EXISTS room_discount_tiers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_room_id uuid REFERENCES meeting_rooms(id) ON DELETE CASCADE,
    min_hours int NOT NULL DEFAULT 1,
    discount_percent numeric(8,2) NOT NULL DEFAULT 0,
    label text,
    active boolean NOT NULL DEFAULT true,
    sort_order int NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );`,
  `CREATE INDEX IF NOT EXISTS idx_room_discount_tiers ON room_discount_tiers(meeting_room_id, active) WHERE deleted_at IS NULL;`,

  `CREATE TABLE IF NOT EXISTS room_bookings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_room_id uuid NOT NULL REFERENCES meeting_rooms(id) ON DELETE CASCADE,
    member_id uuid REFERENCES members(id) ON DELETE CASCADE,
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL,
    status text NOT NULL DEFAULT 'pending_payment',
    invoice_id uuid REFERENCES invoices(id) ON DELETE SET NULL,
    booking_reference text NOT NULL UNIQUE,
    purpose text,
    base_cents bigint NOT NULL DEFAULT 0,
    discount_cents bigint NOT NULL DEFAULT 0,
    total_cents bigint NOT NULL DEFAULT 0,
    discount_tier_id uuid REFERENCES room_discount_tiers(id) ON DELETE SET NULL,
    duration_minutes int NOT NULL DEFAULT 0,
    payment_deadline_at timestamptz,
    payment_warning_sent boolean NOT NULL DEFAULT false,
    cancelled_at timestamptz,
    cancellation_reason text,
    created_by_admin boolean NOT NULL DEFAULT false,
    admin_note text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );`,
  `CREATE INDEX IF NOT EXISTS idx_room_bookings_room_time ON room_bookings(meeting_room_id, starts_at, ends_at) WHERE deleted_at IS NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_room_bookings_member ON room_bookings(member_id) WHERE deleted_at IS NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_room_bookings_invoice ON room_bookings(invoice_id) WHERE deleted_at IS NULL AND invoice_id IS NOT NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_room_bookings_pending ON room_bookings(payment_deadline_at) WHERE deleted_at IS NULL AND status = 'pending_payment';`,

  `CREATE TABLE IF NOT EXISTS invoice_service_links (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    service_request_id uuid NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
    description text,
    amount_cents bigint NOT NULL DEFAULT 0,
    sort_order int NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_service_links_unique
     ON invoice_service_links(invoice_id, service_request_id) WHERE deleted_at IS NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_invoice_service_links_invoice ON invoice_service_links(invoice_id) WHERE deleted_at IS NULL;`,

  `CREATE TABLE IF NOT EXISTS credit_notes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    source_invoice_id uuid REFERENCES invoices(id) ON DELETE SET NULL,
    room_booking_id uuid REFERENCES room_bookings(id) ON DELETE SET NULL,
    amount_cents bigint NOT NULL,
    reason text,
    created_by_admin_id uuid REFERENCES portal_admin_users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );`,
  `CREATE INDEX IF NOT EXISTS idx_credit_notes_member ON credit_notes(member_id) WHERE deleted_at IS NULL;`,

  `CREATE TABLE IF NOT EXISTS service_request_reminders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    service_request_id uuid NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
    remind_at date NOT NULL,
    reminder_type text NOT NULL DEFAULT 'service_end',
    sent_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );`,
  `CREATE INDEX IF NOT EXISTS idx_sr_reminders_due ON service_request_reminders(remind_at) WHERE deleted_at IS NULL AND sent_at IS NULL;`,

  /* Service plans — credits, capacity flags, marketing copy */
  `ALTER TABLE service_plans ADD COLUMN IF NOT EXISTS monthly_meeting_credit_minutes int NOT NULL DEFAULT 0;`,
  `ALTER TABLE service_plans ADD COLUMN IF NOT EXISTS weekly_access_sessions int;`,
  `ALTER TABLE service_plans ADD COLUMN IF NOT EXISTS is_capacity_limited boolean NOT NULL DEFAULT false;`,
  `ALTER TABLE service_plans ADD COLUMN IF NOT EXISTS plan_kind text;`,
  `ALTER TABLE service_plans ADD COLUMN IF NOT EXISTS features_json jsonb NOT NULL DEFAULT '{}'::jsonb;`,
  `ALTER TABLE service_plans ADD COLUMN IF NOT EXISTS plan_slug text;`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_service_plans_plan_slug
     ON service_plans (service_id, lower(trim(plan_slug))) WHERE deleted_at IS NULL AND plan_slug IS NOT NULL AND trim(plan_slug) <> '';`,

  /* Meeting rooms — full-day rate, credit eligibility, stable seed slug */
  `ALTER TABLE meeting_rooms ADD COLUMN IF NOT EXISTS full_day_rate_cents bigint;`,
  `ALTER TABLE meeting_rooms ADD COLUMN IF NOT EXISTS room_product_kind text;`,
  `ALTER TABLE meeting_rooms ADD COLUMN IF NOT EXISTS consumes_plan_credits boolean NOT NULL DEFAULT true;`,
  `ALTER TABLE meeting_rooms ADD COLUMN IF NOT EXISTS slug text;`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_meeting_rooms_slug_live
     ON meeting_rooms (lower(trim(slug))) WHERE deleted_at IS NULL AND slug IS NOT NULL AND trim(slug) <> '';`,

  /* Room bookings — plan credits applied to invoice */
  `ALTER TABLE room_bookings ADD COLUMN IF NOT EXISTS credit_minutes_applied int NOT NULL DEFAULT 0;`,
  `ALTER TABLE room_bookings ADD COLUMN IF NOT EXISTS payable_cents bigint NOT NULL DEFAULT 0;`,
  `ALTER TABLE room_bookings ADD COLUMN IF NOT EXISTS credit_value_cents bigint NOT NULL DEFAULT 0;`,
  `ALTER TABLE room_bookings ADD COLUMN IF NOT EXISTS credit_period_month date;`,

  `ALTER TABLE member_plans ADD COLUMN IF NOT EXISTS space_unit_id uuid;`,

  `CREATE TABLE IF NOT EXISTS plan_capacity_profiles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    service_plan_id uuid REFERENCES service_plans(id) ON DELETE CASCADE,
    membership_tier_id int REFERENCES membership_tiers(id) ON DELETE SET NULL,
    total_units int NOT NULL DEFAULT 0,
    auto_assign boolean NOT NULL DEFAULT false,
    waitlist_enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_capacity_profiles_sp
     ON plan_capacity_profiles(service_plan_id) WHERE deleted_at IS NULL AND service_plan_id IS NOT NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_plan_capacity_profiles_tier
     ON plan_capacity_profiles(membership_tier_id) WHERE deleted_at IS NULL;`,

  `CREATE TABLE IF NOT EXISTS space_units (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id uuid NOT NULL REFERENCES plan_capacity_profiles(id) ON DELETE CASCADE,
    label text NOT NULL,
    location_note text,
    status text NOT NULL DEFAULT 'available',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );`,
  `CREATE INDEX IF NOT EXISTS idx_space_units_profile ON space_units(profile_id) WHERE deleted_at IS NULL;`,

  `CREATE TABLE IF NOT EXISTS member_space_assignments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    unit_id uuid NOT NULL REFERENCES space_units(id) ON DELETE CASCADE,
    member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    started_at date NOT NULL,
    ends_at date,
    assignment_type text NOT NULL DEFAULT 'ongoing',
    source_service_request_id uuid REFERENCES service_requests(id) ON DELETE SET NULL,
    source_invoice_id uuid REFERENCES invoices(id) ON DELETE SET NULL,
    ended_at timestamptz,
    ended_reason text,
    ends_reminder_sent_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );`,
  `CREATE INDEX IF NOT EXISTS idx_msa_unit_open ON member_space_assignments(unit_id) WHERE deleted_at IS NULL AND ended_at IS NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_msa_member_open ON member_space_assignments(member_id) WHERE deleted_at IS NULL AND ended_at IS NULL;`,

  `CREATE TABLE IF NOT EXISTS plan_waitlist_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id uuid NOT NULL REFERENCES plan_capacity_profiles(id) ON DELETE CASCADE,
    member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    joined_at timestamptz NOT NULL DEFAULT now(),
    status text NOT NULL DEFAULT 'waiting',
    offer_expires_at timestamptz,
    offer_token uuid DEFAULT gen_random_uuid(),
    sort_key bigint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );`,
  `CREATE INDEX IF NOT EXISTS idx_waitlist_profile_status ON plan_waitlist_entries(profile_id, status) WHERE deleted_at IS NULL;`,

  `CREATE TABLE IF NOT EXISTS member_meeting_credit_ledger (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    period_month date NOT NULL,
    granted_minutes int NOT NULL DEFAULT 0,
    used_minutes int NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(member_id, period_month)
  );`,
  `CREATE INDEX IF NOT EXISTS idx_credit_ledger_member_period ON member_meeting_credit_ledger(member_id, period_month);`,

  `CREATE TABLE IF NOT EXISTS meeting_credit_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    period_month date NOT NULL,
    delta_granted int NOT NULL DEFAULT 0,
    delta_used int NOT NULL DEFAULT 0,
    reason text,
    room_booking_id uuid REFERENCES room_bookings(id) ON DELETE SET NULL,
    admin_id uuid REFERENCES portal_admin_users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );`,
  `CREATE INDEX IF NOT EXISTS idx_meeting_credit_events_member ON meeting_credit_events(member_id, created_at DESC);`,

  `ALTER TABLE membership_tiers ADD COLUMN IF NOT EXISTS service_plan_id uuid REFERENCES service_plans(id) ON DELETE SET NULL;`,
  `DO $$ BEGIN
     ALTER TABLE member_plans
       ADD CONSTRAINT member_plans_space_unit_id_fkey
       FOREIGN KEY (space_unit_id) REFERENCES space_units(id) ON DELETE SET NULL;
   EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
];

async function seedAdminAndSettings(client) {
  const bcrypt = require('bcryptjs');
  const hash = bcrypt.hashSync('Admin1234', 10);

  await client.query(
    `INSERT INTO portal_admin_users (username, email, password_hash, must_change_password, active)
     VALUES ('admin', 'admin@emergehub.com.ng', $1, true, true)
     ON CONFLICT (username) DO NOTHING`,
    [hash]
  );

  const defaults = [
    ['bank_name', ''],
    ['account_name', 'EmergeHub'],
    ['account_number', ''],
    ['default_invoice_due_days', '7'],
    [
      'meeting_room_names',
      JSON.stringify(['Main Conference Room', 'Training Space']),
    ],
    [
      'meeting_room_hours',
      '8:00am to 5:00pm Monday to Friday, 8:00am to 5:00pm Saturday',
    ],
    ['paystack_public_key', ''],
    ['paystack_secret_key', ''],
    ['turnaround_json', '{}'],
  ];

  for (const [k, v] of defaults) {
    await client.query(
      `INSERT INTO portal_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO NOTHING`,
      [k, v]
    );
  }
}

async function seedMeetingRoomsDefault(client) {
  const { rows } = await client.query(
    `SELECT id FROM meeting_rooms WHERE deleted_at IS NULL LIMIT 1`
  );
  if (rows[0]) return;
  const { rows: ins } = await client.query(
    `INSERT INTO meeting_rooms (name, description, capacity, hourly_rate_cents, active, sort_order)
     VALUES (
       'Main meeting room',
       'Demo room for the portal — edit hours, pricing, and blocks in Admin.',
       10,
       1500000,
       true,
       0
     )
     RETURNING id`
  );
  const rid = ins[0].id;
  for (const wd of [1, 2, 3, 4, 5]) {
    await client.query(
      `INSERT INTO room_availability_schedule (meeting_room_id, weekday, is_open, opens_at, closes_at, effective_from)
       VALUES ($1::uuid, $2, true, '09:00'::time, '18:00'::time, CURRENT_DATE)`,
      [rid, wd]
    );
  }
  await client.query(
    `INSERT INTO room_discount_tiers (meeting_room_id, min_hours, discount_percent, label, active, sort_order)
     VALUES (NULL, 2, 10.00, '2+ hours — 10%', true, 0)`
  );
}

async function seedCoreWorkspaceDefaults(client) {
  await client.query(
    `INSERT INTO services (category_id, slug, name, description, sort_order, portal_price_cents, portal_active, booking_mode)
     SELECT c.id, 'daily-access', 'Daily access',
       'Single-day access to the core shared workspace during hub opening hours.',
       5, 0, true, 'plan_booking'
     FROM service_categories c WHERE c.slug = 'core-workspace' LIMIT 1
     ON CONFLICT (category_id, slug) DO NOTHING`
  );
  const { rows } = await client.query(
    `SELECT s.id FROM services s
     JOIN service_categories c ON c.id = s.category_id
     WHERE c.slug = 'core-workspace' AND s.slug = 'daily-access' LIMIT 1`
  );
  if (!rows[0]) return;
  const sid = rows[0].id;
  const { rows: cnt } = await client.query(
    `SELECT COUNT(*)::int AS n FROM service_plans WHERE service_id = $1 AND deleted_at IS NULL`,
    [sid]
  );
  if (cnt[0].n === 0) {
    await client.query(
      `INSERT INTO service_plans (service_id, title, description, price_cents, sort_order, active, duration_value, duration_unit)
       VALUES ($1, 'Full day pass', 'Use of shared workspace for one calendar day during opening hours.', 1000000, 0, true, 1, 'day')`,
      [sid]
    );
  }
  await client.query(
    `UPDATE service_plans sp SET duration_value = 1, duration_unit = 'day', updated_at = now()
     WHERE sp.service_id = $1 AND sp.deleted_at IS NULL
       AND (sp.duration_value IS NULL OR sp.duration_value <= 0 OR sp.duration_unit IS NULL OR trim(sp.duration_unit) = '')`,
    [sid]
  );
}

async function main() {
  const client = await pool.connect();
  try {
    for (const sql of statements) {
      await client.query(sql);
    }
    await seedAdminAndSettings(client);
    await seedCoreWorkspaceDefaults(client);
    await seedMeetingRoomsDefault(client);
    console.log('setup-db: completed successfully');
  } catch (e) {
    console.error('setup-db failed:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
