const crypto = require('crypto');

/**
 * Secure numeric OTP (default 4 digits).
 */
function generateOtp(length = 4) {
  const max = 10 ** length;
  const n = crypto.randomInt(0, max);
  return String(n).padStart(length, '0');
}

module.exports = { generateOtp };
