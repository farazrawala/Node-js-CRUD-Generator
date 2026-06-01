const mongoose = require("mongoose");
const OrderItem = require("../models/order_item");
const {
  coalesceObjectId,
  handleGenericCreate,
  handleGenericUpdate,
  handleGenericGetById,
  handleGenericGetAll,
} = require("../utils/modelHelper");

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

    const hasFrom =
      req.query?.from != null && String(req.query.from).trim() !== "";
    const hasTo = req.query?.to != null && String(req.query.to).trim() !== "";

    if (!hasFrom && !hasTo) {
      const toDate = new Date();
      const fromDate = new Date(toDate);
      fromDate.setDate(fromDate.getDate() - FIND_COGS_DEFAULT_RANGE_DAYS);
      match.createdAt = { $gte: fromDate, $lte: toDate };
    } else {
      match.createdAt = {};
      if (hasFrom) {
        const fromDate = new Date(String(req.query.from).trim());
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
        const toDate = new Date(String(req.query.to).trim());
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

module.exports = {
  order_itemCreate,
  order_itemUpdate,
  order_itemById,
  getAllorder_item,
  costOfGoodsSoldByOrderItem,
};
