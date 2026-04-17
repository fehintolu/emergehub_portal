const { portalTz } = require('./roomQuote');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** @param {unknown} t */
function timeToMinutes(t) {
  if (t == null) return null;
  const s = typeof t === 'string' ? t : String(t);
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function formatTimeHms(t) {
  const m = timeToMinutes(t);
  if (m == null) return null;
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}:00`;
}

/**
 * List bookable start instants (ISO strings) for a calendar day in PORTAL_TZ.
 * @param {import('pg').Pool|import('pg').PoolClient} client
 * @param {string} roomId uuid
 * @param {string} localDateStr YYYY-MM-DD (hub calendar day)
 * @param {number} durationMinutes
 * @returns {Promise<{ slots: string[], closed: boolean, noHours: boolean, past?: boolean }>}
 */
async function listAvailableSlotStarts(client, roomId, localDateStr, durationMinutes) {
  const tz = portalTz();
  if (!DATE_RE.test(localDateStr)) {
    const e = new Error('bad_date');
    e.code = 'BAD_DATE';
    throw e;
  }
  const dm = Math.max(15, Math.min(24 * 60, Math.floor(Number(durationMinutes) || 60)));

  const { rows: pastRows } = await client.query(
    `SELECT ($1::date < (now() AT TIME ZONE $2::text)::date) AS is_past`,
    [localDateStr, tz]
  );
  if (pastRows[0].is_past) {
    return { slots: [], closed: false, noHours: false, past: true };
  }

  const { rows: schRows } = await client.query(
    `SELECT ras.is_open, ras.opens_at, ras.closes_at
     FROM room_availability_schedule ras
     WHERE ras.meeting_room_id = $1::uuid AND ras.deleted_at IS NULL
       AND ras.weekday = EXTRACT(DOW FROM (($2::text || ' 12:00:00')::timestamp AT TIME ZONE $3::text))::int
       AND ras.effective_from <= $2::date
     ORDER BY ras.effective_from DESC
     LIMIT 1`,
    [roomId, localDateStr, tz]
  );
  const sch = schRows[0];
  if (!sch || !sch.is_open) {
    return { slots: [], closed: true, noHours: false };
  }
  const openStr = formatTimeHms(sch.opens_at);
  const closeStr = formatTimeHms(sch.closes_at);
  if (!openStr || !closeStr) {
    return { slots: [], closed: false, noHours: true };
  }

  const { rows } = await client.query(
    `WITH cand AS (
       SELECT gs AS starts_at, gs + ($4::int * interval '1 minute') AS ends_at
       FROM generate_series(
         ($1::text || ' ' || $2::text)::timestamp AT TIME ZONE $5::text,
         ($1::text || ' ' || $3::text)::timestamp AT TIME ZONE $5::text - ($4::int * interval '1 minute'),
         interval '15 minutes'
       ) AS gs
     )
     SELECT c.starts_at
     FROM cand c
     WHERE c.starts_at >= now() - interval '1 minute'
       AND NOT EXISTS (
         SELECT 1 FROM room_bookings rb
         WHERE rb.meeting_room_id = $6::uuid AND rb.deleted_at IS NULL
           AND rb.status IN ('confirmed', 'pending_payment')
           AND rb.starts_at < c.ends_at AND rb.ends_at > c.starts_at
       )
       AND NOT EXISTS (
         SELECT 1 FROM room_blocked_slots bl
         WHERE bl.meeting_room_id = $6::uuid AND bl.deleted_at IS NULL
           AND bl.starts_at < c.ends_at AND bl.ends_at > c.starts_at
       )
     ORDER BY c.starts_at`,
    [localDateStr, openStr, closeStr, dm, tz, roomId]
  );

  const slots = rows.map((r) => r.starts_at.toISOString());
  return { slots, closed: false, noHours: false };
}

module.exports = { listAvailableSlotStarts };
