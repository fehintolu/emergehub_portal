const crypto = require('crypto');
const { paystackKeys } = require('./portalSettings');

async function initializeTransaction({
  email,
  amountCents,
  reference,
  callbackUrl,
  metadata,
}) {
  const { secretKey } = await paystackKeys();
  if (!secretKey) {
    throw new Error('Paystack is not configured');
  }
  const res = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      amount: amountCents,
      reference,
      callback_url: callbackUrl,
      metadata: metadata || {},
    }),
  });
  const data = await res.json();
  if (!data.status) {
    throw new Error(data.message || 'Paystack initialize failed');
  }
  return data.data;
}

async function verifyTransaction(reference) {
  const { secretKey } = await paystackKeys();
  if (!secretKey) {
    throw new Error('Paystack is not configured');
  }
  const res = await fetch(
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
    {
      headers: { Authorization: `Bearer ${secretKey}` },
    }
  );
  const data = await res.json();
  if (!data.status) {
    throw new Error(data.message || 'Paystack verify failed');
  }
  return data.data;
}

function verifyWebhookSignature(rawBodyBuffer, signatureHeader, secretKey) {
  if (!signatureHeader || !secretKey || !rawBodyBuffer) return false;
  const hash = crypto
    .createHmac('sha512', secretKey)
    .update(rawBodyBuffer)
    .digest('hex');
  const a = Buffer.from(hash, 'utf8');
  const b = Buffer.from(String(signatureHeader), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  initializeTransaction,
  verifyTransaction,
  verifyWebhookSignature,
};
