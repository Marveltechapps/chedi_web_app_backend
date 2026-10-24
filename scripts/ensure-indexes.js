require('dotenv').config();

const { connectDB, closeDB, getDB } = require('../config/db');

async function ensureIndexes() {
  await connectDB();
  const db = getDB();

  await db.collection('members').createIndexes([
    { key: { id: 1 }, unique: true },
    { key: { phone: 1 }, unique: true },
    { key: { email: 1 }, sparse: true },
    { key: { memberCode: 1 }, unique: true },
  ]);
  await db.collection('plots').createIndexes([{ key: { key: 1 }, unique: true }]);
  await db.collection('plans').createIndexes([{ key: { key: 1 }, unique: true }]);
  await db.collection('subscriptions').createIndexes([
    { key: { id: 1 }, unique: true },
    { key: { memberId: 1, plotKey: 1 } },
  ]);
  await db.collection('payments').createIndexes([
    { key: { id: 1 }, unique: true },
    { key: { memberId: 1, createdAt: -1 } },
    {
      key: { collectionRefNorm: 1 },
      unique: true,
      partialFilterExpression: { collectionRefNorm: { $type: 'string' } },
      name: 'payments_collectionRefNorm_unique',
    },
  ]);
  await db.collection('sessions').createIndexes([
    { key: { token: 1 }, unique: true },
    { key: { memberId: 1 } },
    { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
  ]);
  await db.collection('otps').createIndexes([
    { key: { purpose: 1, target: 1 }, unique: true },
    { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
  ]);
  await db.collection('idempotency').createIndexes([
    { key: { key: 1, scope: 1, memberId: 1 }, unique: true },
    { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
  ]);
  await db.collection('deliveries').createIndexes([
    { key: { id: 1 }, unique: true },
    { key: { subscriptionId: 1, weekIndex: 1 } },
  ]);
  await db.collection('addresses').createIndexes([{ key: { memberId: 1 } }]);
  await db.collection('payment_methods').createIndexes([{ key: { memberId: 1 } }]);
  await db.collection('notifications').createIndexes([
    { key: { memberId: 1, createdAt: -1 } },
  ]);
  await db.collection('registrations').createIndexes([{ key: { id: 1 }, unique: true }]);
  await db.collection('staff').createIndexes([
    { key: { id: 1 }, unique: true },
    { key: { email: 1 }, unique: true },
  ]);
  await db.collection('staff_sessions').createIndexes([
    { key: { token: 1 }, unique: true },
    { key: { staffId: 1 } },
    { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
  ]);
  await db.collection('audit_log').createIndexes([{ key: { createdAt: -1 } }, { key: { actorId: 1 } }]);
  await db.collection('crops').createIndexes([{ key: { key: 1 }, unique: true }]);
  await db.collection('cultivations').createIndexes([{ key: { plotKey: 1 }, unique: true }]);
  await db.collection('baskets').createIndexes([{ key: { id: 1 }, unique: true }]);
  await db.collection('tickets').createIndexes([{ key: { id: 1 }, unique: true }, { key: { memberId: 1 } }]);
  await db.collection('cancellation_requests').createIndexes([{ key: { id: 1 }, unique: true }]);
  await db.collection('notifications_sent').createIndexes([{ key: { createdAt: -1 } }]);

  console.log('Indexes ensured.');
  await closeDB();
}

ensureIndexes().catch((err) => {
  console.error(err);
  process.exit(1);
});
