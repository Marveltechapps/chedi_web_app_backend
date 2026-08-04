const { ApiError } = require('../lib/errors');

/**
 * Simple shared-secret admin auth for the payment approval dashboard.
 * Header: Authorization: Bearer <ADMIN_API_KEY>
 * or body/query adminKey for the login form.
 */
function adminKey() {
  return process.env.ADMIN_API_KEY || process.env.ADMIN_PASSWORD || 'chedi-admin-demo';
}

function requireAdmin(req, _res, next) {
  try {
    const header = req.get('Authorization') || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const key = bearer || req.get('X-Admin-Key') || req.body?.adminKey || req.query?.adminKey;
    if (!key || key !== adminKey()) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Admin authentication required');
    }
    req.admin = { role: 'admin' };
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireAdmin, adminKey };
