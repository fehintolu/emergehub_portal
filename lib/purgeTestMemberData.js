const path = require('path');
const fs = require('fs').promises;
const { syncUnitStatus } = require('./capacityAssignment');

const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '../data/uploads');

async function unlinkQuiet(absPath) {
  if (!absPath || typeof absPath !== 'string') return;
  try {
    await fs.unlink(absPath);
  } catch {
    /* missing file is fine */
  }
}

/**
 * Remove transactional / generated data for a member while keeping the `members` row
 * (profile + authentication). Only call for accounts intended as test accounts.
 * @param {import('pg').PoolClient} client
 * @param {string} memberId uuid
 */
async function purgeTestMemberTransactionalData(client, memberId) {
  const { rows: invRows } = await client.query(
    `SELECT id FROM invoices WHERE member_id = $1::uuid AND deleted_at IS NULL`,
    [memberId]
  );
  const invoiceIds = invRows.map((r) => r.id);

  const { rows: srRows } = await client.query(
    `SELECT id FROM service_requests WHERE member_id = $1::uuid AND deleted_at IS NULL`,
    [memberId]
  );
  const srIds = srRows.map((r) => r.id);

  const { rows: tkRows } = await client.query(
    `SELECT id FROM support_tickets WHERE member_id = $1::uuid AND deleted_at IS NULL`,
    [memberId]
  );
  const ticketIds = tkRows.map((r) => r.id);

  const { rows: proofDocs } = await client.query(
    `SELECT bank_proof_document_id AS id FROM invoices
     WHERE member_id = $1::uuid AND bank_proof_document_id IS NOT NULL AND deleted_at IS NULL`,
    [memberId]
  );
  const proofIds = proofDocs.map((r) => r.id).filter(Boolean);

  if (srIds.length) {
    await client.query(`DELETE FROM service_request_messages WHERE service_request_id = ANY($1::uuid[])`, [srIds]);
    await client.query(`DELETE FROM service_request_updates WHERE service_request_id = ANY($1::uuid[])`, [srIds]);
    await client.query(`DELETE FROM service_request_reminders WHERE service_request_id = ANY($1::uuid[])`, [srIds]);
  }

  if (ticketIds.length) {
    await client.query(`DELETE FROM support_messages WHERE ticket_id = ANY($1::uuid[])`, [ticketIds]);
  }

  await client.query(
    `UPDATE invoices SET bank_proof_document_id = NULL, updated_at = now()
     WHERE member_id = $1::uuid`,
    [memberId]
  );

  const { rows: docRows } = await client.query(
    `SELECT id, storage_path FROM member_documents
     WHERE deleted_at IS NULL AND (
       member_id = $1::uuid
       OR uploaded_by_member_id = $1::uuid
       OR (cardinality($2::uuid[]) > 0 AND service_request_id = ANY($2::uuid[]))
       OR (cardinality($3::uuid[]) > 0 AND support_ticket_id = ANY($3::uuid[]))
       OR (cardinality($4::uuid[]) > 0 AND id = ANY($4::uuid[]))
     )`,
    [memberId, srIds, ticketIds, proofIds]
  );

  for (const d of docRows) {
    if (d.storage_path) {
      const abs = path.isAbsolute(d.storage_path) ? d.storage_path : path.join(uploadDir, d.storage_path);
      await unlinkQuiet(abs);
    }
  }
  if (docRows.length) {
    const docIds = docRows.map((r) => r.id);
    await client.query(`DELETE FROM member_documents WHERE id = ANY($1::uuid[])`, [docIds]);
  }

  if (invoiceIds.length) {
    await client.query(
      `UPDATE invoices SET service_request_id = NULL, updated_at = now() WHERE id = ANY($1::uuid[])`,
      [invoiceIds]
    );
  }

  if (srIds.length) {
    await client.query(
      `UPDATE service_requests SET invoice_id = NULL, updated_at = now() WHERE id = ANY($1::uuid[])`,
      [srIds]
    );
  }

  if (invoiceIds.length) {
    await client.query(`DELETE FROM invoice_service_links WHERE invoice_id = ANY($1::uuid[])`, [invoiceIds]);
    await client.query(`DELETE FROM payments WHERE invoice_id = ANY($1::uuid[])`, [invoiceIds]);
    await client.query(`DELETE FROM invoice_items WHERE invoice_id = ANY($1::uuid[])`, [invoiceIds]);
    await client.query(
      `UPDATE room_bookings SET invoice_id = NULL, updated_at = now() WHERE invoice_id = ANY($1::uuid[])`,
      [invoiceIds]
    );
  }

  await client.query(`DELETE FROM credit_notes WHERE member_id = $1::uuid`, [memberId]);

  const { rows: msaRows } = await client.query(
    `SELECT unit_id FROM member_space_assignments
     WHERE member_id = $1::uuid AND deleted_at IS NULL`,
    [memberId]
  );
  const unitIdsToSync = [...new Set(msaRows.map((r) => r.unit_id).filter(Boolean))];

  await client.query(
    `UPDATE member_plans SET space_unit_id = NULL, desk_or_office = NULL, updated_at = now()
     WHERE member_id = $1::uuid AND deleted_at IS NULL`,
    [memberId]
  );
  await client.query(`DELETE FROM member_space_assignments WHERE member_id = $1::uuid`, [memberId]);

  await client.query(`DELETE FROM member_plans WHERE member_id = $1::uuid`, [memberId]);
  await client.query(`DELETE FROM member_plan_history WHERE member_id = $1::uuid`, [memberId]);
  await client.query(`DELETE FROM plan_waitlist_entries WHERE member_id = $1::uuid`, [memberId]);

  if (invoiceIds.length) {
    await client.query(`DELETE FROM invoices WHERE id = ANY($1::uuid[])`, [invoiceIds]);
  }

  if (srIds.length) {
    await client.query(`DELETE FROM service_requests WHERE id = ANY($1::uuid[])`, [srIds]);
  }

  if (ticketIds.length) {
    await client.query(`DELETE FROM support_tickets WHERE id = ANY($1::uuid[])`, [ticketIds]);
  }

  await client.query(`DELETE FROM meeting_room_bookings WHERE member_id = $1::uuid`, [memberId]);
  await client.query(`DELETE FROM room_bookings WHERE member_id = $1::uuid`, [memberId]);

  await client.query(`DELETE FROM member_meeting_credit_ledger WHERE member_id = $1::uuid`, [memberId]);
  await client.query(`DELETE FROM meeting_credit_events WHERE member_id = $1::uuid`, [memberId]);
  await client.query(`DELETE FROM member_notifications WHERE member_id = $1::uuid`, [memberId]);
  await client.query(`DELETE FROM portal_activity_events WHERE member_id = $1::uuid`, [memberId]);

  const { rows: sessRows } = await client.query(
    `SELECT session_sid FROM member_tracked_sessions WHERE member_id = $1::uuid`,
    [memberId]
  );
  for (const s of sessRows) {
    if (s.session_sid) {
      await client.query(`DELETE FROM member_sessions WHERE sid = $1`, [s.session_sid]);
    }
  }
  await client.query(`DELETE FROM member_tracked_sessions WHERE member_id = $1::uuid`, [memberId]);

  const { rows: memRow } = await client.query(`SELECT profile_photo_path FROM members WHERE id = $1::uuid`, [memberId]);
  const photoPath = memRow[0]?.profile_photo_path;
  if (photoPath) {
    const abs = path.isAbsolute(photoPath) ? photoPath : path.join(uploadDir, photoPath);
    await unlinkQuiet(abs);
  }

  await client.query(
    `UPDATE members SET
       profile_photo_path = NULL,
       internal_notes = NULL,
       suspended_at = NULL,
       updated_at = now()
     WHERE id = $1::uuid`,
    [memberId]
  );

  for (const uid of unitIdsToSync) {
    try {
      await syncUnitStatus(client, uid);
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {import('pg').PoolClient} client
 * @param {string[]} memberIds
 * @returns {Promise<{ purged: string[], skipped: string[] }>}
 */
async function purgeTestMembers(client, memberIds) {
  const unique = [...new Set((memberIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  const purged = [];
  const skipped = [];
  for (const id of unique) {
    const { rows } = await client.query(
      `SELECT id FROM members WHERE id = $1::uuid AND deleted_at IS NULL AND is_test_account = true`,
      [id]
    );
    if (!rows[0]) {
      skipped.push(id);
      continue;
    }
    await purgeTestMemberTransactionalData(client, id);
    purged.push(id);
  }
  return { purged, skipped };
}

module.exports = {
  purgeTestMemberTransactionalData,
  purgeTestMembers,
};
