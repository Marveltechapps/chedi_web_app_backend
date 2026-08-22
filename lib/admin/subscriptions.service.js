const { getDB } = require('../../config/db');
const { ApiError } = require('../errors');
const { parsePagination, paginationMeta } = require('../pagination');
const { writeAudit } = require('../audit');
const { formatInr } = require('../money');
const { toMemberDto, defaultDueDate, memberPublicId, toPaymentDto } = require('./dto');
const { requireMemberByAnyId, latestSubscription, loadPlan, loadFarmPlot } = require('./lookups');
const { hydrateMember, cancelMember, cancelUpcomingDeliveries } = require('./members.service');
const { insertMemberNotification } = require('./notify');
const { createPaymentRecord, paymentLabel } = require('../payments');

async function listSubscriptions(query = {}) {
  const db = getDB();
  const { page, limit, skip } = parsePagination(query);
  const filter = String(query.status || query.filter || 'all');
  const q = String(query.q || '').trim().toLowerCase();
  const members = await db
    .collection('members')
    .find({ deletedAt: null, subStatus: { $exists: true, $nin: [null, 'none'] } })
    .sort({ createdAt: -1 })
    .toArray();

  const hydrated = [];
  for (const m of members) hydrated.push(await hydrateMember(m));

  const withSubs = hydrated.filter((m) => m.subStatus && m.subStatus !== 'none');

  const counts = {
    all: withSubs.length,
    active: withSubs.filter((m) => m.subStatus === 'active').length,
    renewal_due: withSubs.filter((m) => m.subStatus === 'renewal_due').length,
    payment_pending: withSubs.filter((m) => ['payment_pending', 'pending_activation'].includes(m.subStatus)).length,
    paused: withSubs.filter((m) => ['paused', 'cancelled', 'expired'].includes(m.subStatus)).length,
  };

  let rows = withSubs;
  if (filter === 'active') rows = withSubs.filter((m) => m.subStatus === 'active');
  else if (filter === 'renewal_due') rows = withSubs.filter((m) => m.subStatus === 'renewal_due');
  else if (filter === 'payment_pending') {
    rows = withSubs.filter((m) => ['payment_pending', 'pending_activation'].includes(m.subStatus));
  } else if (filter === 'paused') {
    rows = withSubs.filter((m) => ['paused', 'cancelled', 'expired'].includes(m.subStatus));
  }

  if (q) {
    rows = rows.filter((m) =>
      [m.name, m.memberCode, m.plotName, m.planName, m.email].filter(Boolean).join(' ').toLowerCase().includes(q)
    );
  }

  const total = rows.length;
  return {
    data: rows.slice(skip, skip + limit),
    pagination: paginationMeta(page, limit, total),
    meta: { counts },
  };
}

async function activateSubscription(memberId, staff) {
  const db = getDB();
  const member = await requireMemberByAnyId(memberId);
  const hydrated = await hydrateMember(member);
  if (hydrated.subStatus !== 'pending_activation') {
    throw new ApiError(409, 'INVALID_STATUS', 'Subscription is not pending activation');
  }
  await db.collection('members').updateOne(
    { id: member.id },
    { $set: { accountStatus: 'active', subStatus: 'active', updatedAt: new Date() } }
  );
  await db.collection('subscriptions').updateMany(
    { memberId: member.id, status: { $in: ['pending_activation', 'payment_pending'] } },
    { $set: { status: 'active', updatedAt: new Date() } }
  );
  const sub = await latestSubscription(member.id);
  if (sub?.plotKey) {
    await db.collection('plots').updateOne(
      { key: sub.plotKey },
      { $set: { opsStatus: 'leased', updatedAt: new Date() } }
    );
  }
  const plot = await loadFarmPlot(sub?.plotKey || member.plotKey);
  await insertMemberNotification({
    memberId: member.id,
    icon: 'sprout',
    title: 'Subscription activated',
    body: 'Your subscription is now active.',
    deepLinkTab: 'my-plot',
    deepLinkPath: '/app/my-plot',
  });
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Subscription activated',
    entity: memberPublicId(member),
    entityType: 'subscription',
    detail: `${member.name} · ${plot?.name || ''}`.trim(),
    meta: { memberId: member.id },
  });
  return hydrateMember(await requireMemberByAnyId(member.id));
}

async function pauseSubscription(memberId, staff) {
  const db = getDB();
  const member = await requireMemberByAnyId(memberId);
  await db.collection('members').updateOne(
    { id: member.id },
    { $set: { subStatus: 'paused', updatedAt: new Date() } }
  );
  await db.collection('subscriptions').updateMany(
    { memberId: member.id, status: 'active' },
    { $set: { status: 'paused', updatedAt: new Date() } }
  );
  await cancelUpcomingDeliveries(member.id);
  await insertMemberNotification({
    memberId: member.id,
    icon: 'sprout',
    title: 'Subscription paused',
    body: 'Your deliveries are paused. Resume anytime.',
  });
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Subscription paused',
    entity: memberPublicId(member),
    entityType: 'subscription',
    detail: `${member.name} · future deliveries held`,
    meta: { memberId: member.id },
  });
  return hydrateMember(await requireMemberByAnyId(member.id));
}

async function resumeSubscription(memberId, staff) {
  const db = getDB();
  const member = await requireMemberByAnyId(memberId);
  await db.collection('members').updateOne(
    { id: member.id },
    { $set: { subStatus: 'active', updatedAt: new Date() } }
  );
  await db.collection('subscriptions').updateMany(
    { memberId: member.id, status: 'paused' },
    { $set: { status: 'active', updatedAt: new Date() } }
  );
  await insertMemberNotification({
    memberId: member.id,
    icon: 'sprout',
    title: 'Subscription resumed',
    body: 'Welcome back — your deliveries resume this week.',
  });
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Subscription resumed',
    entity: memberPublicId(member),
    entityType: 'subscription',
    detail: member.name,
    meta: { memberId: member.id },
  });
  return hydrateMember(await requireMemberByAnyId(member.id));
}

async function generateRenewalBill(memberId, staff) {
  const db = getDB();
  const member = await requireMemberByAnyId(memberId);
  const sub = await latestSubscription(member.id);
  if (!sub) throw new ApiError(404, 'SUBSCRIPTION_NOT_FOUND', 'Subscription not found');
  if (sub.billPaid) {
    const cycleEnd = sub.cycleEnd ? String(sub.cycleEnd).slice(0, 10) : null;
    const today = require('../dates').isoDate(new Date());
    if (cycleEnd && cycleEnd > today) {
      throw new ApiError(409, 'BILL_ALREADY_PAID', 'Renewal bill already paid');
    }
  }
  const existing = await db.collection('payments').findOne({
    memberId: member.id,
    context: 'renewal',
    status: 'pending',
    'metadata.subscriptionId': sub.id,
  });
  if (existing) {
    return { member: await hydrateMember(member), payment: toPaymentDto(existing, { memberName: member.name, memberCode: memberPublicId(member), memberId: member.id }) };
  }
  const plan = await loadPlan(sub.planKey || member.planKey);
  const plot = await loadFarmPlot(sub.plotKey || member.plotKey);
  const amount = plan?.priceInr || sub.nextBillAmountInr || sub.totalInr || 0;
  const payment = await createPaymentRecord({
    memberId: member.id,
    context: 'renewal',
    amountInr: amount,
    method: 'payment_request',
    label: paymentLabel('renewal', { plotName: plot?.name, planName: plan?.name, subscriptionId: sub.id }),
    metadata: { subscriptionId: sub.id, createdBy: staff.id },
    status: 'pending',
    memberName: member.name,
    memberEmail: member.email,
    memberPhone: member.phoneDisplay || member.phone,
  });
  await db.collection('payments').updateOne(
    { id: payment.id },
    { $set: { dueDate: defaultDueDate(), memberCode: memberPublicId(member) } }
  );
  await db.collection('members').updateOne(
    { id: member.id },
    { $set: { subStatus: 'payment_pending', updatedAt: new Date() } }
  );
  await insertMemberNotification({
    memberId: member.id,
    icon: 'refresh',
    title: 'Renewal reminder',
    body: `Your renewal of ${formatInr(amount)} is ready. Pay to continue baskets.`,
  });
  const stored = await db.collection('payments').findOne({ id: payment.id });
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Renewal bill generated',
    entity: stored.ref,
    entityType: 'payment',
    detail: `${member.name} · ${formatInr(amount)}`,
    meta: { memberId: member.id, paymentId: stored.id },
  });
  return {
    member: await hydrateMember(await requireMemberByAnyId(member.id)),
    payment: toPaymentDto(stored, {
      memberId: member.id,
      memberCode: memberPublicId(member),
      memberName: member.name,
    }),
  };
}

async function remindRenewal(memberId, staff) {
  const member = await requireMemberByAnyId(memberId);
  const hydrated = await hydrateMember(member);
  if (!['renewal_due', 'payment_pending'].includes(hydrated.subStatus)) {
    throw new ApiError(409, 'INVALID_STATUS', 'Renewal reminder is only for renewal_due or payment_pending');
  }
  await insertMemberNotification({
    memberId: member.id,
    icon: 'refresh',
    title: 'Renewal reminder',
    body: 'Your subscription is up for renewal soon.',
  });
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Renewal reminder sent',
    entity: memberPublicId(member),
    entityType: 'subscription',
    detail: member.name,
    meta: { memberId: member.id },
  });
  return { sent: true };
}

async function cancelSubscription(memberId, staff) {
  const member = await requireMemberByAnyId(memberId);
  await cancelMember(member.id, staff, { keepAccountActive: true });
  const db = getDB();
  await db.collection('members').updateOne(
    { id: member.id },
    { $set: { accountStatus: 'active', isMember: true, subStatus: 'cancelled', updatedAt: new Date() } }
  );
  await insertMemberNotification({
    memberId: member.id,
    icon: 'sprout',
    title: 'Subscription paused',
    body: 'Your plot subscription has been cancelled. You remain a Farm Club member.',
  });
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Subscription cancelled',
    entity: memberPublicId(member),
    entityType: 'subscription',
    detail: member.name,
    meta: { memberId: member.id },
  });
  return hydrateMember(await requireMemberByAnyId(member.id));
}

module.exports = {
  listSubscriptions,
  activateSubscription,
  pauseSubscription,
  resumeSubscription,
  generateRenewalBill,
  remindRenewal,
  cancelSubscription,
  toMemberDto,
};
