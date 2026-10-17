/**
 * Boots a local MongoDB whose files stay in .mongo-data, seeds demo data
 * only when the database is empty, and starts the API.
 * Usage: npm run dev:memory
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config();

async function main() {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const dbPath = path.join(__dirname, '..', '.mongo-data');
  fs.mkdirSync(dbPath, { recursive: true });
  const mongod = await MongoMemoryServer.create({
    instance: {
      dbPath,
      storageEngine: 'wiredTiger',
    },
  });
  process.env.CHEDI_USE_MEMORY_MONGO = 'true';
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = process.env.MONGODB_DB || 'chedi_csa';
  // Keep .env ALLOW_DEMO_OTP. When Gmail is set, login codes are emailed.
  if (!process.env.ALLOW_DEMO_OTP && !process.env.GMAIL_USER) {
    process.env.ALLOW_DEMO_OTP = 'true';
  }
  process.env.DEMO_OTP = process.env.DEMO_OTP || '1234';
  process.env.OTP_LENGTH = process.env.OTP_LENGTH || '4';
  process.env.NODE_ENV = process.env.NODE_ENV || 'development';

  console.log(`[dev:memory] MongoMemoryServer ready (${dbPath})`);

  const { connectDB, getDB } = require('../config/db');
  await connectDB();
  const memberCount = await getDB().collection('members').countDocuments();
  if (memberCount === 0) {
    const { seed } = require('../seed/seed');
    await seed();
  } else {
    console.log(`[dev:memory] keeping existing local data (${memberCount} members)`);
  }

  const http = require('http');
  const { initRedis } = require('../config/redis');
  const { createApp } = require('../app');
  const { attachRealtime } = require('../lib/realtime');

  await connectDB();
  console.log(`[db] connected (${process.env.MONGODB_DB})`);
  await initRedis();

  const host = process.env.HOST || '0.0.0.0';
  const port = Number(process.env.PORT || 4000);
  const app = createApp();
  const server = http.createServer(app);
  attachRealtime(server);
  server.listen(port, host, () => {
    console.log(`[server] CHEDI CSA API (memory) on http://${host}:${port}`);
    console.log(`[server] Socket.IO path: /socket.io`);
    console.log(`[server] Demo login: priya@email.com / OTP ${process.env.DEMO_OTP}`);
  });

  const shutdown = async () => {
    try {
      await mongod.stop({ doCleanup: false });
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
