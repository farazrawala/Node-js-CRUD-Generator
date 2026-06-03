function escapeRegexLiteral(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `?tag=API` on logs list routes — documents store `tags` (string array), not `tag`.
 * Matches any array element case-insensitively. Comma-separated values require all tags (AND).
 *
 * @param {Record<string, unknown>} filter
 * @param {Record<string, unknown>} [query]
 * @returns {Record<string, unknown>}
 */
function applyLogsTagQueryFilter(filter, query = {}) {
  const next = { ...filter };
  delete next.tag;

  const raw = query?.tag;
  if (raw == null || String(raw).trim() === "") {
    return next;
  }

  const tags = (Array.isArray(raw) ? raw : String(raw).split(","))
    .map((t) => String(t).trim())
    .filter(Boolean);

  if (tags.length === 0) return next;

  if (tags.length === 1) {
    next.tags = {
      $regex: new RegExp(`^${escapeRegexLiteral(tags[0])}$`, "i"),
    };
    return next;
  }

  const tagClauses = tags.map((t) => ({
    tags: { $regex: new RegExp(`^${escapeRegexLiteral(t)}$`, "i") },
  }));
  next.$and = [...(Array.isArray(next.$and) ? next.$and : []), ...tagClauses];
  return next;
}

module.exports = {
  applyLogsTagQueryFilter,
};
