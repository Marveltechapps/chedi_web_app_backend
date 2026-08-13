/**
 * Boots an in-memory MongoDB, seeds demo data, and starts the API.
 * Usage: npm run dev:memory
 */
require('dotenv').config();

async function main() {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  process.env.CHEDI_USE_MEMORY_MONGO = 'true';
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = process.env.MONGODB_DB || 'chedi_csa';
  process.env.ALLOW_DEMO_OTP = process.env.ALLOW_DEMO_OTP || 'true';
  process.env.DEMO_OTP = process.env.DEMO_OTP || '1234';
  process.env.OTP_LENGTH = process.env.OTP_LENGTH || '4';
  process.env.NODE_ENV = process.env.NODE_ENV || 'development';

  console.log('[dev:memory] MongoMemoryServer ready');

  const { seed } = require('../seed/seed');
  await seed();

  const { connectDB } = require('../config/db');
  const { initRedis } = require('../config/redis');
  const { createApp } = require('../app');

  await connectDB();
  console.log(`[db] connected (${process.env.MONGODB_DB})`);
  await initRedis();

  const host = process.env.HOST || '0.0.0.0';
  const port = Number(process.env.PORT || 4000);
  const app = createApp();
  app.listen(port, host, () => {
    console.log(`[server] CHEDI CSA API (memory) on http://${host}:${port}`);
    console.log(`[server] Demo login: priya@email.com / OTP ${process.env.DEMO_OTP}`);
  });

  const shutdown = async () => {
    try {
      await mongod.stop();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[dev:memory] failed:', err);
  process.exit(1);
});
