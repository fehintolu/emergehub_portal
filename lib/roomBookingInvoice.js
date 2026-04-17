const crypto = require('crypto');
const { computeRoomQuote } = require('./roomQuote');
const { assertSlotBookable } = require('./roomSlot');

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
 * @returns {Promise<{ bookingId: string, invoiceId: string, bookingRef: string, quote: object }>}
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
  }
) {
  const durationMinutes = Math.max(
    1,
    Math.round((endsAt.getTime() - startsAt.getTime()) / 60000)
  );
  const tiers = await loadDiscountTiers(client, roomRow.id);
  const quote = computeRoomQuote(
    { hourly_rate_cents: roomRow.hourly_rate_cents, durationMinutes },
    tiers
  );

  await assertSlotBookable(client, roomRow.id, startsAt, endsAt);

  const bookingRef = `RB-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  const { rows: dl } = await client.query(`SELECT (now() + interval '2 hours') AS t`);
  const paymentDeadlineAt = dl[0].t;
  const roomName = roomRow.name || 'Meeting room';
  const notes = `Meeting room booking (${roomName}). Complete payment within 2 hours to hold this slot. Reference: ${bookingRef}.`;

  const insInv = await client.query(
    `INSERT INTO invoices (member_id, invoice_number, status, subtotal_cents, total_cents, due_date, notes, service_request_id)
     VALUES ($1, $2, 'sent', $3, $4, $5::date, $6, NULL)
     RETURNING id`,
    [
      memberId,
      invoiceNumber,
      quote.base_cents,
      quote.total_cents,
      dueDateStr,
      notes,
    ]
  );
  const invoiceId = insInv.rows[0].id;

  await client.query(
    `INSERT INTO invoice_items (invoice_id, description, amount_cents, sort_order)
     VALUES ($1, $2, $3, 0)`,
    [invoiceId, `${roomName} — ${durationMinutes} minutes`, quote.base_cents]
  );
  if (quote.discount_cents > 0) {
    await client.query(
      `INSERT INTO invoice_items (invoice_id, description, amount_cents, sort_order)
       VALUES ($1, $2, $3, 1)`,
      [
        invoiceId,
        `Volume discount${quote.discount_tier_label ? ` (${quote.discount_tier_label})` : ''}`,
        -quote.discount_cents,
      ]
    );
  }

  const insB = await client.query(
    `INSERT INTO room_bookings (
       meeting_room_id, member_id, starts_at, ends_at, status, invoice_id, booking_reference, purpose,
       base_cents, discount_cents, total_cents, discount_tier_id, duration_minutes, payment_deadline_at, created_by_admin
     ) VALUES ($1, $2, $3, $4, 'pending_payment', $5, $6, $7, $8, $9, $10, $11, $12, $13, false)
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
    ]
  );

  return {
    bookingId: insB.rows[0].id,
    invoiceId,
    bookingRef,
    quote,
    durationMinutes,
  };
}

module.exports = {
  loadDiscountTiers,
  createRoomBookingWithInvoice,
};
