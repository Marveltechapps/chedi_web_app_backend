/**
 * Admin success envelope (API_CONTRACT §2.1).
 */
function ok(res, data, { message, pagination, meta, status = 200 } = {}) {
  const body = { success: true, data: data == null ? {} : data };
  if (message) body.message = message;
  if (pagination) body.pagination = pagination;
  if (meta) body.meta = meta;
  return res.status(status).json(body);
}

module.exports = { ok };
