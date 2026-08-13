/**
 * Real-time OTP email delivery via Gmail SMTP (nodemailer).
 * Optionally logs send events to Google Sheets (never logs the OTP code).
 */

const nodemailer = require('nodemailer');
const { withTimeout } = require('../lib/timeout');

const SMTP_TIMEOUT_MS = Number(process.env.OTP_SMTP_TIMEOUT_MS || 18000);

let transporter = null;

function gmailConfigured() {
  return Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

function attachTransporterGuards(tx) {
  tx.on('error', (err) => {
    console.error('[email] transporter error:', err && err.message ? err.message : err);
  });
}

function getTransporter() {
  if (!gmailConfigured()) {
    const err = new Error('Email delivery is not configured.');
    err.code = 'EMAIL_NOT_CONFIGURED';
    err.status = 503;
    throw err;
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
      connectionTimeout: SMTP_TIMEOUT_MS,
      greetingTimeout: SMTP_TIMEOUT_MS,
      socketTimeout: SMTP_TIMEOUT_MS,
      tls: {
        minVersion: 'TLSv1.2',
      },
    });
    attachTransporterGuards(transporter);
  }
  return transporter;
}

function otpSubject(purpose) {
  if (purpose === 'phone_change') return 'Your CHEDI phone-change verification code';
  return 'Your CHEDI login code';
}

function otpHtml({ code, purpose }) {
  const minutes = Math.max(1, Math.round(Number(process.env.OTP_TTL_SECONDS || 300) / 60));
  const action =
    purpose === 'phone_change' ? 'confirm your mobile number change' : 'log in to your Farm Club account';
  return `
    <div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;color:#1c3b2c">
      <h2 style="font-weight:500;font-size:22px;margin:0 0 12px">CHEDI verification code</h2>
      <p style="font-size:15px;line-height:1.5;color:#4b5142">
        Use this code to ${action}. It expires in about ${minutes} minute${minutes === 1 ? '' : 's'}.
      </p>
      <p style="font-size:32px;letter-spacing:0.35em;font-weight:700;margin:24px 0;font-family:monospace">
        ${code}
      </p>
      <p style="font-size:13px;color:#6f7566;line-height:1.5">
        If you did not request this, you can ignore this email.
      </p>
    </div>
  `;
}

function otpText({ code, purpose }) {
  const action =
    purpose === 'phone_change' ? 'confirm your mobile number change' : 'log in';
  return `Your CHEDI verification code is ${code}. Use it to ${action}. It expires in a few minutes. If you did not request this, you can ignore this email.`;
}

async function fetchWithTimeout(url, options, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Append a non-sensitive row to Google Sheets via Apps Script webhook.
 * Never includes the OTP code.
 */
async function logOtpEventToSheets({ to, purpose }) {
  const url = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'otp_sent',
          email: to,
          purpose,
          at: new Date().toISOString(),
          sheetsUrl: process.env.GOOGLE_SHEETS_URL || undefined,
        }),
      },
      5000
    );
  } catch (err) {
    console.warn('[email] Google Sheets log failed:', err.message);
  }
}

/**
 * Optional admin notice (no OTP code) when a code is requested.
 * Enable with NOTIFY_SUPPORT_ON_OTP=true.
 */
async function notifySupport({ to, purpose }) {
  if (process.env.NOTIFY_SUPPORT_ON_OTP !== 'true') return;
  const support = process.env.RECIPIENT_EMAIL;
  if (!support || !gmailConfigured()) return;
  if (String(support).toLowerCase() === String(to).toLowerCase()) return;
  try {
    const tx = getTransporter();
    await withTimeout(
      tx.sendMail({
        from: `"CHEDI" <${process.env.GMAIL_USER}>`,
        to: support,
        subject: `[CHEDI] OTP requested (${purpose})`,
        text: `An OTP was requested for ${to} (purpose: ${purpose}) at ${new Date().toISOString()}.`,
      }),
      SMTP_TIMEOUT_MS,
      'Support notify timed out'
    );
  } catch (err) {
    console.warn('[email] Support notify failed:', err.message);
  }
}

async function sendOtpEmail({ to, code, purpose = 'login' }) {
  if (!to || !code) {
    const err = new Error('OTP email requires recipient and code');
    err.code = 'VALIDATION_ERROR';
    err.status = 400;
    throw err;
  }

  const subject = otpSubject(purpose);
  const text = otpText({ code, purpose });
  const html = otpHtml({ code, purpose });

  try {
    const tx = getTransporter();
    const info = await withTimeout(
      tx.sendMail({
        from: `"CHEDI" <${process.env.GMAIL_USER}>`,
        to,
        subject,
        text,
        html,
      }),
      SMTP_TIMEOUT_MS,
      'OTP email send timed out'
    );
    console.log(`[email] OTP sent → ${to} purpose=${purpose} messageId=${info.messageId || 'n/a'}`);

    Promise.allSettled([
      logOtpEventToSheets({ to, purpose }),
      notifySupport({ to, purpose }),
    ]).catch((err) => {
      console.warn('[email] side-effect failed:', err && err.message);
    });

    return { ok: true, to, subject, messageId: info.messageId || null };
  } catch (err) {
    const wrapped = new Error('Unable to send OTP. Please try again.');
    wrapped.code = err.code === 'TIMEOUT' || err.code === 'ETIMEDOUT' ? 'TIMEOUT' : 'OTP_DELIVERY_FAILED';
    wrapped.status = wrapped.code === 'TIMEOUT' ? 504 : 502;
    wrapped.cause = err;
    console.error('[email] send failed:', err && err.message ? err.message : err);
    throw wrapped;
  }
}

module.exports = {
  sendOtpEmail,
  gmailConfigured,
  logOtpEventToSheets,
};
