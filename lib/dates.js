function isoDate(input = new Date()) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function addDays(input, days) {
  const d = input instanceof Date ? new Date(input.getTime()) : new Date(input);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function utcToday() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function parseIsoDate(value) {
  if (!value) return null;
  const s = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isSaturdayUtc(dateStr) {
  const d = parseIsoDate(dateStr);
  if (!d) return false;
  return d.getUTCDay() === 6;
}

function formatDisplayDate(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return String(input || '');
  return d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

function formatJoinedLabel(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return String(input || '');
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function monthLabel(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return String(input || '');
  return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function timeAgo(input) {
  if (!input) return '';
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  const diffMs = Date.now() - d.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return '1 day ago';
  if (days < 14) return `${days} days ago`;
  return formatJoinedLabel(d);
}

function defaultDueDate(from = utcToday()) {
  return isoDate(addDays(from, 7));
}

function daysUntil(dateStr) {
  const target = parseIsoDate(dateStr);
  if (!target) return null;
  const today = utcToday();
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

function inRange(dateStr, from, to) {
  if (!dateStr) return false;
  const d = String(dateStr).slice(0, 10);
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

module.exports = {
  isoDate,
  addDays,
  utcToday,
  parseIsoDate,
  isSaturdayUtc,
  formatDisplayDate,
  formatJoinedLabel,
  monthLabel,
  timeAgo,
  defaultDueDate,
  daysUntil,
  inRange,
};
