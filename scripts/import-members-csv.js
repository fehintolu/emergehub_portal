/**
 * Import members from a Zoho-style CRM export CSV.
 *
 * Columns (0-based after header):
 *   0 Display Name, 1 STATUS, 2 product/notes, 3 Company, 4 Salutation,
 *   5 First, 6 Last, 7 Phone, 8 Billing State, 9 Billing Country,
 *   10 Email, 11 Mobile, 12 Contact Name, 13 Contact Type
 *
 * Usage:
 *   node scripts/import-members-csv.js /path/to/export.csv
 *   node scripts/import-members-csv.js /path/to/export.csv --strip-plans=all
 *
 * Default: every imported row is set to crm_status inactive, portal suspended,
 * and all member_plans for that member are soft-deleted. CSV ACTIVE/INACTIVE
 * is ignored so the catalogue matches a fresh portal baseline.
 *
 * --strip-plans=all  After import, soft-delete ALL member_plans in the database.
 */
require('dotenv').config();
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('../lib/db');
const { parseCsv } = require('../lib/csvParse');

function trim(s) {
  return String(s ?? '')
    .trim()
    .replace(/\u00a0/g, ' ');
}

function normalizeEmail(raw) {
  const e = trim(raw).toLowerCase();
  if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  return e;
}

function normalizePhone(raw) {
  let s = trim(raw).replace(/[\s\-]/g, '');
  if (!s) return '';
  if (s.includes(',')) s = trim(s.split(',')[0]);
  return s;
}

function pickPhone(p7, p11) {
  const a = normalizePhone(p7);
  const b = normalizePhone(p11);
  if (a.length >= b.length && a) return a;
  if (b) return b;
  return a || b || '0000000000';
}

function fullNameFromRow(c) {
  const display = trim(c[0]);
  const contact = trim(c[12]);
  const sal = trim(c[4]);
  const first = trim(c[5]);
  const last = trim(c[6]);
  const company = trim(c[3]);
  const parts = [sal, first, last].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (display) return display;
  if (contact) return contact;
  if (parts) return parts;
  if (company) return company;
  return 'Member';
}

function rowScore(cols) {
  let n = 0;
  for (let i = 0; i < cols.length; i++) {
    if (trim(cols[i])) n += 1;
  }
  return n;
}

function padRow(cols, len) {
  const out = cols.slice();
  while (out.length < len) out.push('');
  return out;
}

async function stripPlansForMembers(client, ids) {
  if (!ids.length) return;
  await client.query(
    `UPDATE member_plans SET deleted_at = now(), updated_at = now()
     WHERE deleted_at IS NULL AND member_id = ANY($1::uuid[])`,
    [ids]
  );
}

async function stripAllPlans(client) {
  await client.query(
    `UPDATE member_plans SET deleted_at = now(), updated_at = now() WHERE deleted_at IS NULL`
  );
}

async function main() {
  const args = process.argv.slice(2);
  const stripAll = args.some((a) => a === '--strip-plans=all');
  const paths = args.filter((a) => !a.startsWith('--'));
  const fileArg = paths[0];
  if (!fileArg) {
    console.error('Usage: node scripts/import-members-csv.js <file.csv> [--strip-plans=all]');
    process.exitCode = 1;
    return;
  }
  const path = fileArg;
  if (!fs.existsSync(path)) {
    console.error('File not found:', path);
    process.exitCode = 1;
    return;
  }
  const text = fs.readFileSync(path, 'utf8');
  const table = parseCsv(text);
  if (!table.length) {
    console.error('Empty CSV');
    process.exitCode = 1;
    return;
  }

  const byEmail = new Map();
  for (let r = 1; r < table.length; r++) {
    let cols = padRow(table[r], 14);
    const email = normalizeEmail(cols[10]);
    if (!email) continue;
    const sc = rowScore(cols);
    const prev = byEmail.get(email);
    if (!prev || sc >= prev.score) {
      byEmail.set(email, { cols, score: sc });
    }
  }

  const passwordHash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
  const importedIds = [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const [email, { cols }] of byEmail) {
      const c = padRow(cols, 14);
      const full_name = fullNameFromRow(c);
      const phone = pickPhone(c[7], c[11]);
      const business_name = trim(c[3]) || null;
      const salutation = trim(c[4]) || null;
      const first_name = trim(c[5]) || null;
      const last_name = trim(c[6]) || null;
      const billing_state = trim(c[8]) || null;
      const billing_country = trim(c[9]) || null;
      const mobile_phone = normalizePhone(c[11]) || null;
      const contact_name = trim(c[12]) || null;
      const contact_type = trim(c[13]) || null;
      const crm_product = trim(c[2]) || null;

      const { rows: ex } = await client.query(
        `SELECT id FROM members WHERE lower(trim(email)) = lower(trim($1)) AND deleted_at IS NULL`,
        [email]
      );

      if (ex[0]) {
        const id = ex[0].id;
        await client.query(
          `UPDATE members SET
             full_name = $2,
             phone = $3,
             business_name = COALESCE($4, business_name),
             salutation = $5,
             first_name = $6,
             last_name = $7,
             billing_state = $8,
             billing_country = $9,
             mobile_phone = $10,
             contact_name = $11,
             contact_type = $12,
             crm_status = 'inactive',
             crm_product = COALESCE($13, crm_product),
             suspended_at = now(),
             updated_at = now()
           WHERE id = $1::uuid`,
          [
            id,
            full_name,
            phone,
            business_name,
            salutation,
            first_name,
            last_name,
            billing_state,
            billing_country,
            mobile_phone,
            contact_name,
            contact_type,
            crm_product,
          ]
        );
        await stripPlansForMembers(client, [id]);
        importedIds.push(id);
      } else {
        const ins = await client.query(
          `INSERT INTO members (
             email, password_hash, full_name, phone, business_name,
             salutation, first_name, last_name, billing_state, billing_country,
             mobile_phone, contact_name, contact_type, crm_status, crm_product,
             suspended_at
           ) VALUES (
             $1, $2, $3, $4, $5,
             $6, $7, $8, $9, $10,
             $11, $12, $13, 'inactive', $14,
             now()
           ) RETURNING id`,
          [
            email,
            passwordHash,
            full_name,
            phone,
            business_name,
            salutation,
            first_name,
            last_name,
            billing_state,
            billing_country,
            mobile_phone,
            contact_name,
            contact_type,
            crm_product,
          ]
        );
        importedIds.push(ins.rows[0].id);
      }
    }

    if (stripAll) {
      await stripAllPlans(client);
    }

    await client.query('COMMIT');
    console.log(
      `import-members-csv: upserted ${byEmail.size} members (${importedIds.length} ids). strip-plans=all: ${stripAll}`
    );
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('import-members-csv failed:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
