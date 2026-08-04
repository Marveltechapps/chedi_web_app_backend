const { nanoid } = require('nanoid');
const { getDB } = require('../config/db');
const { displayPhone } = require('./phone');

function memberStatusLabel(member) {
  if (!member.isMember) return 'Not a member';
  if (member.hasPlot || (member.plotCount || 0) > 0) return 'Subscribed · active';
  return 'Member · no plot yet';
}

function toMemberSummary(member) {
  if (!member) return null;
  const firstName = (member.name || '').trim().split(/\s+/)[0] || '';
  return {
    id: member.id,
    memberCode: member.memberCode || `CHEDI-${member.id}`,
    name: member.name,
    firstName,
    phone: member.phone,
    phoneDisplay: member.phoneDisplay || displayPhone(member.phone),
    email: member.email || null,
    isMember: Boolean(member.isMember),
    memberSince: member.memberSince || null,
    hasPlot: Boolean(member.hasPlot),
    plotCount: member.plotCount || 0,
    statusLabel: member.statusLabel || memberStatusLabel(member),
  };
}

function toProfile(member) {
  return {
    name: member.name,
    phone: member.phone,
    phoneDisplay: member.phoneDisplay || displayPhone(member.phone),
    email: member.email || null,
  };
}

async function nextMemberId() {
  const db = getDB();
  const counter = await db.collection('counters').findOneAndUpdate(
    { _id: 'memberId' },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  // Driver v6 returns the document; older shapes used { value }
  const seq = (counter && (counter.seq ?? counter.value?.seq)) || 500;
  return String(seq).padStart(4, '0');
}

async function findMemberByPhone(phone) {
  const db = getDB();
  return db.collection('members').findOne({ phone, deletedAt: null });
}

async function findMemberByEmail(email) {
  const db = getDB();
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  return db.collection('members').findOne({ email: normalized, deletedAt: null });
}

async function findMemberById(id) {
  const db = getDB();
  return db.collection('members').findOne({ id, deletedAt: null });
}

async function refreshMemberPlotStats(memberId) {
  const db = getDB();
  const plotCount = await db.collection('subscriptions').countDocuments({
    memberId,
    status: { $in: ['active', 'past_due'] },
  });
  const hasPlot = plotCount > 0;
  const statusLabel = hasPlot ? 'Subscribed · active' : 'Member · no plot yet';
  await db.collection('members').updateOne(
    { id: memberId },
    { $set: { hasPlot, plotCount, statusLabel, updatedAt: new Date() } }
  );
  return findMemberById(memberId);
}

async function softDeleteMember(memberId) {
  const db = getDB();
  await db.collection('members').updateOne(
    { id: memberId },
    {
      $set: {
        deletedAt: new Date(),
        phone: `deleted_${memberId}_${nanoid(6)}`,
        email: null,
        name: 'Deleted Member',
        isMember: false,
        updatedAt: new Date(),
      },
    }
  );
}

module.exports = {
  toMemberSummary,
  toProfile,
  nextMemberId,
  findMemberByPhone,
  findMemberByEmail,
  findMemberById,
  refreshMemberPlotStats,
  softDeleteMember,
  memberStatusLabel,
};
