/**
 * Optional access windows for paid workspace bookings (service_requests + service_plans with duration).
 */

function parseDatetimeLocal(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) return null;
  return new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    0,
    0
  );
}

function computeAccessEnd(start, value, unit) {
  const d = new Date(start.getTime());
  const v = Number(value) || 0;
  if (v <= 0) return null;
  const u = String(unit || '').toLowerCase();
  if (u === 'hour') d.setHours(d.getHours() + v);
  else if (u === 'day') d.setDate(d.getDate() + v);
  else if (u === 'month') d.setMonth(d.getMonth() + v);
  else return null;
  return d;
}

/**
 * After an invoice is marked paid: if it is tied to a service request with a plan that has
 * a duration, set access_started_at / access_ends_at once (first time only).
 * @param {import('pg').PoolClient} client
 * @param {string} invoiceId uuid
 * @param {Date | null} accessStartsAt - null/undefined → now()
 */
async function applyPaidInvoiceAccessWindow(client, invoiceId, accessStartsAt) {
  const { rows } = await client.query(
    `SELECT sr.id AS sr_id, sp.duration_value, sp.duration_unit
     FROM invoices i
     JOIN service_requests sr ON sr.id = i.service_request_id AND sr.deleted_at IS NULL
     JOIN service_plans sp ON sp.id = sr.service_plan_id AND sp.deleted_at IS NULL
     WHERE i.id = $1::uuid AND i.service_request_id IS NOT NULL
       AND COALESCE(sp.duration_value, 0) > 0
       AND lower(trim(sp.duration_unit)) IN ('hour', 'day', 'month')`,
    [invoiceId]
  );
  const row = rows[0];
  if (!row) return;

  const start =
    accessStartsAt instanceof Date && !Number.isNaN(accessStartsAt.getTime())
      ? accessStartsAt
      : new Date();
  const end = computeAccessEnd(start, row.duration_value, row.duration_unit);
  if (!end) return;

  const upd = await client.query(
    `UPDATE service_requests sr
     SET access_started_at = $2, access_ends_at = $3, updated_at = now()
     WHERE sr.id = $1::uuid
       AND sr.access_started_at IS NULL
       AND sr.service_plan_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM service_plans sp
         WHERE sp.id = sr.service_plan_id AND sp.deleted_at IS NULL
           AND COALESCE(sp.duration_value, 0) > 0
           AND lower(trim(sp.duration_unit)) IN ('hour', 'day', 'month')
       )`,
    [row.sr_id, start, end]
  );
  if (upd.rowCount > 0) {
    const fmt = (d) =>
      d.toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    await client.query(
      `INSERT INTO service_request_updates (service_request_id, stage, note, visible_to_member)
       VALUES ($1::uuid, 'Access', $2, true)`,
      [
        row.sr_id,
        `Your access is scheduled from ${fmt(start)} to ${fmt(end)} (hub time).`,
      ]
    );
  }
}

module.exports = {
  parseDatetimeLocal,
  computeAccessEnd,
  applyPaidInvoiceAccessWindow,
};
