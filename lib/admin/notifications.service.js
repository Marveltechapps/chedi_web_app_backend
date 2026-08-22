const { nanoid } = require('nanoid');
const { getDB } = require('../../config/db');
const { ApiError } = require('../errors');
const { parsePagination, paginationMeta, slicePage } = require('../pagination');
const { writeAudit } = require('../audit');
const { insertMemberNotification } = require('./notify');
const { toSentDto } = require('./dto');
const { AUDIENCES, AUDIENCE_LABELS } = require('./constants');
const { paymentOpsStatus } = require('./dto');
const { hydrateMember } = require('./members.service');

async function listTemplates() {
  const db = getDB();
  return db
    .collection('notification_templates')
    .find({})
    .project({ _id: 0, key: 1, title: 1, body: 1 })
    .toArray();
}

async function listSent(query = {}) {
  const db = getDB();
  const { page, limit } = parsePagination(query);
  const rows = await db.collection('notifications_sent').find({}).sort({ createdAt: -1 }).toArray();
  const data = rows.map(toSentDto);
  return {
    data: slicePage(data, page, limit),
    pagination: paginationMeta(page, limit, data.length),
  };
}

async function resolveAudience(audience, memberId) {
  const db = getDB();
  if (audience === 'individual') {
    if (!memberId) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'memberId is required for individual audience', [
        { field: 'memberId', message: 'Required' },
      ]);
    }
    const member = await db.collection('members').findOne({
      deletedAt: null,
      $or: [{ id: memberId }, { memberCode: memberId }],
    });
    if (!member) throw new ApiError(404, 'MEMBER_NOT_FOUND', 'Member not found');
    return [member];
  }
  const members = await db.collection('members').find({ deletedAt: null }).toArray();
  if (audience === 'all_members') {
    return members.filter((m) => (m.accountStatus || (m.isMember ? 'active' : 'pending')) === 'active');
  }
  const hydrated = [];
  for (const m of members) hydrated.push({ raw: m, dto: await hydrateMember(m) });
  if (audience === 'active_subscribers') {
    return hydrated.filter((x) => x.dto.subStatus === 'active').map((x) => x.raw);
  }
  if (audience === 'renewal_due') {
    return hydrated.filter((x) => x.dto.subStatus === 'renewal_due').map((x) => x.raw);
  }
  if (audience === 'pending_payments') {
    const pays = await db.collection('payments').find({ status: { $in: ['pending', 'processing', 'failed'] } }).toArray();
    const ids = new Set(
      pays.filter((p) => ['pending', 'overdue', 'failed'].includes(paymentOpsStatus(p))).map((p) => p.memberId)
    );
    return members.filter((m) => ids.has(m.id));
  }
  throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid audience', [{ field: 'audience', message: 'Invalid audience' }]);
}

async function sendNotification(body, staff) {
  const title = String(body?.title || '').trim();
  const text = body?.body != null ? String(body.body) : '';
  const audience = body?.audience;
  const channel = body?.channel || 'push';
  const details = [];
  if (!title || title.length > 80) details.push({ field: 'title', message: 'Required, 1–80 characters' });
  if (text.length > 500) details.push({ field: 'body', message: 'Max 500 characters' });
  if (!AUDIENCES.includes(audience)) details.push({ field: 'audience', message: 'Invalid audience' });
  if (!['push', 'sms', 'email'].includes(channel)) details.push({ field: 'channel', message: 'Invalid channel' });
  if (details.length) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid notification', details);

  const recipients = await resolveAudience(audience, body.memberId);
  for (const m of recipients) {
    await insertMemberNotification({
      memberId: m.id,
      icon: body.icon || 'bell',
      title,
      body: text,
      deepLinkTab: body.deepLinkTab || null,
      deepLinkPath: body.deepLinkPath || null,
    });
  }
  const db = getDB();
  const sent = {
    id: `snd_${nanoid(8)}`,
    icon: body.icon || 'bell',
    title,
    body: text,
    audience,
    audienceLabel: AUDIENCE_LABELS[audience],
    channel,
    memberId: audience === 'individual' ? recipients[0]?.id : null,
    recipientCount: recipients.length,
    createdAt: new Date(),
    sentBy: staff.id,
  };
  await db.collection('notifications_sent').insertOne(sent);
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Notification sent',
    entity: sent.id,
    entityType: 'notification',
    detail: `${title} · ${recipients.length} recipients`,
  });
  return toSentDto(sent);
}

module.exports = { listTemplates, listSent, sendNotification };
