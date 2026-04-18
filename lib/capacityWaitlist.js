const { pool } = require('./db');
const { notifyMember } = require('./notifications');

/**
 * Notify next waiting member that a spot opened (48h claim window).
 * @param {import('pg').PoolClient} client
 */
async function offerNextWaitlist(client, profileId) {
  const { rows: prof } = await client.query(
    `SELECT p.*, sp.title AS plan_title
     FROM plan_capacity_profiles p
     LEFT JOIN service_plans sp ON sp.id = p.service_plan_id
     WHERE p.id = $1::uuid AND p.deleted_at IS NULL`,
    [profileId]
  );
  const planTitle = prof[0]?.plan_title || 'Workspace plan';
  if (!prof[0] || !prof[0].waitlist_enabled) return;

  const { rows: next } = await client.query(
    `SELECT * FROM plan_waitlist_entries
     WHERE profile_id = $1::uuid AND deleted_at IS NULL AND status = 'waiting'
     ORDER BY sort_key ASC, joined_at ASC
     LIMIT 1
     FOR UPDATE SKIP LOCKED`,
    [profileId]
  );
  const w = next[0];
  if (!w) return;

  const exp = new Date();
  exp.setHours(exp.getHours() + 48);
  await client.query(
    `UPDATE plan_waitlist_entries SET status = 'offered', offer_expires_at = $2, offer_token = gen_random_uuid(), updated_at = now()
     WHERE id = $1::uuid`,
    [w.id, exp.toISOString()]
  );

  const { rows: tok } = await client.query(`SELECT offer_token FROM plan_waitlist_entries WHERE id = $1::uuid`, [w.id]);
  const token = tok[0]?.offer_token;

  await notifyMember(
    {
      memberId: w.member_id,
      title: 'A workspace spot opened up',
      message: `${planTitle}: a place is available. You have 48 hours to claim it from My Workspace.`,
      linkUrl: token ? `/workspace?waitlist_claim=${token}` : '/workspace',
    },
    client
  );
}

/**
 * When a unit becomes available, offer waitlist if profile has queue.
 */
async function onCapacityUnitFreed(client, unitId) {
  const { rows } = await client.query(
    `SELECT su.profile_id FROM space_units su WHERE su.id = $1::uuid AND su.deleted_at IS NULL`,
    [unitId]
  );
  if (!rows[0]) return;
  await offerNextWaitlist(client, rows[0].profile_id);
}

/**
 * Expire offers past deadline; offer next in queue.
 */
async function expireStaleWaitlistOffers(client) {
  const { rows } = await client.query(
    `SELECT id, profile_id, member_id FROM plan_waitlist_entries
     WHERE deleted_at IS NULL AND status = 'offered' AND offer_expires_at IS NOT NULL AND offer_expires_at < now()
     FOR UPDATE`
  );
  for (const r of rows) {
    await client.query(
      `UPDATE plan_waitlist_entries SET status = 'expired', updated_at = now() WHERE id = $1::uuid`,
      [r.id]
    );
    await notifyMember(
      {
        memberId: r.member_id,
        title: 'Waitlist offer expired',
        message: 'Your 48-hour window to claim an opened workspace spot has passed. You can join the waitlist again from My Workspace.',
        linkUrl: '/workspace',
      },
      client
    );
    await offerNextWaitlist(client, r.profile_id);
  }
}

async function runExpireStaleWaitlistOffersJob() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await expireStaleWaitlistOffers(c);
    await c.query('COMMIT');
  } catch (e) {
    try {
      await c.query('ROLLBACK');
    } catch (_) {
      /* ignore */
    }
    console.error('runExpireStaleWaitlistOffersJob', e);
  } finally {
    c.release();
  }
}

module.exports = {
  offerNextWaitlist,
  onCapacityUnitFreed,
  expireStaleWaitlistOffers,
  runExpireStaleWaitlistOffersJob,
};
