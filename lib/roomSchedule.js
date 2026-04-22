const { portalTz } = require('./roomQuote');

/**
 * Resolve open hours for a hub calendar day. If the room has no schedule rows at all,
 * Mon–Fri defaults to 09:00–18:00 so new rooms remain bookable until an admin sets hours.
 */
async function getEffectiveRoomDaySchedule(client, roomId, localDateStr) {
  const tz = portalTz();
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
  let sch = schRows[0];
  if (sch && sch.is_open) return sch;

  const { rows: cnt } = await client.query(
    `SELECT COUNT(*)::int AS c FROM room_availability_schedule
     WHERE meeting_room_id = $1::uuid AND deleted_at IS NULL`,
    [roomId]
  );
  if (cnt[0].c === 0) {
    const { rows: wdRows } = await client.query(
      `SELECT EXTRACT(DOW FROM (($1::text || ' 12:00:00')::timestamp AT TIME ZONE $2::text))::int AS wd`,
      [localDateStr, tz]
    );
    const wd = Number(wdRows[0].wd);
    if (wd >= 1 && wd <= 5) {
      return { is_open: true, opens_at: '09:00', closes_at: '18:00' };
    }
  }
  return sch || null;
}

module.exports = { getEffectiveRoomDaySchedule };
