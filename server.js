require('dotenv').config();

const http = require('http');
const { createApp } = require('./app');
const { connectDB, isMemoryFallback, isDbReady } = require('./config/db');
const { initRedis } = require('./config/redis');
const { redactSecrets } = require('./lib/errors');
const { attachRealtime } = require('./lib/realtime');

const REQUEST_TIMEOUT_MS = Number(process.env.HTTP_REQUEST_TIMEOUT_MS || 30000);

function installProcessGuards() {
  process.on('unhandledRejection', (reason) => {
    const msg = reason && reason.message ? reason.message : reason;
    console.error('[process] unhandledRejection:', redactSecrets(msg));
  });

  process.on('uncaughtException', (err) => {
    console.error('[process] uncaughtException:', redactSecrets(err && err.message), err && err.stack);
    // Do not exit: a single OTP/provider/database failure must not kill the API.
  });
}

async function main() {
  installProcessGuards();

  const host = process.env.HOST || '0.0.0.0';
  const port = Number(process.env.PORT || 4000);

  await connectDB();

  if (isMemoryFallback()) {
    console.log(`[db] connected (explicit in-memory Mongo → ${process.env.MONGODB_DB || 'chedi_csa'})`);
  } else {
    console.log(`[db] connected (${process.env.MONGODB_DB || 'chedi_csa'})`);
  }

  await initRedis();

  const app = createApp();
  const server = http.createServer(app);
  attachRealtime(server);
  server.listen(port, host, () => {
    console.log(`[server] CHEDI CSA API listening on http://${host}:${port}`);
    console.log(`[server] Base paths: /api/v1  and  /api`);
    console.log(`[server] Socket.IO path: /socket.io`);
    console.log(`[server] database ready=${isDbReady()}`);
  });

  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = REQUEST_TIMEOUT_MS + 5000;
  server.keepAliveTimeout = 65000;
  server.timeout = REQUEST_TIMEOUT_MS;

  server.on('error', (err) => {
    console.error('[server] http error:', redactSecrets(err && err.message));
  });
}

main().catch((err) => {
  console.error('[server] failed to start:', redactSecrets(err && err.message));
  if (err && err.cause) {
    console.error('[server] cause:', redactSecrets(err.cause.message || err.cause));
  }
  process.exit(1);
});
