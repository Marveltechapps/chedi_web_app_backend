const { getDB } = require('../config/db');
const { getRedis } = require('../config/redis');
const { hashOtp, compareOtp } = require('../utils/hash');
const { generateOtp } = require('../utils/otpGenerator');
const { sendOtpEmail, gmailConfigured } = require('./email.service');

function ttlSeconds() {
  return Number(process.env.OTP_TTL_SECONDS || 300);
}

function resendCooldown() {
  return Number(process.env.OTP_RESEND_COOLDOWN_SECONDS || 30);
}

function maxAttempts() {
  return Number(process.env.OTP_MAX_ATTEMPTS || 3);
}

function otpLength() {
  return Number(process.env.OTP_LENGTH || 4);
}

/** Demo OTP only when explicitly enabled (tests / local fallback). */
function allowDemoOtp() {
  return process.env.ALLOW_DEMO_OTP === 'true';
}

function demoOtp() {
  const configured = process.env.DEMO_OTP;
  if (configured && /^\d+$/.test(configured)) {
    return configured.padStart(otpLength(), '0').slice(-otpLength());
  }
  return '1234'.slice(0, otpLength()).padStart(otpLength(), '0');
}

function resolveTarget({ target, phone, email }) {
  return target || email || phone || null;
}

function redisKey(purpose, target) {
  return `otp:${purpose}:${target}`;
}

async function storeOtp({ purpose, target, code, meta = {}, channel = 'email' }) {
  const hashed = hashOtp(code);
  const expiresAt = new Date(Date.now() + ttlSeconds() * 1000);
  const payload = {
    purpose,
    target,
    phone: channel === 'sms' ? target : null,
    email: channel === 'email' ? target : meta.deliveryEmail || null,
    channel,
    hash: hashed,
    attempts: 0,
    locked: false,
    createdAt: new Date(),
    expiresAt,
    lastSentAt: new Date(),
    meta,
  };

  const redis = getRedis();
  if (redis) {
    await redis.set(redisKey(purpose, target), JSON.stringify(payload), {
      EX: ttlSeconds(),
    });
  }

  const db = getDB();
  await db.collection('otps').updateOne(
    { purpose, target },
    { $set: payload },
    { upsert: true }
  );

  return {
    otpExpiresInSeconds: ttlSeconds(),
    resendAvailableInSeconds: resendCooldown(),
  };
}

async function getOtpRecord(purpose, target) {
  const redis = getRedis();
  if (redis) {
    const raw = await redis.get(redisKey(purpose, target));
    if (raw) return JSON.parse(raw);
  }
  const db = getDB();
  return (
    (await db.collection('otps').findOne({ purpose, target })) ||
    (await db.collection('otps').findOne({ purpose, phone: target }))
  );
}

async function persistOtpRecord(record) {
  const target = record.target || record.phone || record.email;
  const redis = getRedis();
  if (redis) {
    const remaining = Math.max(
      1,
      Math.floor((new Date(record.expiresAt).getTime() - Date.now()) / 1000)
    );
    await redis.set(redisKey(record.purpose, target), JSON.stringify(record), {
      EX: remaining,
    });
  }
  const db = getDB();
  await db.collection('otps').updateOne(
    { purpose: record.purpose, target },
    { $set: { ...record, target } },
    { upsert: true }
  );
}

async function clearOtp(purpose, target) {
  const redis = getRedis();
  if (redis) await redis.del(redisKey(purpose, target));
  const db = getDB();
  await db.collection('otps').deleteMany({
    purpose,
    $or: [{ target }, { phone: target }, { email: target }],
  });
}

/**
 * Send OTP to email (login) or phone target (phone_change — delivered by email when SMTP is configured).
 */
async function sendOtp({ purpose, phone, email, target, channel, meta = {} }) {
  const dest = resolveTarget({ target, phone, email });
  if (!dest) {
    const err = new Error('OTP destination is required');
    err.code = 'VALIDATION_ERROR';
    err.status = 400;
    throw err;
  }

  const deliveryChannel =
    channel ||
    (purpose === 'login' || email || (target && String(target).includes('@')) ? 'email' : 'sms');

  const existing = await getOtpRecord(purpose, dest);
  if (existing?.lastSentAt) {
    const elapsed = (Date.now() - new Date(existing.lastSentAt).getTime()) / 1000;
    if (elapsed < resendCooldown()) {
      const retryAfterSeconds = Math.ceil(resendCooldown() - elapsed);
      const err = new Error('Please wait before requesting another code.');
      err.code = 'RESEND_COOLDOWN';
      err.status = 429;
      err.details = [
        {
          field: deliveryChannel === 'email' ? 'email' : 'mobile',
          message: 'Resend cooldown',
          retryAfterSeconds,
        },
      ];
      throw err;
    }
  }

  const code = allowDemoOtp() ? demoOtp() : generateOtp(otpLength());
  const timing = await storeOtp({
    purpose,
    target: dest,
    code,
    meta,
    channel: deliveryChannel,
  });

  const mailTo =
    deliveryChannel === 'email' ? dest : meta.deliveryEmail || null;

  if (mailTo) {
    if (gmailConfigured()) {
      await sendOtpEmail({ to: mailTo, code, purpose });
    } else if (allowDemoOtp()) {
      console.log(`[email/demo] ${purpose} OTP → ${mailTo} | code=${code}`);
    } else {
      const err = new Error(
        'Email delivery is not configured. Set GMAIL_USER and GMAIL_APP_PASSWORD.'
      );
      err.code = 'EMAIL_NOT_CONFIGURED';
      err.status = 503;
      throw err;
    }
  } else if (allowDemoOtp()) {
    console.log(`[otp/sms-demo] ${purpose} → ${dest} code=${code}`);
  } else {
    const err = new Error(
      'Unable to deliver OTP. Email delivery is required (no SMS provider configured).'
    );
    err.code = 'OTP_DELIVERY_FAILED';
    err.status = 503;
    throw err;
  }

  return timing;
}

async function verifyOtp({ purpose, phone, email, target, code }) {
  const dest = resolveTarget({ target, phone, email });
  const record = await getOtpRecord(purpose, dest);
  if (!record) {
    const err = new Error('Code expired or not found. Request a new code.');
    err.code = 'OTP_EXPIRED';
    err.status = 410;
    throw err;
  }

  if (record.locked) {
    const err = new Error('Too many incorrect attempts. Request a new code.');
    err.code = 'OTP_LOCKED';
    err.status = 403;
    throw err;
  }

  if (new Date(record.expiresAt) < new Date()) {
    await clearOtp(purpose, dest);
    const err = new Error('Code expired. Request a new code.');
    err.code = 'OTP_EXPIRED';
    err.status = 410;
    throw err;
  }

  const ok =
    compareOtp(code, record.hash) ||
    (allowDemoOtp() && String(code) === demoOtp());

  if (!ok) {
    record.attempts = (record.attempts || 0) + 1;
    const remaining = maxAttempts() - record.attempts;
    if (remaining <= 0) {
      record.locked = true;
      await persistOtpRecord(record);
      const err = new Error('Too many incorrect attempts. Request a new code.');
      err.code = 'OTP_LOCKED';
      err.status = 403;
      throw err;
    }
    await persistOtpRecord(record);
    const err = new Error(`Incorrect code. ${remaining} attempts left.`);
    err.code = 'OTP_INVALID';
    err.status = 401;
    err.details = [
      { field: 'code', message: 'Incorrect code', attemptsRemaining: remaining },
    ];
    throw err;
  }

  await clearOtp(purpose, dest);
  return { ok: true, meta: record.meta || {} };
}

module.exports = {
  sendOtp,
  verifyOtp,
  clearOtp,
  ttlSeconds,
  resendCooldown,
  allowDemoOtp,
  demoOtp,
  otpLength,
};
