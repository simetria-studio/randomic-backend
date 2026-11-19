function parsePaging(query = {}) {
  let page = parseInt(query.page, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  let pageSize = parseInt(query.pageSize, 10);
  if (!Number.isFinite(pageSize)) pageSize = 20;
  pageSize = Math.min(100, Math.max(1, pageSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function pageResult(items, total, paging) {
  return { items, total, page: paging.page, pageSize: paging.pageSize };
}

module.exports = { parsePaging, pageResult };
