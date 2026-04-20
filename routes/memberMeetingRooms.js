const express = require('express');
const { pool } = require('../lib/db');
const { requireValidCsrf } = require('../lib/csrf');
const { formatNgn, formatDate, formatDateTime } = require('../lib/format');
const { nextInvoiceNumber } = require('../lib/invoiceNumber');
const { getSetting } = require('../lib/portalSettings');
const { unreadCount } = require('../lib/notifications');
const { logActivity } = require('../lib/activity');
const { sendServiceRequestInvoiceNotifications } = require('../lib/serviceRequestInvoice');
const { computeRoomQuote, portalTz } = require('../lib/roomQuote');
const { assertSlotBookable } = require('../lib/roomSlot');
const { loadDiscountTiers, createRoomBookingWithInvoice } = require('../lib/roomBookingInvoice');
const { getAvailableCreditMinutes, splitQuoteWithCredits } = require('../lib/meetingCredits');
const { listAvailableSlotStarts } = require('../lib/roomAvailableSlots');
const { getDayTimeline } = require('../lib/roomDayTimeline');
const { getMonthDayStates } = require('../lib/roomMonthAvailability');

const router = express.Router();
/** Middleware is applied by `memberArea` when this router is mounted there. */

function isUuid(s) {
  return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

function myBookingsSummary(rows) {
  const now = new Date();
  const y = now.getFullYear();
  const mon = now.getMonth();
  let pendingCount = 0;
  let pendingCents = 0;
  let confirmedUpcoming = 0;
  let cancelledThisMonth = 0;
  let totalSpentConfirmed = 0;

  (rows || []).forEach((r) => {
    const st = String(r.status || '').toLowerCase();
    if (st === 'pending_payment') {
      pendingCount += 1;
      pendingCents += Number(r.total_cents || 0);
    }
    if (st === 'confirmed') {
      totalSpentConfirmed += Number(r.total_cents || 0);
      if (new Date(r.starts_at) >= now) confirmedUpcoming += 1;
    }
    if (st === 'cancelled' || st === 'expired') {
      const ca = r.cancelled_at
        ? new Date(r.cancelled_at)
        : r.updated_at
          ? new Date(r.updated_at)
          : null;
      if (ca && ca.getFullYear() === y && ca.getMonth() === mon) {
        cancelledThisMonth += 1;
      }
    }
  });

  return {
    pendingCount,
    pendingCents,
    confirmedUpcoming,
    cancelledThisMonth,
    totalSpentConfirmed,
  };
}

router.get('/meeting-rooms/my-bookings', async (req, res) => {
  const m = res.locals.currentMember;
  const { rows } = await pool.query(
    `SELECT rb.*, mr.name AS room_name, mr.capacity AS room_capacity
     FROM room_bookings rb
     JOIN meeting_rooms mr ON mr.id = rb.meeting_room_id
     WHERE rb.member_id = $1 AND rb.deleted_at IS NULL
     ORDER BY rb.starts_at DESC
     LIMIT 100`,
    [m.id]
  );
  const enriched = rows.map((r) => {
    const st = String(r.status || '').toLowerCase();
    let holdSec = null;
    if (st === 'pending_payment' && r.payment_deadline_at) {
      holdSec = Math.max(
        0,
        Math.floor((new Date(r.payment_deadline_at).getTime() - Date.now()) / 1000)
      );
    }
    return { ...r, _holdSec: holdSec };
  });
  const mrbSummary = myBookingsSummary(rows);
  res.render('member/meeting-rooms-my-bookings', {
    layout: 'layouts/member',
    title: 'My Room Bookings',
    pageSub: 'Hold, pay, and manage your meeting room reservations',
    rows: enriched,
    mrbSummary,
    showBookRoomCta: true,
    formatDate,
    formatDateTime,
    formatNgn,
    notifCount: await unreadCount(m.id),
    query: req.query,
  });
});

router.get('/meeting-rooms/bookings/:bookingId/confirmation', async (req, res) => {
  const m = res.locals.currentMember;
  const bid = req.params.bookingId;
  if (!isUuid(bid)) return res.status(404).send('Not found');
  const { rows } = await pool.query(
    `SELECT rb.*, mr.name AS room_name, mr.description AS room_description
     FROM room_bookings rb
     JOIN meeting_rooms mr ON mr.id = rb.meeting_room_id
     WHERE rb.id = $1::uuid AND rb.member_id = $2 AND rb.deleted_at IS NULL`,
    [bid, m.id]
  );
  const b = rows[0];
  if (!b) return res.status(404).send('Not found');
  res.render('member/meeting-room-confirmation', {
    layout: 'layouts/member',
    title: 'Booking confirmation',
    pageSub: b.booking_reference,
    b,
    formatDate,
    formatDateTime,
    formatNgn,
    notifCount: await unreadCount(m.id),
  });
});

router.post('/meeting-rooms/bookings/:bookingId/cancel', requireValidCsrf, async (req, res) => {
  const m = res.locals.currentMember;
  const bid = req.params.bookingId;
  if (!isUuid(bid)) return res.status(404).send('Not found');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT rb.*, i.status AS invoice_status
       FROM room_bookings rb
       LEFT JOIN invoices i ON i.id = rb.invoice_id AND i.deleted_at IS NULL
       WHERE rb.id = $1::uuid AND rb.member_id = $2 AND rb.deleted_at IS NULL
       FOR UPDATE OF rb`,
      [bid, m.id]
    );
    const b = rows[0];
    if (!b) {
      await client.query('ROLLBACK');
      return res.redirect('/meeting-rooms/my-bookings?err=notfound');
    }
    if (b.status === 'cancelled' || b.status === 'expired') {
      await client.query('ROLLBACK');
      return res.redirect('/meeting-rooms/my-bookings?err=state');
    }

    const reason = String(req.body.reason || '').trim() || 'Cancelled by member';

    if (b.status === 'pending_payment') {
      await client.query(
        `UPDATE room_bookings SET status = 'cancelled', cancelled_at = now(), cancellation_reason = $2, updated_at = now()
         WHERE id = $1::uuid`,
        [bid, reason]
      );
      if (b.invoice_id) {
        await client.query(
          `UPDATE invoices SET status = 'cancelled', updated_at = now()
           WHERE id = $1::uuid AND member_id = $2::uuid
             AND status IN ('unpaid', 'sent', 'overdue', 'awaiting_confirmation')`,
          [b.invoice_id, m.id]
        );
      }
      await client.query('COMMIT');
      return res.redirect('/meeting-rooms/my-bookings?msg=cancelled');
    }

    if (b.status !== 'confirmed') {
      await client.query('ROLLBACK');
      return res.redirect('/meeting-rooms/my-bookings?err=state');
    }

    const hoursUntil = (new Date(b.starts_at).getTime() - Date.now()) / (3600 * 1000);
    if (hoursUntil < 24) {
      await client.query('ROLLBACK');
      return res.redirect('/meeting-rooms/my-bookings?err=24h');
    }

    await client.query(
      `UPDATE room_bookings SET status = 'cancelled', cancelled_at = now(), cancellation_reason = $2, updated_at = now()
       WHERE id = $1::uuid`,
      [bid, reason]
    );
    await client.query(
      `INSERT INTO credit_notes (member_id, source_invoice_id, room_booking_id, amount_cents, reason, created_by_admin_id)
       VALUES ($1, $2, $3, $4, $5, NULL)`,
      [m.id, b.invoice_id || null, b.id, b.total_cents, reason]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    return res.redirect('/meeting-rooms/my-bookings?err=server');
  } finally {
    client.release();
  }
  res.redirect('/meeting-rooms/my-bookings?msg=credit');
});

router.get('/meeting-rooms', async (req, res) => {
  const m = res.locals.currentMember;
  const { rows } = await pool.query(
    `SELECT id, name, description, capacity, hourly_rate_cents, full_day_rate_cents,
            amenities, photo_path, room_product_kind, consumes_plan_credits, slug
     FROM meeting_rooms
     WHERE active = true AND deleted_at IS NULL
     ORDER BY sort_order, name`
  );
  res.render('member/meeting-rooms-index', {
    layout: 'layouts/member',
    title: 'Meeting rooms',
    pageSub: 'Book a room with instant pricing and online payment',
    rooms: rows,
    formatNgn,
    notifCount: await unreadCount(m.id),
  });
});

router.get('/meeting-rooms/:roomId/quote', async (req, res) => {
  const roomId = req.params.roomId;
  if (!isUuid(roomId)) return res.status(404).json({ ok: false, error: 'not_found' });
  const starts = new Date(String(req.query.starts_at || ''));
  const durationMinutes = Math.max(1, Math.floor(Number(req.query.duration_minutes || 60)));
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
  const fullDay = String(req.query.full_day || '') === '1';
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
  const m = res.locals.currentMember;
  let credits = null;
  if (m && rm[0].consumes_plan_credits !== false && quote.total_cents > 0) {
    const bal = await getAvailableCreditMinutes(pool, m.id);
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

router.get('/meeting-rooms/:roomId/slots', async (req, res) => {
  const roomId = req.params.roomId;
  if (!isUuid(roomId)) return res.status(404).json({ ok: false, error: 'not_found' });
  const date = String(req.query.date || '');
  const durationMinutes = Math.max(15, Math.floor(Number(req.query.duration_minutes || 60)));
  const { rows: rm } = await pool.query(
    `SELECT id FROM meeting_rooms WHERE id = $1::uuid AND active = true AND deleted_at IS NULL`,
    [roomId]
  );
  if (!rm[0]) return res.status(404).json({ ok: false, error: 'not_found' });
  try {
    const r = await listAvailableSlotStarts(pool, roomId, date, durationMinutes);
    return res.json({ ok: true, ...r });
  } catch (e) {
    if (e.code === 'BAD_DATE') return res.status(400).json({ ok: false, error: 'bad_date' });
    console.error(e);
    return res.status(500).json({ ok: false, error: 'server' });
  }
});

router.get('/meeting-rooms/:roomId/availability-month', async (req, res) => {
  const roomId = req.params.roomId;
  if (!isUuid(roomId)) return res.status(404).json({ ok: false, error: 'not_found' });
  const y = Math.floor(Number(req.query.year));
  const m = Math.floor(Number(req.query.month));
  if (!Number.isFinite(y) || y < 2000 || y > 2100 || !Number.isFinite(m) || m < 1 || m > 12) {
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
    const out = await getMonthDayStates(pool, roomId, y, m, md[0].min_date);
    return res.json({ ok: true, ...out });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: 'server' });
  }
});

router.get('/meeting-rooms/:roomId/day-blocks', async (req, res) => {
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

router.get('/meeting-rooms/:roomId/busy', async (req, res) => {
  const roomId = req.params.roomId;
  if (!isUuid(roomId)) return res.status(404).json({ ok: false });
  const from = new Date(String(req.query.from || ''));
  const to = new Date(String(req.query.to || ''));
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
    return res.status(400).json({ ok: false, error: 'range' });
  }
  const maxSpan = 40 * 24 * 3600 * 1000;
  if (to.getTime() - from.getTime() > maxSpan) {
    return res.status(400).json({ ok: false, error: 'span' });
  }
  const { rows: bk } = await pool.query(
    `SELECT starts_at, ends_at, 'booking' AS kind, status
     FROM room_bookings
     WHERE meeting_room_id = $1::uuid AND deleted_at IS NULL
       AND status IN ('confirmed', 'pending_payment')
       AND starts_at < $3::timestamptz AND ends_at > $2::timestamptz`,
    [roomId, from, to]
  );
  const { rows: bl } = await pool.query(
    `SELECT starts_at, ends_at, 'block' AS kind
     FROM room_blocked_slots
     WHERE meeting_room_id = $1::uuid AND deleted_at IS NULL
       AND starts_at < $3::timestamptz AND ends_at > $2::timestamptz`,
    [roomId, from, to]
  );
  res.json({
    ok: true,
    busy: [...bk, ...bl].map((r) => ({
      starts_at: r.starts_at,
      ends_at: r.ends_at,
      kind: r.kind,
      status: r.status || null,
    })),
  });
});

router.get('/meeting-rooms/:roomId', async (req, res) => {
  const m = res.locals.currentMember;
  const roomId = req.params.roomId;
  if (!isUuid(roomId)) return res.status(404).send('Not found');
  const { rows } = await pool.query(
    `SELECT * FROM meeting_rooms WHERE id = $1::uuid AND active = true AND deleted_at IS NULL`,
    [roomId]
  );
  const room = rows[0];
  if (!room) return res.status(404).send('Not found');
  const tiers = await loadDiscountTiers(pool, roomId);
  const { rows: md } = await pool.query(
    `SELECT to_char((now() AT TIME ZONE $1::text)::date, 'YYYY-MM-DD') AS min_date`,
    [portalTz()]
  );
  res.render('member/meeting-room-detail', {
    layout: 'layouts/member',
    title: room.name,
    pageSub: 'Choose a day, then your time range — hub time (' + portalTz() + ')',
    room,
    tiers,
    formatNgn,
    notifCount: await unreadCount(m.id),
    query: req.query,
    minBookDate: md[0].min_date,
    portalTzName: portalTz(),
  });
});

router.post('/meeting-rooms/:roomId/book', requireValidCsrf, async (req, res) => {
  const m = res.locals.currentMember;
  const roomId = req.params.roomId;
  const jsonOut = String(req.get('Accept') || '').includes('application/json');

  function sendSlotConflict() {
    if (jsonOut) {
      return res.status(409).json({ ok: false, error: 'slot_taken' });
    }
    return res.redirect(`/meeting-rooms/${roomId}?err=slot`);
  }
  function sendBadTime() {
    if (jsonOut) {
      return res.status(400).json({ ok: false, error: 'bad_time' });
    }
    return res.redirect(`/meeting-rooms/${roomId}?err=time`);
  }
  if (!isUuid(roomId)) {
    if (jsonOut) return res.status(404).json({ ok: false, error: 'not_found' });
    return res.status(404).send('Not found');
  }
  const starts = new Date(String(req.body.starts_at || ''));
  const durationMinutes = Math.max(1, Math.floor(Number(req.body.duration_minutes || 60)));
  const purpose = String(req.body.purpose || '').trim();
  const fullDay = String(req.body.full_day || '') === '1';
  if (Number.isNaN(starts.getTime())) {
    return sendBadTime();
  }
  const ends = new Date(starts.getTime() + durationMinutes * 60 * 1000);

  const { rows: rm } = await pool.query(
    `SELECT * FROM meeting_rooms WHERE id = $1::uuid AND active = true AND deleted_at IS NULL`,
    [roomId]
  );
  const room = rm[0];
  if (!room) {
    if (jsonOut) return res.status(404).json({ ok: false, error: 'not_found' });
    return res.status(404).send('Not found');
  }

  const dueDays = Number((await getSetting('default_invoice_due_days', '7')) || 7) || 7;
  const due = new Date();
  due.setDate(due.getDate() + dueDays);
  const dueStr = due.toISOString().slice(0, 10);
  const invNo = await nextInvoiceNumber();

  const client = await pool.connect();
  let summary;
  try {
    await client.query('BEGIN');
    summary = await createRoomBookingWithInvoice(client, {
      memberId: m.id,
      roomRow: room,
      startsAt: starts,
      endsAt: ends,
      purpose,
      invoiceNumber: invNo,
      dueDateStr: dueStr,
      fullDay,
    });
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    const slotErr =
      e.code === 'OVERLAP' || e.code === 'BLOCK' || e.code === 'HOURS' || e.code === 'SCHEDULE';
    if (slotErr) return sendSlotConflict();
    const q = 'book';
    if (jsonOut) return res.status(500).json({ ok: false, error: q });
    return res.redirect(`/meeting-rooms/${roomId}?err=${q}`);
  } finally {
    client.release();
  }

  await logActivity({
    memberId: m.id,
    eventType: 'booking',
    title: 'Meeting room booking',
    body: room.name,
    entityType: 'room_booking',
    entityId: summary.bookingId,
  });

  const billingPath = `/billing?invoice=${encodeURIComponent(summary.invoiceId)}`;
  await sendServiceRequestInvoiceNotifications({
    memberId: m.id,
    memberEmail: m.email,
    memberName: m.full_name,
    notifyInvoiceEmail: m.notify_email_invoice,
    invoiceNumber: invNo,
    amountCents: summary.payable_cents,
    invId: summary.invoiceId,
    dueDateStr: dueStr,
    serviceRequestId: null,
    title: 'Invoice for meeting room',
    message: `Invoice ${invNo} for ${room.name}. Pay within 2 hours to confirm your slot.`,
    linkUrl: billingPath,
    billingPath,
  });

  const redirectUrl = `${billingPath}&booked=1&ref=${encodeURIComponent(summary.bookingRef)}`;
  if (jsonOut) {
    return res.json({ ok: true, redirect: redirectUrl });
  }
  return res.redirect(redirectUrl);
});

module.exports = router;
