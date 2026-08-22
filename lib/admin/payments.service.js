const { getDB } = require('../../config/db');
const { ApiError } = require('../errors');
const { parsePagination, paginationMeta, slicePage } = require('../pagination');
const { writeAudit } = require('../audit');
const { formatInr } = require('../money');
const { isoDate, defaultDueDate } = require('../dates');
const {
  approvePayment,
  rejectPayment,
  createPaymentRecord,
  paymentLabel,
} = require('../payments');
const { insertMemberNotification } = require('./notify');
const { toPaymentDto, toReceiptDto, paymentOpsStatus, memberPublicId } = require('./dto');
const {
  requireMemberByAnyId,
  findMemberByAnyId,
  requirePaymentByAnyId,
  findRegistration,
  loadPlot,
  loadPlan,
} = require('./lookups');
const { PAYMENT_METHODS, PAYMENT_CONTEXTS, COLLECTIBLE_STATUSES } = require('./constants');

function extraFor(payment, member) {
  return {
    memberId: payment.memberId || member?.id,
    memberCode: member ? memberPublicId(member) : payment.memberCode,
    memberName: member?.name || payment.memberName,
    memberEmail: member?.email || payment.memberEmail,
    memberPhone: member?.phoneDisplay || payment.memberPhone,
  };
}

async function enrichPayment(payment) {
  let member = null;
  if (payment.memberId) member = await findMemberByAnyId(payment.memberId);
  return toPaymentDto(payment, extraFor(payment, member));
}

function chipOf(payment) {
  return paymentOpsStatus(payment);
}

function matchesStatusFilter(ops, filter) {
  if (!filter || filter === 'all') return true;
  if (filter === 'pending') return ops === 'pending' || ops === 'overdue';
  if (filter === 'paid') return ops === 'paid';
  return ops === filter;
}

async function listPayments(query = {}) {
  const db = getDB();
  const { page, limit } = parsePagination(query);
  const q = String(query.q || '').trim().toLowerCase();
  const status = String(query.status || 'all');
  const context = query.context && query.context !== 'all' ? String(query.context) : null;
  const memberId = query.memberId ? String(query.memberId) : null;

  const filter = {};
  if (context) filter.context = context;
  if (memberId) {
    const member = await findMemberByAnyId(memberId);
    filter.memberId = member ? member.id : memberId;
  }

  const rows = await db.collection('payments').find(filter).sort({ createdAt: -1 }).toArray();
  const dtos = [];
  for (const p of rows) dtos.push(await enrichPayment(p));

  const counts = {
    all: dtos.length,
    pending: dtos.filter((p) => p.opsStatus === 'pending' || p.opsStatus === 'overdue').length,
    overdue: dtos.filter((p) => p.opsStatus === 'overdue').length,
    paid: dtos.filter((p) => p.opsStatus === 'paid').length,
    failed: dtos.filter((p) => p.opsStatus === 'failed').length,
    refunded: dtos.filter((p) => p.opsStatus === 'refunded').length,
  };

  let filtered = dtos.filter((p) => matchesStatusFilter(p.opsStatus, status));
  if (q) {
    filtered = filtered.filter((p) =>
      [p.ref, p.memberName, p.memberEmail, p.label].filter(Boolean).join(' ').toLowerCase().includes(q)
    );
  }
  return {
    data: slicePage(filtered, page, limit),
    pagination: paginationMeta(page, limit, filtered.length),
    meta: { counts },
  };
}

async function getPayment(paymentId) {
  const payment = await requirePaymentByAnyId(paymentId);
  return enrichPayment(payment);
}

async function getReceipt(paymentId) {
  const payment = await requirePaymentByAnyId(paymentId);
  if (payment.status !== 'succeeded' && payment.status !== 'refunded') {
    throw new ApiError(409, 'INVALID_STATUS', 'Receipt is only available after collection');
  }
  const member = payment.memberId ? await findMemberByAnyId(payment.memberId) : null;
  return toReceiptDto(payment, extraFor(payment, member));
}

async function createAdminPayment(body, staff) {
  const memberId = body?.memberId;
  const context = body?.context;
  const amountInr = Number(body?.amountInr);
  const details = [];
  if (!memberId) details.push({ field: 'memberId', message: 'Required' });
  if (!PAYMENT_CONTEXTS.includes(context)) {
    details.push({ field: 'context', message: 'Must be membership, lease, renewal, or delivery' });
  }
  if (!Number.isInteger(amountInr) || amountInr <= 0) {
    details.push({ field: 'amountInr', message: 'Must be a positive integer' });
  }
  const metadata = body?.metadata || {};
  if (context === 'lease' && (!metadata.plotKey || !metadata.planKey)) {
    details.push({ field: 'metadata', message: 'plotKey and planKey required for lease' });
  }
  if (context === 'renewal' && !metadata.subscriptionId) {
    details.push({ field: 'metadata.subscriptionId', message: 'Required for renewal' });
  }
  if (details.length) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid payment request', details);

  let member = await findMemberByAnyId(memberId);
  let registration = null;
  if (!member) {
    registration = await findRegistration(memberId);
    if (!registration) throw new ApiError(404, 'MEMBER_NOT_FOUND', 'Member not found');
  }

  const db = getDB();
  const dupFilter = {
    status: 'pending',
    context,
  };
  if (member) dupFilter.memberId = member.id;
  if (context === 'lease') {
    dupFilter['metadata.plotKey'] = metadata.plotKey;
    dupFilter.memberId = member?.id;
  }
  if (context === 'renewal') dupFilter['metadata.subscriptionId'] = metadata.subscriptionId;
  if (context === 'membership' && (metadata.registrationId || registration)) {
    dupFilter['metadata.registrationId'] = metadata.registrationId || registration.id;
  }
  const existing = await db.collection('payments').findOne(dupFilter);
  if (existing) return { payment: await enrichPayment(existing), existing: true };

  let plot;
  let plan;
  if (metadata.plotKey) plot = await loadPlot(metadata.plotKey);
  if (metadata.planKey) plan = await loadPlan(metadata.planKey);
  const label =
    body.label ||
    paymentLabel(context, { plotName: plot?.name, plotKey: metadata.plotKey, planName: plan?.name, planKey: metadata.planKey });

  const payment = await createPaymentRecord({
    memberId: member?.id || null,
    context,
    amountInr,
    method: 'payment_request',
    label,
    metadata: {
      ...metadata,
      registrationId: metadata.registrationId || registration?.id || null,
    },
    status: 'pending',
    memberName: member?.name || registration?.name,
    memberEmail: member?.email || registration?.email,
    memberPhone: member?.phoneDisplay || registration?.phoneDisplay,
  });

  const dueDate = body.dueDate || defaultDueDate();
  await db.collection('payments').updateOne(
    { id: payment.id },
    { $set: { dueDate, memberCode: member ? memberPublicId(member) : null } }
  );

  if (member) {
    await insertMemberNotification({
      memberId: member.id,
      icon: 'card',
      title: 'Payment request',
      body: `${label} — ${formatInr(amountInr)} due.`,
      deepLinkTab: 'subscription',
      deepLinkPath: '/app/subscription',
    });
  }
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Payment request created',
    entity: payment.ref,
    entityType: 'payment',
    detail: `${member?.name || registration?.name || ''} · ${formatInr(amountInr)}`.trim(),
    meta: { memberId: member?.id, paymentId: payment.id },
  });
  const stored = await db.collection('payments').findOne({ id: payment.id });
  return { payment: await enrichPayment(stored) };
}

async function markPaid(paymentId, body, staff) {
  const payment = await requirePaymentByAnyId(paymentId);
  if (payment.status === 'succeeded') {
    return { alreadyPaid: true, payment: await enrichPayment(payment) };
  }
  if (payment.status === 'cancelled') {
    throw new ApiError(409, 'PAYMENT_CLOSED', 'This payment request was cancelled and cannot be approved');
  }
  if (payment.status === 'refunded') {
    throw new ApiError(409, 'INVALID_STATUS', `Cannot approve payment in status ${payment.status}`);
  }
  if (!COLLECTIBLE_STATUSES.includes(payment.status) && payment.status !== 'pending') {
    throw new ApiError(409, 'INVALID_STATUS', `Cannot approve payment in status ${payment.status}`);
  }

  let method = body?.method || (body?.collectionRef ? 'offline' : 'offline');
  if (body?.method && !PAYMENT_METHODS.includes(body.method)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid collection method', [
      { field: 'method', message: `Must be one of ${PAYMENT_METHODS.join(', ')}` },
    ]);
  }

  const result = await approvePayment(payment.id, {
    approvedBy: staff.id,
    adminNote: body?.adminNote || '',
  });

  const db = getDB();
  await db.collection('payments').updateOne(
    { id: payment.id },
    {
      $set: {
        method,
        collectionRef: body?.collectionRef || null,
        collectedAt: isoDate(new Date()),
        updatedAt: new Date(),
      },
    }
  );

  const updated = await db.collection('payments').findOne({ id: payment.id });
  const member = updated.memberId ? await findMemberByAnyId(updated.memberId) : null;
  if (member) {
    if (updated.context === 'membership') {
      await db.collection('members').updateOne(
        { id: member.id },
        { $set: { accountStatus: 'active', isMember: true, updatedAt: new Date() } }
      );
      await insertMemberNotification({
        memberId: member.id,
        icon: 'leaf',
        title: 'Membership activated',
        body: 'Welcome to CHEDI Farm Club! Your membership is active.',
        deepLinkTab: 'overview',
        deepLinkPath: '/app/overview',
      });
    } else if (updated.context === 'lease') {
      await db.collection('members').updateOne(
        { id: member.id },
        { $set: { accountStatus: 'active', subStatus: 'active', updatedAt: new Date() } }
      );
      await insertMemberNotification({
        memberId: member.id,
        icon: 'sprout',
        title: 'Subscription activated',
        body: 'Your subscription is active and your weekly baskets are scheduled.',
        deepLinkTab: 'my-plot',
        deepLinkPath: '/app/my-plot',
      });
    } else if (updated.context === 'renewal') {
      await db.collection('members').updateOne(
        { id: member.id },
        { $set: { subStatus: 'active', updatedAt: new Date() } }
      );
      await insertMemberNotification({
        memberId: member.id,
        icon: 'sprout',
        title: 'Subscription renewed',
        body: 'Your subscription is active and your weekly baskets are scheduled.',
        deepLinkTab: 'subscription',
        deepLinkPath: '/app/subscription',
      });
    }
  }

  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Payment marked paid',
    entity: updated.ref,
    entityType: 'payment',
    detail: `${updated.memberName || member?.name || ''} · ${formatInr(updated.amountInr)}`.trim(),
    meta: { memberId: updated.memberId, paymentId: updated.id },
  });

  return { alreadyPaid: Boolean(result.alreadyPaid), payment: await enrichPayment(updated), sideEffect: result.sideEffect };
}

async function rejectAdminPayment(paymentId, body, staff) {
  const payment = await requirePaymentByAnyId(paymentId);
  const result = await rejectPayment(payment.id, {
    rejectedBy: staff.id,
    adminNote: body?.adminNote || '',
  });
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Payment rejected',
    entity: payment.ref,
    entityType: 'payment',
    detail: payment.memberName || payment.ref,
    meta: { memberId: payment.memberId, paymentId: payment.id },
  });
  const db = getDB();
  const updated = await db.collection('payments').findOne({ id: payment.id });
  return { payment: await enrichPayment(updated || result.payment) };
}

async function remindPayment(paymentId, staff) {
  const payment = await requirePaymentByAnyId(paymentId);
  const ops = paymentOpsStatus(payment);
  if (!['pending', 'overdue', 'failed'].includes(ops)) {
    throw new ApiError(409, 'INVALID_STATUS', 'Payment is not collectible');
  }
  if (payment.memberId) {
    await insertMemberNotification({
      memberId: payment.memberId,
      icon: 'bell',
      title: 'Payment reminder',
      body: `A reminder that your payment of ${formatInr(payment.amountInr)} is due.`,
      deepLinkTab: 'subscription',
      deepLinkPath: '/app/subscription',
    });
  }
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Payment reminder sent',
    entity: payment.ref,
    entityType: 'payment',
    detail: `${payment.memberName || ''} · ${formatInr(payment.amountInr)}`.trim(),
    meta: { memberId: payment.memberId, paymentId: payment.id },
  });
  return { sent: true };
}

async function refundPayment(paymentId, body, staff) {
  const payment = await requirePaymentByAnyId(paymentId);
  if (payment.status !== 'succeeded') {
    throw new ApiError(409, 'INVALID_STATUS', 'Only succeeded payments can be refunded');
  }
  if (body?.amountInr != null && Number(body.amountInr) !== payment.amountInr) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Partial refunds are not supported', [
      { field: 'amountInr', message: 'Must equal original amount' },
    ]);
  }
  const db = getDB();
  const now = new Date();
  await db.collection('payments').updateOne(
    { id: payment.id },
    {
      $set: {
        status: 'refunded',
        refundedAt: now,
        refundedBy: staff.id,
        adminNote: body?.adminNote || payment.adminNote,
        updatedAt: now,
      },
    }
  );
  if (payment.memberId) {
    await insertMemberNotification({
      memberId: payment.memberId,
      icon: 'card',
      title: 'Refund processed',
      body: `A refund of ${formatInr(payment.amountInr)} has been issued.`,
    });
  }
  const updated = await db.collection('payments').findOne({ id: payment.id });
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Refund issued',
    entity: payment.ref,
    entityType: 'payment',
    detail: `${payment.memberName || ''} · ${formatInr(payment.amountInr)}`.trim(),
    meta: { memberId: payment.memberId, paymentId: payment.id },
  });
  return { payment: await enrichPayment(updated) };
}

module.exports = {
  listPayments,
  getPayment,
  getReceipt,
  createAdminPayment,
  markPaid,
  rejectAdminPayment,
  remindPayment,
  refundPayment,
};
