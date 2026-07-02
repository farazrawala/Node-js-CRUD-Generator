const ProcessModel = require("../models/process");
const Product = require("../models/product");
const SyncProduct = require("../models/sync_product");
const { coalesceObjectId } = require("./modelHelper");
const { enqueueProcess } = require("./processQueue");

/**
 * Variable-product edits should queue sync against the parent so WooCommerce
 * receives the parent plus all variation rows in one job.
 */
async function resolveProductIdForWebsiteSync(productId, companyId) {
  const product_id = coalesceObjectId(productId);
  const company_id = coalesceObjectId(companyId);
  if (!product_id || !company_id) {
    return product_id;
  }

  const product = await Product.findOne({
    _id: product_id,
    company_id,
    deletedAt: null,
  })
    .select("_id product_type parent_product_id")
    .lean();

  if (!product) {
    return product_id;
  }

  if (
    typeof product.product_type === "string" &&
    product.product_type.toLowerCase() === "variable"
  ) {
    return product_id;
  }

  const parentId = coalesceObjectId(product.parent_product_id);
  if (!parentId || String(parentId) === String(product_id)) {
    return product_id;
  }

  const parent = await Product.findOne({
    _id: parentId,
    company_id,
    deletedAt: null,
  })
    .select("_id product_type")
    .lean();

  if (
    parent &&
    typeof parent.product_type === "string" &&
    parent.product_type.toLowerCase() === "variable"
  ) {
    return parentId;
  }

  return product_id;
}

/**
 * After a POS product edit, queue one `sync_product` process per active mapping.
 * For variable products, mappings on parent or any child resolve to one parent job.
 */
async function enqueueProductWebsiteSyncJobs({
  productId,
  companyId,
  createdBy,
}) {
  const product_id = coalesceObjectId(productId);
  const company_id = coalesceObjectId(companyId);
  if (!product_id || !company_id) {
    return { created: [], count: 0, reason: "missing_ids" };
  }

  const syncTargetId = await resolveProductIdForWebsiteSync(
    product_id,
    company_id,
  );

  const relatedProductIds = [product_id];
  if (
    syncTargetId &&
    String(syncTargetId) !== String(product_id)
  ) {
    relatedProductIds.push(syncTargetId);
  }

  const mappings = await SyncProduct.find({
    product_id: { $in: relatedProductIds },
    company_id,
    status: "active",
    deletedAt: null,
  })
    .select("integration_id product_id company_id")
    .lean();

  if (!mappings.length) {
    return { created: [], count: 0, reason: "no_sync_product_mappings" };
  }

  const actor = coalesceObjectId(createdBy);
  const created = [];
  const seenIntegrations = new Set();

  for (const row of mappings) {
    const integration_id = coalesceObjectId(row.integration_id);
    if (!integration_id) {
      continue;
    }

    const integrationKey = String(integration_id);
    if (seenIntegrations.has(integrationKey)) {
      continue;
    }
    seenIntegrations.add(integrationKey);

    const doc = await ProcessModel.create({
      integration_id,
      product_id: syncTargetId || product_id,
      action: "sync_product",
      company_id,
      created_by: actor,
      status: "active",
      progress: "not_started",
      priority: 50,
      limit: 1,
      page: 1,
      offset: 0,
      count: 0,
      hits: 0,
      remarks: "Auto-queued sync_product after product edit",
    });
    await enqueueProcess(doc);
    created.push(doc);
  }

  return {
    created,
    count: created.length,
    sync_target_product_id: syncTargetId,
  };
}

module.exports = {
  resolveProductIdForWebsiteSync,
  enqueueProductWebsiteSyncJobs,
};
