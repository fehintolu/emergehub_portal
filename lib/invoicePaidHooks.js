const { applyPaidInvoiceAccessWindow } = require('./serviceRequestAccess');
const { notifyMember } = require('./notifications');
const { logActivity } = require('./activity');
const { sendServicePaymentInitiatedEmail } = require('./mail');

/**
 * Run after an invoice is set to `paid` inside an open transaction.
 * - Workspace access window (plan duration) via applyPaidInvoiceAccessWindow
 * - Linked service requests → In Progress + timeline + notify + email
 * - Linked room_bookings → confirmed
 */
async function onInvoicePaid(client, invoiceId, accessStartsAt) {
  await applyPaidInvoiceAccessWindow(client, invoiceId, accessStartsAt);

  const { rows: invRows } = await client.query(
    `SELECT i.* FROM invoices i WHERE i.id = $1::uuid AND i.deleted_at IS NULL`,
    [invoiceId]
  );
  const inv = invRows[0];
  if (!inv) return;

  const srIdSet = new Set();
  const linkQ = await client.query(
    `SELECT service_request_id FROM invoice_service_links
     WHERE invoice_id = $1::uuid AND deleted_at IS NULL`,
    [invoiceId]
  );
  linkQ.rows.forEach((r) => srIdSet.add(r.service_request_id));
  if (inv.service_request_id) srIdSet.add(inv.service_request_id);
  const revQ = await client.query(
    `SELECT id FROM service_requests WHERE invoice_id = $1::uuid AND deleted_at IS NULL`,
    [invoiceId]
  );
  revQ.rows.forEach((r) => srIdSet.add(r.id));

  const base = process.env.BASE_URL || '';

  for (const srId of srIdSet) {
    const { rows: srRows } = await client.query(
      `SELECT sr.*, sv.name AS service_name
       FROM service_requests sr
       JOIN services sv ON sv.id = sr.service_id
       WHERE sr.id = $1::uuid AND sr.deleted_at IS NULL`,
      [srId]
    );
    const sr = srRows[0];
    if (!sr) continue;
    if (!['Submitted', 'Under Review'].includes(sr.status)) continue;

    await client.query(
      `UPDATE service_requests SET status = 'In Progress', updated_at = now() WHERE id = $1::uuid`,
      [srId]
    );
    await client.query(
      `INSERT INTO service_request_updates (service_request_id, stage, note, visible_to_member)
       VALUES ($1::uuid, 'In Progress', $2, true)`,
      [srId, 'Payment confirmed. Service has been initiated.']
    );

    await notifyMember(
      {
        memberId: sr.member_id,
        title: 'Service in progress',
        message: `Your ${sr.service_name || 'service'} request is now in progress.`,
        linkUrl: `/services/${srId}`,
      },
      client
    );
    await logActivity(
      {
        memberId: sr.member_id,
        eventType: 'service',
        title: 'Payment confirmed — service started',
        body: sr.service_name || 'Service',
        entityType: 'service_request',
        entityId: srId,
      },
      client
    );

    const { rows: memRows } = await client.query(
      `SELECT email, full_name, notify_email_service FROM members WHERE id = $1`,
      [sr.member_id]
    );
    const mem = memRows[0];
    if (mem && mem.email && mem.notify_email_service) {
      try {
        await sendServicePaymentInitiatedEmail({
          to: mem.email,
          name: mem.full_name,
          serviceName: sr.service_name || 'Service',
          serviceRequestId: srId,
          portalUrl: base,
        });
      } catch (e) {
        console.error('sendServicePaymentInitiatedEmail', e.message);
      }
    }
  }

  const rbUp = await client.query(
    `UPDATE room_bookings
     SET status = 'confirmed', updated_at = now()
     WHERE invoice_id = $1::uuid AND status = 'pending_payment' AND deleted_at IS NULL
     RETURNING id, member_id, meeting_room_id, starts_at, ends_at, booking_reference`,
    [invoiceId]
  );
  for (const b of rbUp.rows) {
    const { rows: rm } = await client.query(`SELECT name FROM meeting_rooms WHERE id = $1`, [
      b.meeting_room_id,
    ]);
    const roomName = rm[0]?.name || 'Meeting room';
    if (b.member_id) {
      await notifyMember(
        {
          memberId: b.member_id,
          title: 'Meeting room booking confirmed',
          message: `Your booking for ${roomName} is confirmed. Ref: ${b.booking_reference}.`,
          linkUrl: '/meeting-rooms/my-bookings',
        },
        client
      );
      await logActivity(
        {
          memberId: b.member_id,
          eventType: 'booking',
          title: 'Room booking confirmed',
          body: b.booking_reference,
          entityType: 'room_booking',
          entityId: b.id,
        },
        client
      );
    }
  }
}

module.exports = { onInvoicePaid };
