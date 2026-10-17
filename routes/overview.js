const express = require('express');
const { getDB } = require('../config/db');
const { requireMember } = require('../middleware/auth');
const { toMemberSummary } = require('../lib/members');
const { toSubscription, toPlan } = require('../lib/serializers');
const { growingNowForPlot } = require('../lib/growingNow');
const { syncDeliveryWindow } = require('../lib/deliveryWindow');

const router = express.Router();

const LEASE_TEASER = [
  { step: 1, title: 'Pick a plot' },
  { step: 2, title: 'Choose a plan' },
  { step: 3, title: 'We farm it' },
];

router.get('/', requireMember, async (req, res, next) => {
  try {
    const db = getDB();
    const member = req.memberDoc;
    let activeSubscription = null;
    let nextDelivery = null;

    if (member.activeSubscriptionId || member.hasPlot) {
      const sub =
        (member.activeSubscriptionId &&
          (await db.collection('subscriptions').findOne({
            id: member.activeSubscriptionId,
            memberId: member.id,
          }))) ||
        (await db.collection('subscriptions').findOne(
          { memberId: member.id, status: { $in: ['active', 'past_due'] } },
          { sort: { createdAt: -1 } }
        ));

      if (sub) {
        const plot = await db.collection('plots').findOne({ key: sub.plotKey });
        const planDoc = await db.collection('plans').findOne({ key: sub.planKey });
        activeSubscription = toSubscription(sub, plot, planDoc ? toPlan(planDoc) : null);

        const window = await syncDeliveryWindow(member.id, sub.id);
        const delivery = window.find((d) => !d.cancelled) || null;
        if (delivery) {
          nextDelivery = {
            dateLabel: delivery.dateLabel,
            varietyCount: 9,
          };
        }
      }
    }

    const hasPlot = Boolean(activeSubscription);

    res.json({
      member: toMemberSummary(member),
      welcomeBasket: member.welcomeBasket
        ? {
            status: member.welcomeBasket.status,
            etaLabel: member.welcomeBasket.etaLabel,
            etaDate: member.welcomeBasket.etaDate,
            imageUrl: member.welcomeBasket.imageUrl,
            description: member.welcomeBasket.description,
          }
        : null,
      hasPlot,
      activeSubscription: hasPlot ? activeSubscription : null,
      nextDelivery: hasPlot ? nextDelivery : null,
      growingNow: hasPlot ? await growingNowForPlot(activeSubscription.plotKey) : [],
      leaseTeaser: hasPlot ? undefined : LEASE_TEASER,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
