const crypto = require('crypto');
const { pool } = require('./db');

async function nextInvoiceNumber() {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  const num = `INV-${day}-${suffix}`;
  const chk = await pool.query(
    'SELECT 1 FROM invoices WHERE invoice_number = $1 LIMIT 1',
    [num]
  );
  if (chk.rowCount) return nextInvoiceNumber();
  return num;
}

module.exports = { nextInvoiceNumber };
