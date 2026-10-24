const { getDB } = require('../config/db');

const WINDOW_WEEKS = 4;
const CANCEL_LEAD_DAYS = 7;
const FULFILLED = new Set(['packed', 'ready_dispatch', 'out', 'delivered', 'failed', 'rescheduled']);
const OPS_RANK = {
  cancelled: -1,
  scheduled: 0,
  rescheduled: 1,
  packed: 2,
  ready_dispatch: 3,
  failed: 3,
  out: 4,
  delivered: 5,
};

function kolkataToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function parseIso(iso) {
  return new Date(`${String(iso).slice(0, 10)}T00:00:00.000Z`);
}

function isoAddDays(iso, days) {
  const d = parseIso(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysUntil(today, date) {
  return Math.round((parseIso(date) - parseIso(today)) / 86400000);
}

function upcomingSaturdays(today, count = WINDOW_WEEKS) {
  const day = parseIso(today).getUTCDay();
  const add = (6 - day + 7) % 7;
  const dates = [];
  for (let i = 0; i < count; i++) dates.push(isoAddDays(today, add + i * 7));
  return dates;
}

function dateLabel(iso) {
  return parseIso(iso).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

function windowLabel(index) {
  if (index === 0) return 'THIS WEEK';
  if (index === 1) return 'NEXT';
  return `WEEK ${index + 1}`;
}

function cancelStillOpen(delivery, today) {
  if (!delivery || delivery.cancelled) return false;
  if (FULFILLED.has(delivery.opsStatus)) return false;
  if (!delivery.date || delivery.date < today) return false;
  return daysUntil(today, delivery.date) >= CANCEL_LEAD_DAYS;
}

function lockPatch(delivery, today, label) {
  const cancelled = Boolean(delivery?.cancelled);
  const fulfilled = Boolean(delivery && FULFILLED.has(delivery.opsStatus));
  const open = cancelStillOpen({ ...delivery, date: delivery.date }, today);
  const locked = cancelled || fulfilled || !open;
  return {
    label,
    date: delivery.date,
    dateLabel: dateLabel(delivery.date),
    locked,
    cancellable: open,
    lockReason: cancelled || open ? null : 'Approved and locked one week before delivery',
    updatedAt: new Date(),
  };
}

function keepBetter(current, incoming) {
  if (!current) return incoming;
  const ra = OPS_RANK[current.opsStatus || 'scheduled'] ?? 0;
  const rb = OPS_RANK[incoming.opsStatus || 'scheduled'] ?? 0;
  if (rb !== ra) return rb > ra ? incoming : current;
  const ta = new Date(current.updatedAt || 0).getTime();
  const tb = new Date(incoming.updatedAt || 0).getTime();
  return tb >= ta ? incoming : current;
}

async function syncDeliveryWindow(memberId, subscriptionId, now = new Date()) {
  const db = getDB();
  const today = kolkataToday(now);
  const existing = await db.collection('deliveries').find({ subscriptionId }).toArray();
  const byDate = new Map();
  const vacated = new Set();
  for (const row of existing) {
    const date = row.date ? String(row.date).slice(0, 10) : '';
    if (date) byDate.set(date, keepBetter(byDate.get(date), row));
    const from = row.rescheduledFrom ? String(row.rescheduledFrom).slice(0, 10) : '';
    if (from && date >= today && from >= isoAddDays(today, -7)) vacated.add(from);
  }
  let maxIndex = existing.reduce((max, row) => Math.max(max, Number(row.weekIndex) || 0), -1);
  const window = [];
  const horizon = upcomingSaturdays(today, WINDOW_WEEKS + vacated.size + 4);

  for (const date of horizon) {
    if (window.length >= WINDOW_WEEKS) break;
    const label = windowLabel(window.length);
    const current = byDate.get(date);
    if (!current) {
      if (vacated.has(date)) continue;
      maxIndex += 1;
      const doc = {
        id: `del_${subscriptionId}_${maxIndex}`,
        memberId,
        subscriptionId,
        weekIndex: maxIndex,
        note: 'Planned',
        cancelled: false,
        opsStatus: 'scheduled',
        createdAt: now,
        ...lockPatch({ date, cancelled: false, opsStatus: 'scheduled' }, today, label),
      };
      await db.collection('deliveries').insertOne(doc);
      window.push(doc);
      continue;
    }
    const patch = lockPatch(current, today, label);
    await db.collection('deliveries').updateOne({ id: current.id }, { $set: patch });
    window.push({ ...current, ...patch });
  }

  return window;
}

module.exports = {
  WINDOW_WEEKS,
  CANCEL_LEAD_DAYS,
  kolkataToday,
  upcomingSaturdays,
  daysUntil,
  cancelStillOpen,
  syncDeliveryWindow,
};
