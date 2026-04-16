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

async function main() {
  const client = await pool.connect();
  try {
    for (const sql of statements) {
      await client.query(sql);
    }
    await seedAdminAndSettings(client);
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
