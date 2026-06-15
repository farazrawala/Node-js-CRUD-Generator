const {
  coalesceObjectId,
  activeNotDeletedCriteria,
} = require("../utils/modelHelper");
const { dispatchByStoreType } = require("../utils/processHelpers");
const ProcessModel = require("../models/process");
const Category = require("../models/category");
const Brand = require("../models/brands");
const woocommerceProcess = require("./woocommerceProcess");
const shopifyProcess = require("./shopifyProcess");

/**
 * Process queue orchestrator.
 * Loads the next active job and delegates to woocommerceProcess / shopifyProcess.
 */

function buildCompanyIdCriteria(companyId) {
  if (!companyId) {
    return null;
  }
  const objectId = coalesceObjectId(companyId);
  const asString = String(objectId);
  return {
    $or: [{ company_id: objectId }, { company_id: asString }],
  };
}

function buildActiveProcessFilter(req) {
  const filter = {
    status: "active",
    $and: [activeNotDeletedCriteria()],
  };

  if (req.query.company_id) {
    const companyCriteria = buildCompanyIdCriteria(req.query.company_id);
    if (companyCriteria) {
      filter.$and.push(companyCriteria);
    }
  }

  if (req.params?.id) {
    filter._id = coalesceObjectId(req.params.id);
  } else if (req.query.process_id) {
    filter._id = coalesceObjectId(req.query.process_id);
  }

  return { filter };
}

async function explainNoActiveProcess(req) {
  const { filter } = buildActiveProcessFilter(req);
  const totalActive = await ProcessModel.countDocuments(filter);

  const hints = [];
  if (req.params?.id || req.query.process_id) {
    hints.push("Check that process_id exists and status is active.");
  } else if (totalActive === 0) {
    hints.push(
      "Create a process in Admin with status active, or set an existing row back to active.",
    );
  } else {
    hints.push(
      "Pass ?process_id=<id> or GET /process/execute-process/:id to run a specific process row.",
    );
  }

  hints.push(
    "Use fetch_product / fetch_category / fetch_brand to import from the store; sync_* actions push one POS row to the store.",
  );

  return {
    message: "No active process found for this request.",
    hints,
    active_processes_matching_filter: totalActive,
  };
}

async function hydrateProcessCategory(process, req) {
  if (process?.category_id && typeof process.category_id === "object") {
    if (process.category_id.name) {
      return process.category_id;
    }
    process.category_id = coalesceObjectId(process.category_id._id);
  }

  const categoryId =
    coalesceObjectId(process?.category_id) ||
    coalesceObjectId(req.query?.category_id) ||
    coalesceObjectId(req.body?.category_id);

  if (!categoryId) {
    return null;
  }

  const category = await Category.findOne({
    _id: categoryId,
    deletedAt: null,
  }).lean();

  if (category) {
    process.category_id = category;
    return category;
  }

  return null;
}

async function hydrateProcessBrand(process, req) {
  if (process?.brand_id && typeof process.brand_id === "object") {
    if (process.brand_id.name) {
      return process.brand_id;
    }
    process.brand_id = coalesceObjectId(process.brand_id._id);
  }

  const brandId =
    coalesceObjectId(process?.brand_id) ||
    coalesceObjectId(req.query?.brand_id) ||
    coalesceObjectId(req.body?.brand_id);

  if (!brandId) {
    return null;
  }

  const brand = await Brand.findOne({
    _id: brandId,
    deletedAt: null,
  }).lean();

  if (brand) {
    process.brand_id = brand;
    return brand;
  }

  return null;
}

async function loadActiveProcess(req) {
  const { filter } = buildActiveProcessFilter(req);

  const processDoc = await ProcessModel.findOne(filter)
    .sort({ priority: 1, createdAt: 1 })
    .populate([
      "company_id",
      "integration_id",
      "product_id",
      "category_id",
      "brand_id",
    ]);

  if (!processDoc) {
    return null;
  }

  const rawCategoryId = processDoc.category_id;
  const process = processDoc.toObject({ flattenMaps: true });

  if (!process.category_id && rawCategoryId) {
    process.category_id = rawCategoryId;
  }

  const rawBrandId = processDoc.brand_id;
  if (!process.brand_id && rawBrandId) {
    process.brand_id = rawBrandId;
  }

  await hydrateProcessCategory(process, req);
  await hydrateProcessBrand(process, req);
  return process;
}

const PROCESS_ACTIONS = new Set([
  "fetch_products",
  "fetch_product",
  "sync_product",
  "delete_product",
  "fetch_category",
  "sync_category",
  "delete_category",
  "fetch_brand",
  "sync_brand",
  "delete_brand",
]);

function normalizeBulkProcessRow(row, { companyId, createdBy }) {
  return {
    integration_id:
      row.integration_id ? coalesceObjectId(row.integration_id) : undefined,
    product_id: row.product_id ? coalesceObjectId(row.product_id) : undefined,
    category_id:
      row.category_id ? coalesceObjectId(row.category_id) : undefined,
    brand_id: row.brand_id ? coalesceObjectId(row.brand_id) : undefined,
    action: String(row.action || "").trim(),
    count: Number(row.count) || 0,
    page: Number(row.page) || 1,
    offset: Number(row.offset) || 0,
    limit: Number(row.limit) || 1,
    priority: Number(row.priority) || 100,
    remarks: row.remarks || "",
    hits: Number(row.hits) || 0,
    progress: row.progress || "not_started",
    status: row.status || "active",
    company_id: companyId,
    created_by: createdBy,
  };
}

function validateProcessRow(row) {
  if (!row.action || !PROCESS_ACTIONS.has(row.action)) {
    return `Invalid or missing action: ${row.action || "(empty)"}`;
  }
  if (!row.company_id) {
    return "company_id is required.";
  }
  if (row.action === "sync_category" && !row.category_id) {
    return "category_id is required for sync_category.";
  }
  if (row.action === "sync_brand" && !row.brand_id) {
    return "brand_id is required for sync_brand.";
  }
  if (row.action === "sync_product" && !row.product_id) {
    return "product_id is required for sync_product.";
  }
  if (
    (row.action === "fetch_category" ||
      row.action === "fetch_products" ||
      row.action === "fetch_product" ||
      row.action === "fetch_brand") &&
    !row.integration_id
  ) {
    return "integration_id is required for fetch actions.";
  }
  if (row.action === "sync_category" && !row.integration_id) {
    return "integration_id is required for sync_category.";
  }
  if (row.action === "sync_brand" && !row.integration_id) {
    return "integration_id is required for sync_brand.";
  }
  if (row.action === "sync_product" && !row.integration_id) {
    return "integration_id is required for sync_product.";
  }
  return null;
}

/**
 * POST /api/process/bulk-create
 *
 * Option A — shared fields + many category ids (sync_category bulk):
 * {
 *   "integration_id": "...",
 *   "action": "sync_category",
 *   "category_ids": ["69150...", "69151..."]
 * }
 *
 * Option B — explicit rows:
 * {
 *   "items": [
 *     { "integration_id": "...", "category_id": "...", "action": "sync_category" }
 *   ]
 * }
 */
async function processBulkCreate(req, res) {
  const companyId = coalesceObjectId(
    req.body?.company_id || req.user?.company_id,
  );
  const createdBy = coalesceObjectId(req.user?._id);

  if (!companyId) {
    return res.status(400).json({
      success: false,
      message: "company_id is required (from auth user or request body).",
    });
  }

  let sourceRows = [];

  if (Array.isArray(req.body?.category_ids) && req.body.category_ids.length) {
    const action = String(req.body.action || "sync_category").trim();
    const template = {
      integration_id: req.body.integration_id,
      product_id: req.body.product_id,
      action,
      status: req.body.status,
      progress: req.body.progress,
      priority: req.body.priority,
      limit: req.body.limit,
      page: req.body.page,
      remarks: req.body.remarks,
    };
    sourceRows = req.body.category_ids.map((categoryId) => ({
      ...template,
      category_id: categoryId,
    }));
  } else if (Array.isArray(req.body?.brand_ids) && req.body.brand_ids.length) {
    const action = String(req.body.action || "sync_brand").trim();
    const template = {
      integration_id: req.body.integration_id,
      action,
      status: req.body.status,
      progress: req.body.progress,
      priority: req.body.priority,
      limit: req.body.limit,
      page: req.body.page,
      remarks: req.body.remarks,
    };
    sourceRows = req.body.brand_ids.map((brandId) => ({
      ...template,
      brand_id: brandId,
    }));
  } else if (
    Array.isArray(req.body?.product_ids) &&
    req.body.product_ids.length
  ) {
    const action = String(req.body.action || "sync_product").trim();
    const template = {
      integration_id: req.body.integration_id,
      action,
      status: req.body.status,
      progress: req.body.progress,
      priority: req.body.priority,
      limit: req.body.limit,
      page: req.body.page,
      remarks: req.body.remarks,
    };
    sourceRows = req.body.product_ids.map((productId) => ({
      ...template,
      product_id: productId,
    }));
  } else {
    const items = req.body?.items;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message:
          "Send a non-empty `items` array, or `category_ids` / `brand_ids` / `product_ids` with shared fields.",
      });
    }
    sourceRows = items;
  }

  const created = [];
  const failed = [];

  for (let index = 0; index < sourceRows.length; index += 1) {
    const normalized = normalizeBulkProcessRow(sourceRows[index], {
      companyId,
      createdBy,
    });
    const error = validateProcessRow(normalized);
    if (error) {
      failed.push({ index, error, input: sourceRows[index] });
      continue;
    }

    try {
      const doc = await ProcessModel.create(normalized);
      created.push(doc);
    } catch (err) {
      failed.push({
        index,
        error: err.message || "Insert failed",
        input: sourceRows[index],
      });
    }
  }

  if (created.length === 0) {
    return res.status(400).json({
      success: false,
      message: "No process records were created.",
      failed,
    });
  }

  const statusCode = failed.length > 0 ? 207 : 201;
  return res.status(statusCode).json({
    success: true,
    message: `Created ${created.length} process record(s).`,
    data: {
      created,
      summary: {
        total: sourceRows.length,
        created: created.length,
        failed: failed.length,
      },
      failed,
    },
  });
}

async function execute_process(req, res) {
  const process = await loadActiveProcess(req);

  if (!process) {
    const details = await explainNoActiveProcess(req);
    return res.status(400).json({
      success: false,
      ...details,
    });
  }

  switch (process.action) {
    case "sync_product": {
      return dispatchByStoreType(req, res, process, {
        woocommerce: woocommerceProcess.sync_product,
        shopify: shopifyProcess.sync_product,
      });
    }
    case "fetch_product":
    case "fetch_products": {
      return dispatchByStoreType(req, res, process, {
        woocommerce: woocommerceProcess.fetch_product,
        shopify: shopifyProcess.fetch_product,
      });
    }
    case "fetch_category": {
      return dispatchByStoreType(req, res, process, {
        woocommerce: woocommerceProcess.fetch_category,
        shopify: shopifyProcess.fetch_category,
      });
    }
    case "sync_category": {
      return dispatchByStoreType(req, res, process, {
        woocommerce: woocommerceProcess.sync_category,
        shopify: shopifyProcess.sync_category,
      });
    }
    case "fetch_brand": {
      return dispatchByStoreType(req, res, process, {
        woocommerce: woocommerceProcess.fetch_brand,
        shopify: shopifyProcess.fetch_brand,
      });
    }
    case "sync_brand": {
      return dispatchByStoreType(req, res, process, {
        woocommerce: woocommerceProcess.sync_brand,
        shopify: shopifyProcess.sync_brand,
      });
    }

    default: {
      return res.status(400).json({
        success: false,
        message: `Invalid action: ${process.action}`,
      });
    }
  }
}

module.exports = {
  execute_process,
  processBulkCreate,
};
