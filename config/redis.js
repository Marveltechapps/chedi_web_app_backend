/**
 * Optional Redis client. When REDIS_URL is unset, returns null and callers
 * should fall back to MongoDB (e.g. OTP storage).
 */
let redis = null;
let initAttempted = false;

async function initRedis() {
  if (initAttempted) return redis;
  initAttempted = true;

  const url = process.env.REDIS_URL;
  if (!url) return null;

  try {
    // Optional dependency — only load if configured
    // eslint-disable-next-line import/no-extraneous-dependencies, global-require
    const { createClient } = require('redis');
    redis = createClient({ url });
    redis.on('error', (err) => {
      console.warn('[redis] error:', err.message);
    });
    await redis.connect();
    console.log('[redis] connected');
    return redis;
  } catch (err) {
    console.warn('[redis] unavailable, using Mongo fallback:', err.message);
    redis = null;
    return null;
  }
}

function getRedis() {
  return redis;
}

module.exports = { initRedis, getRedis };
