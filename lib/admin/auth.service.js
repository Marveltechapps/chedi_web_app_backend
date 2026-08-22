const jwtService = require('../../services/jwt.service');
const { getDB } = require('../../config/db');
const { ApiError } = require('../errors');
const { verifyPassword } = require('../password');
const { toStaffDto } = require('./dto');

function validateLogin(body) {
  const email = String(body?.email || '').trim().toLowerCase();
  const password = String(body?.password || '');
  const details = [];
  if (!email) details.push({ field: 'email', message: 'Required' });
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    details.push({ field: 'email', message: 'Invalid email address' });
  }
  if (!password) details.push({ field: 'password', message: 'Required' });
  if (details.length) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid admin credentials', details);
  }
  return { email, password };
}

async function login(body) {
  const { email, password } = validateLogin(body);
  const db = getDB();
  const staff = await db.collection('staff').findOne({ email, active: { $ne: false } });
  if (!staff || !(await verifyPassword(password, staff.passwordHash))) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Invalid admin credentials');
  }
  const tokens = await jwtService.issueStaffTokens(staff);
  return {
    ...tokens,
    staff: toStaffDto(staff),
  };
}

async function refresh(refreshToken) {
  if (!refreshToken) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'refreshToken is required', [
      { field: 'refreshToken', message: 'Required' },
    ]);
  }
  try {
    const result = await jwtService.refreshStaffTokens(refreshToken);
    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
      tokenType: 'Bearer',
      staff: toStaffDto(result.staff),
    };
  } catch (err) {
    throw new ApiError(err.status || 401, err.code || 'UNAUTHORIZED', err.message || 'Invalid refresh token');
  }
}

async function logout(refreshToken) {
  await jwtService.revokeStaffRefreshToken(refreshToken);
  return { loggedOut: true };
}

async function me(staffDoc) {
  return { staff: toStaffDto(staffDoc) };
}

module.exports = { login, refresh, logout, me };
