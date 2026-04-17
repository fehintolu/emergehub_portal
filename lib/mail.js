const nodemailer = require('nodemailer');
const { Resend } = require('resend');

const DEFAULT_FROM = 'no-reply@emergehub.com.ng';

function resendFrom() {
  return (process.env.RESEND_FROM || DEFAULT_FROM).trim();
}

function hasResendConfig() {
  return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_API_KEY.trim());
}

function hasSmtpConfig() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM);
}

/** True if any outbound email transport is configured (Resend preferred). */
function hasMailTransport() {
  return hasResendConfig() || hasSmtpConfig();
}

function wrapHtml(title, innerHtml, ctaHref, ctaLabel) {
  const ctaBlock =
    ctaHref && ctaLabel
      ? `<p style="margin:24px 0;"><a href="${ctaHref}" style="background:#FFF605;color:#1A1A1A;padding:12px 20px;text-decoration:none;font-weight:600;border-radius:4px;display:inline-block;">${ctaLabel}</a></p>`
      : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head>
  <body style="margin:0;background:#F7F5F0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1A1A1A;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation"><tr><td align="center" style="padding:24px;">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
      <tr><td style="background:#610536;color:#fff;padding:20px 24px;font-family:Georgia,'Times New Roman',Times,serif;font-size:20px;font-weight:600;">EmergeHub</td></tr>
      <tr><td style="padding:24px;">${innerHtml}${ctaBlock}
      <p style="font-size:13px;color:#666;margin-top:32px;">4 Ayanboye Street, Anthony Village, Maryland, Lagos</p></td></tr>
    </table>
  </td></tr></table></body></html>`;
}

async function sendViaResend({ to, subject, html, text }) {
  const resend = new Resend(process.env.RESEND_API_KEY.trim());
  const { data, error } = await resend.emails.send({
    from: resendFrom(),
    to: [to],
    subject,
    html,
    text: text || undefined,
  });
  if (error) {
    throw new Error(error.message || String(error));
  }
  return { sent: true, provider: 'resend', id: data?.id };
}

async function sendViaSmtp({ to, subject, html, text }) {
  const port = Number(process.env.SMTP_PORT) || 587;
  const secure = process.env.SMTP_SECURE === '1' || port === 465;
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth:
      process.env.SMTP_USER && process.env.SMTP_PASS
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
  });
  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject,
    html,
    text: text || subject,
  });
  return { sent: true, provider: 'smtp' };
}

async function sendMail({ to, subject, html, text }) {
  if (hasResendConfig()) {
    try {
      return await sendViaResend({ to, subject, html, text });
    } catch (e) {
      console.error('[mail] Resend failed:', e.message || e);
      if (hasSmtpConfig()) {
        console.warn('[mail] Falling back to SMTP');
        return sendViaSmtp({ to, subject, html, text });
      }
      throw e;
    }
  }
  if (hasSmtpConfig()) {
    return sendViaSmtp({ to, subject, html, text });
  }
  console.warn('[mail] No email transport (set RESEND_API_KEY or SMTP_*); skipping send to', to);
  return { sent: false, reason: 'not_configured' };
}

async function sendVerificationEmail({ to, name, verifyUrl }) {
  const html = wrapHtml(
    'Verify your email',
    `<p>Hi ${escapeHtml(name)},</p><p>Please verify your email address to activate your EmergeHub member portal account.</p>`,
    verifyUrl,
    'Verify email'
  );
  return sendMail({ to, subject: 'Verify your EmergeHub account', html });
}

async function sendPasswordResetEmail({ to, name, resetUrl }) {
  const html = wrapHtml(
    'Reset your password',
    `<p>Hi ${escapeHtml(name)},</p><p>We received a request to reset your portal password. If you did not request this, you can ignore this email.</p>`,
    resetUrl,
    'Reset password'
  );
  return sendMail({ to, subject: 'Reset your EmergeHub portal password', html });
}

async function sendInvoiceCreatedEmail({
  to,
  name,
  invoiceNumber,
  amount,
  dueDate,
  portalUrl,
  billingPath,
}) {
  const path = billingPath && String(billingPath).startsWith('/') ? billingPath : '/billing';
  const html = wrapHtml(
    'New invoice',
    `<p>Hi ${escapeHtml(name)},</p><p>A new invoice <strong>${escapeHtml(
      invoiceNumber
    )}</strong> has been added to your account.</p><p>Amount: ${escapeHtml(
      amount
    )}<br>Due: ${escapeHtml(dueDate)}</p>`,
    `${portalUrl || ''}${path}`,
    'View & pay invoice'
  );
  return sendMail({ to, subject: `New invoice ${invoiceNumber}`, html });
}

async function sendPaymentConfirmedEmail({ to, name, invoiceNumber, portalUrl }) {
  const html = wrapHtml(
    'Payment received',
    `<p>Hi ${escapeHtml(name)},</p><p>Your payment for invoice <strong>${escapeHtml(
      invoiceNumber
    )}</strong> was confirmed. Thank you.</p>`,
    `${portalUrl}/billing`,
    'View billing'
  );
  return sendMail({ to, subject: `Payment confirmed — ${invoiceNumber}`, html });
}

async function sendServiceStatusEmail({ to, name, serviceName, status, portalUrl }) {
  const html = wrapHtml(
    'Service update',
    `<p>Hi ${escapeHtml(name)},</p><p>Your service request <strong>${escapeHtml(
      serviceName
    )}</strong> is now: <strong>${escapeHtml(status)}</strong>.</p>`,
    `${portalUrl}/services`,
    'View services'
  );
  return sendMail({ to, subject: `Service update: ${serviceName}`, html });
}

async function sendServicePaymentInitiatedEmail({ to, name, serviceName, serviceRequestId, portalUrl }) {
  const base = String(portalUrl || '').replace(/\/$/, '');
  const link = serviceRequestId ? `${base}/services/${serviceRequestId}` : `${base}/services`;
  const html = wrapHtml(
    'Payment confirmed',
    `<p>Hi ${escapeHtml(name)},</p><p>Your payment has been confirmed and your <strong>${escapeHtml(
      serviceName
    )}</strong> request is now in progress.</p>`,
    link,
    'View request'
  );
  return sendMail({ to, subject: `Your ${serviceName} request is in progress`, html });
}

async function sendSupportReplyEmail({ to, name, subjectLine, portalUrl }) {
  const html = wrapHtml(
    'Support ticket update',
    `<p>Hi ${escapeHtml(name)},</p><p>There is a new reply on your support ticket: <strong>${escapeHtml(
      subjectLine
    )}</strong>.</p>`,
    `${portalUrl}/support`,
    'View ticket'
  );
  return sendMail({ to, subject: `Support: ${subjectLine}`, html });
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

module.exports = {
  hasSmtpConfig: hasMailTransport,
  hasMailTransport,
  hasResendConfig,
  sendMail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendInvoiceCreatedEmail,
  sendPaymentConfirmedEmail,
  sendServiceStatusEmail,
  sendServicePaymentInitiatedEmail,
  sendSupportReplyEmail,
};
