const express = require('express');
const { getDB } = require('../config/db');
const { ApiError } = require('../lib/errors');
const { requireMember, optionalMember } = require('../middleware/auth');
const { withIdempotency } = require('../lib/idempotency');
const { toPlan, toSubscription } = require('../lib/serializers');
const {
  NET_BANKS,
  validatePaymentMethod,
  toPaymentIntent,
  createLeasePaymentRequest,
  createRenewalPaymentRequest,
} = require('../lib/payments');

const router = express.Router();

router.get('/net-banks', optionalMember, async (_req, res) => {
  // Kept for API compatibility — card/net-banking checkout removed
  res.json({ items: NET_BANKS, deprecated: true, notice: 'Use payment_request checkout instead.' });
});

router.get('/history', requireMember, async (req, res, next) => {
  try {
    const db = getDB();
    const payments = await db
      .collection('payments')
      .find({ memberId: req.member.id })
      .sort({ createdAt: -1 })
      .toArray();
    res.json({
      items: payments.map((p) => ({
        id: p.id,
        ref: p.ref,
        label: p.label,
        amountFormatted: p.amountFormatted,
        amountInr: p.amountInr,
        date: p.date,
        status: p.status,
        context: p.context,
        method: p.method,
        subscriptionId: p.metadata?.subscriptionId || undefined,
        plotKey: p.metadata?.plotKey || undefined,
        planKey: p.metadata?.planKey || undefined,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireMember, async (req, res, next) => {
  try {
    const result = await withIdempotency(req, 'payment_create', async () => {
      const body = req.body || {};
      const context = body.context;
      if (!['lease', 'renewal', 'membership'].includes(context)) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid payment context', [
          { field: 'context', message: 'Must be membership, lease, or renewal' },
        ]);
      }

      validatePaymentMethod(body);
      const metadata = body.metadata || {};
      const member = req.memberDoc || req.member;

      if (context === 'lease') {
        const plotKey = metadata.plotKey;
        const planKey = metadata.planKey;
        if (!plotKey || !planKey) {
          throw new ApiError(400, 'VALIDATION_ERROR', 'metadata.plotKey and planKey required');
        }
        const leaseResult = await createLeasePaymentRequest({
          memberId: req.member.id,
          plotKey,
          planKey,
          member,
        });
        return { status: 200, body: leaseResult };
      }

      if (context === 'renewal') {
        const subscriptionId = metadata.subscriptionId;
        if (!subscriptionId) {
          throw new ApiError(400, 'VALIDATION_ERROR', 'metadata.subscriptionId required');
        }
        const db = getDB();
        const sub = await db.collection('subscriptions').findOne({
          id: subscriptionId,
          memberId: req.member.id,
        });
        if (!sub) throw new ApiError(404, 'SUBSCRIPTION_NOT_FOUND', 'Subscription not found');
        const plot = await db.collection('plots').findOne({ key: sub.plotKey });
        const renewResult = await createRenewalPaymentRequest({
          memberId: req.member.id,
          subscription: sub,
          plot,
          member,
        });
        return { status: 200, body: renewResult };
      }

      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        'Use POST /membership/payments for membership join payments'
      );
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    next(err);
  }
});

router.get('/:paymentId', requireMember, async (req, res, next) => {
  try {
    const db = getDB();
    const payment = await db.collection('payments').findOne({
      id: req.params.paymentId,
      $or: [{ memberId: req.member.id }, { memberId: null }],
    });
    if (!payment) throw new ApiError(404, 'NOT_FOUND', 'Payment not found');
    // Membership pending requests may not have memberId yet — allow by registration email match is skipped for simplicity
    if (payment.memberId && payment.memberId !== req.member.id) {
      throw new ApiError(404, 'NOT_FOUND', 'Payment not found');
    }

    const response = { payment: toPaymentIntent(payment) };

    if (payment.status === 'succeeded' && payment.context === 'lease') {
      const sub = await db.collection('subscriptions').findOne({
        paymentId: payment.id,
        memberId: req.member.id,
      });
      if (sub) {
        const plot = await db.collection('plots').findOne({ key: sub.plotKey });
        const planDoc = await db.collection('plans').findOne({ key: sub.planKey });
        response.subscription = toSubscription(sub, plot, planDoc ? toPlan(planDoc) : null);
      }
      response.member = req.member;
    }

    res.json(response);
  } catch (err) {
    next(err);
  }
});

router.get('/:paymentId/receipt', requireMember, async (req, res, next) => {
  try {
    const db = getDB();
    const payment = await db.collection('payments').findOne({
      id: req.params.paymentId,
      memberId: req.member.id,
    });
    if (!payment) throw new ApiError(404, 'NOT_FOUND', 'Payment not found');
    const statusLabel =
      payment.status === 'succeeded'
        ? 'Paid'
        : payment.status === 'pending'
          ? 'Awaiting confirmation'
          : payment.status;
    res.json({
      ref: payment.ref,
      date: payment.date,
      memberName: req.memberDoc.name,
      memberCode: req.member.memberCode,
      label: payment.label,
      status: statusLabel,
      amountFormatted: payment.amountFormatted,
      amountInr: payment.amountInr,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/webhooks/:provider', async (req, res) => {
  console.log(`[webhook] provider=${req.params.provider}`, req.body);
  res.json({ ok: true });
});

module.exports = router;
