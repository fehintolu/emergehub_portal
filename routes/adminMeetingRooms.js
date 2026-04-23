const express = require('express');
const crypto = require('crypto');
const { pool } = require('../lib/db');
const { requireValidCsrf } = require('../lib/csrf');
const { requireAdmin } = require('../middleware/adminAuth');
const { adminLayoutLocals } = require('../middleware/adminLayoutLocals');
const { restrictConsultantScope } = require('../middleware/consultantScope');
const {
  blockViewerMutations,
  requireSuperAdmin,
  enforceViewerReadOnlyGet,
} = require('../lib/adminRbac');
const { formatNgn, formatDate, formatDateTime } = require('../lib/format');
const { getSetting } = require('../lib/portalSettings');
const { nextInvoiceNumber } = require('../lib/invoiceNumber');
const { computeRoomQuote, portalTz } = require('../lib/roomQuote');
const { assertSlotBookable } = require('../lib/roomSlot');
const { loadDiscountTiers, createRoomBookingWithInvoice } = require('../lib/roomBookingInvoice');
const { getDayTimeline } = require('../lib/roomDayTimeline');
const { getMonthDayStates } = require('../lib/roomMonthAvailability');
const { getAvailableCreditMinutes, splitQuoteWithCredits } = require('../lib/meetingCredits');
const { notifyMember } = require('../lib/notifications');
const { sendServiceRequestInvoiceNotifications } = require('../lib/serviceRequestInvoice');

const router = express.Router();
router.use(requireAdmin);
router.use(adminLayoutLocals);
router.use(restrictConsultantScope);
router.use(enforceViewerReadOnlyGet);
router.use(blockViewerMutations);

const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function isUuid(s) {
  return (
    typeof s === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s)
  );
}

router.get('/meeting-rooms', (req, res) => {
  res.render('admin/meeting-rooms-index', {
    layout: 'layouts/admin',
    title: 'Meeting rooms',
    pageSub: 'Configure spaces, availability, and paid bookings',
  });
});

router.get('/meeting-rooms/rooms', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM meeting_rooms WHERE deleted_at IS NULL ORDER BY sort_order, name`
  );
  res.render('admin/meeting-rooms-rooms', {
    layout: 'layouts/admin',
    title: 'Rooms',
    rooms: rows,
    formatNgn,
    query: req.query,
  });
});

router.get('/meeting-rooms/rooms/new', (req, res) => {
  res.render('admin/meeting-rooms-room-form', {
    layout: 'layouts/admin',
    title: 'New room',
    room: null,
    scheduleByWd: {},
    WD,
    formatNgn,
  });
});

router.post('/meeting-rooms/rooms/new', requireValidCsrf, async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.redirect('/admin/meeting-rooms/rooms/new?err=name');
  const description = String(req.body.description || '').trim();
  const capacity = Math.max(1, Math.floor(Number(req.body.capacity || 1)));
  const hourly_rate_cents = Math.max(0, Math.floor(Number(req.body.hourly_rate_cents || 0)));
  const active = req.body.active === '1' || req.body.active === 'on';
  const sort_order = Math.floor(Number(req.body.sort_order || 0)) || 0;
  const { rows } = await pool.query(
    `INSERT INTO meeting_rooms (name, description, capacity, hourly_rate_cents, active, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [name, description, capacity, hourly_rate_cents, active, sort_order]
  );
  const id = rows[0].id;
  await saveWeeklySchedule(pool, id, req.body);
  res.redirect(`/admin/meeting-rooms/rooms/${id}/edit?msg=created`);
});

router.get('/meeting-rooms/rooms/:id/edit', async (req, res) => {
  const id = req.params.id;
  if (!isUuid(id)) return res.status(404).send('Not found');
  const { rows } = await pool.query(`SELECT * FROM meeting_rooms WHERE id = $1::uuid AND deleted_at IS NULL`, [id]);
  const room = rows[0];
  if (!room) return res.status(404).send('Not found');
  const { rows: sch } = await pool.query(
    `SELECT * FROM room_availability_schedule
     WHERE meeting_room_id = $1::uuid AND deleted_at IS NULL
     ORDER BY weekday`,
    [id]
  );
  const scheduleByWd = {};
  sch.forEach((r) => {
    scheduleByWd[r.weekday] = r;
  });
  const { rows: blocks } = await pool.query(
    `SELECT * FROM room_blocked_slots WHERE meeting_room_id = $1::uuid AND deleted_at IS NULL ORDER BY starts_at DESC LIMIT 100`,
    [id]
  );
  res.render('admin/meeting-rooms-room-form', {
    layout: 'layouts/admin',
    title: 'Edit room',
    room,
    scheduleByWd,
    blocks,
    WD,
    formatNgn,
    formatDateTime,
    query: req.query,
  });
});

router.post('/meeting-rooms/rooms/:id/edit', requireValidCsrf, async (req, res) => {
  const id = req.params.id;
  if (!isUuid(id)) return res.status(404).send('Not found');
  const name = String(req.body.name || '').trim();
  if (!name) return res.redirect(`/admin/meeting-rooms/rooms/${id}/edit?err=name`);
  const description = String(req.body.description || '').trim();
  const capacity = Math.max(1, Math.floor(Number(req.body.capacity || 1)));
  const hourly_rate_cents = Math.max(0, Math.floor(Number(req.body.hourly_rate_cents || 0)));
  const active = req.body.active === '1' || req.body.active === 'on';
  const sort_order = Math.floor(Number(req.body.sort_order || 0)) || 0;
  await pool.query(
    `UPDATE meeting_rooms SET name = $2, description = $3, capacity = $4, hourly_rate_cents = $5, active = $6, sort_order = $7, updated_at = now()
     WHERE id = $1::uuid AND deleted_at IS NULL`,
    [id, name, description, capacity, hourly_rate_cents, active, sort_order]
  );
  await saveWeeklySchedule(pool, id, req.body);
  res.redirect(`/admin/meeting-rooms/rooms/${id}/edit?msg=saved`);
});

router.post('/meeting-rooms/rooms/:id/delete', requireValidCsrf, requireSuperAdmin, async (req, res) => {
  const id = req.params.id;
  if (!isUuid(id)) return res.status(404).send('Not found');
  await pool.query(`UPDATE meeting_rooms SET deleted_at = now(), updated_at = now() WHERE id = $1::uuid`, [id]);
  res.redirect('/admin/meeting-rooms/rooms?msg=deleted');
});

router.post('/meeting-rooms/rooms/:id/blocks', requireValidCsrf, async (req, res) => {
  const id = req.params.id;
  if (!isUuid(id)) return res.status(404).send('Not found');
  const starts_at = new Date(String(req.body.starts_at || ''));
  const ends_at = new Date(String(req.body.ends_at || ''));
  const reason = String(req.body.reason || '').trim() || null;
  const internal_note = String(req.body.internal_note || '').trim() || null;
  if (Number.isNaN(starts_at.getTime()) || Number.isNaN(ends_at.getTime()) || ends_at <= starts_at) {
    return res.redirect(`/admin/meeting-rooms/rooms/${id}/edit?err=blocktime`);
  }
  const adminId = res.locals.currentAdmin.id;
  await pool.query(
    `INSERT INTO room_blocked_slots (meeting_room_id, starts_at, ends_at, reason, internal_note, created_by_admin_id)
     VALUES ($1::uuid, $2, $3, $4, $5, $6)`,
    [id, starts_at, ends_at, reason, internal_note, adminId]
  );
  res.redirect(`/admin/meeting-rooms/rooms/${id}/edit?msg=block`);
});

router.post('/meeting-rooms/blocks/:blockId/delete', requireValidCsrf, requireSuperAdmin, async (req, res) => {
  const bid = req.params.blockId;
  if (!isUuid(bid)) return res.status(404).send('Not found');
  const { rows } = await pool.query(
    `UPDATE room_blocked_slots SET deleted_at = now(), updated_at = now() WHERE id = $1::uuid RETURNING meeting_room_id`,
    [bid]
  );
  const rid = rows[0]?.meeting_room_id;
  res.redirect(rid ? `/admin/meeting-rooms/rooms/${rid}/edit?msg=blockdel` : '/admin/meeting-rooms/rooms');
});

router.get('/meeting-rooms/calendar', async (req, res) => {
  const now = new Date();
  const y = Math.floor(Number(req.query.year || now.getFullYear())) || now.getFullYear();
  const m = Math.min(12, Math.max(1, Math.floor(Number(req.query.month || now.getMonth() + 1)))) || 1;
  const roomId = String(req.query.room_id || '').trim();
  const { rows: rooms } = await pool.query(
    `SELECT id, name FROM meeting_rooms WHERE deleted_at IS NULL ORDER BY sort_order, name`
  );
  const mStr = String(m).padStart(2, '0');
  const monthStartStr = `${y}-${mStr}-01`;
  const nextM = m === 12 ? 1 : m + 1;
  const nextY = m === 12 ? y + 1 : y;
  const monthAfterStr = `${nextY}-${String(nextM).padStart(2, '0')}-01`;
  const roomUuid = isUuid(roomId) ? roomId : null;
  const { rows: bookings } = await pool.query(
    `SELECT rb.*, m.full_name, mr.name AS room_name
     FROM room_bookings rb
     JOIN meeting_rooms mr ON mr.id = rb.meeting_room_id
     LEFT JOIN members m ON m.id = rb.member_id
     WHERE rb.deleted_at IS NULL
       AND rb.status IN ('confirmed', 'pending_payment', 'completed')
       AND ($3::uuid IS NULL OR rb.meeting_room_id = $3::uuid)
       AND rb.starts_at < $2::timestamptz
       AND rb.ends_at > $1::timestamptz`,
    [`${monthStartStr}T00:00:00`, `${monthAfterStr}T00:00:00`, roomUuid]
  );
  const monthStart = new Date(y, m - 1, 1);
  const monthEnd = new Date(y, m, 0);
  const startPad = monthStart.getDay();
  const daysInMonth = monthEnd.getDate();
  const cells = [];
  for (let i = 0; i < startPad; i++) cells.push({ empty: true });
  for (let d = 1; d <= daysInMonth; d++) {
    const dayDate = new Date(y, m - 1, d);
    const dayKey = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dayBookings = bookings.filter((b) => {
      const a = new Date(b.starts_at);
      const z = new Date(b.ends_at);
      return a <= new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate(), 23, 59, 59, 999) && z >= new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate(), 0, 0, 0, 0);
    });
    cells.push({ day: d, dayKey, dayDate, bookings: dayBookings });
  }
  while (cells.length % 7 !== 0) cells.push({ empty: true });
  res.render('admin/meeting-rooms-calendar', {
    layout: 'layouts/admin',
    title: 'Room calendar',
    y,
    m,
    roomId: isUuid(roomId) ? roomId : '',
    rooms,
    cells,
    formatDateTime,
    portalTz: portalTz(),
  });
});

router.get('/meeting-rooms/calendar.json', async (req, res) => {
  const from = new Date(String(req.query.from || ''));
  const to = new Date(String(req.query.to || ''));
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
    return res.status(400).json({ ok: false });
  }
  const roomId = String(req.query.room_id || '').trim();
  const { rows: bk } = await pool.query(
    `SELECT starts_at, ends_at, status, booking_reference
     FROM room_bookings
     WHERE deleted_at IS NULL AND status IN ('confirmed', 'pending_payment', 'completed')
       AND ($3::uuid IS NULL OR meeting_room_id = $3::uuid)
       AND starts_at < $2::timestamptz AND ends_at > $1::timestamptz`,
    [from, to, isUuid(roomId) ? roomId : null]
  );
  const { rows: bl } = await pool.query(
    `SELECT starts_at, ends_at, reason
     FROM room_blocked_slots
     WHERE deleted_at IS NULL
       AND ($3::uuid IS NULL OR meeting_room_id = $3::uuid)
       AND starts_at < $2::timestamptz AND ends_at > $1::timestamptz`,
    [from, to, isUuid(roomId) ? roomId : null]
  );
  res.json({
    ok: true,
    busy: [
      ...bk.map((r) => ({ ...r, kind: 'booking' })),
      ...bl.map((r) => ({ ...r, kind: 'block' })),
    ],
  });
});

/** Typeahead for booking calendar (name, email, business) */
router.get('/meeting-rooms/members-suggest', async (req, res) => {
  const raw = String(req.query.q || '').trim();
  if (!raw) {
    return res.json({ ok: true, members: [] });
  }
  if (isUuid(raw)) {
    const { rows } = await pool.query(
      `SELECT id, full_name, email, business_name
       FROM members WHERE id = $1::uuid AND deleted_at IS NULL`,
      [raw]
    );
    return res.json({ ok: true, members: rows });
  }
  if (raw.length < 2) {
    return res.json({ ok: true, members: [] });
  }
  const like = `%${raw.toLowerCase()}%`;
  const { rows } = await pool.query(
    `SELECT id, full_name, email, business_name
     FROM members
     WHERE deleted_at IS NULL AND suspended_at IS NULL
       AND (
         lower(email) LIKE $1
         OR lower(full_name) LIKE $1
         OR lower(coalesce(business_name, '')) LIKE $1
         OR lower(coalesce(contact_name, '')) LIKE $1
       )
     ORDER BY full_name ASC
     LIMIT 25`,
    [like]
  );
  return res.json({ ok: true, members: rows });
});

/** Member-parity calendar APIs for admin manual booking UI */
router.get('/meeting-rooms/bookings/new', async (req, res) => {
  const prefillMemberId = isUuid(String(req.query.member_id || '').trim())
    ? String(req.query.member_id).trim()
    : '';
  let prefillMemberLabel = '';
  if (prefillMemberId) {
    const { rows: pm } = await pool.query(
      `SELECT full_name, email FROM members WHERE id = $1::uuid AND deleted_at IS NULL`,
      [prefillMemberId]
    );
    if (pm[0]) {
      prefillMemberLabel = `${pm[0].full_name || 'Member'} · ${pm[0].email || ''}`;
    }
  }
  let roomId = String(req.query.room_id || '').trim();
  const { rows: rooms } = await pool.query(
    `SELECT id, name FROM meeting_rooms WHERE deleted_at IS NULL AND active = true ORDER BY sort_order, name`
  );
  if (!rooms.length) {
    return res.redirect('/admin/meeting-rooms/bookings?err=norooms');
  }
  if (!isUuid(roomId) || !rooms.some((r) => String(r.id) === roomId)) {
    roomId = rooms[0].id;
  }
  const { rows } = await pool.query(
    `SELECT * FROM meeting_rooms WHERE id = $1::uuid AND active = true AND deleted_at IS NULL`,
    [roomId]
  );
  const room = rows[0];
  if (!room) return res.redirect('/admin/meeting-rooms/bookings?err=room');
  const tiers = await loadDiscountTiers(pool, roomId);
  const { rows: md } = await pool.query(
    `SELECT to_char((now() AT TIME ZONE $1::text)::date, 'YYYY-MM-DD') AS min_date`,
    [portalTz()]
  );
  res.render('admin/meeting-room-book-calendar', {
    layout: 'layouts/admin',
    title: 'New room booking',
    pageSub: 'Same calendar experience as members — pick a day, then a time range',
    room,
    rooms,
    tiers,
    formatNgn,
    prefillMemberId,
    prefillMemberLabel,
    minBookDate: md[0].min_date,
    portalTzName: portalTz(),
    query: req.query,
  });
});

router.get('/meeting-rooms/rooms/:roomId/availability-month', async (req, res) => {
  const roomId = req.params.roomId;
  if (!isUuid(roomId)) return res.status(404).json({ ok: false, error: 'not_found' });
  const y = Math.floor(Number(req.query.year));
  const mon = Math.floor(Number(req.query.month));
  if (!Number.isFinite(y) || y < 2000 || y > 2100 || !Number.isFinite(mon) || mon < 1 || mon > 12) {
    return res.status(400).json({ ok: false, error: 'bad_month' });
  }
  const { rows: rm } = await pool.query(
    `SELECT id FROM meeting_rooms WHERE id = $1::uuid AND active = true AND deleted_at IS NULL`,
    [roomId]
  );
  if (!rm[0]) return res.status(404).json({ ok: false, error: 'not_found' });
  const { rows: md } = await pool.query(
    `SELECT to_char((now() AT TIME ZONE $1::text)::date, 'YYYY-MM-DD') AS min_date`,
    [portalTz()]
  );
  try {
    const out = await getMonthDayStates(pool, roomId, y, mon, md[0].min_date);
    return res.json({ ok: true, ...out });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: 'server' });
  }
});

router.get('/meeting-rooms/rooms/:roomId/day-blocks', async (req, res) => {
  const roomId = req.params.roomId;
  if (!isUuid(roomId)) return res.status(404).json({ ok: false, error: 'not_found' });
  const date = String(req.query.date || '');
  const { rows: rm } = await pool.query(
    `SELECT id FROM meeting_rooms WHERE id = $1::uuid AND active = true AND deleted_at IS NULL`,
    [roomId]
  );
  if (!rm[0]) return res.status(404).json({ ok: false, error: 'not_found' });
  try {
    const tl = await getDayTimeline(pool, roomId, date);
    return res.json({ ok: true, date, ...tl });
  } catch (e) {
    if (e.code === 'BAD_DATE') return res.status(400).json({ ok: false, error: 'bad_date' });
    console.error(e);
    return res.status(500).json({ ok: false, error: 'server' });
  }
});

router.get('/meeting-rooms/rooms/:roomId/quote', async (req, res) => {
  const roomId = req.params.roomId;
  if (!isUuid(roomId)) return res.status(404).json({ ok: false, error: 'not_found' });
  const starts = new Date(String(req.query.starts_at || ''));
  const durationMinutes = Math.max(1, Math.floor(Number(req.query.duration_minutes || 60)));
  const fullDay = String(req.query.full_day || '') === '1';
  if (Number.isNaN(starts.getTime())) {
    return res.status(400).json({ ok: false, error: 'bad_start' });
  }
  const ends = new Date(starts.getTime() + durationMinutes * 60 * 1000);
  const { rows: rm } = await pool.query(
    `SELECT * FROM meeting_rooms WHERE id = $1::uuid AND active = true AND deleted_at IS NULL`,
    [roomId]
  );
  if (!rm[0]) return res.status(404).json({ ok: false, error: 'not_found' });
  const tiers = await loadDiscountTiers(pool, roomId);
  const quote = computeRoomQuote(
    {
      hourly_rate_cents: rm[0].hourly_rate_cents,
      full_day_rate_cents: rm[0].full_day_rate_cents,
      durationMinutes,
    },
    tiers,
    { fullDay }
  );
  let bookable = true;
  let bookableError = null;
  try {
    await assertSlotBookable(pool, roomId, starts, ends);
  } catch (e) {
    bookable = false;
    bookableError = e.code || 'slot';
  }
  const memberQ = String(req.query.member_id || '').trim();
  let credits = null;
  if (
    memberQ &&
    isUuid(memberQ) &&
    rm[0].consumes_plan_credits !== false &&
    quote.total_cents > 0
  ) {
    const bal = await getAvailableCreditMinutes(pool, memberQ);
    const split = splitQuoteWithCredits(quote.total_cents, durationMinutes, bal.available, true);
    credits = {
      available_minutes: bal.available,
      granted_minutes: bal.granted,
      used_minutes: bal.used,
      period_month: bal.period_month,
      minutes_applied: split.credit_minutes_used,
      value_cents: split.credit_value_cents,
      payable_cents: split.payable_cents,
    };
  }
  res.json({
    ok: true,
    bookable,
    bookableError,
    quote,
    credits,
    ends_at: ends.toISOString(),
  });
});

router.get('/meeting-rooms/bookings', async (req, res) => {
  const status = String(req.query.status || '').trim();
  const roomId = String(req.query.room_id || '').trim();
  const prefillMemberId = isUuid(String(req.query.member_id || '').trim())
    ? String(req.query.member_id).trim()
    : '';
  const params = [];
  let wh = `rb.deleted_at IS NULL`;
  if (status) {
    params.push(status);
    wh += ` AND rb.status = $${params.length}`;
  }
  if (isUuid(roomId)) {
    params.push(roomId);
    wh += ` AND rb.meeting_room_id = $${params.length}::uuid`;
  }
  const { rows } = await pool.query(
    `SELECT rb.*, mr.name AS room_name, m.full_name, m.email
     FROM room_bookings rb
     JOIN meeting_rooms mr ON mr.id = rb.meeting_room_id
     LEFT JOIN members m ON m.id = rb.member_id
     WHERE ${wh}
     ORDER BY rb.starts_at DESC
     LIMIT 500`,
    params
  );
  const { rows: rooms } = await pool.query(
    `SELECT id, name FROM meeting_rooms WHERE deleted_at IS NULL ORDER BY sort_order, name`
  );
  res.render('admin/meeting-rooms-bookings', {
    layout: 'layouts/admin',
    title: 'Room bookings',
    rows,
    rooms,
    filters: { status, room_id: roomId },
    prefillMemberId,
    formatDateTime,
    formatNgn,
  });
});

router.post('/meeting-rooms/bookings/manual', requireValidCsrf, async (req, res) => {
  const member_id = String(req.body.member_id || '').trim();
  const room_id = String(req.body.room_id || '').trim();
  const purpose = String(req.body.purpose || '').trim() || null;
  const bill = req.body.create_invoice === '1' || req.body.create_invoice === 'on';
  const fullDay = String(req.body.full_day || '') === '1';
  const durRaw = req.body.duration_minutes;
  const useDuration =
    durRaw !== undefined && durRaw !== null && String(durRaw).trim() !== '';

  let starts_at;
  let ends_at;
  if (useDuration) {
    starts_at = new Date(String(req.body.starts_at || ''));
    const durationMinutes = Math.max(1, Math.floor(Number(durRaw || 60)));
    if (Number.isNaN(starts_at.getTime())) {
      return res.redirect('/admin/meeting-rooms/bookings?err=time');
    }
    ends_at = new Date(starts_at.getTime() + durationMinutes * 60 * 1000);
  } else {
    starts_at = new Date(String(req.body.starts_at || ''));
    ends_at = new Date(String(req.body.ends_at || ''));
  }

  if (!isUuid(member_id) || !isUuid(room_id)) {
    return res.redirect('/admin/meeting-rooms/bookings?err=ids');
  }
  if (Number.isNaN(starts_at.getTime()) || Number.isNaN(ends_at.getTime()) || ends_at <= starts_at) {
    return res.redirect('/admin/meeting-rooms/bookings?err=time');
  }
  const { rows: rm } = await pool.query(
    `SELECT * FROM meeting_rooms WHERE id = $1::uuid AND deleted_at IS NULL`,
    [room_id]
  );
  const room = rm[0];
  if (!room) return res.redirect('/admin/meeting-rooms/bookings?err=room');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assertSlotBookable(client, room_id, starts_at, ends_at);
    if (bill) {
      const dueDays = Number((await getSetting('default_invoice_due_days', '7')) || 7) || 7;
      const due = new Date();
      due.setDate(due.getDate() + dueDays);
      const dueStr = due.toISOString().slice(0, 10);
      const invNo = await nextInvoiceNumber();
      const summary = await createRoomBookingWithInvoice(client, {
        memberId: member_id,
        roomRow: room,
        startsAt: starts_at,
        endsAt: ends_at,
        purpose,
        invoiceNumber: invNo,
        dueDateStr: dueStr,
        fullDay,
      });
      await client.query(
        `UPDATE room_bookings SET created_by_admin = true, updated_at = now() WHERE id = $1::uuid`,
        [summary.bookingId]
      );
      await client.query('COMMIT');
      const { rows: mem } = await pool.query(
        `SELECT email, full_name, notify_email_invoice FROM members WHERE id = $1`,
        [member_id]
      );
      const m = mem[0];
      if (m) {
        await sendServiceRequestInvoiceNotifications({
          memberId: member_id,
          memberEmail: m.email,
          memberName: m.full_name,
          notifyInvoiceEmail: m.notify_email_invoice,
          invoiceNumber: invNo,
          amountCents: summary.payable_cents,
          invId: summary.invoiceId,
          dueDateStr: dueStr,
          serviceRequestId: null,
          title: 'Meeting room invoice',
          message: `Invoice ${invNo} for ${room.name}.`,
        });
      }
      return res.redirect('/admin/meeting-rooms/bookings?msg=manualinv');
    }

    const bookingRef = `RB-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    const durationMinutes = Math.max(1, Math.round((ends_at.getTime() - starts_at.getTime()) / 60000));
    await client.query(
      `INSERT INTO room_bookings (
         meeting_room_id, member_id, starts_at, ends_at, status, invoice_id, booking_reference, purpose,
         base_cents, discount_cents, total_cents, discount_tier_id, duration_minutes, payment_deadline_at, created_by_admin
       ) VALUES ($1, $2, $3, $4, 'confirmed', NULL, $5, $6, 0, 0, 0, NULL, $7, NULL, true)`,
      [room_id, member_id, starts_at, ends_at, bookingRef, purpose, durationMinutes]
    );
    await client.query('COMMIT');
    await notifyMember({
      memberId: member_id,
      title: 'Meeting room reserved',
      message: `An administrator confirmed a booking for ${room.name}.`,
      linkUrl: '/meeting-rooms/my-bookings',
    });
    return res.redirect('/admin/meeting-rooms/bookings?msg=manual');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    return res.redirect('/admin/meeting-rooms/bookings?err=slot');
  } finally {
    client.release();
  }
});

router.get('/meeting-rooms/discount-tiers', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT t.*, mr.name AS room_name
     FROM room_discount_tiers t
     LEFT JOIN meeting_rooms mr ON mr.id = t.meeting_room_id
     WHERE t.deleted_at IS NULL
     ORDER BY t.meeting_room_id NULLS FIRST, t.sort_order, t.min_hours`
  );
  const { rows: rooms } = await pool.query(
    `SELECT id, name FROM meeting_rooms WHERE deleted_at IS NULL ORDER BY sort_order, name`
  );
  res.render('admin/meeting-rooms-discount-tiers', {
    layout: 'layouts/admin',
    title: 'Room discount tiers',
    rows,
    rooms,
    query: req.query,
  });
});

router.post('/meeting-rooms/discount-tiers', requireValidCsrf, async (req, res) => {
  const meeting_room_id = String(req.body.meeting_room_id || '').trim();
  const min_hours = Math.max(0, Math.floor(Number(req.body.min_hours || 0)));
  const discount_percent = Math.min(100, Math.max(0, Number(req.body.discount_percent || 0)));
  const label = String(req.body.label || '').trim() || null;
  const active = req.body.active === '1' || req.body.active === 'on';
  const sort_order = Math.floor(Number(req.body.sort_order || 0)) || 0;
  const roomParam = meeting_room_id && isUuid(meeting_room_id) ? meeting_room_id : null;
  await pool.query(
    `INSERT INTO room_discount_tiers (meeting_room_id, min_hours, discount_percent, label, active, sort_order)
     VALUES ($1::uuid, $2, $3, $4, $5, $6)`,
    [roomParam, min_hours, discount_percent, label, active, sort_order]
  );
  res.redirect('/admin/meeting-rooms/discount-tiers?msg=added');
});

router.post('/meeting-rooms/discount-tiers/:id/delete', requireValidCsrf, requireSuperAdmin, async (req, res) => {
  const id = req.params.id;
  if (!isUuid(id)) return res.status(404).send('Not found');
  await pool.query(`UPDATE room_discount_tiers SET deleted_at = now(), updated_at = now() WHERE id = $1::uuid`, [id]);
  res.redirect('/admin/meeting-rooms/discount-tiers?msg=deleted');
});

router.get('/meeting-rooms/discount-demo', async (req, res) => {
  const { rows: rooms } = await pool.query(
    `SELECT id, name FROM meeting_rooms WHERE deleted_at IS NULL ORDER BY sort_order, name`
  );
  res.render('admin/meeting-rooms-discount-demo', {
    layout: 'layouts/admin',
    title: 'Discount calculator (demo)',
    rooms,
    result: null,
    query: req.query,
  });
});

router.post('/meeting-rooms/discount-demo', requireValidCsrf, async (req, res) => {
  const hours = Math.max(0.25, Number(req.body.hours || 1));
  const durationMinutes = Math.round(hours * 60);
  const roomId = String(req.body.room_id || '').trim();
  const hourly = Math.max(0, Math.floor(Number(req.body.hourly_rate_cents || 100000)));
  let tiers;
  if (isUuid(roomId)) {
    tiers = await loadDiscountTiers(pool, roomId);
  } else {
    const { rows } = await pool.query(
      `SELECT * FROM room_discount_tiers
       WHERE deleted_at IS NULL AND active = true AND meeting_room_id IS NULL
       ORDER BY min_hours ASC, sort_order`
    );
    tiers = rows;
  }
  const quote = computeRoomQuote({ hourly_rate_cents: hourly, durationMinutes }, tiers);
  const { rows: rooms } = await pool.query(
    `SELECT id, name FROM meeting_rooms WHERE deleted_at IS NULL ORDER BY sort_order, name`
  );
  res.render('admin/meeting-rooms-discount-demo', {
    layout: 'layouts/admin',
    title: 'Discount calculator (demo)',
    rooms,
    result: { hours, durationMinutes, quote, roomId, hourly_rate_cents: hourly },
    query: req.query,
  });
});

async function saveWeeklySchedule(q, roomId, body) {
  for (let wd = 0; wd <= 6; wd++) {
    const open = body[`wd_${wd}_open`] === '1' || body[`wd_${wd}_open`] === 'on';
    const fromT = String(body[`wd_${wd}_from`] || '').trim() || '09:00';
    const toT = String(body[`wd_${wd}_to`] || '').trim() || '18:00';
    await q.query(
      `UPDATE room_availability_schedule SET deleted_at = now(), updated_at = now()
       WHERE meeting_room_id = $1::uuid AND weekday = $2 AND deleted_at IS NULL`,
      [roomId, wd]
    );
    await q.query(
      `INSERT INTO room_availability_schedule (meeting_room_id, weekday, is_open, opens_at, closes_at, effective_from)
       VALUES ($1::uuid, $2, $3, $4::time, $5::time, CURRENT_DATE)`,
      [roomId, wd, open, fromT, toT]
    );
  }
}

module.exports = router;
