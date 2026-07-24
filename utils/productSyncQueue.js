const ProcessModel = require("../models/process");
const Product = require("../models/product");
const SyncProduct = require("../models/sync_product");
const Integration = require("../models/integration");
const { coalesceObjectId } = require("./modelHelper");
const { enqueueProcess } = require("./processQueue");
const { createApplicationLog } = require("./applicationLogs");
const {
  findIntegrationIfActive,
  logIntegrationInactiveSkip,
  logSyncProductMappingInactiveSkip,
} = require("./integrationActiveGuard");

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
    const inactiveMappings = await SyncProduct.find({
      product_id: { $in: relatedProductIds },
      company_id,
      status: "inactive",
      deletedAt: null,
    })
      .select("_id integration_id product_id")
      .lean();

    if (inactiveMappings.length) {
      const actor = coalesceObjectId(createdBy);
      for (const row of inactiveMappings) {
        await logSyncProductMappingInactiveSkip(null, {
          action: "sync_product",
          integrationId: row.integration_id,
          companyId: company_id,
          productId: row.product_id || syncTargetId || product_id,
          syncProductId: row._id,
          createdBy: actor,
          message:
            "Skipped single-product sync_product queue: sync_product mapping is inactive",
          extra: {
            source: "enqueueProductWebsiteSyncJobs",
          },
        });
      }
      return {
        created: [],
        count: 0,
        skipped: inactiveMappings.map((row) => ({
          sync_product_id: String(row._id),
          integration_id: String(row.integration_id),
          reason: "sync_product_inactive",
        })),
        skipped_count: inactiveMappings.length,
        reason: "sync_product_mappings_inactive",
      };
    }

    return { created: [], count: 0, reason: "no_sync_product_mappings" };
  }

  const actor = coalesceObjectId(createdBy);
  const created = [];
  const skipped = [];
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

    const activeIntegration = await findIntegrationIfActive(
      integration_id,
      company_id,
    );
    if (!activeIntegration) {
      await logIntegrationInactiveSkip(null, {
        action: "sync_product",
        integrationId: integration_id,
        companyId: company_id,
        productId: syncTargetId || product_id,
        createdBy: actor,
        message:
          "Skipped single-product sync_product queue: integration is inactive",
        extra: {
          source: "enqueueProductWebsiteSyncJobs",
          sync_target_product_id: syncTargetId ?
            String(syncTargetId)
          : String(product_id),
        },
      });
      skipped.push({
        integration_id: String(integration_id),
        reason: "integration_inactive",
      });
      continue;
    }

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
    skipped,
    skipped_count: skipped.length,
    sync_target_product_id: syncTargetId,
  };
}

/**
 * Bulk-queue `sync_product` process rows for many products, grouped by company.
 * Creates one process per product for each active company integration
 * (e.g. 2 integrations → 2 jobs per product).
 *
 * @param {{
 *   req?: import("express").Request | null,
 *   productIds: Array<string|import("mongoose").Types.ObjectId>,
 *   createdBy?: unknown,
 *   remarks?: string,
 *   priority?: number,
 * }} params
 */
async function enqueueBulkSyncProductJobsByCompany({
  req = null,
  productIds,
  createdBy = null,
  remarks = "Auto-queued sync_product from recent line items",
  priority = 50,
}) {
  const uniqueIds = [
    ...new Set(
      (productIds || [])
        .map((id) => coalesceObjectId(id))
        .filter(Boolean)
        .map((id) => String(id)),
    ),
  ];

  console.log(
    `[recent-sync] enqueueBulkSyncProductJobsByCompany start: products=${uniqueIds.length}`,
  );

  if (!uniqueIds.length) {
    console.log("[recent-sync] skipped: no product_ids");
    return {
      created: [],
      count: 0,
      skipped: 0,
      by_company: {},
      logs: [],
      reason: "no_product_ids",
    };
  }

  const objectIds = uniqueIds.map((id) => coalesceObjectId(id));
  const products = await Product.find({
    _id: { $in: objectIds },
    deletedAt: null,
  })
    .select("_id company_id product_name")
    .lean();

  const productNameById = new Map(
    products.map((p) => [
      String(p._id),
      String(p.product_name || "").trim() || String(p._id),
    ]),
  );

  const productsWithCompany = products
    .map((p) => ({
      product_id: coalesceObjectId(p._id),
      company_id: coalesceObjectId(p.company_id),
      product_name: String(p.product_name || "").trim() || String(p._id),
    }))
    .filter((p) => p.product_id && p.company_id);

  if (!productsWithCompany.length) {
    console.warn(
      `[recent-sync] skipped: none of ${uniqueIds.length} product(s) have company_id`,
    );
    return {
      created: [],
      count: 0,
      skipped: uniqueIds.length,
      by_company: {},
      logs: [],
      reason: "no_products_with_company",
    };
  }

  const companyIds = [
    ...new Set(productsWithCompany.map((p) => String(p.company_id))),
  ].map((id) => coalesceObjectId(id));

  const integrations = await Integration.find({
    company_id: { $in: companyIds },
    status: "active",
    deletedAt: null,
  })
    .select("_id company_id")
    .lean();

  console.log(
    `[recent-sync] loaded products=${productsWithCompany.length} companies=${companyIds.length} integrations=${integrations.length}`,
  );

  const integrationsByCompany = new Map();
  for (const row of integrations) {
    const companyKey = String(row.company_id);
    if (!integrationsByCompany.has(companyKey)) {
      integrationsByCompany.set(companyKey, []);
    }
    const integrationId = coalesceObjectId(row._id);
    if (!integrationId) continue;
    const list = integrationsByCompany.get(companyKey);
    if (!list.some((id) => String(id) === String(integrationId))) {
      list.push(integrationId);
    }
  }

  const actor = coalesceObjectId(createdBy);
  const jobKeys = new Set();
  const jobs = [];
  const productIdsByCompany = new Map();
  const productNamesByCompany = new Map();

  for (const product of productsWithCompany) {
    const companyKey = String(product.company_id);
    if (!productIdsByCompany.has(companyKey)) {
      productIdsByCompany.set(companyKey, new Set());
      productNamesByCompany.set(companyKey, []);
    }
    const productIdStr = String(product.product_id);
    if (!productIdsByCompany.get(companyKey).has(productIdStr)) {
      productIdsByCompany.get(companyKey).add(productIdStr);
      productNamesByCompany.get(companyKey).push(product.product_name);
    }

    // One sync_product process per product × each active company integration
    const integrationIds = integrationsByCompany.get(companyKey) || [];

    for (const integration_id of integrationIds) {
      if (!integration_id) continue;
      const jobKey = `${companyKey}:${productIdStr}:${String(integration_id)}`;
      if (jobKeys.has(jobKey)) continue;
      jobKeys.add(jobKey);
      jobs.push({
        product_id: product.product_id,
        company_id: product.company_id,
        integration_id,
        product_name: product.product_name,
      });
    }
  }

  function companyProductSummary(companyKey) {
    const companyProductIds = [...(productIdsByCompany.get(companyKey) || [])];
    const product_names = productNamesByCompany.get(companyKey) || [];
    const namesList = product_names.join(", ");
    return {
      companyProductIds,
      product_names,
      namesList,
      product_count: companyProductIds.length,
    };
  }

  console.log(`[recent-sync] jobs planned=${jobs.length}`);

  const created = [];
  const failed = [];
  const byCompany = {};
  const createdByCompany = new Map();
  const logs = [];
  const logUrl =
    req?.originalUrl || req?.url || "/api/product/recent-product-ids";

  for (const job of jobs) {
    try {
      const doc = await ProcessModel.create({
        integration_id: job.integration_id,
        product_id: job.product_id,
        action: "sync_product",
        company_id: job.company_id,
        created_by: actor,
        status: "active",
        progress: "not_started",
        priority,
        limit: 1,
        page: 1,
        offset: 0,
        count: 0,
        hits: 0,
        remarks,
      });
      await enqueueProcess(doc);
      const createdRow = {
        _id: doc._id,
        product_id: doc.product_id,
        company_id: doc.company_id,
        integration_id: doc.integration_id,
        action: doc.action,
        progress: doc.progress,
      };
      created.push(createdRow);

      const companyKey = String(job.company_id);
      byCompany[companyKey] = (byCompany[companyKey] || 0) + 1;
      if (!createdByCompany.has(companyKey)) {
        createdByCompany.set(companyKey, []);
      }
      createdByCompany.get(companyKey).push(createdRow);
    } catch (err) {
      const errorMessage = err?.message || "Insert failed";
      console.error(
        `[recent-sync] process create failed product=${job.product_id} company=${job.company_id}:`,
        errorMessage,
      );
      const failedRow = {
        product_id: String(job.product_id),
        company_id: String(job.company_id),
        integration_id: String(job.integration_id),
        error: errorMessage,
      };
      failed.push(failedRow);

      const productLabel =
        job.product_name ||
        productNameById.get(String(job.product_id)) ||
        String(job.product_id);
      const failLog = await createApplicationLog(
        req,
        {
          action: `Recent line items sync_product failed :: ${productLabel}`,
          url: logUrl,
          tags: [
            "product",
            "process",
            "sync_product",
            "recent-product-ids",
            "failed",
            "cron job",
          ],
          description: {
            message: `Failed to queue sync_product process for ${productLabel}`,
            action: "sync_product",
            product_id: String(job.product_id),
            product_name: productLabel,
            company_id: String(job.company_id),
            integration_id: String(job.integration_id),
            error: errorMessage,
            remarks,
          },
          company_id: job.company_id,
          created_by: actor,
          reference_type: "product",
          reference_id: job.product_id,
        },
        { silent: true },
      );
      logs.push({
        company_id: String(job.company_id),
        ok: !!failLog?.ok,
        log_id: failLog?._id ? String(failLog._id) : null,
        type: "failed",
        skipped: failLog?.skipped || null,
      });
    }
  }

  for (const [companyKey, rows] of createdByCompany.entries()) {
    const { companyProductIds, product_names, namesList, product_count } =
      companyProductSummary(companyKey);
    const failedForCompany = failed.filter((f) => f.company_id === companyKey);
    const integrationCount = new Set(
      rows.map((r) => String(r.integration_id)),
    ).size;
    const logResult = await createApplicationLog(
      req,
      {
        action: `Recent line items sync_product :: ${product_count} product(s) going in sync`,
        url: logUrl,
        tags: [
          "product",
          "process",
          "sync_product",
          "recent-product-ids",
          "bulk",
          "cron job",
        ],
        description: {
          message: `${product_count} product(s) going in sync: ${namesList}`,
          action: "sync_product",
          process_count: rows.length,
          product_count,
          product_ids: companyProductIds,
          product_names,
          products_going_in_sync: namesList,
          integration_count: integrationCount,
          process_ids: rows.map((r) => String(r._id)),
          failed_count: failedForCompany.length,
          failed: failedForCompany,
          remarks,
        },
        company_id: companyKey,
        created_by: actor,
        reference_type: "process",
        reference_id: rows[0]?._id || null,
      },
      { silent: true },
    );
    logs.push({
      company_id: companyKey,
      ok: !!logResult?.ok,
      log_id: logResult?._id ? String(logResult._id) : null,
      type: "queued",
      product_count,
      product_names,
      skipped: logResult?.skipped || null,
    });
    console.log(
      `[recent-sync] log company=${companyKey} products=${product_count} names=${namesList} jobs=${rows.length} log_ok=${!!logResult?.ok}`,
    );
  }

  // Companies with products but no successful creates
  for (const companyKey of productIdsByCompany.keys()) {
    if (createdByCompany.has(companyKey)) continue;
    const { companyProductIds, product_names, namesList, product_count } =
      companyProductSummary(companyKey);
    const failedForCompany = failed.filter((f) => f.company_id === companyKey);

    if (failedForCompany.length) {
      const logResult = await createApplicationLog(
        req,
        {
          action: `Recent line items sync_product failed :: ${product_count} product(s)`,
          url: logUrl,
          tags: [
            "product",
            "process",
            "sync_product",
            "recent-product-ids",
            "failed",
            "cron job",
          ],
          description: {
            message: `All sync_product inserts failed for ${product_count} product(s): ${namesList}`,
            action: "sync_product",
            process_count: 0,
            product_count,
            product_ids: companyProductIds,
            product_names,
            products_going_in_sync: namesList,
            failed_count: failedForCompany.length,
            failed: failedForCompany,
            remarks,
          },
          company_id: companyKey,
          created_by: actor,
          reference_type: "product",
          reference_id: companyProductIds[0] || null,
        },
        { silent: true },
      );
      logs.push({
        company_id: companyKey,
        ok: !!logResult?.ok,
        log_id: logResult?._id ? String(logResult._id) : null,
        type: "failed_summary",
        product_count,
        product_names,
        skipped: logResult?.skipped || null,
      });
      console.error(
        `[recent-sync] all jobs failed for company=${companyKey} products=${namesList} failed=${failedForCompany.length}`,
      );
      continue;
    }

    const logResult = await createApplicationLog(
      req,
      {
        action: `Recent line items sync_product skipped :: ${product_count} product(s), no integrations`,
        url: logUrl,
        tags: [
          "product",
          "process",
          "sync_product",
          "recent-product-ids",
          "skipped",
          "cron job",
        ],
        description: {
          message: `No sync_product jobs created for ${product_count} product(s) (no active integrations): ${namesList}`,
          action: "sync_product",
          process_count: 0,
          product_count,
          product_ids: companyProductIds,
          product_names,
          products_going_in_sync: namesList,
        },
        company_id: companyKey,
        created_by: actor,
        reference_type: "product",
        reference_id: companyProductIds[0] || null,
      },
      { silent: true },
    );
    logs.push({
      company_id: companyKey,
      ok: !!logResult?.ok,
      log_id: logResult?._id ? String(logResult._id) : null,
      type: "skipped",
      product_count,
      product_names,
      skipped: logResult?.skipped || "no_jobs",
    });
    console.warn(
      `[recent-sync] no jobs for company=${companyKey} products=${namesList}`,
    );
  }

  console.log(
    `[recent-sync] done created=${created.length} failed=${failed.length} companies=${Object.keys(byCompany).length}`,
  );

  return {
    created,
    count: created.length,
    skipped: uniqueIds.length - productsWithCompany.length,
    failed,
    jobs_planned: jobs.length,
    by_company: byCompany,
    logs,
  };
}

module.exports = {
  resolveProductIdForWebsiteSync,
  enqueueProductWebsiteSyncJobs,
  enqueueBulkSyncProductJobsByCompany,
};
