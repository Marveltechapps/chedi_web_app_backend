const { getDB } = require('../../config/db');
const { ApiError } = require('../errors');
const { writeAudit } = require('../audit');
const { toBasketDto, nextSeq } = require('./dto');
const { BASKET_STATUSES } = require('./constants');
const { insertMemberNotification } = require('./notify');
const { formatDisplayDate, addDays, isoDate } = require('../dates');

async function cropMap() {
  const db = getDB();
  const crops = await db.collection('crops').find({}).toArray();
  return Object.fromEntries(crops.map((c) => [c.key, c]));
}

async function currentBasket() {
  const db = getDB();
  return db.collection('baskets').findOne({}, { sort: { weekStart: -1, createdAt: -1 } });
}

async function listBaskets() {
  const db = getDB();
  const rows = await db.collection('baskets').find({}).sort({ weekStart: -1, createdAt: -1 }).toArray();
  const crops = await cropMap();
  const mapped = rows.map((b) => toBasketDto(b, crops));
  return { current: mapped[0] || null, history: mapped.slice(1) };
}

function assertComposable(basket, staff) {
  const lockedFrom = BASKET_STATUSES.indexOf('locked');
  const i = BASKET_STATUSES.indexOf(basket.status);
  if (i >= lockedFrom && staff?.role !== 'super_admin') {
    throw new ApiError(409, 'INVALID_STATUS', 'Basket is locked and cannot be edited');
  }
}

async function advanceBasket(staff) {
  const db = getDB();
  const cur = await currentBasket();
  if (!cur) throw new ApiError(404, 'BASKET_NOT_FOUND', 'No basket found');
  const i = BASKET_STATUSES.indexOf(cur.status);
  if (i < 0 || i >= BASKET_STATUSES.length - 1) {
    throw new ApiError(409, 'BASKET_COMPLETE', 'Basket is already at the final status');
  }
  const next = BASKET_STATUSES[i + 1];
  await db.collection('baskets').updateOne({ id: cur.id }, { $set: { status: next, updatedAt: new Date() } });
  if (next === 'locked') {
    await db.collection('deliveries').updateMany(
      { basketId: cur.id },
      { $set: { locked: true, cancellable: false, lockReason: 'Produce is already being harvested', updatedAt: new Date() } }
    );
  }
  if (next === 'published') {
    const members = await db.collection('members').find({ subStatus: 'active', deletedAt: null }).toArray();
    for (const m of members) {
      await insertMemberNotification({
        memberId: m.id,
        icon: 'basket',
        title: 'This week’s basket',
        body: `Your ${cur.weekLabel || cur.week} basket is confirmed.`,
        deepLinkTab: 'deliveries',
        deepLinkPath: '/app/deliveries',
      });
    }
  }
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: `Basket ${next}`,
    entity: cur.id,
    entityType: 'basket',
    detail: `${cur.weekLabel || cur.week} → ${next}`,
  });
  return listBaskets();
}

async function addBasketItem(item, staff) {
  const db = getDB();
  const cur = await currentBasket();
  if (!cur) throw new ApiError(404, 'BASKET_NOT_FOUND', 'No basket found');
  assertComposable(cur, staff);
  const cropKey = item.cropKey;
  if (!cropKey) throw new ApiError(400, 'VALIDATION_ERROR', 'cropKey is required', [{ field: 'cropKey', message: 'Required' }]);
  const crop = await db.collection('crops').findOne({ key: cropKey });
  if (!crop) throw new ApiError(404, 'CROP_NOT_FOUND', 'Crop not found');
  const qty = Number(item.qty);
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'qty must be a positive number', [{ field: 'qty', message: 'Must be > 0' }]);
  }
  const nextItem = { cropKey, qty, supp: item.supp !== false, unit: crop.unit };
  await db.collection('baskets').updateOne(
    { id: cur.id },
    { $push: { items: nextItem }, $set: { updatedAt: new Date() } }
  );
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Supplement added',
    entity: cur.id,
    entityType: 'basket',
    detail: `${crop.name} added to ${cur.weekLabel || cur.week} basket`,
  });
  return listBaskets();
}

async function replaceBasketItems(basketId, items, staff) {
  const db = getDB();
  const basket = await db.collection('baskets').findOne({ id: basketId });
  if (!basket) throw new ApiError(404, 'BASKET_NOT_FOUND', 'Basket not found');
  assertComposable(basket, staff);
  if (!Array.isArray(items)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'items must be an array', [{ field: 'items', message: 'Required' }]);
  }
  const crops = await cropMap();
  const nextItems = [];
  for (const item of items) {
    const crop = crops[item.cropKey];
    if (!crop) throw new ApiError(404, 'CROP_NOT_FOUND', `Crop not found: ${item.cropKey}`);
    const qty = Number(item.qty);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'qty must be a positive number', [{ field: 'qty', message: 'Must be > 0' }]);
    }
    nextItems.push({ cropKey: item.cropKey, qty, supp: Boolean(item.supp), unit: crop.unit });
  }
  await db.collection('baskets').updateOne({ id: basketId }, { $set: { items: nextItems, updatedAt: new Date() } });
  return listBaskets();
}

async function duplicateBasket(staff) {
  const db = getDB();
  const rows = await db.collection('baskets').find({}).sort({ weekStart: -1, createdAt: -1 }).toArray();
  const prev = rows[0];
  if (!prev) throw new ApiError(404, 'BASKET_NOT_FOUND', 'No basket to duplicate');
  const seq = await nextSeq('basketWeek', 35);
  const weekStart = prev.weekStart ? isoDate(addDays(new Date(prev.weekStart), 7)) : isoDate(new Date());
  const nb = {
    id: `wk${seq}`,
    weekLabel: `Week ${seq} · ${formatDisplayDate(weekStart).replace(/ \d{4}$/, '')}`,
    weekStart,
    status: 'draft',
    items: (prev.items || []).map((x) => ({ ...x, supp: false })),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await db.collection('baskets').insertOne(nb);
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Basket duplicated',
    entity: nb.id,
    entityType: 'basket',
    detail: `New draft from ${prev.weekLabel || prev.week}`,
  });
  return listBaskets();
}

async function publishedBasket() {
  const db = getDB();
  const row =
    (await db.collection('baskets').findOne({ status: { $in: ['published', 'packed'] } }, { sort: { weekStart: -1 } })) ||
    (await currentBasket());
  if (!row) return null;
  const crops = await cropMap();
  return toBasketDto(row, crops);
}

module.exports = {
  listBaskets,
  currentBasket,
  advanceBasket,
  addBasketItem,
  replaceBasketItems,
  duplicateBasket,
  publishedBasket,
};
