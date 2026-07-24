/**
 * Shared helpers: skip product/process sync when integration or sync_product mapping is inactive.
 * @module utils/integrationActiveGuard
 */

const Integration = require("../models/integration");
const SyncProduct = require("../models/sync_product");
const { coalesceObjectId } = require("./modelHelper");
const { createApplicationLog } = require("./applicationLogs");

/**
 * @param {object|null|undefined} integration - Populated integration doc or lean object
 * @returns {boolean}
 */
function isIntegrationRecordInactive(integration) {
  if (!integration) return true;
  if (integration.deletedAt) return true;
  return String(integration.status || "").toLowerCase() !== "active";
}

/**
 * @param {object|null|undefined} mapping - sync_product row
 * @returns {boolean} true when mapping exists and is inactive / deleted
 */
function isSyncProductMappingInactive(mapping) {
  if (!mapping) return false;
  if (mapping.deletedAt) return true;
  return String(mapping.status || "").toLowerCase() !== "active";
}

/**
 * Load integration only when active and not soft-deleted.
 * @param {unknown} integrationId
 * @param {unknown} [companyId]
 * @returns {Promise<object|null>}
 */
async function findIntegrationIfActive(integrationId, companyId) {
  const _id = coalesceObjectId(integrationId);
  if (!_id) return null;

  const filter = {
    _id,
    deletedAt: null,
    status: "active",
  };
  const company_id = coalesceObjectId(companyId);
  if (company_id) {
    filter.company_id = company_id;
  }

  return Integration.findOne(filter).lean();
}

/**
 * Latest sync_product mapping for product × integration (any status, not deleted).
 * @param {{ productId: unknown, integrationId: unknown, companyId?: unknown }} params
 * @returns {Promise<object|null>}
 */
async function findSyncProductMapping({ productId, integrationId, companyId }) {
  const product_id = coalesceObjectId(productId);
  const integration_id = coalesceObjectId(integrationId);
  if (!product_id || !integration_id) return null;

  const filter = {
    product_id,
    integration_id,
    deletedAt: null,
  };
  const company_id = coalesceObjectId(companyId);
  if (company_id) {
    filter.company_id = company_id;
  }

  return SyncProduct.findOne(filter).lean();
}

/**
 * Audit log when sync/mapping is skipped because the integration is inactive.
 * @param {import("express").Request | null} req
 * @param {{
 *   action?: string,
 *   integrationId?: unknown,
 *   integrationName?: string,
 *   companyId?: unknown,
 *   productId?: unknown,
 *   processId?: unknown,
 *   createdBy?: unknown,
 *   message?: string,
 *   extra?: Record<string, unknown>,
 * }} meta
 */
async function logIntegrationInactiveSkip(req, meta = {}) {
  const integration_id = coalesceObjectId(meta.integrationId);
  const company_id = coalesceObjectId(
    meta.companyId ?? req?.user?.company_id,
  );
  const product_id = coalesceObjectId(meta.productId);
  const process_id = coalesceObjectId(meta.processId);
  const actionLabel = String(meta.action || "sync").trim() || "sync";
  const name =
    meta.integrationName != null && String(meta.integrationName).trim() ?
      String(meta.integrationName).trim()
    : integration_id ? String(integration_id)
    : "unknown";

  const message =
    meta.message ||
    `Skipped ${actionLabel}: integration "${name}" is inactive`;

  console.warn(
    `[integration] skip inactive integration_id=${integration_id || "n/a"} action=${actionLabel}`,
  );

  return createApplicationLog(
    req,
    {
      action: `Skipped ${actionLabel} :: integration inactive`,
      tags: [
        "integration",
        "inactive",
        "skipped",
        actionLabel,
        "sync_product",
      ],
      description: {
        message,
        code: "INTEGRATION_INACTIVE",
        action: actionLabel,
        integration_id: integration_id ? String(integration_id) : null,
        integration_name: name,
        product_id: product_id ? String(product_id) : null,
        process_id: process_id ? String(process_id) : null,
        ...(meta.extra && typeof meta.extra === "object" ? meta.extra : {}),
      },
      company_id,
      created_by: meta.createdBy ?? req?.user?._id,
      reference_type: integration_id ? "integration" : "process",
      reference_id: integration_id || process_id || product_id || null,
    },
    { silent: true },
  );
}

/**
 * Audit log when sync is skipped because sync_product mapping status is inactive.
 * @param {import("express").Request | null} req
 * @param {{
 *   action?: string,
 *   integrationId?: unknown,
 *   companyId?: unknown,
 *   productId?: unknown,
 *   processId?: unknown,
 *   syncProductId?: unknown,
 *   createdBy?: unknown,
 *   message?: string,
 *   extra?: Record<string, unknown>,
 * }} meta
 */
async function logSyncProductMappingInactiveSkip(req, meta = {}) {
  const integration_id = coalesceObjectId(meta.integrationId);
  const company_id = coalesceObjectId(
    meta.companyId ?? req?.user?.company_id,
  );
  const product_id = coalesceObjectId(meta.productId);
  const process_id = coalesceObjectId(meta.processId);
  const sync_product_id = coalesceObjectId(meta.syncProductId);
  const actionLabel =
    String(meta.action || "sync_product").trim() || "sync_product";

  const message =
    meta.message ||
    `Skipped ${actionLabel}: sync_product mapping is inactive`;

  console.warn(
    `[sync_product] skip inactive mapping product_id=${product_id || "n/a"} integration_id=${integration_id || "n/a"}`,
  );

  return createApplicationLog(
    req,
    {
      action: `Skipped ${actionLabel} :: sync_product mapping inactive`,
      tags: [
        "sync_product",
        "inactive",
        "skipped",
        "mapping",
        actionLabel,
      ],
      description: {
        message,
        code: "SYNC_PRODUCT_INACTIVE",
        action: actionLabel,
        sync_product_id: sync_product_id ? String(sync_product_id) : null,
        integration_id: integration_id ? String(integration_id) : null,
        product_id: product_id ? String(product_id) : null,
        process_id: process_id ? String(process_id) : null,
        ...(meta.extra && typeof meta.extra === "object" ? meta.extra : {}),
      },
      company_id,
      created_by: meta.createdBy ?? req?.user?._id,
      reference_type: "sync_product",
      reference_id: sync_product_id || product_id || process_id || null,
    },
    { silent: true },
  );
}

module.exports = {
  isIntegrationRecordInactive,
  isSyncProductMappingInactive,
  findIntegrationIfActive,
  findSyncProductMapping,
  logIntegrationInactiveSkip,
  logSyncProductMappingInactiveSkip,
};
