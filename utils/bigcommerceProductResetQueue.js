/**
 * Queue discovery of BigCommerce me-too products that fetch from recent
 * origin product_ids, then insert `bigcommerce_product_reset` rows in the
 * process worker (not inline on the HTTP request).
 *
 * Process action: `queue_bigcommerce_product_reset`
 * - One process row per origin product_id (no integration required)
 * - Worker finds products with fetch_from_product_id = origin and insertMany
 *
 * @module utils/bigcommerceProductResetQueue
 */

const ProcessModel = require("../models/process");
const Product = require("../models/product");
const BigcommerceProductReset = require("../models/bigcommerce_product_reset");
const { coalesceObjectId } = require("./modelHelper");
const { enqueueProcess } = require("./processQueue");
const { markProcessOutcome } = require("./processHelpers");

const ACTION = "queue_bigcommerce_product_reset";
const INSERT_CHUNK = 500;

/**
 * Enqueue one lightweight process job per origin product.
 * Does NOT run the Product.find / insertMany — that happens in the worker.
 *
 * @param {{
 *   productIds: Array<string|import("mongoose").Types.ObjectId>,
 *   createdBy?: unknown,
 *   remarks?: string,
 *   priority?: number,
 * }} params
 */
async function enqueueBigcommerceProductResetJobs({
  productIds,
  createdBy = null,
  remarks = "Auto-queued bigcommerce product reset discovery from recent-product-ids",
  priority = 60,
}) {
  const uniqueIds = [
    ...new Set(
      (productIds || [])
        .map((id) => coalesceObjectId(id))
        .filter(Boolean)
        .map((id) => String(id)),
    ),
  ];

  if (!uniqueIds.length) {
    return {
      created: [],
      count: 0,
      skipped: 0,
      failed: [],
      reason: "no_product_ids",
    };
  }

  const objectIds = uniqueIds.map((id) => coalesceObjectId(id));
  const products = await Product.find({
    _id: { $in: objectIds },
    deletedAt: null,
  })
    .select("_id company_id")
    .lean();

  const actor = coalesceObjectId(createdBy);
  const created = [];
  const failed = [];
  let skipped = uniqueIds.length - products.length;

  for (const product of products) {
    const productId = coalesceObjectId(product._id);
    const companyId = coalesceObjectId(product.company_id);
    if (!productId || !companyId) {
      skipped += 1;
      continue;
    }

    try {
      const doc = await ProcessModel.create({
        product_id: productId,
        company_id: companyId,
        action: ACTION,
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
      created.push({
        _id: doc._id,
        product_id: doc.product_id,
        company_id: doc.company_id,
        action: doc.action,
        progress: doc.progress,
      });
    } catch (err) {
      failed.push({
        product_id: String(productId),
        company_id: String(companyId),
        error: err?.message || "Insert failed",
      });
    }
  }

  console.log(
    `[bc-reset-queue] enqueued processes=${created.length} failed=${failed.length} skipped=${skipped}`,
  );

  return {
    created,
    count: created.length,
    skipped,
    failed,
    action: ACTION,
  };
}

/**
 * Worker handler: for one origin product_id, queue me-too copies into
 * bigcommerce_product_reset.
 *
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {object} process
 */
async function queue_bigcommerce_product_reset(req, res, process) {
  const originId = coalesceObjectId(
    process.product_id?._id || process.product_id,
  );
  if (!originId) {
    const msg = "product_id (origin) is required for queue_bigcommerce_product_reset";
    await markProcessOutcome(process._id, "failed", msg);
    return res.status(400).json({
      success: false,
      message: msg,
      process_id: process._id,
    });
  }

  const actorId =
    coalesceObjectId(req.user?._id) ||
    coalesceObjectId(process.created_by?._id || process.created_by) ||
    null;

  const linkedProducts = await Product.find({
    fetch_from_product_id: originId,
    status: "active",
    deletedAt: null,
  })
    .select("_id company_id created_by")
    .lean();

  if (!linkedProducts.length) {
    const msg = `No me-too products fetch from origin ${originId}`;
    await markProcessOutcome(process._id, "completed", msg);
    return res.status(200).json({
      success: true,
      inserted: 0,
      origin_product_id: String(originId),
      message: msg,
      process_id: process._id,
    });
  }

  const docs = linkedProducts
    .map((row) => {
      const companyId = coalesceObjectId(row.company_id);
      if (!companyId) return null;
      const ownerId = coalesceObjectId(row.created_by);
      return {
        product_id: String(row._id),
        reset_status: "not_started",
        reset_message:
          "Queued from process queue_bigcommerce_product_reset (origin product activity)",
        user_id: actorId || ownerId || null,
        company_id: companyId,
        created_by: actorId || ownerId || null,
        status: "active",
        deletedAt: null,
      };
    })
    .filter(Boolean);

  let inserted = 0;
  for (let i = 0; i < docs.length; i += INSERT_CHUNK) {
    const chunk = docs.slice(i, i + INSERT_CHUNK);
    const result = await BigcommerceProductReset.insertMany(chunk, {
      ordered: false,
    });
    inserted += result.length;
  }

  const msg = `Queued ${inserted} bigcommerce_product_reset row(s) for origin ${originId}`;
  await markProcessOutcome(process._id, "completed", msg);

  return res.status(200).json({
    success: true,
    inserted,
    linked_found: linkedProducts.length,
    origin_product_id: String(originId),
    message: msg,
    process_id: process._id,
  });
}

module.exports = {
  ACTION,
  enqueueBigcommerceProductResetJobs,
  queue_bigcommerce_product_reset,
};
