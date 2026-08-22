const { nanoid } = require('nanoid');
const { getDB } = require('../../config/db');

async function insertMemberNotification({
  memberId,
  icon,
  title,
  body,
  deepLinkTab = null,
  deepLinkPath = null,
}) {
  if (!memberId) return null;
  const db = getDB();
  const row = {
    id: `ntf_${nanoid(8)}`,
    memberId,
    icon: icon || 'bell',
    title,
    description: body || '',
    createdAt: new Date(),
    unread: true,
    deepLinkTab,
    deepLinkPath,
  };
  await db.collection('notifications').insertOne(row);
  try {
    const realtime = require('../realtime');
    realtime.notifyNotificationCreated(memberId, {
      id: row.id,
      icon: row.icon,
      title: row.title,
      description: row.description,
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
      unread: true,
      deepLinkTab: row.deepLinkTab,
      deepLinkPath: row.deepLinkPath,
    });
  } catch (err) {
    console.error('[realtime] notification emit failed:', err && err.message);
  }
  return row;
}

async function notifyMany(memberIds, payload) {
  const ids = [...new Set((memberIds || []).filter(Boolean))];
  for (const memberId of ids) {
    await insertMemberNotification({ ...payload, memberId });
  }
  return ids.length;
}

module.exports = { insertMemberNotification, notifyMany };
