const cron = require('node-cron');
const { pool } = require('./db');
const { notifyMember } = require('./notifications');
const { releaseUsedMinutes, runMonthlyCreditResetJob } = require('./meetingCredits');
const { resetDailyAccessAssignments, sendAssignmentEndingReminders } = require('./capacityAssignment');
const { runExpireStaleWaitlistOffersJob } = require('./capacityWaitlist');

async function expirePendingRoomBookings() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT rb.id, rb.member_id, rb.booking_reference, rb.invoice_id, rb.credit_minutes_applied,
              rb.credit_period_month, mr.name AS room_name
       FROM room_bookings rb
       JOIN meeting_rooms mr ON mr.id = rb.meeting_room_id
       WHERE rb.deleted_at IS NULL AND rb.status = 'pending_payment'
         AND rb.payment_deadline_at IS NOT NULL AND rb.payment_deadline_at < now()
       FOR UPDATE OF rb`
    );
    for (const b of rows) {
      const cm = Math.max(0, Math.floor(Number(b.credit_minutes_applied) || 0));
      const pm = b.credit_period_month;
      if (cm > 0 && b.member_id && pm) {
        await releaseUsedMinutes(client, b.member_id, pm, cm, 'room_booking_expired', b.id);
      }
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
  const tz = process.env.PORTAL_TZ || 'Africa/Lagos';
  cron.schedule('*/15 * * * *', () => {
    expirePendingRoomBookings().catch((e) => console.error(e));
    sendRoomPaymentWarnings().catch((e) => console.error(e));
  });
  cron.schedule('5 8 * * *', () => {
    sendServiceEndReminders().catch((e) => console.error(e));
  });
  cron.schedule('0 0 1 * *', () => {
    runMonthlyCreditResetJob().catch((e) => console.error(e));
  });
  cron.schedule('15 0 * * *', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await resetDailyAccessAssignments(c);
      await c.query('COMMIT');
    } catch (e) {
      try {
        await c.query('ROLLBACK');
      } catch (_) {
        /* ignore */
      }
      console.error('resetDailyAccessAssignments job', e);
    } finally {
      c.release();
    }
  });
  cron.schedule('30 8 * * *', () => {
    sendAssignmentEndingReminders(pool).catch((e) => console.error('sendAssignmentEndingReminders', e));
  });
  cron.schedule('0 12 * * *', () => {
    runExpireStaleWaitlistOffersJob().catch((e) => console.error(e));
  });
  console.log(
    `portal cron: enabled (15m room expiry/warnings, 08:05 service reminders, credits 1st 00:00, daily access 00:15, assignment reminders 08:30, waitlist noon). Hub TZ label: ${tz} (schedules use server clock; set PORTAL_TZ for docs/consistency).`
  );
}

module.exports = { startPortalCron, expirePendingRoomBookings, sendRoomPaymentWarnings, sendServiceEndReminders };
