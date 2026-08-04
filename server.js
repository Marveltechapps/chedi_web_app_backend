require('dotenv').config();

const { createApp } = require('./app');
const { connectDB } = require('./config/db');
const { initRedis } = require('./config/redis');

async function main() {
  const host = process.env.HOST || '0.0.0.0';
  const port = Number(process.env.PORT || 4000);

  await connectDB();
  console.log(`[db] connected (${process.env.MONGODB_DB || 'chedi_csa'})`);

  await initRedis();

  const app = createApp();
  app.listen(port, host, () => {
    console.log(`[server] CHEDI CSA API listening on http://${host}:${port}`);
    console.log(`[server] Base paths: /api/v1  and  /api`);
  });
}

main().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});
