/**
 * Real-time OTP email delivery via Gmail SMTP (nodemailer).
 * Optionally logs send events to Google Sheets (never logs the OTP code).
 */

const nodemailer = require('nodemailer');

let transporter = null;

function gmailConfigured() {
  return Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

function getTransporter() {
  if (!gmailConfigured()) {
    const err = new Error(
      'Email delivery is not configured. Set GMAIL_USER and GMAIL_APP_PASSWORD.'
    );
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
    });
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

/**
 * Append a non-sensitive row to Google Sheets via Apps Script webhook.
 * Never includes the OTP code.
 */
async function logOtpEventToSheets({ to, purpose }) {
  const url = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'otp_sent',
        email: to,
        purpose,
        at: new Date().toISOString(),
        sheetsUrl: process.env.GOOGLE_SHEETS_URL || undefined,
      }),
    });
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
    await tx.sendMail({
      from: `"CHEDI" <${process.env.GMAIL_USER}>`,
      to: support,
      subject: `[CHEDI] OTP requested (${purpose})`,
      text: `An OTP was requested for ${to} (purpose: ${purpose}) at ${new Date().toISOString()}.`,
    });
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

  const tx = getTransporter();
  const info = await tx.sendMail({
    from: `"CHEDI" <${process.env.GMAIL_USER}>`,
    to,
    subject,
    text,
    html,
  });

  console.log(`[email] OTP sent → ${to} purpose=${purpose} messageId=${info.messageId || 'n/a'}`);

  // Fire-and-forget side effects (do not block login on sheets/support failures)
  Promise.allSettled([
    logOtpEventToSheets({ to, purpose }),
    notifySupport({ to, purpose }),
  ]).catch(() => {});

  return { ok: true, to, subject, messageId: info.messageId || null };
}

module.exports = {
  sendOtpEmail,
  gmailConfigured,
  logOtpEventToSheets,
};
