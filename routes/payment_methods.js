const express = require('express');
const { getDB } = require('../config/db');
const { ApiError } = require('../lib/errors');
const { requireMember } = require('../middleware/auth');
const {
  listPaymentMethods,
  addCardMethod,
  validateCard,
} = require('../lib/payments');

const router = express.Router();

router.get('/', requireMember, async (req, res, next) => {
  try {
    const items = await listPaymentMethods(req.member.id);
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireMember, async (req, res, next) => {
  try {
    const body = req.body || {};
    if (body.kind !== 'card') {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Only card methods can be added', [
        { field: 'kind', message: 'Must be card' },
      ]);
    }
    const card = validateCard(body);
    const paymentMethod = await addCardMethod(
      req.member.id,
      card,
      Boolean(body.setPrimary)
    );
    res.status(201).json({ ok: true, paymentMethod });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/primary', requireMember, async (req, res, next) => {
  try {
    const db = getDB();
    const method = await db.collection('payment_methods').findOne({
      id: req.params.id,
      memberId: req.member.id,
    });
    if (!method) throw new ApiError(404, 'NOT_FOUND', 'Payment method not found');

    await db.collection('payment_methods').updateMany(
      { memberId: req.member.id },
      { $set: { isPrimary: false } }
    );
    await db.collection('payment_methods').updateOne(
      { id: method.id },
      { $set: { isPrimary: true } }
    );
    const items = await listPaymentMethods(req.member.id);
    res.json({ ok: true, items });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireMember, async (req, res, next) => {
  try {
    const db = getDB();
    const method = await db.collection('payment_methods').findOne({
      id: req.params.id,
      memberId: req.member.id,
    });
    if (!method) throw new ApiError(404, 'NOT_FOUND', 'Payment method not found');
    if (method.isFixed || method.removable === false) {
      throw new ApiError(400, 'METHOD_NOT_REMOVABLE', 'This payment method cannot be removed');
    }

    const wasPrimary = method.isPrimary;
    await db.collection('payment_methods').deleteOne({ id: method.id });

    if (wasPrimary) {
      const nextMethod = await db.collection('payment_methods').findOne({
        memberId: req.member.id,
      });
      if (nextMethod) {
        await db.collection('payment_methods').updateOne(
          { id: nextMethod.id },
          { $set: { isPrimary: true } }
        );
      }
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
