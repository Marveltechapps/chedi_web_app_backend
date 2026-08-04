const express = require('express');
const { nanoid } = require('nanoid');
const { getDB } = require('../config/db');
const { ApiError } = require('../lib/errors');
const { requireMember } = require('../middleware/auth');

const router = express.Router();

function toAddress(a) {
  return {
    id: a.id,
    label: a.label,
    line: a.line,
    city: a.city,
    pin: a.pin,
    isDefault: Boolean(a.isDefault),
  };
}

router.get('/', requireMember, async (req, res, next) => {
  try {
    const db = getDB();
    const items = await db
      .collection('addresses')
      .find({ memberId: req.member.id })
      .sort({ isDefault: -1, createdAt: 1 })
      .toArray();
    res.json({ items: items.map(toAddress) });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireMember, async (req, res, next) => {
  try {
    const { label, line, city, pin, setDefault } = req.body || {};
    const details = [];
    if (!line) details.push({ field: 'line', message: 'Required' });
    if (!city) details.push({ field: 'city', message: 'Required' });
    if (!pin || !/^\d{6}$/.test(String(pin).trim())) {
      details.push({ field: 'pin', message: 'PIN must be 6 digits' });
    }
    if (details.length) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid address', details);
    }

    const db = getDB();
    const count = await db.collection('addresses').countDocuments({ memberId: req.member.id });
    const isDefault = count === 0 || Boolean(setDefault);
    if (isDefault) {
      await db.collection('addresses').updateMany(
        { memberId: req.member.id },
        { $set: { isDefault: false } }
      );
    }

    const address = {
      id: `addr_${nanoid(6)}`,
      memberId: req.member.id,
      label: label || 'Home',
      line: String(line).trim(),
      city: String(city).trim(),
      pin: String(pin).trim(),
      isDefault,
      createdAt: new Date(),
    };
    await db.collection('addresses').insertOne(address);
    res.status(201).json({ ok: true, address: toAddress(address) });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', requireMember, async (req, res, next) => {
  try {
    const db = getDB();
    const existing = await db.collection('addresses').findOne({
      id: req.params.id,
      memberId: req.member.id,
    });
    if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Address not found');

    const $set = { updatedAt: new Date() };
    for (const field of ['label', 'line', 'city', 'pin']) {
      if (req.body?.[field] != null) $set[field] = String(req.body[field]).trim();
    }
    await db.collection('addresses').updateOne({ id: existing.id }, { $set });
    const address = await db.collection('addresses').findOne({ id: existing.id });
    res.json({ ok: true, address: toAddress(address) });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/default', requireMember, async (req, res, next) => {
  try {
    const db = getDB();
    const existing = await db.collection('addresses').findOne({
      id: req.params.id,
      memberId: req.member.id,
    });
    if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Address not found');

    await db.collection('addresses').updateMany(
      { memberId: req.member.id },
      { $set: { isDefault: false } }
    );
    await db.collection('addresses').updateOne(
      { id: existing.id },
      { $set: { isDefault: true } }
    );
    const items = await db
      .collection('addresses')
      .find({ memberId: req.member.id })
      .sort({ isDefault: -1, createdAt: 1 })
      .toArray();
    res.json({ ok: true, items: items.map(toAddress) });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireMember, async (req, res, next) => {
  try {
    const db = getDB();
    const existing = await db.collection('addresses').findOne({
      id: req.params.id,
      memberId: req.member.id,
    });
    if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Address not found');

    await db.collection('addresses').deleteOne({ id: existing.id });
    if (existing.isDefault) {
      const nextAddr = await db.collection('addresses').findOne({ memberId: req.member.id });
      if (nextAddr) {
        await db.collection('addresses').updateOne(
          { id: nextAddr.id },
          { $set: { isDefault: true } }
        );
      }
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
