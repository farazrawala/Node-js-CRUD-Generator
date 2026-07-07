function normalizeShopifyStatus(status) {
  return String(status || "").trim().toLowerCase();
}

function isDraftShopifyStatus(status) {
  const s = normalizeShopifyStatus(status);
  return s === "draft" || s === "drafted" || s === "checkout_draft";
}

function isArchivedShopifyStatus(status) {
  const s = normalizeShopifyStatus(status);
  return s === "archived" || s === "inactive" || s === "unpublished";
}

function isActiveShopifyStatus(status) {
  const s = normalizeShopifyStatus(status);
  if (!s) return true;
  return s === "active" || s === "published" || s === "true";
}

function shouldImportShopifyStatus(
  status,
  { importDrafts = false, importArchived = false } = {},
) {
  const s = normalizeShopifyStatus(status);
  if (!s) return true;
  if (isActiveShopifyStatus(s)) return true;
  if (isDraftShopifyStatus(s)) return importDrafts;
  if (isArchivedShopifyStatus(s)) return importArchived;
  return importArchived;
}

module.exports = {
  normalizeShopifyStatus,
  isDraftShopifyStatus,
  isArchivedShopifyStatus,
  isActiveShopifyStatus,
  shouldImportShopifyStatus,
};
