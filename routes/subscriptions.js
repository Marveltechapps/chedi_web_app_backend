const express = require('express');
const { getDB } = require('../config/db');
const { ApiError } = require('../lib/errors');
const { requireMember } = require('../middleware/auth');
const { toPlan, toSubscription } = require('../lib/serializers');
const { formatInr } = require('../lib/money');
const { withIdempotency } = require('../lib/idempotency');
const {
  validatePaymentMethod,
  toPaymentIntent,
  createRenewalPaymentRequest,
  createSubscriptionFromPayment,
  DELIVERY_CHARGE_INR,
} = require('../lib/payments');
const realtime = require('../lib/realtime');

const router = express.Router();

async function loadSubscriptionBundle(sub) {
  const db = getDB();
  const [plot, planDoc] = await Promise.all([
    db.collection('plots').findOne({ key: sub.plotKey }),
    db.collection('plans').findOne({ key: sub.planKey }),
  ]);
  return toSubscription(sub, plot, planDoc ? toPlan(planDoc) : null);
}

router.get('/', requireMember, async (req, res, next) => {
  try {
    const db = getDB();
    const member = req.memberDoc;
    const subs = await db
      .collection('subscriptions')
      .find({ memberId: member.id })
      .sort({ createdAt: -1 })
      .toArray();
    const items = await Promise.all(subs.map(loadSubscriptionBundle));
    res.json({
      items,
      activeSubscriptionId: member.activeSubscriptionId || items[0]?.id || null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/quote', requireMember, async (req, res, next) => {
  try {
    const { plotKey, planKey } = req.body || {};
    const db = getDB();
    const plot = await db.collection('plots').findOne({ key: plotKey });
    if (!plot) throw new ApiError(404, 'PLOT_NOT_FOUND', 'Plot not found');
    if (plot.status !== 'available') {
      throw new ApiError(400, 'PLOT_UNAVAILABLE', 'This plot is not available');
    }
    const existing = await db.collection('subscriptions').findOne({
      memberId: req.member.id,
      plotKey,
      status: { $in: ['active', 'past_due'] },
    });
    if (existing) {
      throw new ApiError(400, 'PLOT_ALREADY_LEASED_BY_YOU', 'You already lease this plot');
    }
    const planDoc = await db.collection('plans').findOne({ key: planKey });
    if (!planDoc) throw new ApiError(404, 'PLAN_NOT_FOUND', 'Plan not found');
    const plan = toPlan(planDoc);
    const deliveryChargeInr = DELIVERY_CHARGE_INR();

    res.json({
      plotKey: plot.key,
      planKey: plan.key,
      plotName: plot.name,
      planName: plan.name,
      annualSubscriptionInr: plan.priceInr,
      annualSubscriptionFormatted: formatInr(plan.priceInr),
      deliveryChargeInr,
      deliveryChargeFormatted: formatInr(deliveryChargeInr),
      totalInr: plan.totalInr,
      totalFormatted: formatInr(plan.totalInr),
      billingMode: 'manual',
      billingNote:
        'A renewal bill is generated at the end of your plan year. You pay it manually to continue weekly deliveries — no auto-charge.',
    });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireMember, async (req, res, next) => {
  try {
    const result = await withIdempotency(req, 'create_subscription', async () => {
      const { plotKey, planKey, paymentId } = req.body || {};
      const db = getDB();
      if (!plotKey || !planKey || !paymentId) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'plotKey, planKey, and paymentId are required');
      }
      const payment = await db.collection('payments').findOne({
        id: paymentId,
        memberId: req.member.id,
      });
      if (!payment || payment.status !== 'succeeded') {
        throw new ApiError(402, 'PAYMENT_REQUIRED', 'A successful payment is required');
      }
      if (payment.context !== 'lease') {
        throw new ApiError(400, 'VALIDATION_ERROR', 'Payment context must be lease');
      }

      const existing = await db.collection('subscriptions').findOne({
        memberId: req.member.id,
        plotKey,
        status: { $in: ['active', 'past_due'] },
      });
      if (existing) {
        throw new ApiError(409, 'DUPLICATE_LEASE', 'You already lease this plot');
      }

      const plot = await db.collection('plots').findOne({ key: plotKey });
      if (!plot || plot.status !== 'available') {
        throw new ApiError(409, 'PLOT_NOT_AVAILABLE', 'Plot is not available');
      }
      const planDoc = await db.collection('plans').findOne({ key: planKey });
      if (!planDoc) throw new ApiError(404, 'PLAN_NOT_FOUND', 'Plan not found');

      const subscription = await createSubscriptionFromPayment({
        memberId: req.member.id,
        plot,
        plan: toPlan(planDoc),
        paymentId,
      });
      return { status: 201, body: subscription };
    });
    if (result.status < 400) {
      await realtime.emitSafe(
        realtime.notifySubscriptionChange(realtime.EVENTS.SUBSCRIPTION_CREATED, {
          memberId: req.member.id,
          subscription: result.body,
        })
      );
    }
    res.status(result.status).json(result.body);
  } catch (err) {
    next(err);
  }
});

router.get('/:subscriptionId', requireMember, async (req, res, next) => {
  try {
    const db = getDB();
    const sub = await db.collection('subscriptions').findOne({
      id: req.params.subscriptionId,
      memberId: req.member.id,
    });
    if (!sub) throw new ApiError(404, 'SUBSCRIPTION_NOT_FOUND', 'Subscription not found');
    res.json(await loadSubscriptionBundle(sub));
  } catch (err) {
    next(err);
  }
});

router.post('/:subscriptionId/renewal-payments', requireMember, async (req, res, next) => {
  try {
    const result = await withIdempotency(req, 'renewal_payment', async () => {
      const db = getDB();
      const sub = await db.collection('subscriptions').findOne({
        id: req.params.subscriptionId,
        memberId: req.member.id,
      });
      if (!sub) throw new ApiError(404, 'SUBSCRIPTION_NOT_FOUND', 'Subscription not found');
      if (sub.billPaid) {
        throw new ApiError(409, 'BILL_ALREADY_PAID', 'Renewal bill already paid');
      }

      validatePaymentMethod(req.body || {});
      const plot = await db.collection('plots').findOne({ key: sub.plotKey });
      const body = await createRenewalPaymentRequest({
        memberId: req.member.id,
        subscription: sub,
        plot,
        member: req.memberDoc || req.member,
      });
      return { status: 200, body };
    });
    if (result.body?.payment) {
      await realtime.emitSafe(
        realtime.notifyPaymentChange(realtime.EVENTS.PAYMENT_CREATED, {
          payment: result.body.payment,
          memberId: req.member.id,
        })
      );
    }
    res.status(result.status).json(result.body);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
