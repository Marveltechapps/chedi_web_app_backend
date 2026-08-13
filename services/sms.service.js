/**
 * Optional HTTP SMS provider. Login OTP is email-based; phone-change can use SMS
 * when SMS_API_URL and SMS_API_KEY are set. Never logs API keys or OTP codes.
 */

const { withTimeout } = require('../lib/timeout');

const SMS_TIMEOUT_MS = Number(process.env.OTP_SMS_TIMEOUT_MS || 10000);

function smsConfigured() {
  return Boolean(process.env.SMS_API_URL && process.env.SMS_API_KEY);
}

async function sendOtpSms({ to, code, purpose = 'login' }) {
  if (!to || !code) {
    const err = new Error('Unable to send OTP. Please try again.');
    err.code = 'SMS_DELIVERY_FAILED';
    err.status = 502;
    throw err;
  }
  if (!smsConfigured()) {
    const err = new Error('Unable to send OTP. Please try again.');
    err.code = 'SMS_NOT_CONFIGURED';
    err.status = 503;
    throw err;
  }

  const url = process.env.SMS_API_URL;
  const ac = new AbortController();

  try {
    const response = await withTimeout(
      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.SMS_API_KEY}`,
        },
        body: JSON.stringify({ to, purpose, code }),
        signal: ac.signal,
      }),
      SMS_TIMEOUT_MS,
      'SMS provider timed out'
    );

    if (!response.ok) {
      const err = new Error('Unable to send OTP. Please try again.');
      err.code = 'SMS_DELIVERY_FAILED';
      err.status = 502;
      throw err;
    }

    return { ok: true };
  } catch (err) {
    if (err.code === 'SMS_DELIVERY_FAILED' || err.code === 'SMS_NOT_CONFIGURED') throw err;
    const wrapped = new Error('Unable to send OTP. Please try again.');
    wrapped.code = err.code === 'TIMEOUT' || err.code === 'ETIMEDOUT' ? 'TIMEOUT' : 'SMS_DELIVERY_FAILED';
    wrapped.status = wrapped.code === 'TIMEOUT' ? 504 : 502;
    wrapped.cause = err;
    console.error('[sms] send failed:', err && err.message ? err.message : 'provider error');
    throw wrapped;
  } finally {
    try {
      ac.abort();
    } catch {
      /* ignore */
    }
  }
}

module.exports = { smsConfigured, sendOtpSms };
