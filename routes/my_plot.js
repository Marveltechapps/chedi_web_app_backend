const express = require('express');
const { getDB } = require('../config/db');
const { requireMember } = require('../middleware/auth');
const { toPlotDetail, toPlan, toSubscription } = require('../lib/serializers');
const { growingNowForPlot } = require('../lib/growingNow');

const router = express.Router();

router.get('/', requireMember, async (req, res, next) => {
  try {
    const db = getDB();
    const member = req.memberDoc;
    const subs = await db
      .collection('subscriptions')
      .find({ memberId: member.id, status: { $in: ['active', 'past_due'] } })
      .sort({ createdAt: -1 })
      .toArray();

    if (!subs.length) {
      return res.json({
        hasPlot: false,
        message: "You haven't leased a plot yet.",
      });
    }

    let subscriptionId =
      req.query.subscriptionId || member.activeSubscriptionId || subs[0].id;
    let sub = subs.find((s) => s.id === subscriptionId) || subs[0];
    subscriptionId = sub.id;

    const plot = await db.collection('plots').findOne({ key: sub.plotKey });
    const planDoc = await db.collection('plans').findOne({ key: sub.planKey });
    const plan = planDoc ? toPlan(planDoc) : null;
    const subscription = toSubscription(sub, plot, plan);
    const plotDetail = plot ? toPlotDetail(plot, { leasedByMe: true }) : null;

    const farmer = { name: 'Murugan V.', role: 'Assigned farmer' };
    const facts = [
      { k: 'Plot ID', v: plot?.name || sub.plotKey },
      { k: 'Size', v: plan?.sizeLabel || plot?.size || '' },
      { k: 'Farm', v: plot?.region || '' },
      { k: 'Your farmer', v: farmer.name },
      { k: 'Plan', v: plan?.name || sub.planKey },
      {
        k: 'Subscription cycle',
        v: `${subscription.cycleStartLabel} – ${subscription.cycleEndLabel}`,
      },
    ];

    res.json({
      hasPlot: true,
      subscriptions: await Promise.all(
        subs.map(async (s) => {
          const p = await db.collection('plots').findOne({ key: s.plotKey });
          return { id: s.id, plotKey: s.plotKey, plotName: p?.name || s.plotKey };
        })
      ),
      activeSubscriptionId: subscriptionId,
      plot: plotDetail,
      plan,
      subscription,
      farmer,
      facts,
      growingNow: await growingNowForPlot(sub.plotKey),
      heroImageUrl:
        plot?.imageUrl ||
        'https://chediwebsite.s3.us-east-1.amazonaws.com/images/land-morning.jpg',
      gallery: plotDetail?.gallery || [],
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
