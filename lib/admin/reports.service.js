const { getDB } = require('../../config/db');
const { isoDate, utcToday, addDays, inRange } = require('../dates');
const { formatInr } = require('../money');
const { parsePagination, paginationMeta, slicePage } = require('../pagination');
const { toAuditDto } = require('../audit');
const { toStaffDto } = require('./dto');
const { paymentOpsStatus } = require('./dto');
const { hydrateMember } = require('./members.service');
const { toPlan } = require('../serializers');
const { ApiError } = require('../errors');
const fs = require('fs');
const path = require('path');

function rangeBounds(range) {
  const today = utcToday();
  const todayStr = isoDate(today);
  if (range === 'this_week') {
    const day = today.getUTCDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const from = isoDate(addDays(today, mondayOffset));
    return { from, to: todayStr, label: 'This week' };
  }
  if (range === 'this_year') {
    return { from: `${today.getUTCFullYear()}-01-01`, to: todayStr, label: 'This year' };
  }
  const from = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-01`;
  return { from, to: todayStr, label: 'This month' };
}

function sparkline(values, buckets = 6) {
  if (!values.length) return Array(buckets).fill(0);
  const max = Math.max(...values, 1);
  const size = Math.ceil(values.length / buckets);
  const out = [];
  for (let i = 0; i < buckets; i++) {
    const slice = values.slice(i * size, (i + 1) * size);
    const sum = slice.reduce((a, b) => a + b, 0);
    out.push(Math.round((sum / (max * Math.max(slice.length, 1))) * 100) || 0);
  }
  return out;
}

async function getReports(query = {}) {
  const range = ['this_week', 'this_month', 'this_year'].includes(query.range) ? query.range : 'this_month';
  const bounds = rangeBounds(range);
  const db = getDB();
  const payments = await db.collection('payments').find({}).toArray();
  const succeeded = payments.filter((p) => p.status === 'succeeded' && inRange(p.date, bounds.from, bounds.to));
  const revenue = succeeded.reduce((s, p) => s + (p.amountInr || 0), 0);
  const members = await db.collection('members').find({ deletedAt: null }).toArray();
  const newMembers = members.filter((m) => inRange(m.memberSince || isoDate(m.createdAt), bounds.from, bounds.to));
  const hydrated = [];
  for (const m of members) hydrated.push(await hydrateMember(m));
  const outstanding = payments.filter((p) => ['pending', 'overdue', 'failed'].includes(paymentOpsStatus(p))).length;
  const deliveries = await db.collection('deliveries').find({}).toArray();
  const delivered = deliveries.filter((d) => d.opsStatus === 'delivered' && inRange(d.date, bounds.from, bounds.to)).length;
  const failed = deliveries.filter((d) => d.opsStatus === 'failed' && inRange(d.date, bounds.from, bounds.to)).length;
  const plots = await db.collection('plots').find({}).toArray();
  const notAvailable = plots.filter((p) => p.status !== 'available').length;
  const percent = plots.length ? Math.round((notAvailable / plots.length) * 100) : 0;

  return {
    range,
    rangeLabel: bounds.label,
    revenue: {
      amountInr: revenue,
      amountFormatted: formatInr(revenue),
      series: sparkline(succeeded.map((p) => p.amountInr || 0)),
    },
    newMembers: { count: newMembers.length, series: sparkline(newMembers.map(() => 1)) },
    activeSubscriptions: {
      count: hydrated.filter((m) => m.subStatus === 'active').length,
      renewalsDue: hydrated.filter((m) => m.subStatus === 'renewal_due').length,
      series: [],
    },
    paymentsCollected: {
      count: succeeded.length,
      outstanding,
      series: sparkline(succeeded.map(() => 1)),
    },
    deliveries: { delivered, failed, series: sparkline([delivered, failed, 0, 0, 0, 0]) },
    plotUtilization: {
      percent,
      available: plots.filter((p) => p.status === 'available').length,
      series: [percent],
    },
  };
}

async function exportReportsCsv(query = {}) {
  const range = ['this_week', 'this_month', 'this_year'].includes(query.range) ? query.range : 'this_month';
  const bounds = rangeBounds(range);
  const db = getDB();
  const payments = await db.collection('payments').find({}).sort({ date: 1 }).toArray();
  const lines = ['date,category,ref,memberCode,amountInr,status'];
  for (const p of payments) {
    if (!inRange(p.date, bounds.from, bounds.to)) continue;
    const code = p.memberCode || '';
    lines.push(
      [p.date, p.context, p.ref, code, p.amountInr, p.status]
        .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`)
        .join(',')
    );
  }
  const filename = `chedi-report-${range}-${isoDate(new Date())}.csv`;
  return { csv: `${lines.join('\n')}\n`, filename };
}

async function listAudit(query = {}) {
  const db = getDB();
  const { page, limit } = parsePagination(query);
  const find = {};
  if (query.actorId) find.actorId = query.actorId;
  if (query.entityType) find.entityType = query.entityType;
  if (query.from || query.to) {
    find.createdAt = {};
    if (query.from) find.createdAt.$gte = new Date(`${query.from}T00:00:00.000Z`);
    if (query.to) find.createdAt.$lte = new Date(`${query.to}T23:59:59.999Z`);
  }
  const rows = await db.collection('audit_log').find(find).sort({ createdAt: -1 }).toArray();
  let dtos = rows.map(toAuditDto);
  const q = String(query.q || '').trim().toLowerCase();
  if (q) {
    dtos = dtos.filter((r) =>
      [r.action, r.actorName, r.entity, r.detail].filter(Boolean).join(' ').toLowerCase().includes(q)
    );
  }
  return {
    data: slicePage(dtos, page, limit),
    pagination: paginationMeta(page, limit, dtos.length),
  };
}

async function listStaff() {
  const db = getDB();
  const rows = await db.collection('staff').find({ active: { $ne: false } }).project({ passwordHash: 0 }).toArray();
  rows.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  return rows.map(toStaffDto);
}

async function getSettings() {
  const db = getDB();
  const row = await db.collection('app_settings').findOne({ id: 'app' });
  if (row) {
    const { _id, ...rest } = row;
    return rest;
  }
  const file = path.join(__dirname, '..', '..', 'data', 'app_settings.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const SETTINGS_WHITELIST = [
  'membershipFeeInr',
  'deliveryChargeInr',
  'welcomeBasketEtaDays',
  'billingNote',
  'paymentRequestNotice',
];

async function patchSettings(body) {
  const $set = { updatedAt: new Date() };
  for (const key of SETTINGS_WHITELIST) {
    if (body[key] !== undefined) $set[key] = body[key];
  }
  if ($set.membershipFeeInr != null) {
    $set.membershipFeeInr = Number($set.membershipFeeInr);
    $set.membershipFeeFormatted = formatInr($set.membershipFeeInr);
  }
  if ($set.deliveryChargeInr != null) {
    $set.deliveryChargeInr = Number($set.deliveryChargeInr);
    $set.deliveryChargeFormatted = formatInr($set.deliveryChargeInr);
  }
  const db = getDB();
  await db.collection('app_settings').updateOne({ id: 'app' }, { $set, $setOnInsert: { id: 'app' } }, { upsert: true });
  if ($set.membershipFeeInr != null) process.env.MEMBERSHIP_FEE_INR = String($set.membershipFeeInr);
  if ($set.deliveryChargeInr != null) process.env.DELIVERY_CHARGE_INR = String($set.deliveryChargeInr);
  return getSettings();
}

async function listPlans() {
  const db = getDB();
  const rows = await db.collection('plans').find({}).toArray();
  return rows.map(toPlan);
}

async function patchPlan(planKey, body) {
  const db = getDB();
  const plan = await db.collection('plans').findOne({ key: planKey });
  if (!plan) throw new ApiError(404, 'PLAN_NOT_FOUND', 'Plan not found');
  const $set = { updatedAt: new Date() };
  if (body.priceInr != null) {
    $set.priceInr = Number(body.priceInr);
    $set.priceFormatted = formatInr($set.priceInr);
    const delivery = Number(process.env.DELIVERY_CHARGE_INR || 10000);
    $set.totalInr = $set.priceInr + delivery;
    $set.totalFormatted = formatInr($set.totalInr);
  }
  if (body.features != null) $set.features = body.features;
  if (body.featured != null) $set.featured = Boolean(body.featured);
  await db.collection('plans').updateOne({ key: planKey }, { $set });
  const updated = await db.collection('plans').findOne({ key: planKey });
  return toPlan(updated);
}

module.exports = {
  getReports,
  exportReportsCsv,
  listAudit,
  listStaff,
  getSettings,
  patchSettings,
  listPlans,
  patchPlan,
};
