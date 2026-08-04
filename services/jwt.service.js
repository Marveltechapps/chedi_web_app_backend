const jwt = require('jsonwebtoken');
const { nanoid } = require('nanoid');
const { getDB } = require('../config/db');

const ACCESS_SECRET = () => process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-me';
const REFRESH_SECRET = () => process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-change-me';
const ACCESS_EXPIRES = () => Number(process.env.JWT_ACCESS_EXPIRES_IN || 3600);
const REFRESH_EXPIRES = () => Number(process.env.JWT_REFRESH_EXPIRES_IN || 2592000);

function createAccessToken(member) {
  const expiresIn = ACCESS_EXPIRES();
  const accessToken = jwt.sign(
    {
      sub: member.id,
      memberCode: member.memberCode,
      phone: member.phone,
      typ: 'access',
    },
    ACCESS_SECRET(),
    { expiresIn }
  );
  return { accessToken, expiresIn };
}

async function createRefreshToken(memberId) {
  const token = `rt_${nanoid(32)}`;
  const expiresIn = REFRESH_EXPIRES();
  const expiresAt = new Date(Date.now() + expiresIn * 1000);
  const db = getDB();
  await db.collection('sessions').insertOne({
    token,
    memberId,
    createdAt: new Date(),
    expiresAt,
    revoked: false,
  });
  return { refreshToken: token, expiresIn };
}

async function issueTokens(member) {
  const { accessToken, expiresIn } = createAccessToken(member);
  const { refreshToken } = await createRefreshToken(member.id);
  return {
    accessToken,
    refreshToken,
    expiresIn,
    tokenType: 'Bearer',
  };
}

function verifyAccessToken(token) {
  return jwt.verify(token, ACCESS_SECRET());
}

async function refreshTokens(refreshToken) {
  const db = getDB();
  const session = await db.collection('sessions').findOne({
    token: refreshToken,
    revoked: false,
  });
  if (!session) {
    const err = new Error('Invalid refresh token');
    err.code = 'UNAUTHORIZED';
    err.status = 401;
    throw err;
  }
  if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
    const err = new Error('Refresh token expired');
    err.code = 'UNAUTHORIZED';
    err.status = 401;
    throw err;
  }

  await db.collection('sessions').updateOne(
    { _id: session._id },
    { $set: { revoked: true, revokedAt: new Date() } }
  );

  const member = await db.collection('members').findOne({ id: session.memberId, deletedAt: null });
  if (!member) {
    const err = new Error('Member not found');
    err.code = 'MEMBER_NOT_FOUND';
    err.status = 404;
    throw err;
  }

  const { toMemberSummary } = require('../lib/members');
  const summary = toMemberSummary(member);
  const tokens = await issueTokens(summary);
  return { ...tokens, member: summary };
}

async function revokeRefreshToken(refreshToken) {
  if (!refreshToken) return;
  const db = getDB();
  await db.collection('sessions').updateOne(
    { token: refreshToken, revoked: false },
    { $set: { revoked: true, revokedAt: new Date() } }
  );
}

async function revokeAllSessions(memberId) {
  const db = getDB();
  const result = await db.collection('sessions').updateMany(
    { memberId, revoked: false },
    { $set: { revoked: true, revokedAt: new Date() } }
  );
  return result.modifiedCount;
}

module.exports = {
  createAccessToken,
  createRefreshToken,
  issueTokens,
  verifyAccessToken,
  refreshTokens,
  revokeRefreshToken,
  revokeAllSessions,
};
