const { getDB } = require('../../config/db');
const { ApiError } = require('../errors');
const { parsePagination, paginationMeta, slicePage } = require('../pagination');
const { writeAudit } = require('../audit');
const { formatDisplayDate, isSaturdayUtc, parseIsoDate } = require('../dates');
const { insertMemberNotification } = require('./notify');
const { toDeliveryDto, memberPublicId, planBoxes } = require('./dto');
const { loadPlot, loadPlan, defaultAddress, findMemberByAnyId } = require('./lookups');
const { DELIVERY_OPS } = require('./constants');

function deliveryFilterMatch(ops, filter) {
  if (!filter || filter === 'all') return true;
  if (filter === 'upcoming') return ['scheduled', 'rescheduled', 'packed', 'ready_dispatch', 'out'].includes(ops);
  if (filter === 'delivered') return ops === 'delivered';
  if (filter === 'failed') return ops === 'failed' || ops === 'cancelled';
  if (filter === 'rescheduled') return ops === 'rescheduled';
  return ops === filter;
}

async function extrasFor(delivery) {
  const member = delivery.memberId ? await findMemberByAnyId(delivery.memberId) : null;
  const db = getDB();
  const sub = delivery.subscriptionId
    ? await db.collection('subscriptions').findOne({ id: delivery.subscriptionId })
    : null;
  const plot = await loadPlot(sub?.plotKey);
  const plan = await loadPlan(sub?.planKey);
  const addr = member ? await defaultAddress(member.id) : null;
  const addressDisplay = addr ? `${addr.line}, ${addr.city} ${addr.pin}` : null;
  return {
    memberId: member?.id,
    memberCode: member ? memberPublicId(member) : null,
    memberName: member?.name,
    addressDisplay,
    plotKey: plot?.key,
    plotName: plot?.name,
    boxesPerWeek: planBoxes(plan),
  };
}

async function listDeliveries(query = {}) {
  const db = getDB();
  const { page, limit } = parsePagination(query);
  const filter = String(query.filter || 'all');
  const find = {};
  if (query.memberId) {
    const member = await findMemberByAnyId(query.memberId);
    find.memberId = member ? member.id : query.memberId;
  }
  if (query.subscriptionId) find.subscriptionId = query.subscriptionId;
  if (query.basketId) find.basketId = query.basketId;
  if (query.dateFrom || query.dateTo) {
    find.date = {};
    if (query.dateFrom) find.date.$gte = String(query.dateFrom).slice(0, 10);
    if (query.dateTo) find.date.$lte = String(query.dateTo).slice(0, 10);
  }
  const rows = await db.collection('deliveries').find(find).sort({ date: 1, weekIndex: 1 }).toArray();
  const dtos = [];
  for (const d of rows) dtos.push(toDeliveryDto(d, await extrasFor(d)));
  const counts = {
    all: dtos.length,
    upcoming: dtos.filter((d) => ['scheduled', 'rescheduled', 'packed', 'ready_dispatch', 'out'].includes(d.opsStatus)).length,
    delivered: dtos.filter((d) => d.opsStatus === 'delivered').length,
    failed: dtos.filter((d) => d.opsStatus === 'failed' || d.opsStatus === 'cancelled').length,
    rescheduled: dtos.filter((d) => d.opsStatus === 'rescheduled').length,
  };
  const filtered = dtos.filter((d) => deliveryFilterMatch(d.opsStatus, filter));
  return {
    data: slicePage(filtered, page, limit),
    pagination: paginationMeta(page, limit, filtered.length),
    meta: { counts },
  };
}

async function requireDelivery(id) {
  const db = getDB();
  const row = await db.collection('deliveries').findOne({ id });
  if (!row) throw new ApiError(404, 'DELIVERY_NOT_FOUND', 'Delivery not found');
  return row;
}

async function advanceDelivery(deliveryId, staff) {
  const delivery = await requireDelivery(deliveryId);
  const stored = delivery.opsStatus || 'scheduled';
  const ops = stored === 'rescheduled' ? 'scheduled' : stored;
  const i = DELIVERY_OPS.indexOf(ops);
  if (i < 0 || i >= DELIVERY_OPS.length - 1) {
    throw new ApiError(409, 'INVALID_STATUS', 'Delivery is not on the advance path');
  }
  const next = DELIVERY_OPS[i + 1];
  const db = getDB();
  await db.collection('deliveries').updateOne(
    { id: delivery.id },
    { $set: { opsStatus: next, updatedAt: new Date() } }
  );
  if (next === 'out') {
    await insertMemberNotification({
      memberId: delivery.memberId,
      icon: 'truck',
      title: 'Out for delivery',
      body: 'Your basket is out for delivery.',
      deepLinkTab: 'deliveries',
      deepLinkPath: '/app/deliveries',
    });
  }
  if (next === 'delivered') {
    await insertMemberNotification({
      memberId: delivery.memberId,
      icon: 'check',
      title: 'Delivered',
      body: 'Your basket has been delivered. Enjoy!',
      deepLinkTab: 'deliveries',
      deepLinkPath: '/app/deliveries',
    });
  }
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: `Delivery ${next}`,
    entity: delivery.id,
    entityType: 'delivery',
    detail: `${delivery.dateLabel || delivery.date} → ${next}`,
    meta: { memberId: delivery.memberId },
  });
  const updated = await requireDelivery(delivery.id);
  return toDeliveryDto(updated, await extrasFor(updated));
}

async function cancelDelivery(deliveryId, staff) {
  const delivery = await requireDelivery(deliveryId);
  const ops = delivery.opsStatus || 'scheduled';
  if (!['scheduled', 'rescheduled', 'packed'].includes(ops)) {
    throw new ApiError(409, 'INVALID_STATUS', 'Only scheduled or packed deliveries can be cancelled');
  }
  const db = getDB();
  await db.collection('deliveries').updateOne(
    { id: delivery.id },
    {
      $set: {
        opsStatus: 'cancelled',
        cancelled: true,
        cancellable: false,
        locked: true,
        updatedAt: new Date(),
      },
    }
  );
  await insertMemberNotification({
    memberId: delivery.memberId,
    icon: 'truck',
    title: 'Delivery update',
    body: 'Your delivery has been cancelled.',
    deepLinkTab: 'deliveries',
    deepLinkPath: '/app/deliveries',
  });
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Delivery cancelled',
    entity: delivery.id,
    entityType: 'delivery',
    meta: { memberId: delivery.memberId },
  });
  const updated = await requireDelivery(delivery.id);
  return toDeliveryDto(updated, await extrasFor(updated));
}

async function failDelivery(deliveryId, staff) {
  const delivery = await requireDelivery(deliveryId);
  if ((delivery.opsStatus || 'scheduled') !== 'out') {
    throw new ApiError(409, 'INVALID_STATUS', 'Only out-for-delivery baskets can be marked failed');
  }
  const db = getDB();
  await db.collection('deliveries').updateOne(
    { id: delivery.id },
    { $set: { opsStatus: 'failed', updatedAt: new Date() } }
  );
  await insertMemberNotification({
    memberId: delivery.memberId,
    icon: 'truck',
    title: 'Delivery update',
    body: 'We could not deliver your basket. We will reschedule.',
    deepLinkTab: 'deliveries',
    deepLinkPath: '/app/deliveries',
  });
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Delivery failed',
    entity: delivery.id,
    entityType: 'delivery',
    meta: { memberId: delivery.memberId },
  });
  const updated = await requireDelivery(delivery.id);
  return toDeliveryDto(updated, await extrasFor(updated));
}

async function rescheduleDelivery(deliveryId, date, staff) {
  if (!parseIsoDate(date) || !isSaturdayUtc(date)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Delivery date must be a Saturday (YYYY-MM-DD)', [
      { field: 'date', message: 'Must be a Saturday' },
    ]);
  }
  const delivery = await requireDelivery(deliveryId);
  const ops = delivery.opsStatus || 'scheduled';
  if (!['scheduled', 'rescheduled', 'packed', 'failed', 'cancelled'].includes(ops)) {
    throw new ApiError(409, 'INVALID_STATUS', 'This delivery cannot be rescheduled');
  }
  const newDate = String(date).slice(0, 10);
  const previousDate = String(delivery.date || '').slice(0, 10);
  if (previousDate === newDate) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Choose a different Saturday', [
      { field: 'date', message: 'Already scheduled for that Saturday' },
    ]);
  }
  const dateLabel = formatDisplayDate(newDate);
  const db = getDB();
  if (delivery.subscriptionId) {
    const clash = await db.collection('deliveries').findOne({
      subscriptionId: delivery.subscriptionId,
      date: newDate,
      id: { $ne: delivery.id },
    });
    if (clash) {
      const clashOps = clash.opsStatus || 'scheduled';
      const placeholder = clashOps === 'scheduled';
      if (!placeholder) {
        throw new ApiError(409, 'DATE_TAKEN', 'That Saturday already has a delivery in progress');
      }
      await db.collection('deliveries').deleteOne({ id: clash.id });
    }
  }
  await db.collection('deliveries').updateOne(
    { id: delivery.id },
    {
      $set: {
        opsStatus: 'rescheduled',
        date: newDate,
        dateLabel,
        note: `Rescheduled to ${dateLabel}`,
        cancelled: false,
        cancellable: true,
        locked: false,
        rescheduledFrom: previousDate || null,
        updatedAt: new Date(),
      },
    }
  );
  await insertMemberNotification({
    memberId: delivery.memberId,
    icon: 'truck',
    title: 'Delivery update',
    body: `Your delivery has been moved to ${dateLabel}.`,
    deepLinkTab: 'deliveries',
    deepLinkPath: '/app/deliveries',
  });
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Delivery rescheduled',
    entity: delivery.id,
    entityType: 'delivery',
    detail: dateLabel,
    meta: { memberId: delivery.memberId },
  });
  const updated = await requireDelivery(delivery.id);
  return toDeliveryDto(updated, await extrasFor(updated));
}

module.exports = { listDeliveries, advanceDelivery, cancelDelivery, failDelivery, rescheduleDelivery };
