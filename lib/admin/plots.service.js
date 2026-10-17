const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDB } = require('../../config/db');
const { ApiError } = require('../errors');
const { parsePagination, paginationMeta, slicePage } = require('../pagination');
const { writeAudit } = require('../audit');
const { insertMemberNotification, notifyMany } = require('./notify');
const { toPlotAdminDto, farmFromPlotKey, memberPublicId } = require('./dto');
const { FARMS_SEED } = require('./constants');

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads', 'plots');
const OPS_STATUSES = ['available', 'reserved', 'leased', 'cultivating', 'harvesting', 'maintenance', 'unavailable'];
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_GALLERY = 12;
const {
  requireMemberByAnyId,
  loadPlot,
  latestSubscription,
  loadCultivation,
  loadCrop,
} = require('./lookups');
const { createLeasePaymentRequest } = require('../payments');

function opsGroup(ops) {
  if (!ops || ops === 'available') return 'available';
  if (ops === 'reserved') return 'reserved';
  if (['cultivating', 'harvesting', 'leased'].includes(ops)) return 'cultivating';
  if (['maintenance', 'unavailable'].includes(ops)) return 'maintenance';
  return 'other';
}

function clean(value, max = 120) {
  return String(value ?? '').trim().slice(0, max);
}

function slugify(value) {
  return clean(value, 80)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function intField(value, fallback) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;
  return Math.trunc(n);
}

function catalogStatus(ops) {
  if (ops === 'unavailable' || ops === 'maintenance') return 'soon';
  if (ops === 'available') return 'available';
  return 'booked';
}

function plotFarmId(plot) {
  return plot.farmId || farmFromPlotKey(plot.key)?.id || null;
}

async function ensureFarms() {
  const db = getDB();
  const now = new Date();
  for (const farm of FARMS_SEED) {
    await db.collection('farms').updateOne(
      { id: farm.id },
      { $setOnInsert: { ...farm, createdAt: now, updatedAt: now } },
      { upsert: true }
    );
  }
}

async function resolveFarm(plot, cache) {
  const seeded = farmFromPlotKey(plot.key);
  const id = plot.farmId || seeded?.id || null;
  if (!id) return seeded;
  if (cache?.has(id)) return cache.get(id);
  const row = await getDB().collection('farms').findOne({ id });
  const resolved = row
    ? { id: row.id, name: row.name, region: row.region, farmer: row.farmer }
    : seeded || { id, name: id, region: plot.region || '', farmer: plot.farmerName || '' };
  if (cache) cache.set(id, resolved);
  return resolved;
}

function saveDataUrl(dataUrl, plotKey) {
  const match = /^data:image\/(jpeg|jpg|png|webp|gif);base64,([a-z0-9+/=\s]+)$/i.exec(String(dataUrl || ''));
  if (!match) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Upload a JPEG, PNG, WEBP, or GIF image', [
      { field: 'dataUrl', message: 'Image file required' },
    ]);
  }
  const ext = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
  const buf = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!buf.length || buf.length > MAX_IMAGE_BYTES) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Image must be under 4 MB', [
      { field: 'dataUrl', message: 'Must be under 4 MB' },
    ]);
  }
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const filename = `${slugify(plotKey) || 'plot'}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), buf);
  return `/uploads/plots/${filename}`;
}

function localUploadPath(imageUrl) {
  if (!imageUrl) return null;
  let pathname = String(imageUrl);
  try {
    if (/^https?:\/\//i.test(pathname)) pathname = new URL(pathname).pathname;
  } catch {
    return null;
  }
  if (!pathname.startsWith('/uploads/plots/')) return null;
  const base = path.basename(pathname);
  if (!base || base !== pathname.slice(pathname.lastIndexOf('/') + 1)) return null;
  const full = path.join(UPLOAD_DIR, base);
  if (!full.startsWith(UPLOAD_DIR)) return null;
  return full;
}

function imageIdentity(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw, 'http://local.invalid');
    if (parsed.pathname.includes('/uploads/plots/')) return parsed.pathname;
  } catch {
    /* keep the raw value */
  }
  return raw.split('?')[0];
}

function sameImage(a, b) {
  const left = imageIdentity(a);
  const right = imageIdentity(b);
  return Boolean(left) && left === right;
}

function unlinkUpload(imageUrl) {
  const full = localUploadPath(imageUrl);
  if (!full) return;
  fs.rm(full, { force: true }, () => {});
}

async function overlayForPlot(plot, farmCache) {
  const db = getDB();
  const cultivation = await loadCultivation(plot.key);
  const crop = cultivation?.cropKey ? await loadCrop(cultivation.cropKey) : null;
  const lease = await db.collection('subscriptions').findOne(
    { plotKey: plot.key, status: { $in: ['active', 'past_due', 'paused', 'pending_activation', 'payment_pending'] } },
    { sort: { createdAt: -1 } }
  );
  let member = null;
  if (lease) member = await db.collection('members').findOne({ id: lease.memberId, deletedAt: null });
  const notifyRequestCount = await db.collection('plot_notifications').countDocuments({ plotKey: plot.key });
  let opsStatus = plot.opsStatus || cultivation?.opsStatus;
  if (!opsStatus) {
    if (cultivation && ['ready', 'harvested'].includes(cultivation.cropStage)) opsStatus = 'harvesting';
    else if (lease && ['pending_activation', 'payment_pending'].includes(lease.status)) opsStatus = 'reserved';
    else if (lease) opsStatus = cultivation ? 'cultivating' : 'leased';
    else if (plot.status === 'soon') opsStatus = 'unavailable';
    else opsStatus = 'available';
  }
  return {
    cultivation,
    cropName: crop?.name || null,
    unit: crop?.unit || cultivation?.unit || 'kg',
    opsStatus,
    memberId: member?.id || null,
    memberCode: member ? memberPublicId(member) : null,
    memberName: member?.name || null,
    planKey: lease?.planKey || null,
    notifyRequestCount,
    farm: await resolveFarm(plot, farmCache),
    lease,
  };
}

async function listFarms() {
  const db = getDB();
  await ensureFarms();
  const farms = await db.collection('farms').find({}).sort({ name: 1 }).toArray();
  const plots = await db.collection('plots').find({}).toArray();
  return farms.map((f) => {
    const mine = plots.filter((p) => plotFarmId(p) === f.id);
    const leasedCount = mine.filter((p) => (p.availableUnits || 0) < (p.totalUnits || 0)).length;
    return {
      id: f.id,
      name: f.name,
      region: f.region,
      farmer: f.farmer,
      plotCount: mine.length,
      leasedCount,
    };
  });
}

async function listPlots(query = {}) {
  await ensureFarms();
  const db = getDB();
  const { page, limit } = parsePagination(query);
  const filter = String(query.filter || 'all');
  const farmId = query.farmId && query.farmId !== 'all' ? String(query.farmId) : null;
  const q = String(query.q || '').trim().toLowerCase();
  const plots = await db.collection('plots').find({}).toArray();
  const dtos = [];
  const farmCache = new Map();
  for (const plot of plots) {
    const overlay = await overlayForPlot(plot, farmCache);
    dtos.push(toPlotAdminDto(plot, overlay));
  }
  const counts = {
    all: dtos.length,
    available: dtos.filter((p) => opsGroup(p.opsStatus) === 'available').length,
    cultivating: dtos.filter((p) => opsGroup(p.opsStatus) === 'cultivating').length,
    reserved: dtos.filter((p) => p.opsStatus === 'reserved').length,
    maintenance: dtos.filter((p) => opsGroup(p.opsStatus) === 'maintenance').length,
  };
  let rows = dtos;
  if (filter !== 'all') rows = dtos.filter((p) => opsGroup(p.opsStatus) === filter || p.opsStatus === filter);
  if (farmId) rows = rows.filter((p) => p.farmId === farmId);
  if (q) {
    rows = rows.filter((p) =>
      [p.name, p.region, p.crop, p.cropName, p.city, p.district, p.memberName]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(q)
    );
  }
  return {
    data: slicePage(rows, page, limit),
    pagination: paginationMeta(page, limit, rows.length),
    meta: { counts },
  };
}

async function getPlot(plotKey) {
  const plot = await loadPlot(plotKey);
  if (!plot) throw new ApiError(404, 'PLOT_NOT_FOUND', 'Plot not found');
  const db = getDB();
  const overlay = await overlayForPlot(plot);
  const leases = await db.collection('subscriptions').find({ plotKey: plot.key }).sort({ createdAt: -1 }).toArray();
  const leaseDtos = [];
  for (const s of leases) {
    const m = await db.collection('members').findOne({ id: s.memberId });
    leaseDtos.push({
      id: s.id,
      memberId: s.memberId,
      memberCode: m ? memberPublicId(m) : null,
      memberName: m?.name || null,
      planKey: s.planKey,
      status: s.status,
      cycleStart: s.cycleStart,
      cycleEnd: s.cycleEnd,
    });
  }
  const notifyMeRaw = await db.collection('plot_notifications').find({ plotKey: plot.key }).toArray();
  const notifyMe = [];
  for (const n of notifyMeRaw) {
    const m = n.memberId ? await db.collection('members').findOne({ id: n.memberId }) : null;
    notifyMe.push({
      memberId: n.memberId,
      memberCode: m ? memberPublicId(m) : null,
      memberName: m?.name || n.email || null,
      email: n.email || m?.email,
    });
  }
  return { ...toPlotAdminDto(plot, overlay), leases: leaseDtos, notifyMe };
}

async function assignPlot(plotKey, memberId, staff) {
  const plot = await loadPlot(plotKey);
  if (!plot) throw new ApiError(404, 'PLOT_NOT_FOUND', 'Plot not found');
  const member = await requireMemberByAnyId(memberId);
  if (member.accountStatus === 'cancelled') {
    throw new ApiError(409, 'INVALID_STATUS', 'Cancelled members cannot be assigned a plot');
  }
  const db = getDB();
  const existing = await db.collection('subscriptions').findOne({
    memberId: member.id,
    plotKey: plot.key,
    status: { $in: ['active', 'past_due'] },
  });
  if (existing) throw new ApiError(409, 'DUPLICATE_LEASE', 'Member already has a live lease on this plot');
  if (member.hasPlot) {
    const live = await latestSubscription(member.id);
    if (live && ['active', 'past_due'].includes(live.status)) {
      throw new ApiError(409, 'DUPLICATE_LEASE', 'Member already has a live lease');
    }
  }
  const units = plot.availableUnits ?? 0;
  if (plot.status !== 'available' && units <= 0) {
    throw new ApiError(409, 'PLOT_NOT_AVAILABLE', 'No units available on this plot');
  }
  if (units <= 0) throw new ApiError(409, 'PLOT_NOT_AVAILABLE', 'No units available on this plot');

  const pendingLease = await db.collection('payments').findOne({
    memberId: member.id,
    context: 'lease',
    status: 'pending',
    'metadata.plotKey': plot.key,
  });

  let opsStatus = 'leased';
  if (!pendingLease) {
    const planKey = member.planKey || 'family4';
    await createLeasePaymentRequest({
      memberId: member.id,
      plotKey: plot.key,
      planKey,
      member,
    });
    opsStatus = 'reserved';
  } else {
    opsStatus = 'reserved';
  }

  await db.collection('members').updateOne(
    { id: member.id },
    { $set: { plotKey: plot.key, hasPlot: true, updatedAt: new Date() } }
  );
  await db.collection('plots').updateOne(
    { key: plot.key },
    { $set: { opsStatus, updatedAt: new Date() } }
  );

  await insertMemberNotification({
    memberId: member.id,
    icon: 'pin',
    title: 'Plot assigned',
    body: `Your plot ${plot.name} is ready.`,
    deepLinkTab: 'my-plot',
    deepLinkPath: '/app/my-plot',
  });
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Plot assigned',
    entity: plot.key,
    entityType: 'plot',
    detail: `${member.name} · ${plot.name}`,
    meta: { memberId: member.id },
  });
  return getPlot(plot.key);
}

async function unassignPlot(plotKey, staff) {
  const plot = await loadPlot(plotKey);
  if (!plot) throw new ApiError(404, 'PLOT_NOT_FOUND', 'Plot not found');
  const overlay = await overlayForPlot(plot);
  if (!overlay.memberId) throw new ApiError(409, 'INVALID_STATUS', 'Plot has no assigned member');
  const { releasePlotForMember } = require('./members.service');
  const member = await requireMemberByAnyId(overlay.memberId);
  await releasePlotForMember(member, { keepAccountActive: true });
  const db = getDB();
  await db.collection('plots').updateOne(
    { key: plot.key },
    { $set: { opsStatus: 'available', updatedAt: new Date() } }
  );
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Plot unassigned',
    entity: plot.key,
    entityType: 'plot',
    detail: plot.name,
    meta: { memberId: member.id },
  });
  return getPlot(plot.key);
}

async function patchPlot(plotKey, body, staff) {
  const plot = await loadPlot(plotKey);
  if (!plot) throw new ApiError(404, 'PLOT_NOT_FOUND', 'Plot not found');
  const db = getDB();
  const allowed = ['status', 'availableUnits', 'totalUnits', 'imageUrl', 'gallery', 'crop', 'opsStatus'];
  const textFields = ['name', 'size', 'region', 'city', 'district', 'state', 'soil', 'cropCycle'];
  const $set = { updatedAt: new Date() };
  for (const key of allowed) {
    if (body[key] !== undefined) $set[key] = body[key];
  }
  for (const key of textFields) {
    if (body[key] !== undefined) $set[key] = clean(body[key], key === 'name' ? 80 : 120);
  }
  if ($set.name === '') {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Plot name is required', [
      { field: 'name', message: 'Required' },
    ]);
  }
  if (body.opsStatus !== undefined) {
    const ops = clean(body.opsStatus, 40);
    if (!OPS_STATUSES.includes(ops)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown plot status', [
        { field: 'opsStatus', message: 'Unsupported status' },
      ]);
    }
    $set.opsStatus = ops;
    if (ops === 'available') $set.status = 'available';
    if (ops === 'unavailable' || ops === 'maintenance') $set.status = 'soon';
  }
  if (body.farmId !== undefined) {
    const farmId = clean(body.farmId, 40);
    const farm = farmId ? await db.collection('farms').findOne({ id: farmId }) : null;
    if (!farm) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Farm not found', [
        { field: 'farmId', message: 'Choose a farm' },
      ]);
    }
    $set.farmId = farm.id;
    $set.farmerName = farm.farmer;
  }
  if ($set.availableUnits != null) {
    const units = Number($set.availableUnits);
    if (!Number.isFinite(units) || units < 0) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'availableUnits must be >= 0', [
        { field: 'availableUnits', message: 'Must be >= 0' },
      ]);
    }
    $set.availableUnits = units;
    if (units === 0 && $set.status !== 'soon' && plot.status !== 'soon') $set.status = 'booked';
    if (units > 0 && (plot.status === 'booked' || $set.status === 'booked')) $set.status = 'available';
  }
  if ($set.totalUnits != null) {
    const total = Number($set.totalUnits);
    if (!Number.isFinite(total) || total < 0) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'totalUnits must be >= 0', [
        { field: 'totalUnits', message: 'Must be >= 0' },
      ]);
    }
    $set.totalUnits = total;
  }
  const nextTotal = $set.totalUnits != null ? $set.totalUnits : plot.totalUnits ?? 0;
  const nextAvail = $set.availableUnits != null ? $set.availableUnits : plot.availableUnits ?? 0;
  if (nextAvail > nextTotal) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Available units cannot exceed total units', [
      { field: 'availableUnits', message: 'Cannot exceed total units' },
    ]);
  }
  await db.collection('plots').updateOne({ key: plot.key }, { $set });
  const becameAvailable =
    ($set.status === 'available' || ($set.availableUnits != null && $set.availableUnits > 0)) &&
    plot.status !== 'available';
  if (becameAvailable) {
    await notifyPlotOpen(plot.key, staff, { skipAudit: true });
  }
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Plot updated',
    entity: plot.key,
    entityType: 'plot',
    detail: plot.name,
  });
  return getPlot(plot.key);
}

async function notifyPlotOpen(plotKey, staff, { skipAudit } = {}) {
  const plot = await loadPlot(plotKey);
  if (!plot) throw new ApiError(404, 'PLOT_NOT_FOUND', 'Plot not found');
  const db = getDB();
  const rows = await db.collection('plot_notifications').find({ plotKey: plot.key }).toArray();
  const memberIds = rows.map((r) => r.memberId).filter(Boolean);
  await notifyMany(memberIds, {
    icon: 'pin',
    title: 'Plot available',
    body: `${plot.name} is now open.`,
    deepLinkTab: 'plots',
    deepLinkPath: '/app/plots',
  });
  await db.collection('plot_notifications').deleteMany({ plotKey: plot.key });
  if (!skipAudit) {
    await writeAudit({
      actorId: staff.id,
      actorName: staff.name,
      action: 'Plot notified open',
      entity: plot.key,
      entityType: 'plot',
      detail: `${plot.name} · ${memberIds.length} subscribers`,
    });
  }
  return { notified: memberIds.length };
}

async function createFarm(body, staff) {
  await ensureFarms();
  const name = clean(body?.name, 80);
  const region = clean(body?.region, 120);
  const farmer = clean(body?.farmer, 80);
  const details = [];
  if (!name) details.push({ field: 'name', message: 'Required' });
  if (!region) details.push({ field: 'region', message: 'Required' });
  if (!farmer) details.push({ field: 'farmer', message: 'Required' });
  if (details.length) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid farm', details);
  const db = getDB();
  const base = slugify(name).slice(0, 16) || 'farm';
  let id = base;
  let n = 2;
  while (await db.collection('farms').findOne({ id })) id = `${base}-${n++}`;
  const now = new Date();
  await db.collection('farms').insertOne({
    id,
    name,
    region,
    farmer,
    prefixes: [],
    createdAt: now,
    updatedAt: now,
  });
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Farm created',
    entity: id,
    entityType: 'farm',
    detail: name,
  });
  const farms = await listFarms();
  return farms.find((f) => f.id === id);
}

async function updateFarm(farmId, body, staff) {
  await ensureFarms();
  const db = getDB();
  const farm = await db.collection('farms').findOne({ id: farmId });
  if (!farm) throw new ApiError(404, 'FARM_NOT_FOUND', 'Farm not found');
  const $set = { updatedAt: new Date() };
  if (body.name !== undefined) $set.name = clean(body.name, 80);
  if (body.region !== undefined) $set.region = clean(body.region, 120);
  if (body.farmer !== undefined) $set.farmer = clean(body.farmer, 80);
  const details = [];
  if (!$set.name && body.name !== undefined) details.push({ field: 'name', message: 'Required' });
  if (!$set.region && body.region !== undefined) details.push({ field: 'region', message: 'Required' });
  if (!$set.farmer && body.farmer !== undefined) details.push({ field: 'farmer', message: 'Required' });
  if (details.length) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid farm', details);
  await db.collection('farms').updateOne({ id: farm.id }, { $set });
  if ($set.farmer) {
    await db.collection('plots').updateMany({ farmId: farm.id }, { $set: { farmerName: $set.farmer, updatedAt: new Date() } });
  }
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Farm updated',
    entity: farm.id,
    entityType: 'farm',
    detail: $set.name || farm.name,
  });
  const farms = await listFarms();
  return farms.find((f) => f.id === farm.id);
}

async function deleteFarm(farmId, staff) {
  await ensureFarms();
  const db = getDB();
  const farm = await db.collection('farms').findOne({ id: farmId });
  if (!farm) throw new ApiError(404, 'FARM_NOT_FOUND', 'Farm not found');
  const plots = await db.collection('plots').find({}).toArray();
  if (plots.some((p) => plotFarmId(p) === farm.id)) {
    throw new ApiError(409, 'FARM_IN_USE', 'Move or delete this farm’s plots before deleting the farm');
  }
  await db.collection('farms').deleteOne({ id: farm.id });
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Farm deleted',
    entity: farm.id,
    entityType: 'farm',
    detail: farm.name,
  });
  return { id: farm.id, deleted: true };
}

async function createPlot(body, staff) {
  await ensureFarms();
  const name = clean(body?.name, 80);
  const farmId = clean(body?.farmId, 40);
  const details = [];
  if (!name) details.push({ field: 'name', message: 'Required' });
  if (!farmId) details.push({ field: 'farmId', message: 'Choose a farm' });
  const db = getDB();
  const farm = farmId ? await db.collection('farms').findOne({ id: farmId }) : null;
  if (farmId && !farm) details.push({ field: 'farmId', message: 'Farm not found' });
  const totalUnits = intField(body?.totalUnits, 1);
  const availableUnits = body?.availableUnits == null || body.availableUnits === '' ? totalUnits : intField(body.availableUnits, 0);
  if (!Number.isFinite(totalUnits) || totalUnits < 0) {
    details.push({ field: 'totalUnits', message: 'Must be 0 or more' });
  }
  if (!Number.isFinite(availableUnits) || availableUnits < 0 || availableUnits > totalUnits) {
    details.push({ field: 'availableUnits', message: 'Must be between 0 and total units' });
  }
  const opsStatus = OPS_STATUSES.includes(clean(body?.opsStatus || body?.status, 40))
    ? clean(body?.opsStatus || body?.status, 40)
    : 'available';
  if (details.length) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid plot', details);
  const base = slugify(body?.key || name) || 'plot';
  let key = base;
  let n = 2;
  while (await db.collection('plots').findOne({ key })) key = `${base.slice(0, 40)}-${n++}`;
  const now = new Date();
  await db.collection('plots').insertOne({
    key,
    name,
    status: catalogStatus(opsStatus),
    opsStatus,
    size: clean(body?.size, 40) || '600 sq ft',
    state: clean(body?.state, 80),
    district: clean(body?.district, 80),
    city: clean(body?.city, 80),
    region: clean(body?.region, 120) || farm.region,
    crop: clean(body?.crop, 80),
    cropCycle: clean(body?.cropCycle, 80) || 'Seasonal · year-round beds',
    soil: clean(body?.soil, 120) || 'Red loam · organic certified',
    totalUnits,
    availableUnits,
    imageUrl: null,
    gallery: [],
    farmId: farm.id,
    farmerName: farm.farmer,
    map: null,
    createdAt: now,
    updatedAt: now,
  });
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Plot created',
    entity: key,
    entityType: 'plot',
    detail: name,
  });
  return getPlot(key);
}

async function deletePlot(plotKey, staff) {
  const plot = await loadPlot(plotKey);
  if (!plot) throw new ApiError(404, 'PLOT_NOT_FOUND', 'Plot not found');
  const db = getDB();
  const live = await db.collection('subscriptions').findOne({
    plotKey: plot.key,
    status: { $in: ['active', 'past_due', 'paused', 'pending_activation', 'payment_pending'] },
  });
  if (live) {
    throw new ApiError(409, 'PLOT_IN_USE', 'Unassign the member before deleting this plot');
  }
  const images = [plot.imageUrl, ...(plot.gallery || []).map((g) => g.imageUrl || g.img)].filter(Boolean);
  await db.collection('plots').deleteOne({ key: plot.key });
  await db.collection('cultivations').deleteMany({ plotKey: plot.key });
  await db.collection('plot_notifications').deleteMany({ plotKey: plot.key });
  for (const imageUrl of images) {
    const stillUsed = await db.collection('plots').findOne({
      $or: [{ imageUrl }, { 'gallery.imageUrl': imageUrl }],
    });
    if (!stillUsed) unlinkUpload(imageUrl);
  }
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Plot deleted',
    entity: plot.key,
    entityType: 'plot',
    detail: plot.name,
  });
  return { key: plot.key, deleted: true };
}

async function addPlotImage(plotKey, body, staff) {
  const plot = await loadPlot(plotKey);
  if (!plot) throw new ApiError(404, 'PLOT_NOT_FOUND', 'Plot not found');
  const gallery = Array.isArray(plot.gallery) ? plot.gallery.slice() : [];
  if (gallery.length >= MAX_GALLERY) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'A plot can have up to 12 images', [
      { field: 'gallery', message: 'Limit is 12 images' },
    ]);
  }
  const label = clean(body?.label, 40) || 'photo';
  let imageUrl = '';
  if (body?.dataUrl) imageUrl = saveDataUrl(body.dataUrl, plot.key);
  else if (body?.imageUrl) {
    const raw = clean(body.imageUrl, 2000);
    if (!/^https?:\/\//i.test(raw) && !raw.startsWith('/uploads/plots/')) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Image URL must be http(s) or an uploaded file', [
        { field: 'imageUrl', message: 'Invalid image URL' },
      ]);
    }
    imageUrl = raw;
  } else {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Choose an image to upload', [
      { field: 'dataUrl', message: 'Required' },
    ]);
  }
  gallery.push({ label, imageUrl });
  const setCover = body?.setCover === true || !plot.imageUrl;
  const db = getDB();
  await db.collection('plots').updateOne(
    { key: plot.key },
    { $set: { gallery, ...(setCover ? { imageUrl } : {}), updatedAt: new Date() } }
  );
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Plot image added',
    entity: plot.key,
    entityType: 'plot',
    detail: `${plot.name} · ${label}`,
  });
  return getPlot(plot.key);
}

async function removePlotImage(plotKey, imageUrl, staff) {
  const plot = await loadPlot(plotKey);
  if (!plot) throw new ApiError(404, 'PLOT_NOT_FOUND', 'Plot not found');
  const target = clean(imageUrl, 2000);
  if (!target) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Image is required', [
      { field: 'imageUrl', message: 'Required' },
    ]);
  }
  const before = (plot.gallery || []).length + (plot.imageUrl ? 1 : 0);
  const gallery = (plot.gallery || []).filter((g) => !sameImage(g.imageUrl || g.img, target));
  const $set = { gallery, updatedAt: new Date() };
  if (sameImage(plot.imageUrl, target)) {
    $set.imageUrl = gallery[0]?.imageUrl || gallery[0]?.img || null;
  }
  const after = gallery.length + ($set.imageUrl ? 1 : 0);
  if (after === before && !sameImage(plot.imageUrl, target)) {
    throw new ApiError(404, 'IMAGE_NOT_FOUND', 'That photo is no longer on this plot');
  }
  const db = getDB();
  await db.collection('plots').updateOne({ key: plot.key }, { $set });
  const stillUsed = await db.collection('plots').findOne({
    $or: [{ imageUrl: target }, { 'gallery.imageUrl': target }],
  });
  if (!stillUsed) unlinkUpload(target);
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Plot image removed',
    entity: plot.key,
    entityType: 'plot',
    detail: plot.name,
  });
  return getPlot(plot.key);
}

module.exports = {
  listFarms,
  listPlots,
  getPlot,
  assignPlot,
  unassignPlot,
  patchPlot,
  notifyPlotOpen,
  overlayForPlot,
  createFarm,
  updateFarm,
  deleteFarm,
  createPlot,
  deletePlot,
  addPlotImage,
  removePlotImage,
};
