const mongoose = require("mongoose");
const OrderItem = require("../models/order_item");
const {
  coalesceObjectId,
  handleGenericCreate,
  handleGenericUpdate,
  handleGenericGetById,
  handleGenericGetAll,
} = require("../utils/modelHelper");
const { listApprovedVendorSyncPartnerIds } = require("../utils/vendorOrderSync");

async function order_itemCreate(req, res) {
  const response = await handleGenericCreate(req, "order_item", {
    afterCreate: async (record, req) => {
      console.log("✅ Record created successfully:", record);
    },
  });
  return res.status(response.status).json(response);
}

async function order_itemUpdate(req, res) {
  const response = await handleGenericUpdate(req, "order_item", {
    afterUpdate: async (record, req, existingUser) => {
      console.log("✅ Record updated successfully:", record);
    },
  });
  return res.status(response.status).json(response);
}

async function order_itemById(req, res) {
  const response = await handleGenericGetById(req, "order_item", {
    excludeFields: [], // Don't exclude any fields
    populate: [
      {
        path: "order_id",
        populate: {
          path: "user_id",
          select: "name email role", // Optional: select only specific user fields
        },
      },
    ],
  });
  return res.status(response.status).json(response);
}

async function getAllorder_item(req, res) {
  const response = await handleGenericGetAll(req, "order_item", {
    excludeFields: [], // Don't exclude any fields
    populate: [
      {
        path: "order_id",
        populate: {
          path: "user_id",
          // select: "name email role", // Optional: select only specific user fields
        },
      },
    ],
    sort: { createdAt: -1 }, // Sort by newest first
    limit: req.query.limit ? parseInt(req.query.limit) : null, // Support limit from query params
    skip: req.query.skip ? parseInt(req.query.skip) : 0, // Support skip from query params
  });
  return res.status(response.status).json(response);
}

/** Default reporting window when profit endpoints omit `from` and `to`. */
const FIND_PROFIT_DEFAULT_RANGE_DAYS = 90;

function resolveOrderItemReportCompanyId(req, res) {
  const rawCompany = req.user?.company_id;
  const companyId =
    rawCompany && typeof rawCompany === "object" && rawCompany._id ?
      rawCompany._id
    : rawCompany;
  if (!companyId) {
    res.status(400).json({
      success: false,
      status: 400,
      error: "company_id is required",
      message: "Authentication with company context is required",
    });
    return null;
  }

  const companyObjectId = coalesceObjectId(companyId);
  if (
    !companyObjectId ||
    !mongoose.Types.ObjectId.isValid(String(companyObjectId))
  ) {
    res.status(400).json({
      success: false,
      status: 400,
      error: "company_id is required",
      message: "Invalid company context",
    });
    return null;
  }

  return new mongoose.Types.ObjectId(String(companyObjectId));
}

function applyOrderItemCreatedAtFilter(req, match, defaultRangeDays) {
  const rawFrom =
    req.query?.from ?? req.query?.startDate ?? req.query?.start_date;
  const rawTo = req.query?.to ?? req.query?.endDate ?? req.query?.end_date;
  const hasFrom = rawFrom != null && String(rawFrom).trim() !== "";
  const hasTo = rawTo != null && String(rawTo).trim() !== "";

  if (!hasFrom && !hasTo) {
    const toDate = new Date();
    const fromDate = new Date(toDate);
    fromDate.setDate(fromDate.getDate() - defaultRangeDays);
    match.createdAt = { $gte: fromDate, $lte: toDate };
    return { from: fromDate, to: toDate, defaultRange: true };
  }

  match.createdAt = {};
  if (hasFrom) {
    const fromDate = new Date(String(rawFrom).trim());
    if (Number.isNaN(fromDate.getTime())) {
      return { error: "Invalid from date" };
    }
    match.createdAt.$gte = fromDate;
  }
  if (hasTo) {
    const toDate = new Date(String(rawTo).trim());
    if (Number.isNaN(toDate.getTime())) {
      return { error: "Invalid to date" };
    }
    match.createdAt.$lte = toDate;
  }

  return {
    from: match.createdAt.$gte ?? null,
    to: match.createdAt.$lte ?? null,
    defaultRange: false,
  };
}

/**
 * GET `SUM(profit)` from `order_item` for the authenticated user's `company_id`.
 * Only lines with a matching stock-out `inventory_movements` row (`reference_type: order`).
 * Query: `order_id`, `product_id`, optional `from` / `to` (or `startDate` / `endDate`) on line `createdAt`.
 * If both dates are omitted, only the last {@link FIND_PROFIT_DEFAULT_RANGE_DAYS} days are included.
 */
async function profitByOrderItem(req, res) {
  try {
    const cid = resolveOrderItemReportCompanyId(req, res);
    if (!cid) {
      return;
    }

    const match = {
      company_id: cid,
      status: "active",
      deletedAt: null,
    };

    const rawOrderId = req.query?.order_id ?? req.params?.order_id;
    if (rawOrderId != null && String(rawOrderId).trim() !== "") {
      const orderIdStr = String(rawOrderId).trim();
      if (!mongoose.Types.ObjectId.isValid(orderIdStr)) {
        return res.status(400).json({
          success: false,
          status: 400,
          error: "Invalid order_id",
        });
      }
      match.order_id = new mongoose.Types.ObjectId(orderIdStr);
    }

    const rawProductId = req.query?.product_id;
    if (rawProductId != null && String(rawProductId).trim() !== "") {
      const productIdStr = String(rawProductId).trim();
      if (!mongoose.Types.ObjectId.isValid(productIdStr)) {
        return res.status(400).json({
          success: false,
          status: 400,
          error: "Invalid product_id",
        });
      }
      match.product_id = new mongoose.Types.ObjectId(productIdStr);
    }

    const dateFilter = applyOrderItemCreatedAtFilter(
      req,
      match,
      FIND_PROFIT_DEFAULT_RANGE_DAYS,
    );
    if (dateFilter?.error) {
      return res.status(400).json({
        success: false,
        status: 400,
        error: dateFilter.error,
      });
    }

    const rows = await OrderItem.aggregate([
      { $match: match },
      {
        $lookup: {
          from: "inventory_movements",
          let: {
            orderId: "$order_id",
            productId: "$product_id",
            companyId: "$company_id",
          },
          pipeline: [
            {
              $match: {
                status: "active",
                $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
              },
            },
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$company_id", "$$companyId"] },
                    { $eq: ["$product_id", "$$productId"] },
                    { $eq: ["$reference_id", "$$orderId"] },
                    { $eq: ["$reference_type", "order"] },
                    {
                      $eq: [
                        { $toLower: { $ifNull: ["$movement_type", ""] } },
                        "out",
                      ],
                    },
                  ],
                },
              },
            },
            { $limit: 1 },
          ],
          as: "out_movements",
        },
      },
      { $match: { "out_movements.0": { $exists: true } } },
      {
        $group: {
          _id: null,
          profit: { $sum: { $ifNull: ["$profit", 0] } },
          subtotal: { $sum: { $ifNull: ["$subtotal", 0] } },
          line_count: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          profit: { $round: ["$profit", 2] },
          subtotal: { $round: ["$subtotal", 2] },
          line_count: 1,
        },
      },
    ]);

    const profit = rows[0]?.profit ?? 0;
    const subtotal = rows[0]?.subtotal ?? 0;
    const line_count = rows[0]?.line_count ?? 0;

    return res.status(200).json({
      success: true,
      status: 200,
      company_id: String(cid),
      profit,
      subtotal,
      line_count,
      filters: {
        order_id: match.order_id ? String(match.order_id) : null,
        product_id: match.product_id ? String(match.product_id) : null,
        from: dateFilter.from ? dateFilter.from.toISOString() : null,
        to: dateFilter.to ? dateFilter.to.toISOString() : null,
        default_range_days: dateFilter.defaultRange ?
          FIND_PROFIT_DEFAULT_RANGE_DAYS
        : null,
      },
    });
  } catch (error) {
    console.error("❌ profitByOrderItem:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      error: error.message || "Internal server error",
    });
  }
}

/** Default reporting window when GET …/cost-of-goods-sold-by-order-item omits `from` and `to`. */
const FIND_COGS_DEFAULT_RANGE_DAYS = 365;

/**
 * GET cost of goods sold: `SUM(cost_price_at_sale * qty)` from `order_item` for the user's company.
 * Only lines with a matching `inventory_movements` row (`movement_type: "out"`).
 * Query: `order_id`, `product_id`, optional `from` / `to` on line `createdAt`.
 * If both dates are omitted, only the last {@link FIND_COGS_DEFAULT_RANGE_DAYS} days are included.
 */
async function costOfGoodsSoldByOrderItem(req, res) {
  try {
    const rawCompany = req.user?.company_id;
    const companyId =
      rawCompany && typeof rawCompany === "object" && rawCompany._id ?
        rawCompany._id
      : rawCompany;
    if (!companyId) {
      return res.status(400).json({
        success: false,
        status: 400,
        error: "company_id is required",
        message: "Authentication with company context is required",
      });
    }

    const companyObjectId = coalesceObjectId(companyId);
    if (
      !companyObjectId ||
      !mongoose.Types.ObjectId.isValid(String(companyObjectId))
    ) {
      return res.status(400).json({
        success: false,
        status: 400,
        error: "company_id is required",
        message: "Invalid company context",
      });
    }

    const cid = new mongoose.Types.ObjectId(String(companyObjectId));
    const match = {
      company_id: cid,
      status: "active",
      deletedAt: null,
    };

    const rawOrderId = req.query?.order_id ?? req.params?.order_id;
    if (rawOrderId != null && String(rawOrderId).trim() !== "") {
      const orderIdStr = String(rawOrderId).trim();
      if (!mongoose.Types.ObjectId.isValid(orderIdStr)) {
        return res.status(400).json({
          success: false,
          status: 400,
          error: "Invalid order_id",
        });
      }
      match.order_id = new mongoose.Types.ObjectId(orderIdStr);
    }

    const rawProductId = req.query?.product_id;
    if (rawProductId != null && String(rawProductId).trim() !== "") {
      const productIdStr = String(rawProductId).trim();
      if (!mongoose.Types.ObjectId.isValid(productIdStr)) {
        return res.status(400).json({
          success: false,
          status: 400,
          error: "Invalid product_id",
        });
      }
      match.product_id = new mongoose.Types.ObjectId(productIdStr);
    }

    const rawFrom =
      req.query?.from ?? req.query?.startDate ?? req.query?.start_date;
    const rawTo = req.query?.to ?? req.query?.endDate ?? req.query?.end_date;
    const hasFrom = rawFrom != null && String(rawFrom).trim() !== "";
    const hasTo = rawTo != null && String(rawTo).trim() !== "";

    if (!hasFrom && !hasTo) {
      const toDate = new Date();
      const fromDate = new Date(toDate);
      fromDate.setDate(fromDate.getDate() - FIND_COGS_DEFAULT_RANGE_DAYS);
      match.createdAt = { $gte: fromDate, $lte: toDate };
    } else {
      match.createdAt = {};
      if (hasFrom) {
        const fromDate = new Date(String(rawFrom).trim());
        if (Number.isNaN(fromDate.getTime())) {
          return res.status(400).json({
            success: false,
            status: 400,
            error: "Invalid from date",
          });
        }
        match.createdAt.$gte = fromDate;
      }
      if (hasTo) {
        const toDate = new Date(String(rawTo).trim());
        if (Number.isNaN(toDate.getTime())) {
          return res.status(400).json({
            success: false,
            status: 400,
            error: "Invalid to date",
          });
        }
        match.createdAt.$lte = toDate;
      }
    }

    const lineCostExpr = {
      $multiply: [
        { $ifNull: ["$cost_price_at_sale", 0] },
        {
          $convert: {
            input: "$qty",
            to: "double",
            onError: 0,
            onNull: 0,
          },
        },
      ],
    };

    /*
     * Correlated $lookup per order line — stock-out proof; O(lines) subqueries at scale.
     * Prefer denormalized line fields (cost_price_at_sale) when business rules allow.
     * Subpipeline is tenant-scoped via $$companyId in $expr.
     */
    const rows = await OrderItem.aggregate([
      { $match: match },
      {
        $lookup: {
          from: "inventory_movements",
          let: {
            orderId: "$order_id",
            productId: "$product_id",
            companyId: "$company_id",
          },
          pipeline: [
            {
              $match: {
                status: "active",
                $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
              },
            },
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$company_id", "$$companyId"] },
                    { $eq: ["$product_id", "$$productId"] },
                    { $eq: ["$reference_id", "$$orderId"] },
                    { $eq: ["$reference_type", "order"] },
                    {
                      $eq: [
                        { $toLower: { $ifNull: ["$movement_type", ""] } },
                        "out",
                      ],
                    },
                  ],
                },
              },
            },
            { $limit: 1 },
          ],
          as: "out_movements",
        },
      },
      { $match: { "out_movements.0": { $exists: true } } },
      /*
       * Scalar $group only — do not $push line _id values (MongoDB 16MB aggregation output
       * cap; multi-tenant line volume can exceed BSON limits). Default createdAt window
       * above limits scan when from/to are omitted. Use paginated OrderItem.find for id lists.
       */
      {
        $group: {
          _id: null,
          cost_of_goods_sold: { $sum: lineCostExpr },
          line_count: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          cost_of_goods_sold: { $round: ["$cost_of_goods_sold", 2] },
          line_count: 1,
        },
      },
    ]);

    const cost_of_goods_sold = rows[0]?.cost_of_goods_sold ?? 0;
    const line_count = rows[0]?.line_count ?? 0;

    return res.status(200).json({
      success: true,
      status: 200,
      company_id: String(cid),
      cost_of_goods_sold,
      line_count,
    });
  } catch (error) {
    console.error("❌ costOfGoodsSoldByOrderItem:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      error: error.message || "Internal server error",
    });
  }
}

/**
 * GET order lines whose origin catalog is the authenticated company (A).
 * `company_id` on the line is the selling (buyer) company; `origin_company_id` is A.
 *
 * Query: skip, limit, product_id, company_id (or buyer_company_id),
 * mark_as_delivered_by_vendor, search, from, to,
 * include_own=1 (also return A's own POS lines; default is partner sales only).
 * Partner lines are limited to approved connections with `sync_order_to_vendor=yes`.
 * Lines with `hide_by_vendor: true` are never returned.
 */
async function getOrderItemsByOriginCompany(req, res) {
  try {
    const cid = resolveOrderItemReportCompanyId(req, res);
    if (!cid) return;

    const includeOwn =
      req.query.include_own === "1" ||
      req.query.include_own === "true" ||
      req.query.includeOwn === "1";

    const filter = {
      origin_company_id: cid,
      status: "active",
      deletedAt: null,
      hide_by_vendor: { $ne: true },
    };

    const partnerIds = await listApprovedVendorSyncPartnerIds(cid);
    const allowedBuyerIds = includeOwn ? [...partnerIds, cid] : partnerIds;

    const rawBuyerCompany = req.query.company_id ?? req.query.buyer_company_id;
    if (rawBuyerCompany != null && String(rawBuyerCompany).trim() !== "") {
      const buyerCompanyId = coalesceObjectId(rawBuyerCompany);
      if (!(buyerCompanyId instanceof mongoose.Types.ObjectId)) {
        return res.status(400).json({
          success: false,
          status: 400,
          error: "Invalid company_id",
        });
      }
      const isAllowed = allowedBuyerIds.some(
        (id) => String(id) === String(buyerCompanyId),
      );
      filter.company_id = isAllowed ? buyerCompanyId : { $in: [] };
    } else {
      filter.company_id = { $in: allowedBuyerIds };
    }

    const rawDelivered =
      req.query.mark_as_delivered_by_vendor ??
      req.query.markAsDeliveredByVendor;
    if (rawDelivered != null && String(rawDelivered).trim() !== "") {
      const delivered = parseVendorBooleanFlag(rawDelivered);
      filter.mark_as_delivered_by_vendor = delivered
        ? { $in: [true, "true", "yes", 1, "1"] }
        : { $nin: [true, "true", "yes", 1, "1"] };
    }

    const rawProductId = req.query.product_id;
    if (rawProductId != null && String(rawProductId).trim() !== "") {
      const productIdStr = String(rawProductId).trim();
      if (!mongoose.Types.ObjectId.isValid(productIdStr)) {
        return res.status(400).json({
          success: false,
          status: 400,
          error: "Invalid product_id",
        });
      }
      filter.product_id = new mongoose.Types.ObjectId(productIdStr);
    }

    const rawFrom =
      req.query.from ?? req.query.startDate ?? req.query.start_date;
    const rawTo = req.query.to ?? req.query.endDate ?? req.query.end_date;
    const hasFrom = rawFrom != null && String(rawFrom).trim() !== "";
    const hasTo = rawTo != null && String(rawTo).trim() !== "";
    if (hasFrom || hasTo) {
      filter.createdAt = {};
      if (hasFrom) {
        const fromDate = new Date(String(rawFrom).trim());
        if (Number.isNaN(fromDate.getTime())) {
          return res.status(400).json({
            success: false,
            status: 400,
            error: "Invalid from date",
          });
        }
        filter.createdAt.$gte = fromDate;
      }
      if (hasTo) {
        const toDate = new Date(String(rawTo).trim());
        if (Number.isNaN(toDate.getTime())) {
          return res.status(400).json({
            success: false,
            status: 400,
            error: "Invalid to date",
          });
        }
        filter.createdAt.$lte = toDate;
      }
    }

    const search = String(req.query.search || "").trim();
    if (search) {
      filter.name = {
        $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        $options: "i",
      };
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);

    let rows = [];
    let total = 0;
    try {
      [rows, total] = await Promise.all([
        OrderItem.find(filter)
          .populate("product_id", "product_name sku product_code")
          .populate("company_id", "company_name company_logo")
          .populate("origin_company_id", "company_name company_logo")
          .populate("order_id", "order_no order_status total_amount")
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        OrderItem.countDocuments(filter),
      ]);
    } catch (queryErr) {
      console.warn(
        "[order_item] by-origin-company populate failed, retrying without populate:",
        queryErr?.message || queryErr,
      );
      [rows, total] = await Promise.all([
        OrderItem.find(filter)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        OrderItem.countDocuments(filter),
      ]);
    }

    return res.status(200).json({
      success: true,
      status: 200,
      data: rows,
      total,
      skip,
      limit,
      origin_company_id: String(cid),
    });
  } catch (error) {
    console.error("❌ getOrderItemsByOriginCompany:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      error: error.message || "Failed to list origin order items",
    });
  }
}

function parseVendorBooleanFlag(value) {
  if (value === undefined || value === null || value === "") return true;
  if (value === true || value === "true" || value === 1 || value === "1") {
    return true;
  }
  if (value === false || value === "false" || value === 0 || value === "0") {
    return false;
  }
  return Boolean(value);
}

async function loadOriginOrderItemForVendor(req, res) {
  const cid = resolveOrderItemReportCompanyId(req, res);
  if (!cid) return null;

  const rawId =
    req.params.id ||
    req.params.order_item_id ||
    req.body?.order_item_id ||
    req.body?.id;
  const idStr = String(rawId || "").trim();
  if (!idStr || !mongoose.Types.ObjectId.isValid(idStr) || idStr.length !== 24) {
    res.status(400).json({
      success: false,
      status: 400,
      error: "Invalid order_item id",
      message: "A valid order_item id is required",
    });
    return null;
  }

  const item = await OrderItem.findOne({
    _id: idStr,
    origin_company_id: cid,
    deletedAt: null,
  });
  if (!item) {
    res.status(404).json({
      success: false,
      status: 404,
      error: "Order item not found",
      message: "Order item not found for this vendor",
    });
    return null;
  }

  return item;
}

/**
 * PATCH/POST `/order_item/hide/:id`
 * Vendor (origin company) hides or unhides a sold line via `hide_by_vendor`.
 * Body: optional `{ hide_by_vendor: true|false }` (defaults to true).
 */
async function hideOrderItemByVendor(req, res) {
  try {
    const item = await loadOriginOrderItemForVendor(req, res);
    if (!item) return;

    const hideByVendor = parseVendorBooleanFlag(
      req.body?.hide_by_vendor ?? req.body?.hide,
    );

    item.hide_by_vendor = hideByVendor;
    if (req.user?._id) {
      item.updated_by = req.user._id;
    }
    await item.save();

    return res.status(200).json({
      success: true,
      status: 200,
      message: hideByVendor
        ? "Order item hidden by vendor"
        : "Order item unhidden by vendor",
      data: item,
    });
  } catch (error) {
    console.error("❌ hideOrderItemByVendor:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      error: error.message || "Failed to hide order item",
    });
  }
}

/**
 * PATCH/POST `/order_item/mark-as-delivered/:id`
 * Vendor (origin company) marks or unmarks a sold line as delivered.
 * Body: optional `{ mark_as_delivered_by_vendor: true|false }` (defaults to true).
 */
async function markOrderItemDeliveredByVendor(req, res) {
  try {
    const item = await loadOriginOrderItemForVendor(req, res);
    if (!item) return;

    const markedDelivered = parseVendorBooleanFlag(
      req.body?.mark_as_delivered_by_vendor ??
        req.body?.delivered ??
        req.body?.mark_as_delivered,
    );

    item.mark_as_delivered_by_vendor = markedDelivered;
    if (req.user?._id) {
      item.updated_by = req.user._id;
    }
    await item.save();

    return res.status(200).json({
      success: true,
      status: 200,
      message: markedDelivered
        ? "Order item marked as delivered by vendor"
        : "Order item unmarked as delivered by vendor",
      data: item,
    });
  } catch (error) {
    console.error("❌ markOrderItemDeliveredByVendor:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      error: error.message || "Failed to mark order item delivered",
    });
  }
}

const BULK_VENDOR_ORDER_ITEM_LIMIT = 200;

function collectOrderItemIdsFromRequest(req) {
  const raw =
    req.body?.ids ??
    req.body?.order_item_ids ??
    req.body?.order_items ??
    req.body?.id ??
    req.query?.ids ??
    req.query?.order_item_ids;
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(/[,\s]+/)
      : raw != null
        ? [raw]
        : [];
  const ids = [];
  const seen = new Set();
  for (const entry of list) {
    const idStr = String(
      entry && typeof entry === "object"
        ? entry._id || entry.id || entry.order_item_id || ""
        : entry || "",
    ).trim();
    if (!idStr || seen.has(idStr)) continue;
    seen.add(idStr);
    ids.push(idStr);
  }
  return ids;
}

/**
 * PATCH/POST `/order_item/bulk-mark-as-delivered`
 * Vendor marks or unmarks many origin lines as delivered.
 * Body: `{ ids: string[], mark_as_delivered_by_vendor?: true|false }`
 * (flag defaults to true). Max 200 ids.
 */
async function bulkMarkOrderItemsDeliveredByVendor(req, res) {
  try {
    const cid = resolveOrderItemReportCompanyId(req, res);
    if (!cid) return;

    const ids = collectOrderItemIdsFromRequest(req);
    if (!ids.length) {
      return res.status(400).json({
        success: false,
        status: 400,
        error: "ids is required",
        message: "Provide order_item ids to mark as delivered",
      });
    }
    if (ids.length > BULK_VENDOR_ORDER_ITEM_LIMIT) {
      return res.status(400).json({
        success: false,
        status: 400,
        error: "Too many ids",
        message: `A maximum of ${BULK_VENDOR_ORDER_ITEM_LIMIT} order items can be updated at once`,
      });
    }

    const invalidIds = ids.filter(
      (idStr) =>
        !mongoose.Types.ObjectId.isValid(idStr) || idStr.length !== 24,
    );
    if (invalidIds.length) {
      return res.status(400).json({
        success: false,
        status: 400,
        error: "Invalid order_item id",
        message: "One or more order_item ids are invalid",
        invalid_ids: invalidIds,
      });
    }

    const objectIds = ids.map((idStr) => new mongoose.Types.ObjectId(idStr));
    const markedDelivered = parseVendorBooleanFlag(
      req.body?.mark_as_delivered_by_vendor ??
        req.body?.delivered ??
        req.body?.mark_as_delivered,
    );

    const filter = {
      _id: { $in: objectIds },
      origin_company_id: cid,
      deletedAt: null,
    };
    const set = { mark_as_delivered_by_vendor: markedDelivered };
    if (req.user?._id) {
      set.updated_by = req.user._id;
    }

    const result = await OrderItem.updateMany(filter, { $set: set });
    const updatedItems = await OrderItem.find(filter).select("_id").lean();
    const updatedIdSet = new Set(updatedItems.map((row) => String(row._id)));
    const notFound = ids.filter((idStr) => !updatedIdSet.has(idStr));

    return res.status(200).json({
      success: true,
      status: 200,
      message: markedDelivered
        ? "Order items marked as delivered by vendor"
        : "Order items unmarked as delivered by vendor",
      mark_as_delivered_by_vendor: markedDelivered,
      requested: ids.length,
      updated: result.modifiedCount ?? result.nModified ?? updatedItems.length,
      matched: result.matchedCount ?? updatedItems.length,
      not_found: notFound,
    });
  } catch (error) {
    console.error("❌ bulkMarkOrderItemsDeliveredByVendor:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      error: error.message || "Failed to bulk mark order items delivered",
    });
  }
}

module.exports = {
  order_itemCreate,
  order_itemUpdate,
  order_itemById,
  getAllorder_item,
  costOfGoodsSoldByOrderItem,
  profitByOrderItem,
  getOrderItemsByOriginCompany,
  hideOrderItemByVendor,
  markOrderItemDeliveredByVendor,
  bulkMarkOrderItemsDeliveredByVendor,
};
