const { getDB } = require('../../config/db');
const { ApiError } = require('../errors');
const { writeAudit } = require('../audit');
const { toCropDto } = require('./dto');
const { loadPlot, loadCrop, loadCultivation } = require('./lookups');
const { CROP_STAGES, CROP_STAGE_LABELS } = require('./constants');
const { insertMemberNotification } = require('./notify');

async function listCrops() {
  const db = getDB();
  const rows = await db.collection('crops').find({}).sort({ name: 1 }).toArray();
  return rows.map(toCropDto);
}

async function createCrop(body, staff) {
  const key = String(body?.key || '')
    .trim()
    .toLowerCase();
  const name = String(body?.name || '').trim();
  const season = body?.season || 'All';
  const unit = body?.unit || 'kg';
  const details = [];
  if (!/^[a-z0-9-]+$/.test(key)) details.push({ field: 'key', message: 'Slug must match [a-z0-9-]+' });
  if (!name) details.push({ field: 'name', message: 'Required' });
  if (!['Kharif', 'Rabi', 'All'].includes(season)) {
    details.push({ field: 'season', message: 'Must be Kharif, Rabi, or All' });
  }
  if (!['kg', 'bunch'].includes(unit)) details.push({ field: 'unit', message: 'Must be kg or bunch' });
  if (details.length) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid crop', details);
  const db = getDB();
  const existing = await db.collection('crops').findOne({ key });
  if (existing) throw new ApiError(409, 'CONFLICT', 'Crop key already exists');
  const crop = { key, name, season, unit, createdAt: new Date() };
  await db.collection('crops').insertOne(crop);
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Crop created',
    entity: key,
    entityType: 'crop',
    detail: name,
  });
  return toCropDto(crop);
}

function cultivationRow(plot, cultivation, crop) {
  const stage = cultivation.cropStage || 'planned';
  const i = CROP_STAGES.indexOf(stage);
  const actual = cultivation.actualYield;
  const target = cultivation.targetYield ?? (crop?.unit === 'kg' ? 12 : 10);
  const harvested = stage === 'harvested';
  return {
    plotKey: plot.key,
    plotName: plot.name,
    cropKey: cultivation.cropKey,
    cropName: crop?.name || cultivation.cropName || cultivation.cropKey,
    unit: crop?.unit || cultivation.unit || 'kg',
    plantDate: cultivation.plantDate || null,
    harvestDate: cultivation.harvestDate || null,
    cropStage: stage,
    targetYield: target,
    actualYield: actual ?? null,
    shortfall: harvested && actual != null && actual < target,
    canAdvance: i >= 0 && i < CROP_STAGES.length - 1,
    nextStage: i >= 0 && i < CROP_STAGES.length - 1 ? CROP_STAGES[i + 1] : null,
  };
}

async function listCultivations() {
  const db = getDB();
  const rows = await db.collection('cultivations').find({ cropKey: { $ne: null } }).toArray();
  const out = [];
  for (const c of rows) {
    const plot = await loadPlot(c.plotKey);
    if (!plot) continue;
    const crop = await loadCrop(c.cropKey);
    out.push(cultivationRow(plot, c, crop));
  }
  const shortfalls = out.filter((r) => r.shortfall);
  return { data: out, meta: { shortfalls } };
}

async function assignCrop(plotKey, body, staff) {
  const plot = await loadPlot(plotKey);
  if (!plot) throw new ApiError(404, 'PLOT_NOT_FOUND', 'Plot not found');
  const cropKey = body?.cropKey;
  const crop = await loadCrop(cropKey);
  if (!crop) throw new ApiError(404, 'CROP_NOT_FOUND', 'Crop not found');
  const stage = body.cropStage || 'planned';
  if (!CROP_STAGES.includes(stage)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid cropStage', [{ field: 'cropStage', message: 'Invalid stage' }]);
  }
  const targetYield = body.targetYield != null ? Number(body.targetYield) : crop.unit === 'kg' ? 12 : 10;
  const db = getDB();
  const doc = {
    plotKey: plot.key,
    cropKey: crop.key,
    cropName: crop.name,
    unit: crop.unit,
    plantDate: body.plantDate || null,
    harvestDate: body.harvestDate || null,
    cropStage: stage,
    targetYield,
    actualYield: null,
    updatedAt: new Date(),
  };
  await db.collection('cultivations').updateOne({ plotKey: plot.key }, { $set: doc, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Crop assigned',
    entity: plot.key,
    entityType: 'crop',
    detail: `${crop.name} on ${plot.name}`,
  });
  return cultivationRow(plot, doc, crop);
}

async function advanceStage(plotKey, staff) {
  const plot = await loadPlot(plotKey);
  if (!plot) throw new ApiError(404, 'PLOT_NOT_FOUND', 'Plot not found');
  const cultivation = await loadCultivation(plotKey);
  if (!cultivation) throw new ApiError(404, 'CROP_NOT_FOUND', 'No crop assigned to this plot');
  const i = CROP_STAGES.indexOf(cultivation.cropStage || 'planned');
  if (i < 0 || i >= CROP_STAGES.length - 1) {
    throw new ApiError(409, 'INVALID_STATUS', 'Cannot advance past harvested');
  }
  const next = CROP_STAGES[i + 1];
  const db = getDB();
  const $set = { cropStage: next, updatedAt: new Date() };
  if (next === 'ready' || next === 'harvested') {
    $set.opsStatus = 'harvesting';
    await db.collection('plots').updateOne({ key: plot.key }, { $set: { opsStatus: 'harvesting', updatedAt: new Date() } });
  }
  await db.collection('cultivations').updateOne({ plotKey: plot.key }, { $set });
  const crop = await loadCrop(cultivation.cropKey);
  const memberLease = await db.collection('subscriptions').findOne({
    plotKey: plot.key,
    status: { $in: ['active', 'past_due'] },
  });
  if (memberLease) {
    await insertMemberNotification({
      memberId: memberLease.memberId,
      icon: 'leaf',
      title: 'Crop / plot update',
      body: `There is a fresh update from your plot.`,
      deepLinkTab: 'my-plot',
      deepLinkPath: '/app/my-plot',
    });
  }
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Crop stage updated',
    entity: plot.key,
    entityType: 'crop',
    detail: `${crop?.name || cultivation.cropKey} → ${CROP_STAGE_LABELS[next]}`,
  });
  const updated = await loadCultivation(plot.key);
  return cultivationRow(plot, updated, crop);
}

async function patchYield(plotKey, body) {
  const plot = await loadPlot(plotKey);
  if (!plot) throw new ApiError(404, 'PLOT_NOT_FOUND', 'Plot not found');
  const cultivation = await loadCultivation(plotKey);
  if (!cultivation) throw new ApiError(404, 'CROP_NOT_FOUND', 'No crop assigned to this plot');
  const $set = { updatedAt: new Date() };
  if (body.actualYield != null) $set.actualYield = Number(body.actualYield);
  if (body.targetYield != null) $set.targetYield = Number(body.targetYield);
  const db = getDB();
  await db.collection('cultivations').updateOne({ plotKey: plot.key }, { $set });
  const updated = await loadCultivation(plot.key);
  const crop = await loadCrop(updated.cropKey);
  const row = cultivationRow(plot, updated, crop);
  return { ...row, meta: { shortfall: row.shortfall } };
}

module.exports = { listCrops, createCrop, listCultivations, assignCrop, advanceStage, patchYield };
