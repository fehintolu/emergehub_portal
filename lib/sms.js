/**
 * Outbound SMS — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 * and add the `twilio` npm package, then implement the API call below.
 */
async function sendMemberSms({ phone, message }) {
  const raw = String(phone || '').trim();
  if (!raw) return { sent: false, reason: 'no_phone' };

  const sid = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_ACCOUNT_SID.trim();
  const token = process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_AUTH_TOKEN.trim();
  const from = process.env.TWILIO_FROM_NUMBER && process.env.TWILIO_FROM_NUMBER.trim();
  if (sid && token && from) {
    console.warn(
      '[sms] Twilio env present; wire `twilio` in lib/sms.js to send. Preview:',
      raw,
      message.slice(0, 100)
    );
    return { sent: false, reason: 'integration_pending' };
  }

  console.warn('[sms] Skipped — configure TWILIO_* env vars to enable SMS.', raw);
  return { sent: false, reason: 'not_configured' };
}

module.exports = { sendMemberSms };
