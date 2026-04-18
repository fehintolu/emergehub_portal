const crypto = require('crypto');
const { computeRoomQuote } = require('./roomQuote');
const { assertSlotBookable } = require('./roomSlot');
const { lockAvailableCreditMinutes, splitQuoteWithCredits, addUsedMinutes } = require('./meetingCredits');

async function loadDiscountTiers(client, roomId) {
  const { rows } = await client.query(
    `SELECT * FROM room_discount_tiers
     WHERE deleted_at IS NULL AND active = true
       AND (meeting_room_id IS NULL OR meeting_room_id = $1::uuid)
     ORDER BY meeting_room_id NULLS LAST, min_hours ASC, sort_order`,
    [roomId]
  );
  return rows;
}

/**
 * @returns {Promise<{ bookingId: string, invoiceId: string, bookingRef: string, quote: object, credit_minutes_used: number, payable_cents: number, credit_value_cents: number }>}
 */
async function createRoomBookingWithInvoice(
  client,
  {
    memberId,
    roomRow,
    startsAt,
    endsAt,
    purpose,
    invoiceNumber,
    dueDateStr,
    fullDay = false,
  }
) {
  const durationMinutes = Math.max(
    1,
    Math.round((endsAt.getTime() - startsAt.getTime()) / 60000)
  );
  const tiers = await loadDiscountTiers(client, roomRow.id);
  const consumes = roomRow.consumes_plan_credits !== false;
  const quote = computeRoomQuote(
    {
      hourly_rate_cents: roomRow.hourly_rate_cents,
      full_day_rate_cents: roomRow.full_day_rate_cents,
      durationMinutes,
    },
    tiers,
    { fullDay: Boolean(fullDay) }
  );

  let creditMinutesUsed = 0;
  let creditValueCents = 0;
  let payableCents = quote.total_cents;
  let periodMonth = null;

  if (consumes && quote.total_cents > 0) {
    const lock = await lockAvailableCreditMinutes(client, memberId);
    periodMonth = lock.period_month;
    const split = splitQuoteWithCredits(
      quote.total_cents,
      durationMinutes,
      lock.available,
      true
    );
    creditMinutesUsed = split.credit_minutes_used;
    creditValueCents = split.credit_value_cents;
    payableCents = split.payable_cents;
  }

  await assertSlotBookable(client, roomRow.id, startsAt, endsAt);

  const bookingRef = `RB-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  const { rows: dl } = await client.query(`SELECT (now() + interval '2 hours') AS t`);
  const paymentDeadlineAt = dl[0].t;
  const roomName = roomRow.name || 'Meeting room';
  const notes =
    `Meeting room booking (${roomName}). Complete payment within 2 hours to hold this slot. Reference: ${bookingRef}.` +
    (creditMinutesUsed > 0
      ? ` ${creditMinutesUsed} minutes covered by plan meeting credits.`
      : '');

  const insInv = await client.query(
    `INSERT INTO invoices (member_id, invoice_number, status, subtotal_cents, total_cents, due_date, notes, service_request_id)
     VALUES ($1, $2, 'sent', $3, $4, $5::date, $6, NULL)
     RETURNING id`,
    [memberId, invoiceNumber, payableCents, payableCents, dueDateStr, notes]
  );
  const invoiceId = insInv.rows[0].id;

  const lineDesc =
    `${roomName} — ${durationMinutes} min${quote.full_day ? ' (full day rate)' : ''}` +
    (creditValueCents > 0 ? ` · after plan credits` : '');
  await client.query(
    `INSERT INTO invoice_items (invoice_id, description, amount_cents, sort_order)
     VALUES ($1, $2, $3, 0)`,
    [invoiceId, lineDesc, payableCents]
  );

  const insB = await client.query(
    `INSERT INTO room_bookings (
       meeting_room_id, member_id, starts_at, ends_at, status, invoice_id, booking_reference, purpose,
       base_cents, discount_cents, total_cents, discount_tier_id, duration_minutes, payment_deadline_at, created_by_admin,
       credit_minutes_applied, payable_cents, credit_value_cents, credit_period_month
     ) VALUES ($1, $2, $3, $4, 'pending_payment', $5, $6, $7, $8, $9, $10, $11, $12, $13, false, $14, $15, $16, $17)
     RETURNING id`,
    [
      roomRow.id,
      memberId,
      startsAt,
      endsAt,
      invoiceId,
      bookingRef,
      purpose || null,
      quote.base_cents,
      quote.discount_cents,
      quote.total_cents,
      quote.discount_tier_id,
      durationMinutes,
      paymentDeadlineAt,
      creditMinutesUsed,
      payableCents,
      creditValueCents,
      creditMinutesUsed > 0 ? periodMonth : null,
    ]
  );
  const bookingId = insB.rows[0].id;

  if (creditMinutesUsed > 0 && periodMonth) {
    await addUsedMinutes(
      client,
      memberId,
      periodMonth,
      creditMinutesUsed,
      'room_booking_pending',
      bookingId
    );
  }

  return {
    bookingId,
    invoiceId,
    bookingRef,
    quote,
    durationMinutes,
    credit_minutes_used: creditMinutesUsed,
    payable_cents: payableCents,
    credit_value_cents: creditValueCents,
  };
}

module.exports = {
  loadDiscountTiers,
  createRoomBookingWithInvoice,
};
