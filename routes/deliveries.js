const express = require('express');
const { getDB } = require('../config/db');
const { ApiError } = require('../lib/errors');
const { requireMember } = require('../middleware/auth');
const { nextSeq } = require('../lib/admin/ids');
const { publishedBasket } = require('../lib/admin/baskets.service');
const realtime = require('../lib/realtime');
const { syncDeliveryWindow, cancelStillOpen, kolkataToday } = require('../lib/deliveryWindow');

const router = express.Router();

const DEFAULT_BASKET = [
  { name: 'Onion', qty: '1 kg', imageUrl: null },
  { name: 'Tomato', qty: '1.5 kg', imageUrl: null },
  { name: 'Brinjal', qty: '1 kg', imageUrl: null },
  { name: "Lady's Finger", qty: '750 g', imageUrl: null },
  { name: 'Carrot', qty: '1 kg', imageUrl: null },
  { name: 'Coriander', qty: '2 bunches', imageUrl: null },
  { name: 'Green Chilli', qty: '200 g', imageUrl: null },
  { name: 'Spinach', qty: '1 bunch', imageUrl: null },
  { name: 'Mint', qty: '1 bunch', imageUrl: null },
];

async function currentBasketItems() {
  try {
    const published = await publishedBasket();
    if (published?.items?.length) {
      return published.items.map((i) => ({
        name: i.cropName,
        qty: `${i.qty} ${i.unit}`,
        imageUrl: null,
        supp: Boolean(i.supp),
      }));
    }
  } catch {
    // catalogs may be empty before admin seed
  }
  return DEFAULT_BASKET;
}

function buildTracking(deliveryDate) {
  const d = new Date(deliveryDate + 'T00:00:00Z');
  const prev = new Date(d.getTime() - 24 * 60 * 60 * 1000);
  const fmt = (date) =>
    date.toLocaleDateString('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    });

  return [
    {
      title: 'Chennai city warehouse',
      timeLabel: fmt(prev),
      timestamp: new Date(prev.getTime() + 20 * 60 * 60 * 1000 + 40 * 60 * 1000).toISOString(),
      done: true,
      active: false,
    },
    {
      title: 'Packed at warehouse',
      timeLabel: fmt(d),
      timestamp: new Date(d.getTime() + 5.5 * 60 * 60 * 1000).toISOString(),
      done: true,
      active: false,
    },
    {
      title: 'Out for delivery',
      timeLabel: `Expected ${fmt(d)}`,
      timestamp: new Date(d.getTime() + 7 * 60 * 60 * 1000).toISOString(),
      done: false,
      active: true,
    },
    {
      title: 'Delivered to your door',
      timeLabel: `Expected ${fmt(d)}`,
      timestamp: new Date(d.getTime() + 10 * 60 * 60 * 1000).toISOString(),
      done: false,
      active: false,
    },
  ];
}

router.get('/', requireMember, async (req, res, next) => {
  try {
    const db = getDB();
    const member = req.memberDoc;
    let subscriptionId = req.query.subscriptionId || member.activeSubscriptionId;

    if (!subscriptionId) {
      const first = await db.collection('subscriptions').findOne(
        { memberId: member.id, status: { $in: ['active', 'past_due'] } },
        { sort: { createdAt: -1 } }
      );
      subscriptionId = first?.id;
    }

    if (!subscriptionId) {
      return res.json({
        hasPlot: false,
        welcomeBasket: member.welcomeBasket || null,
        message: 'Weekly deliveries start after you lease a plot.',
      });
    }

    const sub = await db.collection('subscriptions').findOne({
      id: subscriptionId,
      memberId: member.id,
    });
    if (!sub) throw new ApiError(404, 'SUBSCRIPTION_NOT_FOUND', 'Subscription not found');

    const schedule = await syncDeliveryWindow(member.id, subscriptionId);

    const current = schedule.find((d) => !d.cancelled) || schedule[0];
    const basket = await currentBasketItems();

    res.json({
      hasPlot: true,
      subscriptionId,
      currentWeek: current
        ? {
            label: current.label,
            date: current.date,
            dateLabel: current.dateLabel,
            varietyCount: basket.length || 9,
            tracking: buildTracking(current.date),
            basket,
          }
        : null,
      schedule: schedule.map((d) => ({
        id: d.id,
        weekIndex: d.weekIndex,
        label: d.label,
        date: d.date,
        dateLabel: d.dateLabel,
        note: d.cancelled ? 'Cancelled' : d.note,
        locked: d.locked || d.cancelled,
        cancellable: d.cancellable && !d.cancelled,
        cancelled: Boolean(d.cancelled),
        lockReason: d.cancelled ? null : d.lockReason,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:deliveryId/cancel', requireMember, async (req, res, next) => {
  try {
    const db = getDB();
    const subscriptionId = req.body?.subscriptionId || req.memberDoc.activeSubscriptionId;
    if (subscriptionId) await syncDeliveryWindow(req.member.id, subscriptionId);
    const today = kolkataToday();
    const delivery = await db.collection('deliveries').findOne({
      id: req.params.deliveryId,
      memberId: req.member.id,
      ...(subscriptionId ? { subscriptionId } : {}),
    });
    if (!delivery) throw new ApiError(404, 'DELIVERY_NOT_FOUND', 'Delivery not found');
    if (delivery.cancelled) {
      throw new ApiError(409, 'ALREADY_CANCELLED', 'Delivery already cancelled');
    }
    if (!cancelStillOpen(delivery, today)) {
      throw new ApiError(
        400,
        'DELIVERY_LOCKED',
        'Cancel closes one week before delivery. This week is approved and locked.'
      );
    }

    const seq = await nextSeq('cancellation', 1);
    const request = {
      id: `CX-${String(seq).padStart(2, '0')}`,
      deliveryId: delivery.id,
      memberId: req.member.id,
      memberCode: req.member.memberCode,
      memberName: req.member.name,
      date: delivery.date,
      dateLabel: delivery.dateLabel,
      reason: req.body?.reason || '',
      locked: false,
      status: 'approved',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await db.collection('cancellation_requests').insertOne(request);

    await db.collection('deliveries').updateOne(
      { id: delivery.id },
      {
        $set: {
          cancelled: true,
          cancellable: false,
          locked: true,
          opsStatus: 'cancelled',
          cancelReason: req.body?.reason || null,
          cancelledAt: new Date(),
        },
      }
    );

    await realtime.emitSafe(
      Promise.all([
        realtime.notifyDeliveryChange({
          memberId: req.member.id,
          delivery: { id: delivery.id, cancelled: true, opsStatus: 'cancelled' },
        }),
        realtime.notifyCancellationChange({
          memberId: req.member.id,
          cancellation: request,
        }),
      ])
    );

    res.json({
      ok: true,
      delivery: {
        id: delivery.id,
        cancelled: true,
        cancellable: false,
        locked: true,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
