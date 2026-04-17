const cron = require('node-cron');
const { pool } = require('./db');
const { notifyMember } = require('./notifications');

async function expirePendingRoomBookings() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT rb.id, rb.member_id, rb.booking_reference, rb.invoice_id, mr.name AS room_name
       FROM room_bookings rb
       JOIN meeting_rooms mr ON mr.id = rb.meeting_room_id
       WHERE rb.deleted_at IS NULL AND rb.status = 'pending_payment'
         AND rb.payment_deadline_at IS NOT NULL AND rb.payment_deadline_at < now()
       FOR UPDATE OF rb`
    );
    for (const b of rows) {
      await client.query(
        `UPDATE room_bookings SET status = 'expired', updated_at = now() WHERE id = $1::uuid`,
        [b.id]
      );
      if (b.invoice_id) {
        await client.query(
          `UPDATE invoices SET status = 'cancelled', updated_at = now()
           WHERE id = $1::uuid AND status IN ('unpaid', 'sent', 'overdue', 'awaiting_confirmation')`,
          [b.invoice_id]
        );
        await client.query(
          `UPDATE payments SET status = 'cancelled', updated_at = now()
           WHERE invoice_id = $1::uuid AND status = 'pending'`,
          [b.invoice_id]
        );
      }
      if (b.member_id) {
        await notifyMember(
          {
            memberId: b.member_id,
            title: 'Meeting room hold expired',
            message: `Payment window closed for ${b.room_name} (${b.booking_reference}).`,
            linkUrl: '/meeting-rooms/my-bookings',
          },
          client
        );
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('expirePendingRoomBookings', e);
  } finally {
    client.release();
  }
}

async function sendRoomPaymentWarnings() {
  const { rows } = await pool.query(
    `SELECT rb.id, rb.member_id, rb.booking_reference, rb.payment_deadline_at, mr.name AS room_name
     FROM room_bookings rb
     JOIN meeting_rooms mr ON mr.id = rb.meeting_room_id
     WHERE rb.deleted_at IS NULL AND rb.status = 'pending_payment'
       AND rb.payment_warning_sent = false
       AND rb.payment_deadline_at IS NOT NULL
       AND rb.payment_deadline_at - interval '30 minutes' <= now()
       AND rb.payment_deadline_at - interval '15 minutes' > now()`
  );
  for (const b of rows) {
    if (!b.member_id) continue;
    await notifyMember({
      memberId: b.member_id,
      title: 'Meeting room payment reminder',
      message: `Pay soon to keep ${b.room_name} (${b.booking_reference}). Deadline ${new Date(
        b.payment_deadline_at
      ).toLocaleString('en-GB')}.`,
      linkUrl: '/billing',
    });
    await pool.query(
      `UPDATE room_bookings SET payment_warning_sent = true, updated_at = now() WHERE id = $1::uuid`,
      [b.id]
    );
  }
}

async function sendServiceEndReminders() {
  const { rows } = await pool.query(
    `SELECT r.id, r.service_request_id, r.remind_at, sr.member_id, sr.title, sv.name AS service_name
     FROM service_request_reminders r
     JOIN service_requests sr ON sr.id = r.service_request_id AND sr.deleted_at IS NULL
     JOIN services sv ON sv.id = sr.service_id
     WHERE r.deleted_at IS NULL AND r.sent_at IS NULL
       AND r.remind_at <= (now() AT TIME ZONE 'UTC')::date`
  );
  for (const row of rows) {
    await notifyMember({
      memberId: row.member_id,
      title: 'Service reminder',
      message: `Reminder: ${row.service_name || row.title || 'Your service'} — check your portal for dates and next steps.`,
      linkUrl: row.service_request_id ? `/services/${row.service_request_id}` : '/services',
    });
    await pool.query(`UPDATE service_request_reminders SET sent_at = now() WHERE id = $1::uuid`, [row.id]);
  }
}

function startPortalCron() {
  if (process.env.ENABLE_CRON !== '1') return;
  cron.schedule('*/15 * * * *', () => {
    expirePendingRoomBookings().catch((e) => console.error(e));
    sendRoomPaymentWarnings().catch((e) => console.error(e));
  });
  cron.schedule('5 8 * * *', () => {
    sendServiceEndReminders().catch((e) => console.error(e));
  });
  console.log('portal cron: enabled (15m room expiry/warnings, 08:05 daily reminders)');
}

module.exports = { startPortalCron, expirePendingRoomBookings, sendRoomPaymentWarnings, sendServiceEndReminders };
