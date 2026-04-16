const { pool } = require('./db');

let cache = null;
let cacheAt = 0;
const TTL_MS = 30_000;

async function getSettingsMap() {
  const now = Date.now();
  if (cache && now - cacheAt < TTL_MS) return cache;
  const { rows } = await pool.query(
    'SELECT key, value FROM portal_settings WHERE key IS NOT NULL'
  );
  const m = {};
  for (const r of rows) m[r.key] = r.value;
  cache = m;
  cacheAt = now;
  return m;
}

function invalidateSettingsCache() {
  cache = null;
  cacheAt = 0;
}

async function getSetting(key, fallback = '') {
  const m = await getSettingsMap();
  const v = m[key];
  return v != null && v !== '' ? v : fallback;
}

async function setSetting(key, value, client = null) {
  const run = client || pool;
  await run.query(
    `INSERT INTO portal_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value == null ? '' : String(value)]
  );
  invalidateSettingsCache();
}

async function paystackKeys() {
  const m = await getSettingsMap();
  const pub = m.paystack_public_key || process.env.PAYSTACK_PUBLIC_KEY || '';
  const sec = m.paystack_secret_key || process.env.PAYSTACK_SECRET_KEY || '';
  return { publicKey: pub, secretKey: sec };
}

module.exports = {
  getSettingsMap,
  getSetting,
  setSetting,
  paystackKeys,
  invalidateSettingsCache,
};
