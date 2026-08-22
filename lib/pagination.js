function parsePagination(query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  let limit = parseInt(query.limit, 10);
  if (!Number.isFinite(limit)) limit = 20;
  limit = Math.min(100, Math.max(1, limit));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

function paginationMeta(page, limit, total) {
  return {
    page,
    limit,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / limit),
  };
}

function slicePage(rows, page, limit) {
  const skip = (page - 1) * limit;
  return rows.slice(skip, skip + limit);
}

module.exports = { parsePagination, paginationMeta, slicePage };
