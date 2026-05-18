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
const Warehouse = require("../models/warehouse");

function toFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Normalize ids for raw aggregation `$match` (string vs ObjectId must match DB). */
function toLedgerObjectId(value) {
  const raw = coalesceObjectId(value);
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();
  if (!mongoose.Types.ObjectId.isValid(s)) return null;
  return new mongoose.Types.ObjectId(s);
}

/**
 * Active rows in `inventory_movements` (ledger). Matches PO `in` / order `out` documents
 * with `status: "active"`, `deletedAt: null`, and a real `warehouse_id`.
 */
function buildActiveMovementLedgerMatch({
  productId,
  companyId,
  warehouseId,
} = {}) {
  const match = {
    status: "active",
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    warehouse_id: { $exists: true, $ne: null },
  };
  const pid = toLedgerObjectId(productId);
  const cid = toLedgerObjectId(companyId);
  const wid = toLedgerObjectId(warehouseId);
  if (pid) match.product_id = pid;
  if (cid) match.company_id = cid;
  if (wid) match.warehouse_id = wid;
  return match;
}

/**
 * Per-warehouse on-hand from ledger only: sum(`in`.quantity) − sum(`out`.quantity).
 * @returns {Promise<Array<{ warehouse_id: import('mongoose').Types.ObjectId, net_qty: number }>>}
 */
async function aggregateNetQtyByWarehouse(
  productId,
  companyId,
  session = null,
) {
  const match = buildActiveMovementLedgerMatch({ productId, companyId });
  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: "$warehouse_id",
        qty_in: {
          $sum: {
            $cond: [
              {
                $eq: [{ $toLower: { $ifNull: ["$movement_type", ""] } }, "in"],
              },
              { $ifNull: ["$quantity", 0] },
              0,
            ],
          },
        },
        qty_out: {
          $sum: {
            $cond: [
              {
                $eq: [{ $toLower: { $ifNull: ["$movement_type", ""] } }, "out"],
              },
              { $ifNull: ["$quantity", 0] },
              0,
            ],
          },
        },
      },
    },
    {
      $project: {
        warehouse_id: "$_id",
        net_qty: { $subtract: ["$qty_in", "$qty_out"] },
      },
    },
  ];
  let agg = InventoryMovements.aggregate(pipeline);
  if (session) agg = agg.session(session);
  return agg;
}

/** Net qty for one product + company + warehouse from `inventory_movements` only. */
async function getLedgerNetQtyForWarehouse(
  productId,
  companyId,
  warehouseId,
  session = null,
) {
  const match = buildActiveMovementLedgerMatch({
    productId,
    companyId,
    warehouseId,
  });
  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: null,
        qty_in: {
          $sum: {
            $cond: [
              {
                $eq: [{ $toLower: { $ifNull: ["$movement_type", ""] } }, "in"],
              },
              { $ifNull: ["$quantity", 0] },
              0,
            ],
          },
        },
        qty_out: {
          $sum: {
            $cond: [
              {
                $eq: [{ $toLower: { $ifNull: ["$movement_type", ""] } }, "out"],
              },
              { $ifNull: ["$quantity", 0] },
              0,
            ],
          },
        },
      },
    },
  ];
  let agg = InventoryMovements.aggregate(pipeline);
  if (session) agg = agg.session(session);
  const rows = await agg;
  const inQty = toFiniteNumber(rows[0]?.qty_in);
  const outQty = toFiniteNumber(rows[0]?.qty_out);
  return inQty - outQty;
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
    const movementMatch = buildActiveMovementLedgerMatch({
      productId: pidResolved,
      companyId: coalesceObjectId(req.body.company_id ?? req.user?.company_id),
      warehouseId: req.body.warehouse_id,
    });
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

  let in_qty = 0;
  let out_qty = 0;
  for (const row of movement_totals) {
    const type = String(row._id ?? "").toLowerCase();
    if (type === "in") in_qty = toFiniteNumber(row.total_qty);
    if (type === "out") out_qty = toFiniteNumber(row.total_qty);
  }

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

  const companyIdForStock = toLedgerObjectId(
    req.body.company_id ?? req.user?.company_id,
  );
  const warehouseIdForStock = toLedgerObjectId(req.body.warehouse_id);
  // Read committed ledger for availability (txn session can hide existing `in` rows).
  const qty_in_stock =
    warehouseIdForStock && companyIdForStock ?
      await getLedgerNetQtyForWarehouse(
        pid,
        companyIdForStock,
        warehouseIdForStock,
        null,
      )
    : in_qty - out_qty;
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

  if (request_type === "out" && lineQty > qty_in_stock) {
    const warehouseIdStr =
      req.body.warehouse_id ? String(req.body.warehouse_id) : null;
    const productIdStr = String(pid);
    const companyIdStr = String(
      coalesceObjectId(req.body.company_id ?? req.user?.company_id) || "",
    );

    let warehouseStock = [];
    if (
      mongoose.Types.ObjectId.isValid(productIdStr) &&
      mongoose.Types.ObjectId.isValid(companyIdStr)
    ) {
      const rows = await aggregateNetQtyByWarehouse(pid, companyIdStr, session);
      warehouseStock = rows.map((row) => {
        const wid = String(row.warehouse_id);
        const available_qty = Math.max(0, Number(row.net_qty) || 0);
        return {
          warehouse_id: wid,
          available_qty,
          qty_needed: lineQty,
          sufficient: available_qty >= lineQty,
          short_by: Math.max(0, lineQty - available_qty),
        };
      });
      if (
        warehouseIdStr &&
        mongoose.Types.ObjectId.isValid(warehouseIdStr) &&
        !warehouseStock.some((w) => w.warehouse_id === warehouseIdStr)
      ) {
        warehouseStock.push({
          warehouse_id: warehouseIdStr,
          available_qty: 0,
          qty_needed: lineQty,
          sufficient: false,
          short_by: lineQty,
        });
      }
      warehouseStock.sort((a, b) => b.available_qty - a.available_qty);
    }

    const insufficientWarehouses = warehouseStock.filter((w) => !w.sufficient);
    const warehouseHint =
      warehouseIdStr ? ` in warehouse ${warehouseIdStr}` : "";
    const ledgerSummary =
      insufficientWarehouses.length === 0 ?
        ""
      : ` Other warehouses: ${insufficientWarehouses
          .map(
            (w) =>
              `${w.warehouse_id} (available ${w.available_qty}, short by ${w.short_by})`,
          )
          .join("; ")}.`;
    const insufficientMsg = `Insufficient stock${warehouseHint}: need ${lineQty}, available ${qty_in_stock}.${ledgerSummary}`;
    const insufficientErr = new Error(insufficientMsg);
    insufficientErr.clientPayload = {
      success: false,
      status: 400,
      error: "Insufficient stock",
      details: insufficientMsg,
      type: "validation",
      qty_needed: lineQty,
      product_id: productIdStr,
      company_id: companyIdStr,
      warehouse_id: warehouseIdStr,
      available_qty: qty_in_stock,
      warehouses: warehouseStock,
      insufficient_warehouses: insufficientWarehouses,
    };
    throw insufficientErr;
  }

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

/**
 * GET stock for one product from `inventory_movements` ledger (in − out), per warehouse + totals.
 * `product_id` / `id`: path param or query. Tenant from `req.user.company_id`.
 */
async function findStockByProductId(req, res) {
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

    const rawProductId =
      req.params?.product_id ??
      req.params?.id ??
      req.query?.product_id ??
      req.query?.id;
    const productIdStr = String(rawProductId ?? "").trim();
    if (!productIdStr || !mongoose.Types.ObjectId.isValid(productIdStr)) {
      return res.status(400).json({
        success: false,
        status: 400,
        error: "Invalid product id",
        message: "Provide a valid product_id (path or query)",
      });
    }

    const productObjectId = new mongoose.Types.ObjectId(productIdStr);

    const product = await Product.findOne({
      _id: productObjectId,
      company_id: companyObjectId,
      deletedAt: null,
    })
      .select("product_name product_code sku wholesale_price status")
      .lean();

    if (!product) {
      return res.status(404).json({
        success: false,
        status: 404,
        error: "Product not found",
        message: "Product not found for this company",
        product_id: productIdStr,
      });
    }

    const match = buildActiveMovementLedgerMatch({
      productId: productObjectId,
      companyId: companyObjectId,
    });

    const warehouseRows = await InventoryMovements.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$warehouse_id",
          qty_in: {
            $sum: {
              $cond: [
                {
                  $eq: [
                    { $toLower: { $ifNull: ["$movement_type", ""] } },
                    "in",
                  ],
                },
                { $ifNull: ["$quantity", 0] },
                0,
              ],
            },
          },
          qty_out: {
            $sum: {
              $cond: [
                {
                  $eq: [
                    { $toLower: { $ifNull: ["$movement_type", ""] } },
                    "out",
                  ],
                },
                { $ifNull: ["$quantity", 0] },
                0,
              ],
            },
          },
        },
      },
      {
        $project: {
          warehouse_id: "$_id",
          qty_in: 1,
          qty_out: 1,
          net_qty: { $subtract: ["$qty_in", "$qty_out"] },
        },
      },
      { $sort: { net_qty: -1 } },
    ]);

    let Warehouse;
    try {
      Warehouse = mongoose.model("warehouse");
    } catch {
      Warehouse = null;
    }

    const warehouses = [];
    let totalIn = 0;
    let totalOut = 0;

    for (const row of warehouseRows) {
      const qty_in = toFiniteNumber(row.qty_in);
      const qty_out = toFiniteNumber(row.qty_out);
      const net_qty = toFiniteNumber(row.net_qty);
      totalIn += qty_in;
      totalOut += qty_out;

      const entry = {
        warehouse_id: String(row.warehouse_id),
        qty_in,
        qty_out,
        net_qty,
        available_qty: Math.max(0, net_qty),
      };

      if (Warehouse && row.warehouse_id) {
        const wh = await Warehouse.findById(row.warehouse_id)
          .select("name")
          .lean();
        if (wh?.name) entry.warehouse_name = String(wh.name).trim();
      }

      warehouses.push(entry);
    }

    const net_qty = totalIn - totalOut;

    return res.status(200).json({
      success: true,
      status: 200,
      product_id: productIdStr,
      company_id: String(companyObjectId),
      product: {
        product_name: product.product_name,
        product_code: product.product_code,
        sku: product.sku,
        wholesale_price: product.wholesale_price,
        status: product.status,
      },
      qty_in: totalIn,
      qty_out: totalOut,
      net_qty,
      available_qty: Math.max(0, net_qty),
      warehouse_count: warehouses.length,
      warehouses,
    });
  } catch (error) {
    console.error("❌ findStockByProductId:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      error: error.message || "Internal server error",
    });
  }
}

function resolveRequestCompanyId(req) {
  const rawCompany = req.user?.company_id;
  const companyId =
    rawCompany && typeof rawCompany === "object" && rawCompany._id ?
      rawCompany._id
    : rawCompany;
  return coalesceObjectId(companyId);
}

/**
 * POST stock transfer — two `inventory_movements` rows only (no `stock_transfer` table).
 * Out: product_id + from_warehouse_id + qty. In: product_id + to_warehouse_id + qty.
 * Body: product_id, from_warehouse_id, to_warehouse_id, qty (or quantity).
 */
async function stockTransfer(req, res) {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const productIdRaw = body.product_id ?? body.productId;
    const fromWarehouseIdRaw =
      body.from_warehouse_id ?? body.from_warehouse ?? body.fromWarehouseId;
    const toWarehouseIdRaw =
      body.to_warehouse_id ?? body.to_warehouse ?? body.toWarehouseId;
    const qtyRaw = body.qty ?? body.quantity;

    const errors = [];
    const productIdStr =
      productIdRaw != null ? String(productIdRaw).trim() : "";
    const fromWarehouseIdStr =
      fromWarehouseIdRaw != null ? String(fromWarehouseIdRaw).trim() : "";
    const toWarehouseIdStr =
      toWarehouseIdRaw != null ? String(toWarehouseIdRaw).trim() : "";

    if (!productIdStr || !mongoose.Types.ObjectId.isValid(productIdStr)) {
      errors.push("valid product_id is required");
    }
    if (
      !fromWarehouseIdStr ||
      !mongoose.Types.ObjectId.isValid(fromWarehouseIdStr)
    ) {
      errors.push("valid from_warehouse_id is required");
    }
    if (
      !toWarehouseIdStr ||
      !mongoose.Types.ObjectId.isValid(toWarehouseIdStr)
    ) {
      errors.push("valid to_warehouse_id is required");
    }

    const transferQty = Number(qtyRaw);
    if (!Number.isFinite(transferQty) || transferQty <= 0) {
      errors.push("qty must be a number greater than zero");
    }

    if (
      fromWarehouseIdStr &&
      toWarehouseIdStr &&
      fromWarehouseIdStr === toWarehouseIdStr
    ) {
      errors.push("from_warehouse_id and to_warehouse_id must be different");
    }

    const companyObjectId = resolveRequestCompanyId(req);
    if (
      !companyObjectId ||
      !mongoose.Types.ObjectId.isValid(String(companyObjectId))
    ) {
      errors.push("company_id is required (authenticate with a company user)");
    }

    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        status: 400,
        errors,
        message: errors.join("; "),
      });
    }

    const companyId = new mongoose.Types.ObjectId(String(companyObjectId));
    const productId = new mongoose.Types.ObjectId(productIdStr);
    const fromWarehouseId = new mongoose.Types.ObjectId(fromWarehouseIdStr);
    const toWarehouseId = new mongoose.Types.ObjectId(toWarehouseIdStr);

    const companyFilter = {
      company_id: companyId,
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    };

    const product = await Product.findOne({
      _id: productId,
      ...companyFilter,
      status: "active",
    })
      .select("product_name product_code wholesale_price")
      .lean();

    if (!product) {
      return res.status(404).json({
        success: false,
        status: 404,
        message: "Product not found for this company",
      });
    }

    const [fromWarehouse, toWarehouse] = await Promise.all([
      Warehouse.findOne({
        _id: fromWarehouseId,
        ...companyFilter,
        status: "active",
      })
        .select("name code")
        .lean(),
      Warehouse.findOne({
        _id: toWarehouseId,
        ...companyFilter,
        status: "active",
      })
        .select("name code")
        .lean(),
    ]);

    if (!fromWarehouse) {
      return res.status(404).json({
        success: false,
        status: 404,
        message: "Source warehouse not found or inactive",
      });
    }
    if (!toWarehouse) {
      return res.status(404).json({
        success: false,
        status: 404,
        message: "Destination warehouse not found or inactive",
      });
    }

    const availableQty = await getLedgerNetQtyForWarehouse(
      productId,
      companyId,
      fromWarehouseId,
      null,
    );
    if (transferQty > availableQty) {
      return res.status(400).json({
        success: false,
        status: 400,
        error: "Insufficient stock",
        message: `Insufficient stock in source warehouse: need ${transferQty}, available ${availableQty}`,
        product_id: productIdStr,
        from_warehouse_id: fromWarehouseIdStr,
        available_qty: availableQty,
        qty_needed: transferQty,
      });
    }

    const unitCost = toFiniteNumber(product.wholesale_price);
    const totalCost = Math.round(transferQty * unitCost * 100) / 100;

    const runTransferTxn = async (session) => {
      const transferReferenceId = new mongoose.Types.ObjectId();

      const movementBase = {
        product_id: productIdStr,
        quantity: transferQty,
        unit_cost: unitCost,
        total_cost: totalCost,
        reference_type: "stock_transfer",
        reference_id: transferReferenceId,
        reference_name: "Stock Transfer",
        company_id: companyId,
        status: "active",
      };

      const bodyBefore = req.body;
      const paramsIdBefore = req.params?.id;

      req.body = {
        ...movementBase,
        warehouse_id: fromWarehouseIdStr,
        movement_type: "out",
      };
      const outResult = await runInventoryMovementTxnBody(req, session);

      req.body = {
        ...movementBase,
        warehouse_id: toWarehouseIdStr,
        movement_type: "in",
      };
      const inResult = await runInventoryMovementTxnBody(req, session);

      req.body = bodyBefore;
      if (paramsIdBefore !== undefined) req.params.id = paramsIdBefore;
      else delete req.params.id;

      return { transferReferenceId, outResult, inResult };
    };

    let txnResult = null;
    let txnError = null;
    let clientSession = null;

    try {
      clientSession = await mongoose.startSession();
      await clientSession.withTransaction(async () => {
        txnResult = await runTransferTxn(clientSession);
      });
    } catch (transactionStartError) {
      if (isMongoTransactionUnsupportedError(transactionStartError)) {
        if (clientSession) {
          try {
            clientSession.endSession();
          } catch {
            /* ignore */
          }
          clientSession = null;
        }
        console.warn(
          "[inventory_movements] stock transfer: transactions unavailable; continuing without session:",
          transactionStartError.message,
        );
        try {
          txnResult = await runTransferTxn(null);
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
        } catch {
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
        return res
          .status(errorResponsePayload.status)
          .json(errorResponsePayload);
      }
      return res.status(500).json({
        success: false,
        status: 500,
        error: txnError.message || "Stock transfer failed",
      });
    }

    const { transferReferenceId, outResult, inResult } = txnResult;
    const fromLabel = fromWarehouse.name || fromWarehouseIdStr;
    const toLabel = toWarehouse.name || toWarehouseIdStr;

    await createApplicationLog(req, {
      action: "Stock transfer completed",
      url: req.originalUrl || "/api/inventory_movements/stock-transfer",
      tags: ["stock_transfer", "inventory_movement"],
      description: {
        reference_id: transferReferenceId,
        product_id: productIdStr,
        from_warehouse_id: fromWarehouseIdStr,
        to_warehouse_id: toWarehouseIdStr,
        qty: transferQty,
        out_movement_id: outResult?.response?.data?._id,
        in_movement_id: inResult?.response?.data?._id,
      },
      company_id: companyId,
    });

    return res.status(201).json({
      success: true,
      status: 201,
      message: `Transferred ${transferQty} unit(s) from ${fromLabel} to ${toLabel}`,
      data: {
        reference_id: String(transferReferenceId),
        out: outResult?.response?.data ?? null,
        in: inResult?.response?.data ?? null,
      },
    });
  } catch (error) {
    console.error("❌ stockTransfer:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      error: error.message || "Internal server error",
    });
  }
}

module.exports = {
  cost_of_goods_available,
  inventoryMovementsCreate,
  runInventoryMovementTxnBody,
  buildActiveMovementLedgerMatch,
  aggregateNetQtyByWarehouse,
  getLedgerNetQtyForWarehouse,
  findStockByProductId,
  stockTransfer,
};
