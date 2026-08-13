const dns = require('dns');
const { MongoClient } = require('mongodb');
const { redactSecrets } = require('../lib/errors');
const { withTimeout } = require('../lib/timeout');

let client = null;
let db = null;
let connected = false;
let connecting = null;

function isAtlasUri(uri) {
  return Boolean(uri && (uri.startsWith('mongodb+srv://') || /\.mongodb\.net/i.test(uri)));
}

function isMemoryUri(uri) {
  return Boolean(
    process.env.CHEDI_USE_MEMORY_MONGO === 'true' ||
      (uri && /127\.0\.0\.1:\d+/.test(uri) && process.env.CHEDI_USE_MEMORY_MONGO === 'true')
  );
}

function isAtlasTlsBlockedError(err) {
  const msg = String(err && (err.message || err));
  const cause = err && (err.cause || err.reason);
  const causeMsg = cause ? String(cause.message || cause) : '';
  return /TLSV1_ALERT_INTERNAL_ERROR|tlsv1 alert internal error|SSL alert number 80/i.test(
    `${msg}\n${causeMsg}`
  );
}

function isSrvDnsError(err) {
  const msg = String(err && (err.message || err));
  return /querySrv|ENOTFOUND|ECONNREFUSED.*53|dns/i.test(msg) && /mongodb\.net|srv/i.test(msg);
}

function isTransientConnectError(err) {
  if (isAtlasTlsBlockedError(err)) return false;
  const msg = String(err && (err.message || err));
  return /ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENETUNREACH|server selection timed out/i.test(msg);
}

/**
 * Only switch Node to public DNS if Atlas SRV lookup failed.
 * Calling dns.setServers() process-wide changes every lookup (including Gmail SMTP).
 */
function enablePublicDnsForSrv() {
  try {
    const current = dns.getServers();
    const preferred = ['8.8.8.8', '1.1.1.1'];
    const merged = [...new Set([...preferred, ...current])];
    dns.setServers(merged);
    console.warn('[db] SRV lookup failed on system DNS; retrying with public resolvers');
  } catch {
    /* keep system DNS */
  }
}

function attachClientGuards(mongoClient) {
  mongoClient.on('error', (err) => {
    console.error('[db] client error:', redactSecrets(err && err.message));
  });
  mongoClient.on('close', () => {
    connected = false;
    console.warn('[db] connection closed');
  });
}

function clientOptions(uri) {
  const atlas = isAtlasUri(uri);
  return {
    serverSelectionTimeoutMS: atlas ? 15000 : 5000,
    connectTimeoutMS: atlas ? 15000 : 5000,
    heartbeatFrequencyMS: 10000,
    maxIdleTimeMS: 15000,
    retryReads: true,
    // Prefer IPv4 — dual-stack auto-select can break Atlas TLS on some networks
    autoSelectFamily: false,
    family: 4,
  };
}

async function connectWithUri(uri) {
  const dbName = process.env.MONGODB_DB || 'chedi_csa';
  const mongoClient = new MongoClient(uri, clientOptions(uri));
  attachClientGuards(mongoClient);
  await mongoClient.connect();
  const nextDb = mongoClient.db(dbName);
  await nextDb.command({ ping: 1 });
  client = mongoClient;
  db = nextDb;
  connected = true;
  return db;
}

async function attemptConnect(uri) {
  try {
    return await connectWithUri(uri);
  } catch (err) {
    if (client) {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
      client = null;
      db = null;
      connected = false;
    }

    if (isAtlasUri(uri) && isSrvDnsError(err)) {
      enablePublicDnsForSrv();
      return await connectWithUri(uri);
    }
    throw err;
  }
}

function logAtlasTlsFailure(err) {
  console.error('');
  console.error('[db] Atlas TLS handshake failed (SSL alert 80).');
  console.error('     Atlas aborted TLS — usually this IP is not on Network Access,');
  console.error('     or the cluster is paused. TLS verification was NOT disabled.');
  console.error('     Fix: https://cloud.mongodb.com → Network Access → Add IP Address');
  console.error('     Add this machine’s current public IP, wait ~1 minute, restart.');
  console.error('     Do not use 0.0.0.0/0 as a permanent rule.');
  console.error('     Local-only (explicit): npm run dev:memory');
  console.error('    ', redactSecrets(err && err.message));
  console.error('');
}

async function connectDB() {
  if (connected && db) return db;
  if (connecting) return connecting;

  connecting = (async () => {
    const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
    let lastErr;

    for (let i = 1; i <= 3; i += 1) {
      try {
        const result = await attemptConnect(uri);
        connecting = null;
        return result;
      } catch (err) {
        lastErr = err;
        if (isAtlasTlsBlockedError(err)) {
          logAtlasTlsFailure(err);
          break;
        }
        if (!isTransientConnectError(err) || i === 3) break;
        console.error(
          `[db] connection attempt ${i} failed: ${redactSecrets(err.message)}. Retrying…`
        );
        await new Promise((resolve) => setTimeout(resolve, 1000 * i));
      }
    }

    connecting = null;
    connected = false;
    const wrapped = new Error('Database service temporarily unavailable');
    wrapped.status = 503;
    wrapped.code = 'DB_UNAVAILABLE';
    wrapped.cause = lastErr;
    throw wrapped;
  })();

  try {
    return await connecting;
  } catch (err) {
    connecting = null;
    throw err;
  }
}

function getDB() {
  if (!db || !connected) {
    const err = new Error('Database service temporarily unavailable');
    err.status = 503;
    err.code = 'DB_UNAVAILABLE';
    throw err;
  }
  return db;
}

/**
 * Ping the live client and reconnect if the socket is half-open.
 * Idle Atlas / NAT connections can look connected, then hang on the next query
 * until the HTTP proxy sees ECONNRESET.
 */
async function ensureDB() {
  if (connecting) return connecting;
  if (db && connected && client) {
    try {
      await withTimeout(db.command({ ping: 1 }), 3000, 'db ping timed out');
      return db;
    } catch (err) {
      console.warn('[db] ping failed, reconnecting:', redactSecrets(err && err.message));
      await closeDB();
    }
  }
  return connectDB();
}

function isDbReady() {
  return Boolean(db && connected);
}

function isMemoryFallback() {
  return isMemoryUri(process.env.MONGODB_URI);
}

async function closeDB() {
  connected = false;
  if (client) {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
    client = null;
    db = null;
  }
}

module.exports = {
  connectDB,
  getDB,
  ensureDB,
  closeDB,
  isMemoryFallback,
  isDbReady,
  isAtlasTlsBlockedError,
  isAtlasUri,
};
