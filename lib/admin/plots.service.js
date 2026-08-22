const { getDB } = require('../../config/db');
const { ApiError } = require('../errors');
const { parsePagination, paginationMeta, slicePage } = require('../pagination');
const { writeAudit } = require('../audit');
const { insertMemberNotification, notifyMany } = require('./notify');
const { toPlotAdminDto, farmFromPlotKey, memberPublicId } = require('./dto');
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

async function overlayForPlot(plot) {
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
    farm: farmFromPlotKey(plot.key),
    lease,
  };
}

async function listFarms() {
  const db = getDB();
  let farms = await db.collection('farms').find({}).toArray();
  if (!farms.length) {
    const { FARMS_SEED } = require('./constants');
    farms = FARMS_SEED.map(({ prefixes, ...rest }) => rest);
  }
  const plots = await db.collection('plots').find({}).toArray();
  return farms.map((f) => {
    const mine = plots.filter((p) => farmFromPlotKey(p.key)?.id === f.id);
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
  const db = getDB();
  const { page, limit } = parsePagination(query);
  const filter = String(query.filter || 'all');
  const farmId = query.farmId && query.farmId !== 'all' ? String(query.farmId) : null;
  const q = String(query.q || '').trim().toLowerCase();
  const plots = await db.collection('plots').find({}).toArray();
  const dtos = [];
  for (const plot of plots) {
    const overlay = await overlayForPlot(plot);
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
  const allowed = ['status', 'availableUnits', 'totalUnits', 'imageUrl', 'gallery', 'crop', 'opsStatus'];
  const $set = { updatedAt: new Date() };
  for (const key of allowed) {
    if (body[key] !== undefined) $set[key] = body[key];
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
  const db = getDB();
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

module.exports = {
  listFarms,
  listPlots,
  getPlot,
  assignPlot,
  unassignPlot,
  patchPlot,
  notifyPlotOpen,
  overlayForPlot,
};
