const express = require('express');
const cors = require('cors');
const { nanoid } = require('nanoid');
const { errorHandler, notFoundHandler } = require('./lib/errors');

function createApp() {
  const app = express();

  const corsOrigin = process.env.CORS_ORIGIN || '*';
  app.use(
    cors({
      origin: corsOrigin === '*' ? true : corsOrigin.split(',').map((s) => s.trim()),
      credentials: true,
    })
  );
  app.use(express.json({ limit: '1mb' }));

  app.use((req, _res, next) => {
    req.requestId = req.get('X-Request-Id') || `req_${nanoid(10)}`;
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'chediwebapp-backend', version: '1.0.0' });
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
