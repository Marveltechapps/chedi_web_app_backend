const crypto = require('crypto');

function hashOtp(code) {
  const salt = process.env.OTP_HASH_SALT || 'chedi-otp-salt';
  return crypto.createHmac('sha256', salt).update(String(code)).digest('hex');
}

function compareOtp(code, hashed) {
  const a = Buffer.from(hashOtp(code));
  const b = Buffer.from(hashed || '');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { hashOtp, compareOtp };
