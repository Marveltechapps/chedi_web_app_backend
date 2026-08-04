const { verifyAccessToken } = require('../services/jwt.service');
const { findMemberById, toMemberSummary } = require('../lib/members');
const { ApiError } = require('../lib/errors');

/**
 * Require a valid member Bearer token. Sets req.member and req.memberDoc.
 */
async function requireMember(req, _res, next) {
  try {
    const header = req.get('Authorization') || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Missing or invalid Authorization header');
    }
    let payload;
    try {
      payload = verifyAccessToken(match[1]);
    } catch {
      throw new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired access token');
    }
    const member = await findMemberById(payload.sub);
    if (!member || !member.isMember) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Member session is no longer valid');
    }
    req.member = toMemberSummary(member);
    req.memberDoc = member;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Optional auth — attaches member when token present, otherwise continues.
 */
async function optionalMember(req, _res, next) {
  try {
    const header = req.get('Authorization') || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return next();
    try {
      const payload = verifyAccessToken(match[1]);
      const member = await findMemberById(payload.sub);
      if (member && member.isMember) {
        req.member = toMemberSummary(member);
        req.memberDoc = member;
      }
    } catch {
      // ignore invalid optional token
    }
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireMember, optionalMember };
