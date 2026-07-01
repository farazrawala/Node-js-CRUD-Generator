const ProcessModel = require("../models/process");
const SyncProduct = require("../models/sync_product");
const { coalesceObjectId } = require("./modelHelper");
const { enqueueProcess } = require("./processQueue");

/**
 * After a POS product edit, queue one `sync_product` process per active `sync_product` mapping.
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

  const mappings = await SyncProduct.find({
    product_id,
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

  for (const row of mappings) {
    const integration_id = coalesceObjectId(row.integration_id);
    if (!integration_id) continue;

    const doc = await ProcessModel.create({
      integration_id,
      product_id,
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

  return { created, count: created.length };
}

module.exports = {
  enqueueProductWebsiteSyncJobs,
};
