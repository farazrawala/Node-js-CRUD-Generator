const { coalesceObjectId, activeNotDeletedCriteria } = require("../utils/modelHelper");
const { dispatchByStoreType } = require("../utils/processHelpers");
const ProcessModel = require("../models/process");
const Category = require("../models/category");
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
    hints.push("Pass ?process_id=<id> or GET /process/execute-process/:id to run a specific process row.");
  }

  hints.push(
    "Use action fetch_category to import categories from the store; sync_category pushes one POS category to the store.",
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

async function loadActiveProcess(req) {
  const { filter } = buildActiveProcessFilter(req);

  const processDoc = await ProcessModel.findOne(filter)
    .sort({ priority: 1, createdAt: 1 })
    .populate(["company_id", "integration_id", "product_id", "category_id"]);

  if (!processDoc) {
    return null;
  }

  const rawCategoryId = processDoc.category_id;
  const process = processDoc.toObject({ flattenMaps: true });

  if (!process.category_id && rawCategoryId) {
    process.category_id = rawCategoryId;
  }

  await hydrateProcessCategory(process, req);
  return process;
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
    case "fetch_category": {
      return dispatchByStoreType(req, res, process, {
        woocommerce: woocommerceProcess.fetch_category,
        shopify: shopifyProcess.fetch_category,
      });
    }
    case "sync_product": {
      return dispatchByStoreType(req, res, process, {
        woocommerce: woocommerceProcess.sync_product,
        shopify: shopifyProcess.sync_product,
      });
    }
    case "sync_category": {
      return dispatchByStoreType(req, res, process, {
        woocommerce: woocommerceProcess.sync_category,
        shopify: shopifyProcess.sync_category,
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
};
