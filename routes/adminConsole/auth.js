const express = require('express');
const { asyncHandler } = require('../../lib/asyncHandler');
const { ok } = require('../../lib/response');
const { requireStaff } = require('../../middleware/staffAuth');
const { adminKey } = require('../../middleware/admin');
const auth = require('../../lib/admin/auth.service');
const { ApiError } = require('../../lib/errors');

const router = express.Router();

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    if (req.body?.email) {
      const result = await auth.login(req.body || {});
      return ok(res, result, { message: 'Signed in' });
    }
    const key = String(req.body?.password || req.body?.adminKey || '').trim();
    if (key && key === adminKey()) {
      return res.json({
        ok: true,
        token: adminKey(),
        notice: 'Use this token as Bearer for admin APIs.',
      });
    }
    if (!req.body?.email && !key) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid admin credentials', [
        { field: 'email', message: 'Required' },
        { field: 'password', message: 'Required' },
      ]);
    }
    throw new ApiError(401, 'UNAUTHORIZED', 'Invalid admin credentials');
  })
);

router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    await auth.logout(req.body?.refreshToken);
    ok(res, { loggedOut: true }, { message: 'Signed out' });
  })
);

router.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const result = await auth.refresh(req.body?.refreshToken);
    ok(res, result, { message: 'Token refreshed' });
  })
);

router.get(
  '/me',
  requireStaff,
  asyncHandler(async (req, res) => {
    ok(res, await auth.me(req.staffDoc));
  })
);

module.exports = router;
