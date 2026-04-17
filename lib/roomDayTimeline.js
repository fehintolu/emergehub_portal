const { portalTz } = require('./roomQuote');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function pad2(n) {
  return String(n).padStart(2, '0');
}

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
 * 30-minute timeline slots for one hub calendar day (PORTAL_TZ).
 * @returns {Promise<{
 *   past?: boolean,
 *   closed?: boolean,
 *   noHours?: boolean,
 *   opens_at?: string,
 *   closes_at?: string,
 *   slots?: Array<{ starts_at: string, ends_at: string, state: string }>
 * }>}
 */
async function getDayTimeline(client, roomId, localDateStr) {
  const tz = portalTz();
  if (!DATE_RE.test(localDateStr)) {
    const e = new Error('bad_date');
    e.code = 'BAD_DATE';
    throw e;
  }

  const { rows: pastRows } = await client.query(
    `SELECT ($1::date < (now() AT TIME ZONE $2::text)::date) AS is_past`,
    [localDateStr, tz]
  );
  if (pastRows[0].is_past) {
    return { past: true, slots: [] };
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
    return { closed: true, slots: [] };
  }
  const openStr = formatTimeHms(sch.opens_at);
  const closeStr = formatTimeHms(sch.closes_at);
  if (!openStr || !closeStr) {
    return { noHours: true, slots: [] };
  }

  const { rows } = await client.query(
    `WITH slotrow AS (
       SELECT gs AS starts_at, gs + interval '30 minutes' AS ends_at
       FROM generate_series(
         ($1::text || ' ' || $2::text)::timestamp AT TIME ZONE $3::text,
         ($1::text || ' ' || $4::text)::timestamp AT TIME ZONE $3::text - interval '30 minutes',
         interval '30 minutes'
       ) AS gs
     )
     SELECT s.starts_at,
            s.ends_at,
            CASE
              WHEN s.starts_at < now() THEN 'past'
              WHEN EXISTS (
                SELECT 1 FROM room_blocked_slots bl
                WHERE bl.meeting_room_id = $5::uuid AND bl.deleted_at IS NULL
                  AND bl.starts_at < s.ends_at AND bl.ends_at > s.starts_at
              ) THEN 'block'
              WHEN EXISTS (
                SELECT 1 FROM room_bookings rb
                WHERE rb.meeting_room_id = $5::uuid AND rb.deleted_at IS NULL
                  AND rb.status = 'pending_payment'
                  AND rb.starts_at < s.ends_at AND rb.ends_at > s.starts_at
              ) THEN 'pending'
              WHEN EXISTS (
                SELECT 1 FROM room_bookings rb
                WHERE rb.meeting_room_id = $5::uuid AND rb.deleted_at IS NULL
                  AND rb.status = 'confirmed'
                  AND rb.starts_at < s.ends_at AND rb.ends_at > s.starts_at
              ) THEN 'booked'
              ELSE 'open'
            END AS state
     FROM slotrow s
     ORDER BY s.starts_at`,
    [localDateStr, openStr, tz, closeStr, roomId]
  );

  return {
    opens_at: openStr,
    closes_at: closeStr,
    slots: rows.map((r) => ({
      starts_at: r.starts_at.toISOString(),
      ends_at: r.ends_at.toISOString(),
      state: r.state,
    })),
  };
}

module.exports = { getDayTimeline };
