const { nanoid } = require('nanoid');
const { getDB } = require('../../config/db');
const { ApiError } = require('../errors');
const { parsePagination, paginationMeta, slicePage } = require('../pagination');
const { writeAudit } = require('../audit');
const { insertMemberNotification } = require('./notify');
const { toTicketDto, memberPublicId } = require('./dto');
const { findMemberByAnyId } = require('./lookups');
const { toStaffDto } = require('./dto');
const { nextSeq } = require('./ids');

async function extras(ticket) {
  const member = ticket.memberId ? await findMemberByAnyId(ticket.memberId) : null;
  const db = getDB();
  const staff = ticket.assigneeId ? await db.collection('staff').findOne({ id: ticket.assigneeId }) : null;
  return {
    memberCode: member ? memberPublicId(member) : ticket.memberCode,
    memberName: member?.name || ticket.memberName,
    assigneeName: staff ? toStaffDto(staff).name : ticket.assigneeName,
  };
}

async function listTickets(query = {}) {
  const db = getDB();
  const { page, limit } = parsePagination(query);
  const find = {};
  if (query.status && query.status !== 'all') find.status = query.status;
  if (query.category && query.category !== 'all') find.category = query.category;
  if (query.assigneeId && query.assigneeId !== 'all') find.assigneeId = query.assigneeId;
  const rows = await db.collection('tickets').find(find).sort({ createdAt: -1 }).toArray();
  let dtos = [];
  for (const t of rows) dtos.push(toTicketDto(t, await extras(t)));
  const q = String(query.q || '').trim().toLowerCase();
  if (q) {
    dtos = dtos.filter((t) =>
      [t.subject, t.memberName, t.id, t.memberCode].filter(Boolean).join(' ').toLowerCase().includes(q)
    );
  }
  return {
    data: slicePage(dtos, page, limit),
    pagination: paginationMeta(page, limit, dtos.length),
  };
}

async function requireTicket(id) {
  const db = getDB();
  const row = await db.collection('tickets').findOne({ id });
  if (!row) throw new ApiError(404, 'TICKET_NOT_FOUND', 'Ticket not found');
  return row;
}

async function getTicket(id) {
  const row = await requireTicket(id);
  return toTicketDto(row, await extras(row));
}

async function replyTicket(id, text, staff) {
  const body = String(text || '').trim();
  if (!body || body.length > 4000) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Reply text is required (1–4000 chars)', [
      { field: 'text', message: 'Required, 1–4000 characters' },
    ]);
  }
  const ticket = await requireTicket(id);
  const now = new Date();
  const message = {
    id: `msg_${nanoid(6)}`,
    who: staff.name,
    staffId: staff.id,
    text: body,
    createdAt: now,
  };
  const $set = { updatedAt: now };
  if (ticket.status === 'open') $set.status = 'in_progress';
  const db = getDB();
  await db.collection('tickets').updateOne({ id: ticket.id }, { $push: { messages: message }, $set });
  await insertMemberNotification({
    memberId: ticket.memberId,
    icon: 'life',
    title: 'Support reply',
    body,
    deepLinkTab: 'support',
    deepLinkPath: '/app/support',
  });
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Ticket reply',
    entity: ticket.id,
    entityType: 'ticket',
    detail: ticket.subject,
    meta: { memberId: ticket.memberId },
  });
  return getTicket(id);
}

async function assignTicket(id, assigneeId, staff) {
  const ticket = await requireTicket(id);
  const db = getDB();
  const targetId = assigneeId || staff.id;
  const assignee = await db.collection('staff').findOne({ id: targetId });
  if (!assignee) throw new ApiError(404, 'NOT_FOUND', 'Staff not found');
  const now = new Date();
  const $set = {
    assigneeId: assignee.id,
    assigneeName: assignee.name,
    updatedAt: now,
  };
  if (ticket.status === 'open') $set.status = 'in_progress';
  await db.collection('tickets').updateOne({ id: ticket.id }, { $set });
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Ticket assigned',
    entity: ticket.id,
    entityType: 'ticket',
    detail: assignee.name,
    meta: { memberId: ticket.memberId },
  });
  return getTicket(id);
}

async function resolveTicket(id, staff) {
  await requireTicket(id);
  const db = getDB();
  await db.collection('tickets').updateOne({ id }, { $set: { status: 'resolved', updatedAt: new Date() } });
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Ticket resolved',
    entity: id,
    entityType: 'ticket',
  });
  return getTicket(id);
}

async function closeTicket(id, staff) {
  await requireTicket(id);
  const db = getDB();
  await db.collection('tickets').updateOne({ id }, { $set: { status: 'closed', updatedAt: new Date() } });
  await writeAudit({
    actorId: staff.id,
    actorName: staff.name,
    action: 'Ticket closed',
    entity: id,
    entityType: 'ticket',
  });
  return getTicket(id);
}

async function createMemberTicket({ member, category, subject, text }) {
  const details = [];
  if (!subject || !String(subject).trim()) details.push({ field: 'subject', message: 'Required' });
  if (!text || !String(text).trim()) details.push({ field: 'text', message: 'Required' });
  if (details.length) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid ticket', details);
  const seq = await nextSeq('ticket', 118);
  const now = new Date();
  const ticket = {
    id: `TKT-${seq}`,
    memberId: member.id,
    memberCode: member.memberCode,
    memberName: member.name,
    category: category || 'Other',
    subject: String(subject).trim(),
    status: 'open',
    assigneeId: null,
    assigneeName: null,
    messages: [
      {
        id: `msg_${nanoid(6)}`,
        who: member.name,
        staffId: null,
        text: String(text).trim(),
        createdAt: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
  const db = getDB();
  await db.collection('tickets').insertOne(ticket);
  return toTicketDto(ticket, { memberCode: member.memberCode, memberName: member.name });
}

async function memberReply(ticketId, member, text) {
  const body = String(text || '').trim();
  if (!body) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'text is required', [{ field: 'text', message: 'Required' }]);
  }
  const ticket = await requireTicket(ticketId);
  if (ticket.memberId !== member.id) throw new ApiError(404, 'TICKET_NOT_FOUND', 'Ticket not found');
  const now = new Date();
  const message = { id: `msg_${nanoid(6)}`, who: member.name, staffId: null, text: body, createdAt: now };
  const db = getDB();
  await db.collection('tickets').updateOne({ id: ticket.id }, { $push: { messages: message }, $set: { updatedAt: now } });
  return getTicket(ticket.id);
}

async function listMemberTickets(memberId) {
  const db = getDB();
  const rows = await db.collection('tickets').find({ memberId }).sort({ createdAt: -1 }).toArray();
  const out = [];
  for (const t of rows) out.push(toTicketDto(t, await extras(t)));
  return out;
}

module.exports = {
  listTickets,
  getTicket,
  replyTicket,
  assignTicket,
  resolveTicket,
  closeTicket,
  createMemberTicket,
  memberReply,
  listMemberTickets,
};
