const express = require('express');
const path = require('path');
const { requireAdmin, adminKey } = require('../middleware/admin');
const {
  listAdminPayments,
  approvePayment,
  rejectPayment,
} = require('../lib/payments');
const { ApiError } = require('../lib/errors');
const realtime = require('../lib/realtime');

const router = express.Router();

router.post('/login', async (req, res, next) => {
  try {
    const key = String(req.body?.password || req.body?.adminKey || '').trim();
    if (!key || key !== adminKey()) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Invalid admin credentials');
    }
    res.json({
      ok: true,
      token: adminKey(),
      notice: 'Use this token as Bearer for admin APIs.',
    });
  } catch (err) {
    next(err);
  }
});

router.get('/payments', requireAdmin, async (req, res, next) => {
  try {
    const status = req.query.status || 'pending';
    const items = await listAdminPayments({ status });
    res.json({ items, count: items.length });
  } catch (err) {
    next(err);
  }
});

router.post('/payments/:paymentId/approve', requireAdmin, async (req, res, next) => {
  try {
    const result = await approvePayment(req.params.paymentId, {
      approvedBy: req.body?.approvedBy || 'admin',
      adminNote: req.body?.adminNote || '',
    });
    await realtime.emitSafe(
      realtime.notifyPaymentChange(realtime.EVENTS.PAYMENT_UPDATED, {
        payment: result.payment || result,
        memberId: result.payment?.memberId || result.memberId,
      })
    );
    res.json({
      ok: true,
      ...result,
      notice: 'Payment marked as Paid. Membership / lease / renewal effects applied.',
    });
  } catch (err) {
    next(err);
  }
});

router.post('/payments/:paymentId/reject', requireAdmin, async (req, res, next) => {
  try {
    const result = await rejectPayment(req.params.paymentId, {
      rejectedBy: req.body?.rejectedBy || 'admin',
      adminNote: req.body?.adminNote || '',
    });
    await realtime.emitSafe(
      realtime.notifyPaymentChange(realtime.EVENTS.PAYMENT_UPDATED, {
        payment: result.payment || result,
        memberId: result.payment?.memberId || result.memberId,
      })
    );
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

function mountAdminDashboard(app) {
  const dir = path.join(__dirname, '..', 'public', 'admin');
  app.use('/admin', express.static(dir));
  app.get('/admin', (_req, res) => {
    res.sendFile(path.join(dir, 'index.html'));
  });
}

module.exports = router;
module.exports.mountAdminDashboard = mountAdminDashboard;
