const path = require('path');
const express = require('express');
const cors = require('cors');
const { nanoid } = require('nanoid');
const { errorHandler, notFoundHandler } = require('./lib/errors');
const { isDbReady } = require('./config/db');
const { corsOptions } = require('./lib/cors');

const REQUEST_TIMEOUT_MS = Number(process.env.HTTP_REQUEST_TIMEOUT_MS || 30000);

function requestTimeout(ms) {
  return (req, res, next) => {
    res.setTimeout(ms, () => {
      if (res.headersSent) return;
      console.error(`[http] request timeout ${req.method} ${req.originalUrl}`);
      res.status(504).json({
        success: false,
        message: 'Request timed out. Please try again.',
        error: {
          code: 'TIMEOUT',
          message: 'Request timed out. Please try again.',
          details: [],
          requestId: req.requestId,
        },
      });
    });
    next();
  };
}

function createApp() {
  const app = express();
  app.set('trust proxy', 1);

  app.use(cors(corsOptions()));
  app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
  app.use(express.json({ limit: '8mb' }));
  app.use(requestTimeout(REQUEST_TIMEOUT_MS));

  app.use((req, _res, next) => {
    req.requestId = req.get('X-Request-Id') || `req_${nanoid(10)}`;
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      success: true,
      service: 'chediwebapp-backend',
      version: '1.0.0',
      db: isDbReady(),
    });
  });

  const api = express.Router();
  api.use('/auth', require('./routes/auth'));
  api.use('/membership', require('./routes/membership'));
  api.use('/me', require('./routes/me'));
  api.use('/plots', require('./routes/plots'));
  api.use('/plans', require('./routes/plans'));
  api.use('/subscriptions', require('./routes/subscriptions'));
  api.use('/payments', require('./routes/payments'));
  api.use('/payment-methods', require('./routes/payment_methods'));
  api.use('/deliveries', require('./routes/deliveries'));
  api.use('/overview', require('./routes/overview'));
  api.use('/my-plot', require('./routes/my_plot'));
  api.use('/addresses', require('./routes/addresses'));
  api.use('/notifications', require('./routes/notifications'));
  api.use('/support', require('./routes/support'));
  api.use('/legal', require('./routes/legal'));
  api.use('/admin', require('./routes/adminConsole'));
  api.use('/admin', require('./routes/admin'));

  app.use('/api/v1', api);
  // Frontend default VITE_API_URL=/api → map to /api/v1
  app.use('/api', api);

  const { mountAdminDashboard } = require('./routes/admin');
  mountAdminDashboard(app);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
