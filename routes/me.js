const express = require('express');
const { nanoid } = require('nanoid');
const { getDB } = require('../config/db');
const { ApiError } = require('../lib/errors');
const { requireMember } = require('../middleware/auth');
const {
  toMemberSummary,
  toProfile,
  softDeleteMember,
  findMemberByPhone,
} = require('../lib/members');
const { normalizePhone, isValidIndianMobile, displayPhone } = require('../lib/phone');
const otpService = require('../services/otp.service');
const jwtService = require('../services/jwt.service');

const router = express.Router();

router.get('/', requireMember, async (req, res, next) => {
  try {
    const member = req.memberDoc;
    const db = getDB();
    const subscriptionCount = await db.collection('subscriptions').countDocuments({
      memberId: member.id,
      status: { $in: ['active', 'past_due'] },
    });
    res.json({
      member: toMemberSummary(member),
      profile: toProfile(member),
      preferences: member.preferences || {
        notifications: { delivery: true, harvest: true, promos: false },
        channel: 'push',
      },
      activeSubscriptionId: member.activeSubscriptionId || null,
      subscriptionCount,
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/profile', requireMember, async (req, res, next) => {
  try {
    const name = req.body?.name != null ? String(req.body.name).trim() : undefined;
    const email = req.body?.email != null ? String(req.body.email).trim().toLowerCase() : undefined;
    const details = [];
    if (name !== undefined && !name) details.push({ field: 'name', message: 'Cannot be empty' });
    if (email !== undefined && !email) details.push({ field: 'email', message: 'Cannot be empty' });
    if (email !== undefined && email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      details.push({ field: 'email', message: 'Invalid email address' });
    }
    if (details.length) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid profile fields', details);
    }

    const db = getDB();
    if (email) {
      const clash = await db.collection('members').findOne({
        email,
        id: { $ne: req.member.id },
        deletedAt: null,
      });
      if (clash) {
        throw new ApiError(409, 'EMAIL_ALREADY_REGISTERED', 'This email is already registered');
      }
    }

    const $set = { updatedAt: new Date() };
    if (name !== undefined) $set.name = name;
    if (email !== undefined) $set.email = email;
    await db.collection('members').updateOne({ id: req.member.id }, { $set });
    const updated = await db.collection('members').findOne({ id: req.member.id });
    res.json({ ok: true, profile: toProfile(updated) });
  } catch (err) {
    next(err);
  }
});

router.post('/phone/otp', requireMember, async (req, res, next) => {
  try {
    const newPhone = normalizePhone(req.body?.newPhone);
    if (!newPhone || !isValidIndianMobile(newPhone)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid Indian mobile number', [
        { field: 'newPhone', message: 'Invalid Indian mobile number' },
      ]);
    }
    const existing = await findMemberByPhone(newPhone);
    if (existing && existing.id !== req.member.id) {
      throw new ApiError(409, 'PHONE_ALREADY_REGISTERED', 'This phone is already registered');
    }
    const memberEmail =
      req.memberDoc?.email || req.member?.email || null;
    const timing = await otpService.sendOtp({
      purpose: 'phone_change',
      phone: newPhone,
      channel: 'sms',
      meta: {
        memberId: req.member.id,
        deliveryEmail: memberEmail,
      },
    });
    const payload = {
      success: true,
      message: 'OTP sent successfully',
      ok: true,
      notice: memberEmail
        ? `Code sent to ${memberEmail} to confirm this number change.`
        : `Code sent to ${displayPhone(newPhone)}.`,
      resendAvailableInSeconds: timing.resendAvailableInSeconds,
      deliveryEmail: memberEmail || undefined,
    };
    if (otpService.allowDemoOtp()) {
      payload.demoOtp = otpService.demoOtp();
      payload.notice = `${payload.notice} (demo code ${payload.demoOtp})`;
    }
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

router.post('/phone/verify', requireMember, async (req, res, next) => {
  try {
    const newPhone = normalizePhone(req.body?.newPhone);
    const code = String(req.body?.code || '').trim();
    if (!newPhone || !isValidIndianMobile(newPhone)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid Indian mobile number', [
        { field: 'newPhone', message: 'Invalid Indian mobile number' },
      ]);
    }
    const len = otpService.otpLength();
    if (!new RegExp(`^\\d{${len}}$`).test(code)) {
      throw new ApiError(400, 'VALIDATION_ERROR', `OTP must be ${len} digits`, [
        { field: 'code', message: `OTP must be ${len} digits` },
      ]);
    }
    await otpService.verifyOtp({ purpose: 'phone_change', phone: newPhone, code });

    const db = getDB();
    await db.collection('members').updateOne(
      { id: req.member.id },
      {
        $set: {
          phone: newPhone,
          phoneDisplay: displayPhone(newPhone),
          updatedAt: new Date(),
        },
      }
    );
    const updated = await db.collection('members').findOne({ id: req.member.id });
    res.json({ ok: true, profile: toProfile(updated) });
  } catch (err) {
    next(err);
  }
});

router.put('/preferences/notifications', requireMember, async (req, res, next) => {
  try {
    const { delivery, harvest, promos, channel } = req.body || {};
    const preferences = {
      notifications: {
        delivery: Boolean(delivery),
        harvest: Boolean(harvest),
        promos: Boolean(promos),
      },
      channel: ['push', 'sms', 'email'].includes(channel) ? channel : 'push',
    };
    const db = getDB();
    await db.collection('members').updateOne(
      { id: req.member.id },
      { $set: { preferences, updatedAt: new Date() } }
    );
    res.json({ ok: true, preferences });
  } catch (err) {
    next(err);
  }
});

router.put('/active-subscription', requireMember, async (req, res, next) => {
  try {
    const subscriptionId = req.body?.subscriptionId;
    if (!subscriptionId) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'subscriptionId is required', [
        { field: 'subscriptionId', message: 'Required' },
      ]);
    }
    const db = getDB();
    const sub = await db.collection('subscriptions').findOne({
      id: subscriptionId,
      memberId: req.member.id,
    });
    if (!sub) throw new ApiError(404, 'SUBSCRIPTION_NOT_FOUND', 'Subscription not found');
    await db.collection('members').updateOne(
      { id: req.member.id },
      { $set: { activeSubscriptionId: subscriptionId, updatedAt: new Date() } }
    );
    res.json({ ok: true, activeSubscriptionId: subscriptionId });
  } catch (err) {
    next(err);
  }
});

router.delete('/', requireMember, async (req, res, next) => {
  try {
    if (req.body?.confirmation !== 'DELETE') {
      throw new ApiError(400, 'VALIDATION_ERROR', 'confirmation must be DELETE', [
        { field: 'confirmation', message: 'Must be DELETE' },
      ]);
    }
    await jwtService.revokeAllSessions(req.member.id);
    await softDeleteMember(req.member.id);
    const db = getDB();
    await db.collection('deliveries').updateMany(
      { memberId: req.member.id, cancelled: false, date: { $gte: new Date().toISOString().slice(0, 10) } },
      { $set: { cancelled: true, cancellable: false, locked: true } }
    );
    res.json({ ok: true, message: 'Your account has been deleted.' });
  } catch (err) {
    next(err);
  }
});

router.post('/data-export', requireMember, async (req, res, next) => {
  try {
    const db = getDB();
    const exportId = `exp_${nanoid(8)}`;
    const doc = {
      id: exportId,
      memberId: req.member.id,
      status: 'pending',
      downloadUrl: null,
      createdAt: new Date(),
    };
    await db.collection('data_exports').insertOne(doc);

    // Demo: mark ready immediately with inline payload URL placeholder
    setImmediate(async () => {
      try {
        await db.collection('data_exports').updateOne(
          { id: exportId },
          {
            $set: {
              status: 'ready',
              downloadUrl: `/api/v1/me/data-export/${exportId}/download`,
              readyAt: new Date(),
            },
          }
        );
      } catch {
        /* ignore */
      }
    });

    res.status(202).json({
      ok: true,
      exportId,
      status: 'pending',
      downloadUrl: null,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/data-export/:exportId', requireMember, async (req, res, next) => {
  try {
    const db = getDB();
    const doc = await db.collection('data_exports').findOne({
      id: req.params.exportId,
      memberId: req.member.id,
    });
    if (!doc) throw new ApiError(404, 'NOT_FOUND', 'Export not found');
    res.json({
      ok: true,
      exportId: doc.id,
      status: doc.status,
      downloadUrl: doc.downloadUrl || null,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
