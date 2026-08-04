/**
 * Normalize Indian mobile numbers to E.164 (+91XXXXXXXXXX).
 */
function normalizePhone(input) {
  if (!input || typeof input !== 'string') return null;
  let digits = input.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) {
    digits = '+' + digits.slice(1).replace(/\D/g, '');
  } else {
    digits = digits.replace(/\D/g, '');
  }

  if (digits.startsWith('+91') && digits.length === 13) return digits;
  if (digits.startsWith('91') && digits.length === 12) return `+${digits}`;
  if (/^\d{10}$/.test(digits)) return `+91${digits}`;
  if (digits.startsWith('+') && digits.length >= 11) return digits;
  return null;
}

function isValidIndianMobile(e164) {
  return /^\+91[6-9]\d{9}$/.test(e164 || '');
}

function displayPhone(e164) {
  const n = normalizePhone(e164);
  if (!n || !n.startsWith('+91') || n.length !== 13) return e164 || '';
  const local = n.slice(3);
  return `+91 ${local.slice(0, 5)} ${local.slice(5)}`;
}

module.exports = { normalizePhone, isValidIndianMobile, displayPhone };
