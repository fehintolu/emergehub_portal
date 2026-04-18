const { pool } = require('./db');
const { portalTz } = require('./roomQuote');

function hubTz() {
  return portalTz();
}

/**
 * First calendar day of current month in hub timezone (date only).
 * @param {import('pg').PoolClient | import('pg').Pool} q
 */
async function currentPeriodMonthDate(q) {
  const { rows } = await q.query(
    `SELECT (date_trunc('month', timezone($1::text, now())))::date AS d`,
    [hubTz()]
  );
  return rows[0].d;
}

/**
 * Monthly meeting credit allowance (minutes) from active member plan or paid access SR.
 */
async function getMonthlyCreditAllowanceMinutes(q, memberId) {
  const { rows: r1 } = await q.query(
    `SELECT sp.monthly_meeting_credit_minutes AS m
     FROM member_plans mp
     JOIN membership_tiers mt ON mt.id = mp.tier_id
     LEFT JOIN service_plans sp ON sp.id = mt.service_plan_id AND sp.deleted_at IS NULL
     WHERE mp.member_id = $1::uuid AND mp.deleted_at IS NULL AND mp.status = 'active'
       AND COALESCE(sp.monthly_meeting_credit_minutes, 0) > 0
     ORDER BY mp.started_at DESC
     LIMIT 1`,
    [memberId]
  );
  if (r1[0] && Number(r1[0].m) > 0) return Number(r1[0].m);

  const { rows: r2 } = await q.query(
    `SELECT sp.monthly_meeting_credit_minutes AS m
     FROM service_requests sr
     JOIN service_plans sp ON sp.id = sr.service_plan_id AND sp.deleted_at IS NULL
     JOIN invoices inv ON inv.id = sr.invoice_id AND inv.deleted_at IS NULL AND inv.status = 'paid'
     WHERE sr.member_id = $1::uuid AND sr.deleted_at IS NULL
       AND COALESCE(sr.access_ends_at, now() + interval '10 years') > now()
       AND COALESCE(sp.monthly_meeting_credit_minutes, 0) > 0
     ORDER BY sr.updated_at DESC NULLS LAST
     LIMIT 1`,
    [memberId]
  );
  if (r2[0] && Number(r2[0].m) > 0) return Number(r2[0].m);
  return 0;
}

async function getLedgerRow(q, memberId, periodMonthDate) {
  const { rows } = await q.query(
    `SELECT * FROM member_meeting_credit_ledger
     WHERE member_id = $1::uuid AND period_month = $2::date`,
    [memberId, periodMonthDate]
  );
  return rows[0] || null;
}

/**
 * Remaining credit minutes this month (0 if none).
 */
async function getAvailableCreditMinutes(q, memberId) {
  const pm = await currentPeriodMonthDate(q);
  const allowance = await getMonthlyCreditAllowanceMinutes(q, memberId);
  if (allowance <= 0) return { available: 0, granted: 0, used: 0, period_month: pm };
  let row = await getLedgerRow(q, memberId, pm);
  if (!row) {
    await q.query(
      `INSERT INTO member_meeting_credit_ledger (member_id, period_month, granted_minutes, used_minutes)
       VALUES ($1::uuid, $2::date, $3, 0)
       ON CONFLICT (member_id, period_month) DO NOTHING`,
      [memberId, pm, allowance]
    );
    row = await getLedgerRow(q, memberId, pm);
  }
  const granted = Number(row.granted_minutes) || 0;
  const used = Number(row.used_minutes) || 0;
  const available = Math.max(0, granted - used);
  return { available, granted, used, period_month: pm };
}

/**
 * Lock ledger row and return available minutes (FOR UPDATE).
 */
async function lockAvailableCreditMinutes(q, memberId) {
  const pm = await currentPeriodMonthDate(q);
  const allowance = await getMonthlyCreditAllowanceMinutes(q, memberId);
  if (allowance <= 0) return { available: 0, granted: 0, used: 0, period_month: pm };

  await q.query(
    `INSERT INTO member_meeting_credit_ledger (member_id, period_month, granted_minutes, used_minutes)
     VALUES ($1::uuid, $2::date, $3, 0)
     ON CONFLICT (member_id, period_month) DO UPDATE
       SET granted_minutes = GREATEST(member_meeting_credit_ledger.granted_minutes, EXCLUDED.granted_minutes),
           updated_at = now()`,
    [memberId, pm, allowance]
  );

  const { rows } = await q.query(
    `SELECT * FROM member_meeting_credit_ledger
     WHERE member_id = $1::uuid AND period_month = $2::date
     FOR UPDATE`,
    [memberId, pm]
  );
  const row = rows[0];
  const granted = Number(row.granted_minutes) || 0;
  const used = Number(row.used_minutes) || 0;
  return { available: Math.max(0, granted - used), granted, used, period_month: pm, ledgerId: row.id };
}

async function addUsedMinutes(q, memberId, periodMonthDate, minutes, reason, roomBookingId) {
  if (minutes <= 0) return;
  await q.query(
    `UPDATE member_meeting_credit_ledger SET used_minutes = used_minutes + $3, updated_at = now()
     WHERE member_id = $1::uuid AND period_month = $2::date`,
    [memberId, periodMonthDate, minutes]
  );
  await q.query(
    `INSERT INTO meeting_credit_events (member_id, period_month, delta_granted, delta_used, reason, room_booking_id)
     VALUES ($1::uuid, $2::date, 0, $3, $4, $5::uuid)`,
    [memberId, periodMonthDate, minutes, reason, roomBookingId]
  );
}

async function releaseUsedMinutes(q, memberId, periodMonthDate, minutes, reason, roomBookingId) {
  if (minutes <= 0) return;
  await q.query(
    `UPDATE member_meeting_credit_ledger SET used_minutes = GREATEST(0, used_minutes - $3), updated_at = now()
     WHERE member_id = $1::uuid AND period_month = $2::date`,
    [memberId, periodMonthDate, minutes]
  );
  await q.query(
    `INSERT INTO meeting_credit_events (member_id, period_month, delta_granted, delta_used, reason, room_booking_id)
     VALUES ($1::uuid, $2::date, 0, $3, $4, $5::uuid)`,
    [memberId, periodMonthDate, -minutes, reason, roomBookingId]
  );
}

/**
 * Apply proportional plan credits to a monetary quote (after volume discount).
 * @returns {{ credit_minutes_used: number, credit_value_cents: number, payable_cents: number }}
 */
function splitQuoteWithCredits(totalCents, durationMinutes, creditMinutesAvailable, consumesCredits) {
  const dm = Math.max(1, Math.floor(Number(durationMinutes) || 0));
  const total = Math.max(0, Math.floor(Number(totalCents) || 0));
  if (!consumesCredits || creditMinutesAvailable <= 0) {
    return { credit_minutes_used: 0, credit_value_cents: 0, payable_cents: total };
  }
  const useMin = Math.min(dm, Math.floor(creditMinutesAvailable));
  if (useMin <= 0) {
    return { credit_minutes_used: 0, credit_value_cents: 0, payable_cents: total };
  }
  const creditValue = Math.round((total * useMin) / dm);
  const payable = Math.max(0, total - creditValue);
  return {
    credit_minutes_used: useMin,
    credit_value_cents: creditValue,
    payable_cents: payable,
  };
}

/**
 * Monthly reset: set granted for all members with allowance > 0 for the new month.
 */
async function runMonthlyCreditReset(q) {
  const { rows: pmRow } = await q.query(
    `SELECT (date_trunc('month', timezone($1::text, now())))::date AS d`,
    [hubTz()]
  );
  const pm = pmRow[0].d;

  const { rows: members } = await q.query(
    `SELECT DISTINCT m.id AS member_id
     FROM members m
     WHERE m.deleted_at IS NULL
       AND (
         EXISTS (
           SELECT 1 FROM member_plans mp
           JOIN membership_tiers mt ON mt.id = mp.tier_id
           LEFT JOIN service_plans sp ON sp.id = mt.service_plan_id
           WHERE mp.member_id = m.id AND mp.deleted_at IS NULL AND mp.status = 'active'
             AND COALESCE(sp.monthly_meeting_credit_minutes, 0) > 0
         )
         OR EXISTS (
           SELECT 1 FROM service_requests sr
           JOIN service_plans sp ON sp.id = sr.service_plan_id
           JOIN invoices inv ON inv.id = sr.invoice_id AND inv.status = 'paid' AND inv.deleted_at IS NULL
           WHERE sr.member_id = m.id AND sr.deleted_at IS NULL
             AND COALESCE(sr.access_ends_at, now() + interval '1 day') > now()
             AND COALESCE(sp.monthly_meeting_credit_minutes, 0) > 0
         )
       )`
  );

  for (const { member_id } of members) {
    const allowance = await getMonthlyCreditAllowanceMinutes(q, member_id);
    if (allowance <= 0) continue;
    await q.query(
      `INSERT INTO member_meeting_credit_ledger (member_id, period_month, granted_minutes, used_minutes)
       VALUES ($1::uuid, $2::date, $3, 0)
       ON CONFLICT (member_id, period_month) DO UPDATE
         SET granted_minutes = EXCLUDED.granted_minutes,
             used_minutes = 0,
             updated_at = now()`,
      [member_id, pm, allowance]
    );
    await q.query(
      `INSERT INTO meeting_credit_events (member_id, period_month, delta_granted, delta_used, reason)
       VALUES ($1::uuid, $2::date, $3, 0, 'monthly_reset')`,
      [member_id, pm, allowance]
    );
  }
}

/**
 * After payment: ensure ledger row exists with correct grant for members who just gained credit-bearing access.
 */
async function ensureCreditLedgerAfterPaidPlan(client, memberId) {
  const allowance = await getMonthlyCreditAllowanceMinutes(client, memberId);
  if (allowance <= 0) return;
  const pm = await currentPeriodMonthDate(client);
  await client.query(
    `INSERT INTO member_meeting_credit_ledger (member_id, period_month, granted_minutes, used_minutes)
     VALUES ($1::uuid, $2::date, $3, 0)
     ON CONFLICT (member_id, period_month) DO UPDATE
       SET granted_minutes = GREATEST(member_meeting_credit_ledger.granted_minutes, EXCLUDED.granted_minutes),
           updated_at = now()`,
    [memberId, pm, allowance]
  );
}

/** Standalone cron entrypoint (uses own transaction). */
async function runMonthlyCreditResetJob() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await runMonthlyCreditReset(c);
    await c.query('COMMIT');
  } catch (e) {
    try {
      await c.query('ROLLBACK');
    } catch (_) {
      /* ignore */
    }
    console.error('runMonthlyCreditResetJob', e);
  } finally {
    c.release();
  }
}

module.exports = {
  hubTz,
  currentPeriodMonthDate,
  getMonthlyCreditAllowanceMinutes,
  getLedgerRow,
  getAvailableCreditMinutes,
  lockAvailableCreditMinutes,
  addUsedMinutes,
  releaseUsedMinutes,
  splitQuoteWithCredits,
  runMonthlyCreditReset,
  runMonthlyCreditResetJob,
  ensureCreditLedgerAfterPaidPlan,
};
