const { portalTz } = require('./roomQuote');
const { getEffectiveRoomDaySchedule } = require('./roomSchedule');

/**
 * @param {import('pg').PoolClient} client
 * @param {string} roomId uuid
 * @param {Date} startsAt
 * @param {Date} endsAt
 * @param {{ excludeBookingId?: string|null }} [opts]
 */
async function assertSlotBookable(client, roomId, startsAt, endsAt, opts = {}) {
  const excludeBookingId = opts.excludeBookingId || null;
  if (!(startsAt instanceof Date) || !(endsAt instanceof Date) || endsAt <= startsAt) {
    const e = new Error('Invalid time range.');
    e.code = 'RANGE';
    throw e;
  }
  const tz = portalTz();

  const { rows: drow } = await client.query(
    `SELECT to_char($1::timestamptz AT TIME ZONE $2::text, 'YYYY-MM-DD') AS d`,
    [startsAt, tz]
  );
  const localDateStr = drow[0].d;
  const sch = await getEffectiveRoomDaySchedule(client, roomId, localDateStr);
  if (!sch || !sch.is_open) {
    const e = new Error('This room is not available on the selected date.');
    e.code = 'SCHEDULE';
    throw e;
  }
  if (sch.opens_at && sch.closes_at) {
    const { rows: tchk } = await client.query(
      `SELECT
         (($1::timestamptz AT TIME ZONE $5::text)::date = ($2::timestamptz AT TIME ZONE $5::text)::date) AS same_day,
         (($1::timestamptz AT TIME ZONE $5::text)::time >= $3::time) AS ge_open,
         (($2::timestamptz AT TIME ZONE $5::text)::time <= $4::time) AS le_close`,
      [startsAt, endsAt, sch.opens_at, sch.closes_at, tz]
    );
    const c = tchk[0];
    if (!c || !c.same_day || !c.ge_open || !c.le_close) {
      const e = new Error('Booking must fall within hub opening hours on a single calendar day.');
      e.code = 'HOURS';
      throw e;
    }
  }

  const { rows: ov } = await client.query(
    `SELECT id FROM room_bookings
     WHERE meeting_room_id = $1::uuid AND deleted_at IS NULL
       AND status IN ('confirmed', 'pending_payment')
       AND starts_at < $3::timestamptz AND ends_at > $2::timestamptz
       AND ($4::uuid IS NULL OR id <> $4::uuid)
     LIMIT 1`,
    [roomId, startsAt, endsAt, excludeBookingId]
  );
  if (ov[0]) {
    const e = new Error('This time slot is already reserved.');
    e.code = 'OVERLAP';
    throw e;
  }

  const { rows: bl } = await client.query(
    `SELECT id FROM room_blocked_slots
     WHERE meeting_room_id = $1::uuid AND deleted_at IS NULL
       AND starts_at < $3::timestamptz AND ends_at > $2::timestamptz
     LIMIT 1`,
    [roomId, startsAt, endsAt]
  );
  if (bl[0]) {
    const e = new Error('This time slot is not available (blocked).');
    e.code = 'BLOCK';
    throw e;
  }
}

module.exports = { assertSlotBookable };
