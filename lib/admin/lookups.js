const { getDB } = require('../../config/db');
const { ApiError } = require('../errors');
const { farmFromPlotKey } = require('./dto');

async function findMemberByAnyId(id) {
  if (!id) return null;
  const db = getDB();
  const raw = String(id).trim();
  const or = [{ id: raw }, { memberCode: raw }];
  if (/^chedi-/i.test(raw)) {
    or.push({ id: raw.replace(/^chedi-/i, '') });
  }
  return db.collection('members').findOne({ deletedAt: null, $or: or });
}

async function requireMemberByAnyId(id) {
  const member = await findMemberByAnyId(id);
  if (!member) throw new ApiError(404, 'MEMBER_NOT_FOUND', 'Member not found');
  return member;
}

async function findPaymentByAnyId(id) {
  if (!id) return null;
  const db = getDB();
  const raw = String(id).trim();
  return db.collection('payments').findOne({ $or: [{ id: raw }, { ref: raw }] });
}

async function requirePaymentByAnyId(id) {
  const payment = await findPaymentByAnyId(id);
  if (!payment) throw new ApiError(404, 'PAYMENT_NOT_FOUND', 'Payment not found');
  return payment;
}

async function latestSubscription(memberId) {
  const db = getDB();
  return db.collection('subscriptions').findOne(
    { memberId, status: { $nin: ['cancelled'] } },
    { sort: { createdAt: -1 } }
  );
}

async function defaultAddress(memberId) {
  const db = getDB();
  return (
    (await db.collection('addresses').findOne({ memberId, isDefault: true })) ||
    (await db.collection('addresses').findOne({ memberId }, { sort: { createdAt: 1 } }))
  );
}

async function loadPlan(planKey) {
  if (!planKey) return null;
  const db = getDB();
  return db.collection('plans').findOne({ key: planKey });
}

async function loadPlot(plotKey) {
  if (!plotKey) return null;
  const db = getDB();
  return db.collection('plots').findOne({ key: plotKey });
}

/** Alias used by subscriptions.service */
async function loadFarmPlot(plotKey) {
  return loadPlot(plotKey);
}

async function loadFarm(farmId) {
  if (!farmId) return null;
  const db = getDB();
  const row = await db.collection('farms').findOne({ id: farmId });
  if (row) return row;
  return farmFromPlotKey(farmId);
}

async function loadCultivation(plotKey) {
  if (!plotKey) return null;
  const db = getDB();
  return db.collection('cultivations').findOne({ plotKey });
}

async function loadCrop(cropKey) {
  if (!cropKey) return null;
  const db = getDB();
  return db.collection('crops').findOne({ key: cropKey });
}

async function findRegistration(id) {
  if (!id) return null;
  const db = getDB();
  return db.collection('registrations').findOne({
    $or: [{ id: String(id) }, { memberId: String(id) }],
  });
}

module.exports = {
  findMemberByAnyId,
  requireMemberByAnyId,
  findPaymentByAnyId,
  requirePaymentByAnyId,
  latestSubscription,
  defaultAddress,
  loadPlan,
  loadPlot,
  loadFarmPlot,
  loadFarm,
  loadCultivation,
  loadCrop,
  findRegistration,
};
