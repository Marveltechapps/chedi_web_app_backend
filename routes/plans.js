const express = require('express');
const { getDB } = require('../config/db');
const { ApiError } = require('../lib/errors');
const { optionalMember, requireMember } = require('../middleware/auth');
const { toPlan, DELIVERY_CHARGE_INR } = require('../lib/serializers');
const { formatInr } = require('../lib/money');

const router = express.Router();

router.get('/', optionalMember, async (req, res, next) => {
  try {
    const db = getDB();
    const plans = await db.collection('plans').find({}).toArray();
    const deliveryChargeInr = DELIVERY_CHARGE_INR();
    res.json({
      items: plans.map(toPlan),
      deliveryChargeInr,
      deliveryChargeFormatted: formatInr(deliveryChargeInr),
      deliveryChargeNote: 'Flat annual delivery charge across Tamil Nadu',
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:planKey', optionalMember, async (req, res, next) => {
  try {
    const db = getDB();
    const plan = await db.collection('plans').findOne({ key: req.params.planKey });
    if (!plan) throw new ApiError(404, 'PLAN_NOT_FOUND', 'Plan not found');
    res.json(toPlan(plan));
  } catch (err) {
    next(err);
  }
});

router.get('/:planKey/produce-shares', requireMember, async (req, res, next) => {
  try {
    const db = getDB();
    const plan = await db.collection('plans').findOne({ key: req.params.planKey });
    if (!plan) throw new ApiError(404, 'PLAN_NOT_FOUND', 'Plan not found');

    const shares = await db.collection('produce_shares').findOne({ planKey: req.params.planKey });
    const defaultShares = await db.collection('produce_shares').findOne({ planKey: 'default' });
    const data = shares || defaultShares || { staples: [], seasonal: [] };

    res.json({
      staples: data.staples || [],
      seasonal: data.seasonal || [],
      staplesNote:
        data.staplesNote ||
        'Weekly delivery of up to 3kg of everyday kitchen essentials.',
      seasonalNote:
        data.seasonalNote ||
        'Weekly delivery of 7 seasonal vegetable varieties, totaling up to 7kg.',
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
