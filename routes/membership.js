const express = require('express');
const { nanoid } = require('nanoid');
const { getDB } = require('../config/db');
const { ApiError } = require('../lib/errors');
const { normalizePhone, isValidIndianMobile, displayPhone } = require('../lib/phone');
const { formatInr } = require('../lib/money');
const { requireMember } = require('../middleware/auth');
const { withIdempotency } = require('../lib/idempotency');
const { validatePaymentMethod, createMembershipPaymentRequest } = require('../lib/payments');
const { toMemberSummary } = require('../lib/members');
const realtime = require('../lib/realtime');

const router = express.Router();

router.post('/register', async (req, res, next) => {
  try {
    const { name, phone, email, address } = req.body || {};
    const details = [];
    if (!name || !String(name).trim()) details.push({ field: 'name', message: 'Required' });
    const normalized = normalizePhone(phone);
    if (!normalized || !isValidIndianMobile(normalized)) {
      details.push({ field: 'phone', message: 'Invalid Indian mobile number' });
    }
    if (!email || !String(email).trim()) details.push({ field: 'email', message: 'Required' });
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email).trim())) {
      details.push({ field: 'email', message: 'Invalid email address' });
    }
    if (!address?.line || !String(address.line).trim()) {
      details.push({ field: 'address.line', message: 'Required' });
    }
    if (!address?.city || !String(address.city).trim()) {
      details.push({ field: 'address.city', message: 'Required' });
    }
    if (!address?.pin || !/^\d{6}$/.test(String(address.pin).trim())) {
      details.push({ field: 'address.pin', message: 'PIN must be 6 digits' });
    }
    if (details.length) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Please complete all required fields', details);
    }

    const db = getDB();
    const existingPhone = await db.collection('members').findOne({
      phone: normalized,
      isMember: true,
      deletedAt: null,
    });
    if (existingPhone) {
      throw new ApiError(409, 'PHONE_ALREADY_REGISTERED', 'This phone is already registered');
    }
    const existingEmail = await db.collection('members').findOne({
      email: String(email).trim().toLowerCase(),
      isMember: true,
      deletedAt: null,
    });
    if (existingEmail) {
      throw new ApiError(409, 'EMAIL_ALREADY_REGISTERED', 'This email is already registered');
    }

    const fee = Number(process.env.MEMBERSHIP_FEE_INR || 500);
    const registration = {
      id: `reg_${nanoid(8)}`,
      name: String(name).trim(),
      phone: normalized,
      phoneDisplay: displayPhone(normalized),
      email: String(email).trim().toLowerCase(),
      address: {
        line: String(address.line).trim(),
        city: String(address.city).trim(),
        pin: String(address.pin).trim(),
        label: address.label || 'Home',
      },
      status: 'pending_payment',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await db.collection('registrations').insertOne(registration);

    await realtime.emitSafe(
      realtime.notifyMemberChange(realtime.EVENTS.CUSTOMER_CREATED, null, {
        member: {
          id: registration.id,
          name: registration.name,
          email: registration.email,
          phone: registration.phoneDisplay,
          accountStatus: 'pending',
          subStatus: 'none',
          city: registration.address.city,
          addressDisplay: `${registration.address.line}, ${registration.address.city} ${registration.address.pin}`,
        },
        registration: {
          id: registration.id,
          name: registration.name,
          email: registration.email,
          status: registration.status,
        },
      })
    );

    res.status(201).json({
      registrationId: registration.id,
      membershipFeeInr: fee,
      membershipFeeFormatted: formatInr(fee),
      includesWelcomeBasket: true,
      welcomeBasketNote: 'Complimentary welcome basket · 5 kg fresh vegetables',
    });
  } catch (err) {
    next(err);
  }
});

router.post('/payments', async (req, res, next) => {
  try {
    const result = await withIdempotency(req, 'membership_payment', async () => {
      const registrationId = req.body?.registrationId;
      if (!registrationId) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'registrationId is required', [
          { field: 'registrationId', message: 'Required' },
        ]);
      }
      const db = getDB();
      const registration = await db.collection('registrations').findOne({ id: registrationId });
      if (!registration) {
        throw new ApiError(404, 'REGISTRATION_NOT_FOUND', 'Registration not found');
      }
      if (registration.status === 'completed') {
        throw new ApiError(409, 'ALREADY_MEMBER', 'Membership already paid for this registration');
      }

      validatePaymentMethod(req.body || {});
      if (registration.status === 'completed') {
        throw new ApiError(409, 'ALREADY_MEMBER', 'Membership already paid for this registration');
      }
      const body = await createMembershipPaymentRequest(registration);
      return { status: 200, body };
    });

    if (result.body?.payment) {
      await realtime.emitSafe(
        realtime.notifyPaymentChange(realtime.EVENTS.PAYMENT_CREATED, {
          payment: result.body.payment,
          memberId: result.body.payment.memberId || null,
        })
      );
    }

    res.status(result.status).json(result.body);
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireMember, async (req, res, next) => {
  try {
    const member = req.memberDoc;
    const fee = member.membershipFeePaidInr || Number(process.env.MEMBERSHIP_FEE_INR || 500);
    res.json({
      member: toMemberSummary(member),
      membershipFeePaidInr: fee,
      membershipFeePaidFormatted: formatInr(fee),
      welcomeBasket: member.welcomeBasket || null,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
