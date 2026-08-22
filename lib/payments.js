const { nanoid } = require('nanoid');
const { getDB } = require('../config/db');
const { formatInr, moneyFields } = require('./money');
const { ApiError } = require('./errors');
const { toMemberSummary, nextMemberId, refreshMemberPlotStats } = require('./members');
const { toPlan, toSubscription, toPlotSummary, monthLabel, DELIVERY_CHARGE_INR } = require('./serializers');
const { issueTokens } = require('../services/jwt.service');
const { displayPhone } = require('./phone');
const { defaultDueDate } = require('./dates');

const NET_BANKS = [
  { code: 'HDFC', name: 'HDFC Bank' },
  { code: 'SBI', name: 'State Bank of India' },
  { code: 'ICICI', name: 'ICICI Bank' },
  { code: 'AXIS', name: 'Axis Bank' },
  { code: 'KOTAK', name: 'Kotak Mahindra Bank' },
  { code: 'INDIAN', name: 'Indian Bank' },
  { code: 'CANARA', name: 'Canara Bank' },
];

function validateCard(card) {
  if (!card) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Please complete all card details.', [
      { field: 'card', message: 'Required' },
    ]);
  }
  const number = String(card.number || '').replace(/\s/g, '');
  const name = String(card.name || '').trim();
  const expiry = String(card.expiry || '').trim();
  const cvv = String(card.cvv || '').trim();
  const details = [];
  if (number.length < 15) details.push({ field: 'card.number', message: 'Invalid card number' });
  if (!name) details.push({ field: 'card.name', message: 'Name required' });
  if (expiry.length < 5) details.push({ field: 'card.expiry', message: 'Invalid expiry' });
  if (cvv.length < 3) details.push({ field: 'card.cvv', message: 'Invalid CVV' });
  if (details.length) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Please complete all card details.', details);
  }
  return { number, name, expiry, cvv, last4: number.slice(-4), brand: guessBrand(number) };
}

function guessBrand(number) {
  if (number.startsWith('4')) return 'Visa';
  if (number.startsWith('5')) return 'Mastercard';
  return 'HDFC';
}

function validatePaymentMethod(body) {
  const method = body?.method || 'payment_request';
  if (method === 'payment_request' || method === 'offline' || method === 'manual') {
    return { method: 'payment_request' };
  }
  // Legacy card / net_banking no longer accepted for checkout
  throw new ApiError(400, 'VALIDATION_ERROR', 'Payments are completed via an admin payment request', [
    { field: 'method', message: 'Use method payment_request' },
  ]);
}

function toPaymentAdmin(payment, extra = {}) {
  return {
    ...toPaymentIntent(payment),
    memberId: payment.memberId || null,
    memberName: extra.memberName || payment.memberName || null,
    memberEmail: extra.memberEmail || payment.memberEmail || null,
    memberPhone: extra.memberPhone || payment.memberPhone || null,
    metadata: payment.metadata || {},
    adminNote: payment.adminNote || null,
    approvedAt: payment.approvedAt
      ? payment.approvedAt instanceof Date
        ? payment.approvedAt.toISOString()
        : payment.approvedAt
      : null,
    approvedBy: payment.approvedBy || null,
    rejectedAt: payment.rejectedAt
      ? payment.rejectedAt instanceof Date
        ? payment.rejectedAt.toISOString()
        : payment.rejectedAt
      : null,
    requestNotice:
      payment.requestNotice ||
      'Our team will contact you by email to collect payment, then mark this request as paid.',
  };
}

async function nextReceiptRef(date = new Date()) {
  const db = getDB();
  const ymd = date.toISOString().slice(0, 10).replace(/-/g, '');
  const counter = await db.collection('counters').findOneAndUpdate(
    { _id: `receipt_${ymd}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  const seq = (counter && (counter.seq ?? counter.value?.seq)) || 1;
  return `CHEDI-R-${ymd}-${String(seq).padStart(3, '0')}`;
}

function paymentLabel(context, meta = {}) {
  if (context === 'membership') return 'Farm Club membership (one-time)';
  if (context === 'lease') {
    return `Annual subscription · ${meta.plotName || meta.plotKey || 'plot'} · ${meta.planName || meta.planKey || 'plan'}`;
  }
  if (context === 'renewal') return `Renewal · ${meta.plotName || meta.subscriptionId || 'subscription'}`;
  return 'Payment';
}

async function createPaymentRecord({
  memberId,
  context,
  amountInr,
  method = 'payment_request',
  label,
  metadata = {},
  status = 'pending',
  memberName = null,
  memberEmail = null,
  memberPhone = null,
}) {
  const db = getDB();
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const id = `pay_${nanoid(8)}`;
  const ref = await nextReceiptRef(now);
  const payment = {
    id,
    ref,
    memberId: memberId || null,
    context,
    status,
    ...moneyFields(amountInr),
    method: method || 'payment_request',
    label,
    date,
    dueDate: defaultDueDate(),
    receiptUrl: null,
    metadata,
    memberName,
    memberEmail,
    memberPhone,
    requestNotice:
      'Our team will contact you by email to collect payment, then mark this request as paid from the Admin Dashboard.',
    adminNote: null,
    approvedAt: null,
    approvedBy: null,
    rejectedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.collection('payments').insertOne(payment);
  return payment;
}

function toPaymentIntent(payment) {
  const meta = payment.metadata || {};
  return {
    id: payment.id,
    ref: payment.ref,
    context: payment.context,
    status: payment.status,
    amountInr: payment.amountInr,
    amountFormatted: payment.amountFormatted || formatInr(payment.amountInr),
    currency: payment.currency || 'INR',
    method: payment.method,
    label: payment.label,
    date: payment.date,
    receiptUrl: payment.receiptUrl || null,
    plotKey: meta.plotKey || undefined,
    planKey: meta.planKey || undefined,
    subscriptionId: meta.subscriptionId || undefined,
    createdAt:
      payment.createdAt instanceof Date
        ? payment.createdAt.toISOString()
        : payment.createdAt,
  };
}

async function ensureFixedNetBanking(memberId) {
  const db = getDB();
  const existing = await db.collection('payment_methods').findOne({
    memberId,
    isFixed: true,
  });
  if (existing) return existing;
  const method = {
    id: `pm_${nanoid(6)}`,
    memberId,
    kind: 'net_banking',
    label: 'HDFC Bank',
    brand: 'HDFC',
    last4: null,
    isPrimary: false,
    isFixed: true,
    removable: false,
    createdAt: new Date(),
  };
  await db.collection('payment_methods').insertOne(method);
  return method;
}

async function listPaymentMethods(memberId) {
  await ensureFixedNetBanking(memberId);
  const db = getDB();
  const items = await db
    .collection('payment_methods')
    .find({ memberId })
    .sort({ isFixed: 1, isPrimary: -1, createdAt: 1 })
    .toArray();
  return items.map(toPaymentMethod);
}

function toPaymentMethod(pm) {
  return {
    id: pm.id,
    kind: pm.kind,
    label: pm.label,
    brand: pm.brand || null,
    last4: pm.last4 || null,
    isPrimary: Boolean(pm.isPrimary),
    isFixed: Boolean(pm.isFixed),
    removable: pm.removable !== false && !pm.isFixed,
  };
}

async function createMembershipPaymentRequest(registration) {
  const db = getDB();
  if (registration.status === 'completed') {
    throw new ApiError(409, 'ALREADY_MEMBER', 'Membership already paid for this registration');
  }
  const existingPending = await db.collection('payments').findOne({
    context: 'membership',
    status: 'pending',
    'metadata.registrationId': registration.id,
  });
  if (existingPending) {
    return {
      payment: toPaymentIntent(existingPending),
      status: 'pending',
      notice: existingPending.requestNotice,
      memberEmail: registration.email,
    };
  }

  const fee = Number(process.env.MEMBERSHIP_FEE_INR || 500);
  const payment = await createPaymentRecord({
    memberId: null,
    context: 'membership',
    amountInr: fee,
    method: 'payment_request',
    label: paymentLabel('membership'),
    metadata: { registrationId: registration.id },
    status: 'pending',
    memberName: registration.name,
    memberEmail: registration.email,
    memberPhone: registration.phoneDisplay || registration.phone,
  });

  await db.collection('registrations').updateOne(
    { id: registration.id },
    {
      $set: {
        status: 'awaiting_payment_confirmation',
        paymentId: payment.id,
        updatedAt: new Date(),
      },
    }
  );

  console.log(
    `[payment-request] membership ${payment.ref} for ${registration.email} — awaiting admin approval`
  );

  return {
    payment: toPaymentIntent(payment),
    status: 'pending',
    notice: payment.requestNotice,
    memberEmail: registration.email,
  };
}

async function activateMembership({ registration, method = 'payment_request' }) {
  const db = getDB();
  const fee = Number(process.env.MEMBERSHIP_FEE_INR || 500);

  let member = await db.collection('members').findOne({
    phone: registration.phone,
    deletedAt: null,
  });

  if (member?.isMember) {
    throw new ApiError(409, 'ALREADY_MEMBER', 'This phone already has an active membership');
  }

  const now = new Date();
  const memberSince = now.toISOString().slice(0, 10);
  const welcomeEta = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
  const welcomeBasket = {
    status: 'dispatched',
    etaLabel: welcomeEta.toLocaleDateString('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    }),
    etaDate: welcomeEta.toISOString().slice(0, 10),
    imageUrl: 'https://chediwebsite.s3.us-east-1.amazonaws.com/images/2148224020.jpg',
    description: 'Seasonal vegetable sample box',
    tracking: buildWelcomeTracking(now, welcomeEta),
  };

  if (!member) {
    const id = await nextMemberId();
    member = {
      id,
      memberCode: `CHEDI-${id}`,
      name: registration.name,
      phone: registration.phone,
      phoneDisplay: displayPhone(registration.phone),
      email: registration.email,
      isMember: true,
      accountStatus: 'active',
      subStatus: 'none',
      memberSince,
      hasPlot: false,
      plotCount: 0,
      statusLabel: 'Member · no plot yet',
      preferences: {
        notifications: { delivery: true, harvest: true, promos: false },
        channel: 'email',
      },
      activeSubscriptionId: null,
      welcomeBasket,
      membershipFeePaidInr: fee,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    await db.collection('members').insertOne(member);

    if (registration.address) {
      await db.collection('addresses').insertOne({
        id: `addr_${nanoid(6)}`,
        memberId: id,
        label: registration.address.label || 'Home',
        line: registration.address.line,
        city: registration.address.city,
        pin: registration.address.pin,
        isDefault: true,
        createdAt: now,
      });
    }
  } else {
    await db.collection('members').updateOne(
      { id: member.id },
      {
        $set: {
          name: registration.name,
          email: registration.email,
          isMember: true,
          accountStatus: 'active',
          subStatus: member.subStatus || 'none',
          memberSince,
          welcomeBasket,
          membershipFeePaidInr: fee,
          statusLabel: 'Member · no plot yet',
          updatedAt: now,
        },
      }
    );
    member = await db.collection('members').findOne({ id: member.id });
  }

  await ensureFixedNetBanking(member.id);

  let payment = null;
  if (registration.paymentId) {
    payment = await db.collection('payments').findOne({ id: registration.paymentId });
  }
  if (!payment) {
    payment = await createPaymentRecord({
      memberId: member.id,
      context: 'membership',
      amountInr: fee,
      method,
      label: paymentLabel('membership'),
      metadata: { registrationId: registration.id },
      status: 'succeeded',
      memberName: member.name,
      memberEmail: member.email,
      memberPhone: member.phoneDisplay || member.phone,
    });
  } else {
    await db.collection('payments').updateOne(
      { id: payment.id },
      {
        $set: {
          memberId: member.id,
          status: 'succeeded',
          memberName: member.name,
          memberEmail: member.email,
          memberPhone: member.phoneDisplay || member.phone,
          updatedAt: now,
        },
      }
    );
    payment = await db.collection('payments').findOne({ id: payment.id });
  }

  await db.collection('registrations').updateOne(
    { id: registration.id },
    { $set: { status: 'completed', memberId: member.id, paymentId: payment.id, updatedAt: now } }
  );

  const summary = toMemberSummary(member);
  const tokens = await issueTokens(summary);

  return {
    payment: toPaymentIntent(payment),
    redirectUrl: null,
    member: summary,
    ...tokens,
    welcomeBasket: {
      status: welcomeBasket.status,
      etaLabel: welcomeBasket.etaLabel,
      etaDate: welcomeBasket.etaDate,
    },
  };
}

async function createLeasePaymentRequest({ memberId, plotKey, planKey, member }) {
  const db = getDB();
  const plot = await db.collection('plots').findOne({ key: plotKey });
  if (!plot) throw new ApiError(404, 'PLOT_NOT_FOUND', 'Plot not found');
  if (plot.status !== 'available') {
    throw new ApiError(400, 'PLOT_UNAVAILABLE', 'This plot is not available for lease');
  }

  const existing = await db.collection('subscriptions').findOne({
    memberId,
    plotKey,
    status: { $in: ['active', 'past_due'] },
  });
  if (existing) {
    throw new ApiError(400, 'PLOT_ALREADY_LEASED_BY_YOU', 'You already lease this plot');
  }

  const pendingLease = await db.collection('payments').findOne({
    memberId,
    context: 'lease',
    status: 'pending',
    'metadata.plotKey': plotKey,
  });
  if (pendingLease) {
    return {
      payment: toPaymentIntent(pendingLease),
      status: 'pending',
      notice: pendingLease.requestNotice,
      redirectUrl: null,
      pollAfterMs: 0,
      subscription: null,
    };
  }

  const planDoc = await db.collection('plans').findOne({ key: planKey });
  if (!planDoc) throw new ApiError(404, 'PLAN_NOT_FOUND', 'Plan not found');
  const plan = toPlan(planDoc);

  const payment = await createPaymentRecord({
    memberId,
    context: 'lease',
    amountInr: plan.totalInr,
    method: 'payment_request',
    label: paymentLabel('lease', { plotName: plot.name, planName: plan.name }),
    metadata: { plotKey, planKey },
    status: 'pending',
    memberName: member?.name || null,
    memberEmail: member?.email || null,
    memberPhone: member?.phoneDisplay || member?.phone || null,
  });

  console.log(`[payment-request] lease ${payment.ref} for ${member?.email || memberId} — awaiting admin approval`);

  return {
    payment: toPaymentIntent(payment),
    status: 'pending',
    notice: payment.requestNotice,
    redirectUrl: null,
    pollAfterMs: 0,
    subscription: null,
  };
}

async function createLeasePaymentAndSubscription(args) {
  // Back-compat name: now creates a pending payment request (no instant lease)
  return createLeasePaymentRequest(args);
}

async function createRenewalPaymentRequest({ memberId, subscription, plot, member }) {
  const db = getDB();
  if (subscription.billPaid) {
    throw new ApiError(409, 'BILL_ALREADY_PAID', 'Renewal bill already paid');
  }
  const pending = await db.collection('payments').findOne({
    memberId,
    context: 'renewal',
    status: 'pending',
    'metadata.subscriptionId': subscription.id,
  });
  if (pending) {
    return {
      ok: true,
      status: 'pending',
      subscriptionId: subscription.id,
      billPaid: false,
      payment: toPaymentIntent(pending),
      notice: pending.requestNotice,
    };
  }

  const amountInr = subscription.nextBillAmountInr || subscription.totalInr;
  const payment = await createPaymentRecord({
    memberId,
    context: 'renewal',
    amountInr,
    method: 'payment_request',
    label: paymentLabel('renewal', { plotName: plot?.name, subscriptionId: subscription.id }),
    metadata: { subscriptionId: subscription.id },
    status: 'pending',
    memberName: member?.name || null,
    memberEmail: member?.email || null,
    memberPhone: member?.phoneDisplay || member?.phone || null,
  });

  console.log(`[payment-request] renewal ${payment.ref} for ${member?.email || memberId} — awaiting admin approval`);

  return {
    ok: true,
    status: 'pending',
    subscriptionId: subscription.id,
    billPaid: false,
    payment: toPaymentIntent(payment),
    notice: payment.requestNotice,
  };
}

async function fulfillLeasePayment(payment) {
  const db = getDB();
  const { plotKey, planKey } = payment.metadata || {};
  if (!plotKey || !planKey) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Lease payment missing plot/plan metadata');
  }
  const plot = await db.collection('plots').findOne({ key: plotKey });
  if (!plot) throw new ApiError(404, 'PLOT_NOT_FOUND', 'Plot not found');
  const planDoc = await db.collection('plans').findOne({ key: planKey });
  if (!planDoc) throw new ApiError(404, 'PLAN_NOT_FOUND', 'Plan not found');
  const plan = toPlan(planDoc);

  const existing = await db.collection('subscriptions').findOne({
    memberId: payment.memberId,
    plotKey,
    status: { $in: ['active', 'past_due'] },
  });
  if (existing) return existing;

  return createSubscriptionFromPayment({
    memberId: payment.memberId,
    plot,
    plan,
    paymentId: payment.id,
  });
}

async function fulfillRenewalPayment(payment) {
  const db = getDB();
  const subscriptionId = payment.metadata?.subscriptionId;
  if (!subscriptionId) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Renewal payment missing subscriptionId');
  }
  await db.collection('subscriptions').updateOne(
    { id: subscriptionId },
    { $set: { billPaid: true, updatedAt: new Date() } }
  );
  const sub = await db.collection('subscriptions').findOne({ id: subscriptionId });
  if (sub?.memberId) {
    await db.collection('members').updateOne(
      { id: sub.memberId },
      { $set: { subStatus: 'active', updatedAt: new Date() } }
    );
  }
  return sub;
}

async function approvePayment(paymentId, { approvedBy = 'admin', adminNote = '' } = {}) {
  const db = getDB();
  const payment = await db.collection('payments').findOne({ id: paymentId });
  if (!payment) throw new ApiError(404, 'NOT_FOUND', 'Payment not found');
  if (payment.status === 'succeeded') {
    return { payment: toPaymentAdmin(payment), alreadyPaid: true };
  }
  if (payment.status === 'cancelled' || payment.status === 'failed') {
    throw new ApiError(409, 'PAYMENT_CLOSED', 'This payment request was cancelled and cannot be approved');
  }
  if (payment.status !== 'pending' && payment.status !== 'processing') {
    throw new ApiError(409, 'INVALID_STATUS', `Cannot approve payment in status ${payment.status}`);
  }

  const now = new Date();
  await db.collection('payments').updateOne(
    { id: paymentId },
    {
      $set: {
        status: 'succeeded',
        approvedAt: now,
        approvedBy,
        adminNote: adminNote || null,
        updatedAt: now,
      },
    }
  );

  let updated = await db.collection('payments').findOne({ id: paymentId });
  let sideEffect = null;

  if (updated.context === 'membership') {
    const registration = await db.collection('registrations').findOne({
      id: updated.metadata?.registrationId,
    });
    if (!registration) {
      throw new ApiError(404, 'REGISTRATION_NOT_FOUND', 'Registration not found for this payment');
    }
    registration.paymentId = updated.id;
    sideEffect = await activateMembership({
      registration,
      method: 'payment_request',
    });
    updated = await db.collection('payments').findOne({ id: paymentId });
  } else if (updated.context === 'lease') {
    const sub = await fulfillLeasePayment(updated);
    sideEffect = { subscriptionId: sub?.id };
    if (updated.memberId) {
      await db.collection('notifications').insertOne({
        id: `ntf_${nanoid(6)}`,
        memberId: updated.memberId,
        icon: 'check',
        title: 'Payment confirmed',
        description: `Your lease payment ${updated.ref} was marked paid. Your plot subscription is now active.`,
        createdAt: now,
        unread: true,
        deepLinkTab: 'my-plot',
        deepLinkPath: '/app/my-plot',
      });
    }
  } else if (updated.context === 'renewal') {
    const sub = await fulfillRenewalPayment(updated);
    sideEffect = { subscriptionId: sub?.id, billPaid: true };
    if (updated.memberId) {
      await db.collection('notifications').insertOne({
        id: `ntf_${nanoid(6)}`,
        memberId: updated.memberId,
        icon: 'check',
        title: 'Renewal payment confirmed',
        description: `Payment ${updated.ref} was marked paid. Your renewal bill is settled.`,
        createdAt: now,
        unread: true,
        deepLinkTab: 'subscription',
        deepLinkPath: '/app/subscription',
      });
    }
  }

  console.log(`[payment-request] APPROVED ${updated.ref} by ${approvedBy}`);
  return { payment: toPaymentAdmin(updated), sideEffect, alreadyPaid: false };
}

async function rejectPayment(paymentId, { rejectedBy = 'admin', adminNote = '' } = {}) {
  const db = getDB();
  const payment = await db.collection('payments').findOne({ id: paymentId });
  if (!payment) throw new ApiError(404, 'NOT_FOUND', 'Payment not found');
  if (payment.status === 'succeeded') {
    throw new ApiError(409, 'ALREADY_PAID', 'Paid requests cannot be rejected');
  }
  const now = new Date();
  await db.collection('payments').updateOne(
    { id: paymentId },
    {
      $set: {
        status: 'cancelled',
        rejectedAt: now,
        approvedBy: rejectedBy,
        adminNote: adminNote || 'Rejected by admin',
        updatedAt: now,
      },
    }
  );
  if (payment.context === 'membership' && payment.metadata?.registrationId) {
    await db.collection('registrations').updateOne(
      { id: payment.metadata.registrationId },
      { $set: { status: 'pending_payment', updatedAt: now } }
    );
  }
  if (payment.memberId) {
    await db.collection('notifications').insertOne({
      id: `ntf_${nanoid(6)}`,
      memberId: payment.memberId,
      icon: 'alert',
      title: 'Payment request cancelled',
      description: `Payment ${payment.ref} was not approved. Please submit a new request if needed.`,
      createdAt: now,
      unread: true,
      deepLinkTab: 'subscription',
      deepLinkPath: '/app/subscription',
    });
  }
  const updated = await db.collection('payments').findOne({ id: paymentId });
  return { payment: toPaymentAdmin(updated) };
}

async function listAdminPayments({ status } = {}) {
  const db = getDB();
  const filter = {};
  if (status && status !== 'all') filter.status = status;
  const items = await db
    .collection('payments')
    .find(filter)
    .sort({ createdAt: -1 })
    .limit(200)
    .toArray();
  return items.map((p) => toPaymentAdmin(p));
}

function buildWelcomeTracking(activatedAt, etaDate) {
  const d0 = new Date(activatedAt);
  const d1 = new Date(activatedAt.getTime() + 24 * 60 * 60 * 1000);
  const fmt = (d, extra) =>
    `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}${extra ? ` · ${extra}` : ''}`;
  return [
    {
      title: 'Order confirmed',
      timeLabel: fmt(d0, 'membership activated'),
      timestamp: d0.toISOString(),
      done: true,
      active: false,
    },
    {
      title: 'Packed at Periyakulam farm',
      timeLabel: `${fmt(d1)}, 9:00 AM`,
      timestamp: new Date(d1.setHours(9, 0, 0, 0)).toISOString(),
      done: true,
      active: false,
    },
    {
      title: 'Out for delivery',
      timeLabel: `Expected ${etaDate.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}, morning`,
      timestamp: etaDate.toISOString(),
      done: false,
      active: true,
    },
    {
      title: 'Delivered to your door',
      timeLabel: `Expected ${etaDate.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}, by 1 PM`,
      timestamp: etaDate.toISOString(),
      done: false,
      active: false,
    },
  ];
}

async function addCardMethod(memberId, card, setPrimary = false) {
  const db = getDB();
  const validated = typeof card.last4 === 'string' ? card : validateCard(card);
  const count = await db.collection('payment_methods').countDocuments({
    memberId,
    kind: 'card',
  });
  const isPrimary = setPrimary || count === 0;
  if (isPrimary) {
    await db.collection('payment_methods').updateMany(
      { memberId },
      { $set: { isPrimary: false } }
    );
  }
  const method = {
    id: `pm_${nanoid(6)}`,
    memberId,
    kind: 'card',
    label: `${validated.brand} •••• ${validated.last4}`,
    brand: validated.brand,
    last4: validated.last4,
    isPrimary,
    isFixed: false,
    removable: true,
    // Never store PAN/CVV — token placeholder only
    tokenRef: `tok_${nanoid(12)}`,
    createdAt: new Date(),
  };
  await db.collection('payment_methods').insertOne(method);
  return toPaymentMethod(method);
}

async function createSubscriptionFromPayment({ memberId, plot, plan, paymentId }) {
  const db = getDB();
  const now = new Date();
  const cycleStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const cycleEnd = new Date(Date.UTC(now.getUTCFullYear() + 1, now.getUTCMonth(), 1));
  const id = `sub_${nanoid(8)}`;

  const sub = {
    id,
    memberId,
    plotKey: plot.key,
    planKey: plan.key,
    status: 'active',
    totalInr: plan.totalInr,
    cycleStart: cycleStart.toISOString().slice(0, 10),
    cycleEnd: cycleEnd.toISOString().slice(0, 10),
    cycleStartLabel: monthLabel(cycleStart),
    cycleEndLabel: monthLabel(cycleEnd),
    billPaid: false,
    billingMode: 'manual',
    nextBillDue: cycleEnd.toISOString().slice(0, 10),
    nextBillAmountInr: plan.totalInr,
    paymentId,
    createdAt: now,
    updatedAt: now,
  };

  await db.collection('subscriptions').insertOne(sub);

  // Decrement available units and flip catalog status when exhausted
  if ((plot.availableUnits ?? plot.available ?? 0) > 0) {
    const nextUnits = (plot.availableUnits ?? plot.available ?? 0) - 1;
    const $set = { availableUnits: nextUnits, opsStatus: 'leased', updatedAt: now };
    if (nextUnits <= 0 && plot.status !== 'soon') $set.status = 'booked';
    await db.collection('plots').updateOne({ key: plot.key }, { $set });
  }

  const member = await refreshMemberPlotStats(memberId);
  await db.collection('members').updateOne(
    { id: memberId },
    {
      $set: {
        hasPlot: true,
        subStatus: 'active',
        accountStatus: 'active',
        plotKey: plot.key,
        planKey: plan.key,
        ...(member.activeSubscriptionId ? {} : { activeSubscriptionId: id }),
        updatedAt: now,
      },
    }
  );

  // Seed delivery schedule weeks
  await seedDeliverySchedule(memberId, id);

  // Notify
  await db.collection('notifications').insertOne({
    id: `ntf_${nanoid(6)}`,
    memberId,
    icon: 'leaf',
    title: 'Plot leased',
    description: `Your subscription for ${plot.name} is active.`,
    createdAt: now,
    unread: true,
    deepLinkTab: 'my-plot',
    deepLinkPath: '/app/my-plot',
  });

  return toSubscription(sub, plot, plan);
}

async function seedDeliverySchedule(memberId, subscriptionId) {
  const db = getDB();
  const existing = await db.collection('deliveries').countDocuments({ subscriptionId });
  if (existing > 0) return;

  const now = new Date();
  // Next Saturday
  const day = now.getUTCDay();
  const daysUntilSat = (6 - day + 7) % 7 || 7;
  const firstSat = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilSat));

  const weeks = [];
  for (let i = 0; i < 8; i++) {
    const date = new Date(firstSat.getTime() + i * 7 * 24 * 60 * 60 * 1000);
    const locked = i < 2;
    weeks.push({
      id: `del_${subscriptionId}_${i}`,
      memberId,
      subscriptionId,
      weekIndex: i,
      label: i === 0 ? 'THIS WEEK' : i === 1 ? 'NEXT' : `WEEK ${i + 1}`,
      date: date.toISOString().slice(0, 10),
      dateLabel: date.toLocaleDateString('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        timeZone: 'UTC',
      }),
      note: i === 0 ? '9 varieties' : 'Planned',
      locked,
      cancellable: !locked,
      cancelled: false,
      lockReason: locked ? 'Produce is already being harvested' : null,
      opsStatus: i === 0 ? 'packed' : 'scheduled',
      createdAt: now,
    });
  }
  await db.collection('deliveries').insertMany(weeks);
}

module.exports = {
  NET_BANKS,
  validateCard,
  validatePaymentMethod,
  createPaymentRecord,
  toPaymentIntent,
  toPaymentAdmin,
  paymentLabel,
  activateMembership,
  createMembershipPaymentRequest,
  createLeasePaymentRequest,
  createLeasePaymentAndSubscription,
  createRenewalPaymentRequest,
  createSubscriptionFromPayment,
  approvePayment,
  rejectPayment,
  listAdminPayments,
  listPaymentMethods,
  toPaymentMethod,
  addCardMethod,
  ensureFixedNetBanking,
  seedDeliverySchedule,
  buildWelcomeTracking,
  DELIVERY_CHARGE_INR,
};
