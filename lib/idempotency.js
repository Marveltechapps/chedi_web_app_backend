const { getDB } = require('../config/db');
const { ApiError } = require('./errors');

/**
 * Idempotency for payment / lease endpoints.
 * Replaying the same key within 24h returns the stored response.
 */
async function withIdempotency(req, scope, handler) {
  const key = req.get('Idempotency-Key');
  if (!key) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Idempotency-Key header is required', [
      { field: 'Idempotency-Key', message: 'Required' },
    ]);
  }

  const db = getDB();
  const memberId = req.member?.id || (req.staff && `staff:${req.staff.id}`) || 'public';
  const lookup = { key, scope, memberId };
  const existing = await db.collection('idempotency').findOne(lookup);
  if (existing && existing.expiresAt > new Date()) {
    return { replay: true, status: existing.status, body: existing.body };
  }

  const result = await handler();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await db.collection('idempotency').updateOne(
    lookup,
    {
      $set: {
        ...lookup,
        status: result.status,
        body: result.body,
        createdAt: new Date(),
        expiresAt,
      },
    },
    { upsert: true }
  );
  return { replay: false, ...result };
}

function requireIdempotencyKey(req) {
  const key = req.get('Idempotency-Key');
  if (!key) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Idempotency-Key header is required', [
      { field: 'Idempotency-Key', message: 'Required' },
    ]);
  }
  return key;
}

module.exports = { withIdempotency, requireIdempotencyKey };
