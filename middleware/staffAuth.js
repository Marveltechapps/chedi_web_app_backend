const { verifyAccessToken } = require('../services/jwt.service');
const { getDB } = require('../config/db');
const { ApiError } = require('../lib/errors');
const { ROLE_MODULES, WRITE_ROLES } = require('../lib/admin/constants');
const { toStaffDto } = require('../lib/admin/dto');
const { adminKey } = require('./admin');

function bearerToken(req) {
  const header = req.get('Authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function looksLikeJwt(token) {
  return Boolean(token && token.split('.').length === 3);
}

async function loadStaff(staffId) {
  const db = getDB();
  return db.collection('staff').findOne({ id: staffId, active: { $ne: false } });
}

/**
 * Require a staff access JWT. Sets req.staff and req.staffDoc.
 */
async function requireStaff(req, _res, next) {
  try {
    const token = bearerToken(req);
    if (!token) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Missing or invalid Authorization header');
    }
    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch {
      throw new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired access token');
    }
    if (payload.typ !== 'staff_access') {
      throw new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired access token');
    }
    const staff = await loadStaff(payload.sub);
    if (!staff) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Invalid admin credentials');
    }
    req.staffDoc = staff;
    req.staff = toStaffDto(staff);
    next();
  } catch (err) {
    next(err);
  }
}

function canAccessModule(role, moduleKey) {
  if (role === 'super_admin') return true;
  const modules = ROLE_MODULES[role] || [];
  return modules.includes(moduleKey);
}

function canWrite(role, moduleKey) {
  if (role === 'super_admin') return true;
  const allowed = WRITE_ROLES[moduleKey] || [];
  return allowed.includes(role);
}

function requireModule(moduleKey, { write = false } = {}) {
  return (req, _res, next) => {
    try {
      const role = req.staff?.role || req.staffDoc?.role;
      if (!role) throw new ApiError(401, 'UNAUTHORIZED', 'Admin authentication required');
      const ok = write ? canWrite(role, moduleKey) && canAccessModule(role, moduleKey) : canAccessModule(role, moduleKey);
      if (!ok) {
        throw new ApiError(403, 'FORBIDDEN', 'You do not have access to this module');
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

function isLegacyAdminKey(req) {
  const token = bearerToken(req);
  const key = token || req.get('X-Admin-Key') || req.body?.adminKey || req.query?.adminKey;
  return Boolean(key && key === adminKey());
}

/**
 * Staff JWT preferred; shared-secret admin key still accepted for legacy payment tools.
 */
async function requireStaffOrAdmin(req, res, next) {
  try {
    const token = bearerToken(req);
    if (looksLikeJwt(token)) {
      return requireStaff(req, res, next);
    }
    if (isLegacyAdminKey(req)) {
      req.admin = { role: 'admin' };
      req.staff = { id: 'admin', name: 'Admin', role: 'super_admin', roleLabel: 'Super Admin', initial: 'A' };
      req.staffDoc = { id: 'admin', name: 'Admin', role: 'super_admin' };
      return next();
    }
    throw new ApiError(401, 'UNAUTHORIZED', 'Admin authentication required');
  } catch (err) {
    next(err);
  }
}

module.exports = {
  requireStaff,
  requireModule,
  requireStaffOrAdmin,
  canAccessModule,
  canWrite,
  looksLikeJwt,
  isLegacyAdminKey,
  bearerToken,
};
