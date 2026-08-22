const { nanoid } = require('nanoid');
const { getDB } = require('../config/db');
const { timeAgo } = require('./dates');

async function writeAudit({
  actorId,
  actorName,
  action,
  entity,
  entityType,
  detail = '',
  meta = {},
}) {
  const db = getDB();
  const now = new Date();
  const row = {
    id: `aud_${nanoid(10)}`,
    createdAt: now,
    actorId: actorId || 'system',
    actorName: actorName || 'System',
    action,
    entity: entity || '',
    entityType: entityType || 'staff',
    detail: detail || '',
    meta: meta || {},
  };
  await db.collection('audit_log').insertOne(row);
  return row;
}

function toAuditDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    timeLabel: timeAgo(row.createdAt),
    actorId: row.actorId,
    actorName: row.actorName,
    action: row.action,
    entity: row.entity,
    entityType: row.entityType,
    detail: row.detail || '',
    meta: row.meta || {},
  };
}

module.exports = { writeAudit, toAuditDto };
