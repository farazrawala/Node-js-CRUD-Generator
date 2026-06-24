const mongoose = require("mongoose");

const Product = require("../models/product");

const Alerts = require("../models/alerts");

const { coalesceObjectId } = require("../utils/modelHelper");

const { createApplicationLog } = require("../utils/applicationLogs");

function companyIdMatch(value) {
  const co = coalesceObjectId(value);

  if (!co) return null;

  const str = String(co);

  if (!mongoose.Types.ObjectId.isValid(str)) return null;

  return { $in: [new mongoose.Types.ObjectId(str), str] };
}

function queryWithSession(query, session) {
  return session ? query.session(session) : query;
}

/**

 * Low-stock when on-hand <= threshold.

 * - Threshold: `product.alert_qty` when > 0, else `pathQty`.

 * - On-hand: `onHand` (e.g. post-sale `product.stock` or POS remaining qty).

 *

 * @param {{

 *   req?: import("express").Request | null,

 *   productId: string,

 *   companyId?: unknown,

 *   onHand: number,

 *   pathQty?: number,

 *   session?: import("mongoose").ClientSession | null,

 *   logUrl?: string,

 *   logTags?: string[],

 * }} params

 */

async function evaluateProductStockAlert({
  req = null,

  productId,

  companyId: companyIdParam = null,

  onHand,

  pathQty = null,

  session = null,

  logUrl = null,

  logTags = [],
}) {
  const productIdStr = String(productId ?? "").trim();

  const onHandNum = Number(onHand);

  const pathQtyNum =
    pathQty != null && Number.isFinite(Number(pathQty)) ?
      Number(pathQty)
    : onHandNum;

  if (!productIdStr || !mongoose.Types.ObjectId.isValid(productIdStr)) {
    return {
      success: false,

      status: 400,

      error: "Invalid product id",

      details: "Provide a valid product_id",

      type: "validation",
    };
  }

  if (!Number.isFinite(onHandNum)) {
    return {
      success: false,

      status: 400,

      error: "Invalid on-hand qty",

      details: "Provide a numeric on-hand quantity",

      type: "validation",
    };
  }

  const companySource = companyIdParam ?? req?.user?.company_id;

  const companyId = coalesceObjectId(companySource);

  const companyFilter = companyIdMatch(companySource);

  if (!companyFilter) {
    return {
      success: false,

      status: 400,

      error: "company_id is required",

      message: "Company context is required for stock alerts",
    };
  }

  const product = await queryWithSession(
    Product.findOne({
      _id: productIdStr,

      company_id: companyFilter,

      status: "active",

      deletedAt: null,
    }).select("product_name product_code alert_qty stock sku"),

    session,
  ).lean();

  if (!product) {
    return {
      success: false,

      status: 404,

      error: "Product not found",

      message: "Product not found for this company",

      product_id: productIdStr,
    };
  }

  const productAlertQty = Number(product.alert_qty) || 0;

  const alertThreshold = productAlertQty > 0 ? productAlertQty : pathQtyNum;

  const lowStock = alertThreshold > 0 && onHandNum <= alertThreshold;

  let alertRecord = null;

  let alertSkipped = null;

  let alertCreated = false;

  let alertDeleted = false;

  const alertQueryOpts = session ? { session } : {};

  if (lowStock) {
    const existingAlert = await queryWithSession(
      Alerts.findOne({
        product_id: productIdStr,

        company_id: companyFilter,

        status: "active",

        deletedAt: null,
      }),

      session,
    ).lean();

    if (existingAlert) {
      alertSkipped = "existing_active_alert";

      alertRecord = existingAlert;
    } else {
      const createDoc = {
        product_id: productIdStr,

        company_id: new mongoose.Types.ObjectId(String(companyId)),

        status: "active",

        deletedAt: null,
      };

      const createdBy = coalesceObjectId(req?.user?._id);

      if (createdBy) {
        createDoc.created_by = new mongoose.Types.ObjectId(String(createdBy));
      }

      const created = await Alerts.create([createDoc], alertQueryOpts);

      alertRecord = created[0];

      alertCreated = true;
    }
  } else if (alertThreshold > 0) {
    const softDeleteSet = { deletedAt: new Date(), status: "inactive" };

    const updatedBy = coalesceObjectId(req?.user?._id);

    if (updatedBy) {
      softDeleteSet.updated_by = new mongoose.Types.ObjectId(String(updatedBy));
    }

    const cleared = await Alerts.findOneAndUpdate(
      {
        product_id: productIdStr,

        company_id: companyFilter,

        status: "active",

        deletedAt: null,
      },

      { $set: softDeleteSet },

      { new: true, ...alertQueryOpts },
    ).lean();

    if (cleared) {
      alertRecord = cleared;

      alertDeleted = true;
    }
  }

  if (alertThreshold > 0) {
    const nameLabel =
      String(product.product_name || "").trim() || `id ${productIdStr}`;

    const logMessage =
      lowStock ?
        `${nameLabel} ${onHandNum} qty alert is generated`
      : `${nameLabel} is above threshold`;

    await createApplicationLog(
      req,

      {
        action: lowStock ? "Stock alert check (low)" : "Stock alert check (ok)",

        url:
          logUrl ||
          req?.originalUrl ||
          req?.path ||
          "/api/alerts/check-product-alert",

        tags: ["stock_alert", ...logTags],

        description: logMessage,

        reference_id: productIdStr,
        reference_type: "product",
        company_id: companyId,
      },

      { silent: true, session },
    );
  }

  const thresholdSource =
    productAlertQty > 0 ? "product.alert_qty" : "path_qty";

  return {
    success: true,

    status: 200,

    product_id: productIdStr,

    product_name: product.product_name,

    product_code: product.product_code,

    sku: product.sku,

    alert_qty: productAlertQty,

    alert_threshold: alertThreshold,

    threshold_source: thresholdSource,

    on_hand: onHandNum,

    on_hand_source: "caller",

    product_stock: Number(product.stock) || 0,

    path_qty: pathQtyNum,

    low_stock: lowStock,

    alert_created: alertCreated,

    alert_deleted: alertDeleted,

    alert_skipped: alertSkipped,

    alert: alertRecord,

    message:
      alertThreshold <= 0 ?
        "No alert threshold (set product.alert_qty or pass a positive qty)."
      : lowStock ?
        `Low stock: ${onHandNum} on hand is at or below threshold ${alertThreshold}.`
      : `Stock OK: ${onHandNum} on hand is above threshold ${alertThreshold}.`,
  };
}

/**

 * GET /api/alerts/check-product-alert/:product_id/:qty

 *

 * Low-stock when on-hand <= threshold.

 * - Threshold: `product.alert_qty` when > 0, else path `:qty`.

 * - On-hand: `?on_hand=` / `?stock=` if set; else path `:qty` (remaining qty from POS/cart).

 */

async function checkProductAlert(req, res) {
  try {
    const productIdStr = String(req.params?.product_id ?? "").trim();

    const pathQty = Number(req.params?.qty);

    if (!productIdStr || !mongoose.Types.ObjectId.isValid(productIdStr)) {
      return res.status(400).json({
        success: false,

        status: 400,

        error: "Invalid product id",

        details: "Provide a valid product_id in the URL",

        type: "validation",
      });
    }

    if (!Number.isFinite(pathQty)) {
      return res.status(400).json({
        success: false,

        status: 400,

        error: "Invalid qty",

        details: "Provide a numeric qty in the URL path",

        type: "validation",
      });
    }

    const queryOnHandRaw = req.query?.on_hand ?? req.query?.stock;

    let onHand = pathQty;

    let onHandSource = "path_qty";

    if (queryOnHandRaw != null && Number.isFinite(Number(queryOnHandRaw))) {
      onHand = Number(queryOnHandRaw);

      onHandSource = "query";
    }

    const result = await evaluateProductStockAlert({
      req,
      productId: productIdStr,
      onHand,
      pathQty,
    });

    if (!result.success) {
      return res.status(result.status || 400).json(result);
    }

    return res.status(200).json({
      ...result,

      on_hand_source: onHandSource,

      threshold_source: result.threshold_source,
    });
  } catch (err) {
    console.error("checkProductAlert:", err);

    return res.status(500).json({
      success: false,

      status: 500,

      error: err.message || "Internal server error",
    });
  }
}

/**
 * GET /api/alerts/low-stock
 * List products at or below `alert_qty` for the authenticated company.
 * Query: `skip`, `limit` (default 50, max 200), optional `mode=live` (default) | `records`.
 * - live: current stock vs alert_qty on product rows
 * - records: active rows in `alerts` collection (may include stale items until next stock sync)
 */
async function getLowStockAlerts(req, res) {
  try {
    const companyFilter = companyIdMatch(req.user?.company_id);
    if (!companyFilter) {
      return res.status(400).json({
        success: false,
        status: 400,
        error: "company_id is required",
        message: "Company context is required for stock alerts",
      });
    }

    const companyId = coalesceObjectId(req.user?.company_id);
    const skip = Math.max(0, parseInt(req.query?.skip, 10) || 0);
    const limitRaw = parseInt(req.query?.limit, 10);
    const limit = limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
    const mode = String(req.query?.mode || "live").trim().toLowerCase();

    const productSelect =
      "product_name product_code sku barcode alert_qty stock product_price wholesale_price product_image unit";

    function mapProductRow(product, alertRecord = null) {
      const onHand = Number(product?.stock) || 0;
      const alertQty = Number(product?.alert_qty) || 0;
      return {
        alert_id: alertRecord?._id ?? null,
        product_id: product?._id ?? null,
        product_name: product?.product_name ?? null,
        product_code: product?.product_code ?? null,
        sku: product?.sku ?? null,
        barcode: product?.barcode ?? null,
        unit: product?.unit ?? null,
        on_hand: onHand,
        alert_qty: alertQty,
        shortage: Math.max(0, alertQty - onHand),
        product_price: product?.product_price ?? 0,
        wholesale_price: product?.wholesale_price ?? 0,
        product_image: product?.product_image ?? null,
        low_stock: alertQty > 0 && onHand <= alertQty,
        alert_created_at: alertRecord?.createdAt ?? null,
      };
    }

    if (mode === "records") {
      const alertFilter = {
        company_id: companyFilter,
        status: "active",
        deletedAt: null,
      };

      const [total, alertRows] = await Promise.all([
        Alerts.countDocuments(alertFilter),
        Alerts.find(alertFilter)
          .sort({ updatedAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
      ]);

      const productIds = [
        ...new Set(
          alertRows
            .map((row) => String(row.product_id || "").trim())
            .filter((id) => mongoose.Types.ObjectId.isValid(id)),
        ),
      ];

      const products = productIds.length
        ? await Product.find({
            _id: { $in: productIds },
            company_id: companyFilter,
            deletedAt: null,
          })
            .select(productSelect)
            .lean()
        : [];

      const productMap = new Map(products.map((p) => [String(p._id), p]));
      const data = alertRows.map((alertRow) => {
        const product = productMap.get(String(alertRow.product_id));
        return mapProductRow(product, alertRow);
      });

      return res.status(200).json({
        success: true,
        status: 200,
        company_id: String(companyId),
        mode: "records",
        total,
        skip,
        limit,
        count: data.length,
        summary: { low_stock_count: total },
        data,
      });
    }

    const productFilter = {
      company_id: companyFilter,
      status: "active",
      deletedAt: null,
      alert_qty: { $gt: 0 },
      $expr: {
        $lte: [{ $ifNull: ["$stock", 0] }, "$alert_qty"],
      },
    };

    const [total, products] = await Promise.all([
      Product.countDocuments(productFilter),
      Product.find(productFilter)
        .select(productSelect)
        .sort({ stock: 1, product_name: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    const productIds = products.map((p) => String(p._id));
    const alertRows = productIds.length
      ? await Alerts.find({
          product_id: { $in: productIds },
          company_id: companyFilter,
          status: "active",
          deletedAt: null,
        }).lean()
      : [];
    const alertByProduct = new Map(
      alertRows.map((row) => [String(row.product_id), row]),
    );

    const data = products.map((product) =>
      mapProductRow(product, alertByProduct.get(String(product._id)) || null),
    );

    return res.status(200).json({
      success: true,
      status: 200,
      company_id: String(companyId),
      mode: "live",
      total,
      skip,
      limit,
      count: data.length,
      summary: { low_stock_count: total },
      data,
    });
  } catch (err) {
    console.error("getLowStockAlerts:", err);
    return res.status(500).json({
      success: false,
      status: 500,
      error: err.message || "Internal server error",
    });
  }
}

module.exports = {
  checkProductAlert,
  getLowStockAlerts,
  evaluateProductStockAlert,
};
