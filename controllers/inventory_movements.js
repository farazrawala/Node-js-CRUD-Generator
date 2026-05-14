const mongoose = require("mongoose");
const {
  handleGenericCreate,
  handleGenericGetById,
  handleGenericUpdate,
  coalesceObjectId,
} = require("../utils/modelHelper");
const { createApplicationLog } = require("../utils/applicationLogs");
const {
  isMongoTransactionUnsupportedError,
} = require("../utils/mongoTransactionSupport");
const InventoryMovements = require("../models/inventory_movements");
const Product = require("../models/product");

function toFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Net on-hand from **inventory_movements** (sum `in` qty − sum `out` qty) per `product_id`,
 * times each product’s `wholesale_price`. Same response shape as `product` COGS helper.
 *
 * Optional filter: `?product_id=` or `?id=` (Mongo ObjectId).
 */
async function cost_of_goods_available(req, res) {
  try {
    const rawCompany = req.user?.company_id;
    const companyId =
      rawCompany && typeof rawCompany === "object" && rawCompany._id ?
        rawCompany._id
      : rawCompany;
    if (!companyId) {
      return res.status(400).json({
        success: false,
        message: "company_id is required",
      });
    }

    const companyObjectId = coalesceObjectId(companyId);
    if (
      !companyObjectId ||
      !mongoose.Types.ObjectId.isValid(String(companyObjectId))
    ) {
      return res.status(400).json({
        success: false,
        message: "company_id is required",
      });
    }

    const rawProductFilter =
      req.query?.product_id ?? req.query?.id ?? req.params?.id;
    const productIdFilter =
      (
        rawProductFilter &&
        mongoose.Types.ObjectId.isValid(String(rawProductFilter).trim())
      ) ?
        new mongoose.Types.ObjectId(String(rawProductFilter).trim())
      : null;

    if (rawProductFilter && !productIdFilter) {
      return res.status(400).json({
        success: false,
        message: "Invalid product id",
      });
    }

    const movementMatch = {
      company_id: companyObjectId,
      status: "active",
      // Exclude soft-deleted rows (deletedAt is a Date). Plain operators — reliable in $aggregate $match.
      $nor: [{ deletedAt: { $type: "date" } }],
    };
    if (productIdFilter) {
      movementMatch.product_id = productIdFilter;
    }

    const rows = await InventoryMovements.aggregate([
      { $match: movementMatch },
      {
        $group: {
          _id: "$product_id",
          qty_in: {
            $sum: {
              $cond: [
                { $eq: ["$movement_type", "in"] },
                { $ifNull: ["$quantity", 0] },
                0,
              ],
            },
          },
          qty_out: {
            $sum: {
              $cond: [
                { $eq: ["$movement_type", "out"] },
                { $ifNull: ["$quantity", 0] },
                0,
              ],
            },
          },
        },
      },
      {
        $addFields: {
          net_qty: { $subtract: ["$qty_in", "$qty_out"] },
        },
      },
      { $sort: { net_qty: -1 } },
    ]);

    if (productIdFilter) {
      const exists = await Product.exists({
        _id: productIdFilter,
        company_id: companyObjectId,
        deletedAt: null,
      });
      if (!exists) {
        return res.status(404).json({
          success: false,
          message: "Product not found",
        });
      }
      if (rows.length === 0) {
        const productDoc = await Product.findById(productIdFilter)
          .select("product_name sku wholesale_price product_code")
          .lean();
        const wholesaleUnit = Number(productDoc?.wholesale_price);
        const wholesale_price =
          Number.isFinite(wholesaleUnit) ? wholesaleUnit : 0;
        return res.status(200).json({
          success: true,
          count: 1,
          grand_total_cost_of_goods: 0,
          data: [
            {
              product_id: productIdFilter,
              product_name: productDoc?.product_name,
              product_code: productDoc?.product_code,
              sku: productDoc?.sku,
              total_qty: 0,
              wholesale_price,
              cost_of_goods_available: 0,
            },
          ],
        });
      }
    }

    if (!rows.length) {
      return res.status(200).json({
        success: true,
        count: 0,
        grand_total_cost_of_goods: 0,
        data: [],
      });
    }

    const productIds = rows.map((r) => r._id).filter(Boolean);
    const products = await Product.find({
      _id: { $in: productIds },
      company_id: companyObjectId,
      status: "active",
      deletedAt: null,
    })
      .select("product_name sku wholesale_price product_code")
      .lean();

    const productById = new Map(products.map((doc) => [String(doc._id), doc]));

    const data = [];
    for (const row of rows) {
      const productDoc = productById.get(String(row._id));
      if (!productDoc) continue;
      const netQty = Number(row.net_qty);
      const total_qty = Math.max(0, Number.isFinite(netQty) ? netQty : 0);
      const wholesaleUnit = Number(productDoc.wholesale_price);
      const wholesale_price =
        Number.isFinite(wholesaleUnit) ? wholesaleUnit : 0;
      const cost_of_goods_available =
        Math.round(total_qty * wholesale_price * 100) / 100;
      data.push({
        product_id: row._id,
        product_name: productDoc.product_name,
        product_code: productDoc.product_code,
        sku: productDoc.sku,
        total_qty,
        wholesale_price,
        cost_of_goods_available,
      });
    }

    if (productIdFilter && data.length === 0 && rows.length > 0) {
      const row = rows[0];
      const netQty = Number(row.net_qty);
      const total_qty = Math.max(0, Number.isFinite(netQty) ? netQty : 0);
      return res.status(200).json({
        success: true,
        count: 1,
        grand_total_cost_of_goods: 0,
        data: [
          {
            product_id: row._id,
            product_name: null,
            product_code: null,
            sku: null,
            total_qty,
            wholesale_price: 0,
            cost_of_goods_available: 0,
            note: "Movement ledger exists but product is missing or inactive for this company",
          },
        ],
      });
    }

    const grand_total_cost_of_goods =
      Math.round(
        data.reduce(
          (runningTotal, line) => runningTotal + line.cost_of_goods_available,
          0,
        ) * 100,
      ) / 100;

    return res.status(200).json({
      success: true,
      count: data.length,
      grand_total_cost_of_goods,
      data,
    });
  } catch (error) {
    console.error("❌ cost_of_goods_available:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error",
    });
  }
}

/**
 * Runs movement insert + optional product wholesale update in one logical unit.
 * When `session` is set, all reads/writes use it so `withTransaction` can roll back on failure.
 * @returns {{ response: object, consoleLog: string[], logWholesale: null | { productName: string, previousWholesale: unknown, nextWholesale: unknown } }}
 */
async function runInventoryMovementTxnBody(req, session) {
  const { match, pid, productId } = (() => {
    const rawProductId = req.body.product_id;
    const productIdResolved =
      rawProductId instanceof mongoose.Types.ObjectId ?
        rawProductId
      : new mongoose.Types.ObjectId(String(rawProductId).trim());
    const pidResolved = productIdResolved;
    const companyId = coalesceObjectId(
      req.body.company_id ?? req.user?.company_id,
    );
    const movementMatch = {
      product_id: pidResolved,
      status: "active",
      $nor: [{ deletedAt: { $type: "date" } }],
    };
    if (
      companyId != null &&
      String(companyId).trim() !== "" &&
      mongoose.Types.ObjectId.isValid(String(companyId))
    ) {
      movementMatch.company_id = companyId;
    }
    return {
      match: movementMatch,
      pid: pidResolved,
      productId: productIdResolved,
    };
  })();

  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: "$movement_type",
        total_qty: { $sum: { $ifNull: ["$quantity", 0] } },
        total_cost: { $sum: { $ifNull: ["$total_cost", 0] } },
      },
    },
  ];
  let movementTotalsAggregation = InventoryMovements.aggregate(pipeline);
  if (session) {
    movementTotalsAggregation = movementTotalsAggregation.session(session);
  }
  const movement_totals = await movementTotalsAggregation;

  const in_qty = toFiniteNumber(
    movement_totals.find((row) => row._id === "in")?.total_qty,
  );
  const out_qty = toFiniteNumber(
    movement_totals.find((row) => row._id === "out")?.total_qty,
  );

  const lineQty = toFiniteNumber(req.body.quantity);
  const lineCost = toFiniteNumber(req.body.total_cost);

  req.params.id = productId;
  const productData = await handleGenericGetById(req, "product", {
    excludeFields: [],
    session,
  });

  if (!productData?.success) {
    const productLookupFailure = new Error(
      productData?.error || "Product not found for inventory movement",
    );
    productLookupFailure.clientPayload = productData;
    throw productLookupFailure;
  }

  const wholesaleUnit = toFiniteNumber(productData.data.wholesale_price);

  const qty_in_stock = in_qty - out_qty;
  const cost_in_stock = Math.abs(qty_in_stock) * wholesaleUnit;
  const total_qty = Math.abs(qty_in_stock) + lineQty;
  const total_cost = Math.abs(cost_in_stock) + lineCost;
  const average_cost = total_qty !== 0 ? total_cost / total_qty : 0;

  const consoleLog = [
    "in_qty :" + in_qty,
    "out_qty :" + out_qty,
    "lineQty :" + lineQty,
    "lineCost :" + lineCost,
    "total_qty :" + total_qty,
    "total_cost :" + total_cost,
    "average_cost :" + average_cost,
  ];

  const request_type = req.body.movement_type === "in" ? "in" : "out";

  const response = await handleGenericCreate(req, "inventory_movements", {
    session,
    afterCreate: async (createdMovement, createRequest, mongoSession) => {
      console.log("✅ Record created successfully:", createdMovement);
    },
  });

  if (!response.success || !response.data) {
    const createFailure = new Error(
      response.error || "Inventory movement create failed",
    );
    createFailure.clientPayload = response;
    throw createFailure;
  }

  const resolvedCompanyId = coalesceObjectId(
    req.body.company_id ?? req.user?.company_id,
  );
  await createApplicationLog(
    req,
    {
      action: "Inventory movement created",
      url: req.originalUrl || req.path || "/api/inventory_movements/save",
      tags: [
        "inventory_movement",
        String(req.body.movement_type || "").trim() || "movement",
      ],
      description: {
        inventory_movement_id: response.data?._id,
        product_id: req.body.product_id,
        warehouse_id: req.body.warehouse_id,
        movement_type: req.body.movement_type,
        quantity: req.body.quantity,
        unit_cost: req.body.unit_cost,
        total_cost: req.body.total_cost,
        reference_type: req.body.reference_type,
        reference_id: req.body.reference_id,
        reference_name: req.body.reference_name,
      },
      company_id: resolvedCompanyId,
    },
    { session, silent: true },
  );

  let logWholesale = null;

  if (
    request_type === "in" &&
    total_qty !== 0 &&
    Number.isFinite(average_cost)
  ) {
    const productName =
      productData.data?.product_name ?
        String(productData.data.product_name).trim()
      : "";
    const wholesalePrevForLog = productData.data?.wholesale_price;

    const previousBody = req.body;
    req.params.id = String(pid);
    req.body = {
      wholesale_price: Math.round(average_cost * 100) / 100,
    };
    try {
      const updateResponse = await handleGenericUpdate(req, "product", {
        excludeFields: ["password"],
        session,
      });
      if (!updateResponse.success) {
        const productUpdateFailure = new Error(
          updateResponse.error || "Product wholesale update failed",
        );
        productUpdateFailure.clientPayload = updateResponse;
        throw productUpdateFailure;
      }
      logWholesale = {
        productName,
        previousWholesale: wholesalePrevForLog,
        nextWholesale: updateResponse.data?.wholesale_price,
      };
    } finally {
      req.body = previousBody;
    }

    if (logWholesale) {
      const {
        productName: wlName,
        previousWholesale,
        nextWholesale,
      } = logWholesale;
      const previousWholesaleText =
        previousWholesale == null || previousWholesale === "" ?
          "n/a"
        : String(previousWholesale);
      const nextWholesaleText =
        nextWholesale == null || nextWholesale === "" ?
          "n/a"
        : String(nextWholesale);
      const namePart = wlName ? ` "${wlName}"` : "";
      const productIdForDescription =
        req.body.product_id instanceof mongoose.Types.ObjectId ?
          String(req.body.product_id)
        : String(req.body.product_id).trim();
      const description =
        `wholesale_price for product${namePart} (id ${productIdForDescription}) ` +
        `changed from ${previousWholesaleText} to ${nextWholesaleText}.`;
      await createApplicationLog(
        req,
        {
          action: "Product wholesale_price updated",
          url: req.originalUrl || req.path || "/api/inventory_movements/save",
          tags: ["wholesale_price", "product", "inventory_movement"],
          description,
          company_id: resolvedCompanyId,
        },
        { session, silent: true },
      );
    }
  }

  return { response, consoleLog, logWholesale };
}

async function inventoryMovementsCreate(req, res) {
  if (!req.body || typeof req.body !== "object") {
    return res.status(400).json({
      success: false,
      status: 400,
      error: "Request body is required",
    });
  }

  if (!Object.prototype.hasOwnProperty.call(req.body, "unit_cost")) {
    return res.status(400).json({
      success: false,
      status: 400,
      error: "unit_cost is required",
      message:
        "Send unit_cost (number ≥ 0) on every create. total_cost is set as quantity × unit_cost when quantity is a positive number.",
    });
  }

  const rawUnit = req.body.unit_cost;
  if (rawUnit === "" || rawUnit === null) {
    return res.status(400).json({
      success: false,
      status: 400,
      error: "unit_cost cannot be empty",
    });
  }

  const unit_cost = Number(rawUnit);
  if (!Number.isFinite(unit_cost) || unit_cost < 0) {
    return res.status(400).json({
      success: false,
      status: 400,
      error: "unit_cost must be a finite number ≥ 0",
    });
  }
  req.body.unit_cost = unit_cost;

  const qty = Number(req.body.quantity);
  if (Number.isFinite(qty) && qty > 0) {
    req.body.total_cost = Math.round(qty * unit_cost * 100) / 100;
  }

  const rawProductId = req.body.product_id;
  if (
    rawProductId == null ||
    String(rawProductId).trim() === "" ||
    !mongoose.Types.ObjectId.isValid(String(rawProductId).trim())
  ) {
    return res.status(400).json({
      success: false,
      status: 400,
      error: "valid product_id is required before save",
    });
  }

  let clientSession = null;
  let txnResult = null;
  let txnError = null;

  try {
    clientSession = await mongoose.startSession();
    await clientSession.withTransaction(async () => {
      txnResult = await runInventoryMovementTxnBody(req, clientSession);
    });
  } catch (transactionStartError) {
    if (isMongoTransactionUnsupportedError(transactionStartError)) {
      if (clientSession) {
        try {
          clientSession.endSession();
        } catch (ignoredSessionEndError) {
          void ignoredSessionEndError;
          /* ignore */
        }
        clientSession = null;
      }
      console.warn(
        "[inventory_movements] MongoDB transactions unavailable; continuing without session:",
        transactionStartError.message,
      );
      try {
        txnResult = await runInventoryMovementTxnBody(req, null);
      } catch (fallbackExecutionError) {
        txnError = fallbackExecutionError;
      }
    } else {
      txnError = transactionStartError;
    }
  } finally {
    if (clientSession) {
      try {
        clientSession.endSession();
      } catch (ignoredSessionEndError) {
        void ignoredSessionEndError;
        /* ignore */
      }
    }
  }

  if (txnError) {
    const errorResponsePayload = txnError.clientPayload;
    if (
      errorResponsePayload &&
      typeof errorResponsePayload.status === "number"
    ) {
      return res.status(errorResponsePayload.status).json(errorResponsePayload);
    }
    return res.status(500).json({
      success: false,
      status: 500,
      error: txnError.message || "Inventory movement save failed",
    });
  }

  const { response, consoleLog } = txnResult;
  return res.status(response.status).json({
    consoleLog,
    ...response,
  });
}

module.exports = {
  cost_of_goods_available,
  inventoryMovementsCreate,
  runInventoryMovementTxnBody,
};
