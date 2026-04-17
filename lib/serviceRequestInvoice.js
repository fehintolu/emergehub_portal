const { formatNgn } = require('./format');
const { sendInvoiceCreatedEmail } = require('./mail');
const { notifyMember } = require('./notifications');
const { logActivity } = require('./activity');

/**
 * Inside an open transaction `client`: create invoice, line item, link service_requests,
 * and add a member-visible timeline note. Caller supplies invoice_number and due_date.
 */
async function createServiceRequestInvoiceInTx(
  client,
  {
    memberId,
    serviceRequestId,
    serviceName,
    priceCents,
    invoiceNumber,
    dueDateStr,
    lineDescription,
    notesExtra,
  }
) {
  const amount = Number(priceCents) || 0;
  if (amount <= 0) return null;

  const line =
    lineDescription || `${serviceName} — service request`;
  let notes = `Service: ${serviceName}`;
  if (notesExtra) notes += notesExtra;

  const ins = await client.query(
    `INSERT INTO invoices (member_id, invoice_number, status, subtotal_cents, total_cents, due_date, notes, service_request_id)
     VALUES ($1, $2, 'sent', $3, $3, $4::date, $5, $6)
     RETURNING id`,
    [memberId, invoiceNumber, amount, dueDateStr, notes, serviceRequestId]
  );
  const invId = ins.rows[0].id;
  await client.query(
    `INSERT INTO invoice_items (invoice_id, description, amount_cents, sort_order)
     VALUES ($1, $2, $3, 0)`,
    [invId, line, amount]
  );
  await client.query(
    `UPDATE service_requests SET invoice_id = COALESCE(invoice_id, $2::uuid), updated_at = now() WHERE id = $1::uuid`,
    [serviceRequestId, invId]
  );
  await client.query(
    `INSERT INTO invoice_service_links (invoice_id, service_request_id, amount_cents, description, sort_order)
     SELECT $1::uuid, $2::uuid, $3, $4, 0
     WHERE NOT EXISTS (
       SELECT 1 FROM invoice_service_links
       WHERE invoice_id = $1::uuid AND service_request_id = $2::uuid AND deleted_at IS NULL
     )`,
    [invId, serviceRequestId, amount, line]
  );
  await client.query(
    `INSERT INTO service_request_updates (service_request_id, stage, note, visible_to_member)
     VALUES ($1, 'Invoice', $2, true)`,
    [serviceRequestId, `Invoice ${invoiceNumber} for ${formatNgn(amount)}. Pay via Billing or below.`]
  );
  return { id: invId, number: invoiceNumber, amount };
}

async function sendServiceRequestInvoiceNotifications({
  memberId,
  memberEmail,
  memberName,
  notifyInvoiceEmail,
  invoiceNumber,
  amountCents,
  invId,
  dueDateStr,
  serviceRequestId,
  title,
  message,
  linkUrl: linkUrlOverride,
  billingPath,
}) {
  const link =
    linkUrlOverride ||
    (serviceRequestId != null && String(serviceRequestId)
      ? `/services/${serviceRequestId}`
      : '/billing');
  await notifyMember({
    memberId,
    title: title || 'Invoice for your service request',
    message: message || `Invoice ${invoiceNumber} for ${formatNgn(amountCents)}.`,
    linkUrl: link,
  });
  await logActivity({
    memberId,
    eventType: 'invoice',
    title: 'Invoice from service request',
    body: invoiceNumber,
    entityType: 'invoice',
    entityId: invId,
  });
  if (memberEmail && notifyInvoiceEmail) {
    const base = process.env.BASE_URL || '';
    try {
      await sendInvoiceCreatedEmail({
        to: memberEmail,
        name: memberName,
        invoiceNumber,
        amount: formatNgn(amountCents),
        dueDate: new Date(dueDateStr + 'T12:00:00').toLocaleDateString('en-GB'),
        portalUrl: base,
        billingPath: billingPath || undefined,
      });
    } catch (e) {
      console.error('service invoice email', e.message);
    }
  }
}

module.exports = {
  createServiceRequestInvoiceInTx,
  sendServiceRequestInvoiceNotifications,
};
