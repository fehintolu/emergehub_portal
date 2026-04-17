const express = require('express');
const crypto = require('crypto');
const { pool } = require('../lib/db');
const { verifyTransaction, verifyWebhookSignature } = require('../lib/paystack');
const { paystackKeys } = require('../lib/portalSettings');
const { logActivity } = require('../lib/activity');
const { notifyMember } = require('../lib/notifications');
const { sendPaymentConfirmedEmail } = require('../lib/mail');
const { onInvoicePaid } = require('../lib/invoicePaidHooks');

const router = express.Router();

router.post(
  '/paystack',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const raw = req.body;
    const sig = req.get('x-paystack-signature');
    const { secretKey } = await paystackKeys();
    if (!secretKey || !verifyWebhookSignature(raw, sig, secretKey)) {
      return res.status(400).send('invalid signature');
    }
    let event;
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      return res.status(400).send('bad json');
    }
    if (event.event !== 'charge.success') {
      return res.json({ ok: true });
    }
    const ref =
      event.data &&
      event.data.reference &&
      String(event.data.reference).trim();
    if (!ref) return res.status(400).send('no reference');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pay = await client.query(
        `SELECT p.*, i.invoice_number, i.member_id, m.email, m.full_name
         FROM payments p
         JOIN invoices i ON i.id = p.invoice_id
         JOIN members m ON m.id = p.member_id
         WHERE p.paystack_reference = $1 AND p.deleted_at IS NULL FOR UPDATE`,
        [ref]
      );
      if (!pay.rows[0]) {
        await client.query('ROLLBACK');
        return res.json({ ok: true });
      }
      const pRow = pay.rows[0];
      if (pRow.status === 'completed') {
        await client.query('COMMIT');
        return res.json({ ok: true });
      }

      const remote = await verifyTransaction(ref);
      if (!remote || remote.status !== 'success') {
        await client.query('ROLLBACK');
        return res.status(400).send('verify failed');
      }

      const receiptNumber = `RCP-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      await client.query(
        `UPDATE payments SET status = 'completed', receipt_number = $2, updated_at = now(), metadata = metadata || $3::jsonb
         WHERE id = $1`,
        [
          pRow.id,
          receiptNumber,
          JSON.stringify({ paystack: remote }),
        ]
      );
      await client.query(
        `UPDATE invoices SET status = 'paid', updated_at = now() WHERE id = $1`,
        [pRow.invoice_id]
      );
      await onInvoicePaid(client, pRow.invoice_id, null);
      await notifyMember(
        {
          memberId: pRow.member_id,
          title: 'Payment confirmed',
          message: `Invoice ${pRow.invoice_number} has been paid.`,
          linkUrl: '/billing',
        },
        client
      );
      await logActivity(
        {
          memberId: pRow.member_id,
          eventType: 'payment',
          title: 'Payment confirmed',
          body: pRow.invoice_number,
          entityType: 'invoice',
          entityId: pRow.invoice_id,
        },
        client
      );
      await client.query('COMMIT');

      const base = process.env.BASE_URL || '';
      try {
        await sendPaymentConfirmedEmail({
          to: pRow.email,
          name: pRow.full_name,
          invoiceNumber: pRow.invoice_number,
          portalUrl: base,
        });
      } catch (mailErr) {
        console.error('webhook mail', mailErr);
      }
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('webhook', e);
      return res.status(500).send('error');
    } finally {
      client.release();
    }
    return res.json({ ok: true });
  }
);

module.exports = router;
