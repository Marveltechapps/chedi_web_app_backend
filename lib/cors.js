/**
 * Browser CORS for the member app + admin dashboard.
 *
 * Production frontends live on chedi.in subdomains and call the API on a
 * different host (api.webapp.chedi.in). Local Vite uses localhost:5173/5174.
 * A static allow-list misses new subdomains, 127.0.0.1, and extra Vite ports,
 * which the browser reports as "Failed to fetch".
 */

const ALLOWED_HEADERS = [
  'Authorization',
  'Content-Type',
  'Accept',
  'X-Request-Id',
  'Idempotency-Key',
  'X-Requested-With',
];

const ALLOWED_METHODS = ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'];

function parseOriginList(raw) {
  return String(raw == null ? '*' : raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeOrigin(origin) {
  return String(origin || '')
    .trim()
    .replace(/\/+$/, '');
}

function hostnameOf(origin) {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isLocalDevOrigin(origin) {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

function isChediOrigin(origin) {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return host === 'chedi.in' || host.endsWith('.chedi.in');
  } catch {
    return false;
  }
}

function isOriginAllowed(origin, corsOriginEnv = process.env.CORS_ORIGIN) {
  if (!origin) return true;
  const normalized = normalizeOrigin(origin);
  const parts = parseOriginList(corsOriginEnv);
  if (parts.includes('*')) return true;
  const allowed = new Set(parts.map(normalizeOrigin));
  if (allowed.has(normalized)) return true;
  if (isLocalDevOrigin(normalized)) return true;
  if (isChediOrigin(normalized)) return true;
  return false;
}

function corsOriginDelegate(origin, callback) {
  callback(null, isOriginAllowed(origin));
}

function corsOptions() {
  return {
    origin: corsOriginDelegate,
    credentials: true,
    methods: ALLOWED_METHODS,
    allowedHeaders: ALLOWED_HEADERS,
    optionsSuccessStatus: 204,
    maxAge: 86400,
  };
}

function socketCorsOptions() {
  return {
    origin: corsOriginDelegate,
    credentials: true,
    methods: ['GET', 'POST'],
    allowedHeaders: ALLOWED_HEADERS,
  };
}

module.exports = {
  ALLOWED_HEADERS,
  ALLOWED_METHODS,
  parseOriginList,
  normalizeOrigin,
  hostnameOf,
  isLocalDevOrigin,
  isChediOrigin,
  isOriginAllowed,
  corsOriginDelegate,
  corsOptions,
  socketCorsOptions,
};
