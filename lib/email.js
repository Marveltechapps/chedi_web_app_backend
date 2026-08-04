/**
 * Normalize and validate email addresses for login / membership.
 */

function normalizeEmail(input) {
  if (!input || typeof input !== 'string') return null;
  const email = input.trim().toLowerCase();
  if (!email || email.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return null;
  return email;
}

function isValidEmail(value) {
  return Boolean(normalizeEmail(value));
}

/** Mask for UI: jane.doe@example.com → j•••@example.com */
function displayEmail(email) {
  const normalized = normalizeEmail(email) || String(email || '').trim().toLowerCase();
  if (!normalized || !normalized.includes('@')) return normalized || '';
  const [local, domain] = normalized.split('@');
  if (local.length <= 1) return `${local}•••@${domain}`;
  return `${local[0]}•••@${domain}`;
}

module.exports = {
  normalizeEmail,
  isValidEmail,
  displayEmail,
};
