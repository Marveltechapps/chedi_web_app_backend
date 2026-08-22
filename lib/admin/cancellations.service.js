const { getDB } = require('../../config/db');
const { ApiError } = require('../errors');
const { writeAudit } = require('../audit');
const { insertMemberNotification } = require('./notify');
const { toCancellationDto, memberPublicId } = require('./dto');
const { findMemberByAnyId, loadPlot } = require('./lookups');

async function extras(row) {
  const member = await findMemberByAnyId(row.memberId);
  const db = getDB();
  const delivery = await db.collection('deliveries').findOne({ id: row.deliveryId });
  const sub = delivery?.subscriptionId
    ? await db.collection('subscriptions').findOne({ id: delivery.subscriptionId })
    : null;
  const plot = await loadPlot(sub?.plotKey || row.plotKey);
  return {
    memberCode: member ? memberPublicId(member) : row.memberCode,
    memberName: member?.name || row.memberName,
    plotKey: plot?.key,
    plotName: plot?.name,
  };
}

async function listCancellations(query = {}) {
  const db = getDB();
  const status = String(query.status || 'pending');
  const find = status === 'all' ? {} : { status };
  const rows = await db.collection('cancellation_requests').find(find).sort({ createdAt: -1 }).toArray();
  const data = [];
  for (const row of rows) data.push(toCancellationDto(row, await extras(row)));
  return { data };
}

async function requireRequest(id) {
  const db = getDB();
  const row = await db.collection('cancellation_requests').findOne({ id });
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Cancellation request not found');
  return row;
}

async function approveCancellation(id, staff) {
  const row = await requireRequest(id);
  if (row.locked) throw new ApiError(400, 'DELIVERY_LOCKED', 'Basket locked — cannot cancel');
  const db = getDB();
  await db.collection('cancellation_requests').updateOne(
    { id: row.id },
    { $set: { status: 'approved', updatedAt: new Date() } }
  );
  await db.collection('deliveries').updateOne(
    { id: row.deliveryId },
    {
      $set: {
        cancelled: true,
        opsStatus: 'cancelled',
        cancellable: false,
        locked: true,
        updatedAt: new Date(),
      },
    }
  );
  await insertMemberNotification({
    memberId: row.memberId,
    icon: 'truck',
    title: 'Delivery cancelled',
    body: `Your delivery for ${row.dateLabel || row.date} has been cancelled.`,
    deepLinkTab: 'deliveries',
    deepLinkPath: '/app/deliveries',
  });
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Cancellation approved',
    entity: row.id,
    entityType: 'cancellation',
    detail: row.memberName || row.memberId,
    meta: { memberId: row.memberId },
  });
  const updated = await requireRequest(id);
  return toCancellationDto(updated, await extras(updated));
}

async function rejectCancellation(id, staff) {
  const row = await requireRequest(id);
  const db = getDB();
  await db.collection('cancellation_requests').updateOne(
    { id: row.id },
    { $set: { status: 'rejected', updatedAt: new Date() } }
  );
  const body = row.locked
    ? 'Your basket is already locked and cannot be cancelled.'
    : 'We could not cancel this delivery.';
  await insertMemberNotification({
    memberId: row.memberId,
    icon: 'truck',
    title: 'Cancellation declined',
    body,
    deepLinkTab: 'deliveries',
    deepLinkPath: '/app/deliveries',
  });
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Cancellation rejected',
    entity: row.id,
    entityType: 'cancellation',
    detail: row.memberName || row.memberId,
    meta: { memberId: row.memberId },
  });
  const updated = await requireRequest(id);
  return toCancellationDto(updated, await extras(updated));
}

module.exports = { listCancellations, approveCancellation, rejectCancellation };
