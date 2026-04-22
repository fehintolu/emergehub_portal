const { pool } = require('./db');
const { portalTz } = require('./roomQuote');

function hubTz() {
  return portalTz();
}

/**
 * First calendar day of current month in hub timezone (date only).
 * Used when the member has no active plan renewal date.
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
 * Today's date in the hub timezone (for comparing with pool_expires_on).
 */
async function todayInHub(q) {
  const { rows } = await q.query(`SELECT (timezone($1::text, now()))::date AS d`, [hubTz()]);
  return rows[0].d;
}

/**
 * Ledger "period" key: active membership renewal date when set and still valid,
 * otherwise the first day of the current calendar month in the hub (legacy behaviour).
 * Credits are intended to line up with the plan renewal when one exists.
 */
async function currentCreditPeriodKey(q, memberId) {
  const { rows: pr } = await q.query(
    `SELECT mp.renewal_at::date AS r
     FROM member_plans mp
     WHERE mp.member_id = $1::uuid AND mp.deleted_at IS NULL AND mp.status = 'active'
     ORDER BY mp.started_at DESC NULLS LAST
     LIMIT 1`,
    [memberId]
  );
  if (pr[0]?.r) {
    const today = await todayInHub(q);
    const rd = pr[0].r;
    if (rd >= today) return rd;
  }
  return currentPeriodMonthDate(q);
}

/**
 * Default last valid day for a credit pool anchored at periodKeyDate.
 * If periodKeyDate equals the member's plan renewal date, expiry is that day.
 * Otherwise (calendar-month bucket) expiry is the last day of that month.
 */
async function defaultPoolExpiresOn(q, periodKeyDate, memberId) {
  const pv =
    periodKeyDate instanceof Date ? periodKeyDate.toISOString().slice(0, 10) : String(periodKeyDate).slice(0, 10);
  const { rows: pr } = await q.query(
    `SELECT mp.renewal_at::date AS r
     FROM member_plans mp
     WHERE mp.member_id = $1::uuid AND mp.deleted_at IS NULL AND mp.status = 'active'
     ORDER BY mp.started_at DESC NULLS LAST
     LIMIT 1`,
    [memberId]
  );
  if (pr[0]?.r) {
    const rd = String(pr[0].r).slice(0, 10);
    if (rd === pv) return pr[0].r;
  }
  const { rows } = await q.query(
    `SELECT (date_trunc('month', $1::date) + interval '1 month - 1 day')::date AS d`,
    [pv]
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
       AND sr.access_started_at IS NOT NULL
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

function isPoolActive(row, todayYmd) {
  if (!row) return false;
  const pe = row.pool_expires_on;
  if (!pe) return true;
  const exp =
    pe instanceof Date ? pe.toISOString().slice(0, 10) : String(pe).slice(0, 10);
  const td = todayYmd instanceof Date ? todayYmd.toISOString().slice(0, 10) : String(todayYmd).slice(0, 10);
  return exp >= td;
}

/**
 * Remaining credit minutes in the current period (0 if none or pool expired).
 */
async function getAvailableCreditMinutes(q, memberId) {
  const pk = await currentCreditPeriodKey(q, memberId);
  const today = await todayInHub(q);
  const allowance = await getMonthlyCreditAllowanceMinutes(q, memberId);
  if (allowance <= 0) {
    return { available: 0, granted: 0, used: 0, period_month: pk, pool_expires_on: null };
  }
  let row = await getLedgerRow(q, memberId, pk);
  if (!row) {
    const defaultExp = await defaultPoolExpiresOn(q, pk, memberId);
    await q.query(
      `INSERT INTO member_meeting_credit_ledger (member_id, period_month, granted_minutes, used_minutes, pool_expires_on)
       VALUES ($1::uuid, $2::date, $3, 0, $4::date)
       ON CONFLICT (member_id, period_month) DO NOTHING`,
      [memberId, pk, allowance, defaultExp]
    );
    row = await getLedgerRow(q, memberId, pk);
  } else if (!row.pool_expires_on) {
    const defaultExp = await defaultPoolExpiresOn(q, pk, memberId);
    await q.query(
      `UPDATE member_meeting_credit_ledger SET pool_expires_on = $3::date, updated_at = now()
       WHERE member_id = $1::uuid AND period_month = $2::date AND pool_expires_on IS NULL`,
      [memberId, pk, defaultExp]
    );
    row = await getLedgerRow(q, memberId, pk);
  }
  if (!isPoolActive(row, today)) {
    return {
      available: 0,
      granted: Number(row.granted_minutes) || 0,
      used: Number(row.used_minutes) || 0,
      period_month: pk,
      pool_expires_on: row.pool_expires_on || null,
    };
  }
  const granted = Number(row.granted_minutes) || 0;
  const used = Number(row.used_minutes) || 0;
  const available = Math.max(0, granted - used);
  return {
    available,
    granted,
    used,
    period_month: pk,
    pool_expires_on: row.pool_expires_on || null,
  };
}

/**
 * Lock ledger row and return available minutes (FOR UPDATE).
 */
async function lockAvailableCreditMinutes(q, memberId) {
  const pk = await currentCreditPeriodKey(q, memberId);
  const today = await todayInHub(q);
  const allowance = await getMonthlyCreditAllowanceMinutes(q, memberId);
  if (allowance <= 0) {
    return { available: 0, granted: 0, used: 0, period_month: pk, ledgerId: null };
  }
  const defaultExp = await defaultPoolExpiresOn(q, pk, memberId);
  await q.query(
    `INSERT INTO member_meeting_credit_ledger (member_id, period_month, granted_minutes, used_minutes, pool_expires_on)
     VALUES ($1::uuid, $2::date, $3, 0, $4::date)
     ON CONFLICT (member_id, period_month) DO UPDATE
       SET granted_minutes = GREATEST(member_meeting_credit_ledger.granted_minutes, EXCLUDED.granted_minutes),
           pool_expires_on = COALESCE(
             member_meeting_credit_ledger.pool_expires_on,
             EXCLUDED.pool_expires_on
           ),
           updated_at = now()`,
    [memberId, pk, allowance, defaultExp]
  );

  const { rows } = await q.query(
    `SELECT * FROM member_meeting_credit_ledger
     WHERE member_id = $1::uuid AND period_month = $2::date
     FOR UPDATE`,
    [memberId, pk]
  );
  const row = rows[0];
  if (!row || !isPoolActive(row, today)) {
    return { available: 0, granted: 0, used: 0, period_month: pk, ledgerId: row && row.id };
  }
  const granted = Number(row.granted_minutes) || 0;
  const used = Number(row.used_minutes) || 0;
  return {
    available: Math.max(0, granted - used),
    granted,
    used,
    period_month: pk,
    ledgerId: row.id,
  };
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
 * Monthly reset: refresh plan allowance for the current credit period (renewal- or month-based).
 */
async function runMonthlyCreditReset(q) {
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
             AND sr.access_started_at IS NOT NULL
             AND COALESCE(sr.access_ends_at, now() + interval '1 day') > now()
             AND COALESCE(sp.monthly_meeting_credit_minutes, 0) > 0
         )
       )`
  );

  for (const { member_id } of members) {
    const allowance = await getMonthlyCreditAllowanceMinutes(q, member_id);
    if (allowance <= 0) continue;
    const pk = await currentCreditPeriodKey(q, member_id);
    const exp = await defaultPoolExpiresOn(q, pk, member_id);
    await q.query(
      `INSERT INTO member_meeting_credit_ledger (member_id, period_month, granted_minutes, used_minutes, pool_expires_on)
       VALUES ($1::uuid, $2::date, $3, 0, $4::date)
       ON CONFLICT (member_id, period_month) DO UPDATE
         SET granted_minutes = EXCLUDED.granted_minutes,
             used_minutes = 0,
             pool_expires_on = EXCLUDED.pool_expires_on,
             updated_at = now()`,
      [member_id, pk, allowance, exp]
    );
    await q.query(
      `INSERT INTO meeting_credit_events (member_id, period_month, delta_granted, delta_used, reason)
       VALUES ($1::uuid, $2::date, $3, 0, 'monthly_reset')`,
      [member_id, pk, allowance]
    );
  }
}

/**
 * After payment: ensure ledger row exists with correct grant for members who just gained credit-bearing access.
 */
async function ensureCreditLedgerAfterPaidPlan(client, memberId) {
  const allowance = await getMonthlyCreditAllowanceMinutes(client, memberId);
  if (allowance <= 0) return;
  const pk = await currentCreditPeriodKey(client, memberId);
  const exp = await defaultPoolExpiresOn(client, pk, memberId);
  await client.query(
    `INSERT INTO member_meeting_credit_ledger (member_id, period_month, granted_minutes, used_minutes, pool_expires_on)
     VALUES ($1::uuid, $2::date, $3, 0, $4::date)
     ON CONFLICT (member_id, period_month) DO UPDATE
       SET granted_minutes = GREATEST(member_meeting_credit_ledger.granted_minutes, EXCLUDED.granted_minutes),
           pool_expires_on = COALESCE(member_meeting_credit_ledger.pool_expires_on, EXCLUDED.pool_expires_on),
           updated_at = now()`,
    [memberId, pk, allowance, exp]
  );
}

const MAX_MANUAL_GRANT_MINUTES = 43200; /* 30 days in minutes */

/**
 * Super-admin manual grant: adds minutes to the current period ledger row and sets credit expiry date.
 * @param {import('pg').Pool} pool
 * @param {{ memberId: string, expiresOnYmd: string, minutes: number, adminId: string, note?: string }} opts
 */
async function grantManualMeetingCredits(pool, opts) {
  const memberId = opts.memberId;
  const adminId = opts.adminId;
  const minutes = Math.floor(Number(opts.minutes));
  if (!memberId || !adminId) throw new Error('missing_ids');
  if (!minutes || minutes < 1 || minutes > MAX_MANUAL_GRANT_MINUTES) throw new Error('invalid_minutes');

  const expiresOnYmd = String(opts.expiresOnYmd || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiresOnYmd)) throw new Error('invalid_period');

  const note = String(opts.note || '')
    .trim()
    .slice(0, 400);
  const reason = note ? `admin_manual: ${note}` : 'admin_manual';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const mem = await client.query(
      `SELECT id FROM members WHERE id = $1::uuid AND deleted_at IS NULL`,
      [memberId]
    );
    if (!mem.rows[0]) {
      throw new Error('member_not_found');
    }
    const pk = await currentCreditPeriodKey(client, memberId);
    await client.query(
      `INSERT INTO member_meeting_credit_ledger (member_id, period_month, granted_minutes, used_minutes, pool_expires_on)
       VALUES ($1::uuid, $2::date, $3::int, 0, $4::date)
       ON CONFLICT (member_id, period_month) DO UPDATE
         SET granted_minutes = member_meeting_credit_ledger.granted_minutes + EXCLUDED.granted_minutes,
             pool_expires_on = GREATEST(
               COALESCE(member_meeting_credit_ledger.pool_expires_on, EXCLUDED.pool_expires_on),
               EXCLUDED.pool_expires_on
             ),
             updated_at = now()`,
      [memberId, pk, minutes, expiresOnYmd]
    );
    await client.query(
      `INSERT INTO meeting_credit_events (member_id, period_month, delta_granted, delta_used, reason, room_booking_id, admin_id)
       VALUES ($1::uuid, $2::date, $3::int, 0, $4, NULL, $5::uuid)`,
      [memberId, pk, minutes, reason, adminId]
    );
    await client.query('COMMIT');
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      /* ignore */
    }
    throw e;
  } finally {
    client.release();
  }
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
  currentCreditPeriodKey,
  todayInHub,
  defaultPoolExpiresOn,
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
  grantManualMeetingCredits,
  MAX_MANUAL_GRANT_MINUTES,
};
