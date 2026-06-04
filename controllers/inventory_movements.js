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
const { invalidateListCacheForReq } = require("../utils/redisCache");

const INVENTORY_MOVEMENTS_LIST_CACHE_MODULE = "inventory_movements";
const INVENTORY_MOVEMENTS_LIST_CACHE_ACTION = "get-all-active";

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

/** Match ledger rows whether ids were saved as ObjectId or string (legacy / raw inserts). */
function ledgerRefIdsMatch(value) {
  const oid = toLedgerObjectId(value);
  if (!oid) return null;
  const str = String(oid);
  return { $in: [oid, str] };
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
  const pid = ledgerRefIdsMatch(productId);
  const cid = ledgerRefIdsMatch(companyId);
  const wid = ledgerRefIdsMatch(warehouseId);
  if (pid) match.product_id = pid;
  if (cid) match.company_id = cid;
  if (wid) match.warehouse_id = wid;
  return match;
}

/** Shared $group for ledger in/out totals (`movement_type` is enum in, out). */
const LEDGER_QTY_BY_WAREHOUSE_GROUP = {
  _id: "$warehouse_id",
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
};

/**
 * Per-warehouse on-hand from ledger only: sum(`in`.quantity) − sum(`out`.quantity).
 * @returns {Promise<Array<{ warehouse_id: import('mongoose').Types.ObjectId, qty_in: number, qty_out: number, net_qty: number }>>}
 */
async function aggregateNetQtyByWarehouse(
  productId,
  companyId,
  session = null,
) {
  const match = buildActiveMovementLedgerMatch({ productId, companyId });
  const pipeline = [
    { $match: match },
    { $group: LEDGER_QTY_BY_WAREHOUSE_GROUP },
    {
      $project: {
        warehouse_id: "$_id",
        qty_in: 1,
        qty_out: 1,
        net_qty: { $subtract: ["$qty_in", "$qty_out"] },
      },
    },
    { $sort: { net_qty: -1 } },
  ];
  let agg = InventoryMovements.aggregate(pipeline);
  if (session) agg = agg.session(session);
  return agg;
}

/** One query for warehouse display names (avoids N× findById in stock APIs). */
async function loadWarehouseNamesById(warehouseIds) {
  const ids = [
    ...new Set(
      (warehouseIds || [])
        .filter(
          (id) => id != null && mongoose.Types.ObjectId.isValid(String(id)),
        )
        .map((id) => new mongoose.Types.ObjectId(String(id))),
    ),
  ];
  if (!ids.length) return new Map();

  const rows = await Warehouse.find({ _id: { $in: ids } })
    .select("name")
    .lean();
  const map = new Map();
  for (const row of rows) {
    const name = row?.name != null ? String(row.name).trim() : "";
    if (name) map.set(String(row._id), name);
  }
  return map;
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
        qty_in: LEDGER_QTY_BY_WAREHOUSE_GROUP.qty_in,
        qty_out: LEDGER_QTY_BY_WAREHOUSE_GROUP.qty_out,
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
 * Insert one `inventory_movements` row only — for purchase order / purchase return lines.
 * No ledger aggregate, stock check, product read, wholesale update, or application log.
 * Callers must set `req.body` (product_id, warehouse_id, quantity, movement_type, costs, reference_*).
 *
 * @param {import("express").Request} req
 * @param {import("mongoose").ClientSession | null} [session]
 * @returns {Promise<{ response: object, consoleLog: string[], logWholesale: null }>}
 */
async function insertInventoryMovementRecord(req, session = null) {
  const response = await handleGenericCreate(req, "inventory_movements", {
    session,
  });

  if (!response.success || !response.data) {
    const createFailure = new Error(
      response.error || "Inventory movement create failed",
    );
    createFailure.clientPayload = response;
    throw createFailure;
  }

  return { response, consoleLog: [], logWholesale: null };
}

/**
 * Full movement pipeline: ledger reads, stock check on `out`, optional wholesale update, audit log.
 * Use `insertInventoryMovementRecord` for PO/PR; use this for orders, adjustments, manual save, transfers.
 * When `session` is set, all reads/writes use it so `withTransaction` can roll back on failure.
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
      warehouseId:
        toLedgerObjectId(req.body.warehouse_id) ?? req.body.warehouse_id,
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

  const movementId =
    response.data?._id != null ? String(response.data._id) : "";
  const productIdStr =
    req.body.product_id instanceof mongoose.Types.ObjectId ?
      String(req.body.product_id)
    : String(req.body.product_id ?? "").trim();
  const warehouseIdStr =
    req.body.warehouse_id != null ? String(req.body.warehouse_id).trim() : "";
  const movementType =
    String(req.body.movement_type || "")
      .trim()
      .toLowerCase() || "movement";
  const logQty = toFiniteNumber(req.body.quantity);
  const logUnitCost = toFiniteNumber(req.body.unit_cost);
  const logTotalCost = toFiniteNumber(req.body.total_cost);
  const refType =
    req.body.reference_type != null ?
      String(req.body.reference_type).trim()
    : "";
  const refId =
    req.body.reference_id != null ? String(req.body.reference_id).trim() : "";
  const refName =
    req.body.reference_name != null ?
      String(req.body.reference_name).trim()
    : "";
  const productName =
    productData.data?.product_name ?
      String(productData.data.product_name).trim()
    : "";
  const productLabel =
    productName ? `"${productName}"` : `id ${productIdStr || "?"}`;
  const refLabel = refName || refType || "";
  const refPart =
    refLabel || refId ?
      ` Linked to ${refLabel || "reference"}${refId ? ` (${refId})` : ""}.`
    : "";
  const movementLogMessage =
    `Inventory movement ${movementType}: qty ${logQty} @ unit ${logUnitCost} ` +
    `(total ${logTotalCost}) for product ${productLabel} in warehouse `;

  await createApplicationLog(
    req,
    {
      action: "Inventory movement created :: " + productLabel,
      url: req.originalUrl || req.path || "/api/inventory_movements/save",
      tags: [
        "inventory_movement",
        String(req.body.movement_type || "").trim() || "movement",
      ],
      description: movementLogMessage,
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
 * Reconcile `product.stock` with ledger net qty (in − out) for one product.
 * Same logic as GET `/api/inventory_movements/stock-by-product/:productId` (no HTTP self-call).
 *
 * @param {string|import("mongoose").Types.ObjectId} productId
 * @param {string|import("mongoose").Types.ObjectId} companyObjectId
 * @param {{ req?: object, mongoSession?: import("mongoose").ClientSession | null, logUrl?: string }} [options]
 *   When `mongoSession` is set, product read/update, ledger aggregate, and audit log insert use the same session (rollback together).
 * @returns {Promise<object>} success payload or `{ success: false, status, error, ... }`
 */
async function syncProductStockFromMovementLedger(
  productId,
  companyObjectId,
  { req = null, mongoSession = null, logUrl = null } = {},
) {
  const productIdStr = String(productId ?? "").trim();
  if (!productIdStr || !mongoose.Types.ObjectId.isValid(productIdStr)) {
    return {
      success: false,
      status: 400,
      error: "Invalid product id",
      message: "Provide a valid product_id",
    };
  }

  const companyIdCoalesced = coalesceObjectId(companyObjectId);
  if (
    !companyIdCoalesced ||
    !mongoose.Types.ObjectId.isValid(String(companyIdCoalesced))
  ) {
    return {
      success: false,
      status: 400,
      error: "company_id is required",
      message: "Company context is required",
    };
  }

  const productObjectId = new mongoose.Types.ObjectId(productIdStr);
  const companyObj = new mongoose.Types.ObjectId(String(companyIdCoalesced));

  let productQuery = Product.findOne({
    _id: productObjectId,
    company_id: companyObj,
    deletedAt: null,
  }).select("product_name product_code sku wholesale_price status stock");
  if (mongoSession) productQuery = productQuery.session(mongoSession);

  const [product, warehouseRows] = await Promise.all([
    productQuery.lean(),
    aggregateNetQtyByWarehouse(productObjectId, companyObj, mongoSession),
  ]);

  if (!product) {
    return {
      success: false,
      status: 404,
      error: "Product not found",
      message: "Product not found for this company",
      product_id: productIdStr,
    };
  }

  const warehouseNameById = await loadWarehouseNamesById(
    warehouseRows.map((row) => row.warehouse_id),
  );

  const warehouses = [];
  let totalIn = 0;
  let totalOut = 0;

  for (const row of warehouseRows) {
    const qty_in = toFiniteNumber(row.qty_in);
    const qty_out = toFiniteNumber(row.qty_out);
    const net_qty = toFiniteNumber(row.net_qty);
    totalIn += qty_in;
    totalOut += qty_out;

    const warehouseIdStr = String(row.warehouse_id);
    const entry = {
      warehouse_id: warehouseIdStr,
      qty_in,
      qty_out,
      net_qty,
      available_qty: Math.max(0, net_qty),
    };
    const whName = warehouseNameById.get(warehouseIdStr);
    if (whName) entry.warehouse_name = whName;

    warehouses.push(entry);
  }

  const net_qty = totalIn - totalOut;
  const available_qty = Math.max(0, net_qty);
  const stockFromLedger = Math.round(available_qty * 100) / 100;
  const previousStock = Number(product.stock) || 0;
  let productStock = previousStock;

  if (previousStock !== stockFromLedger) {
    const updateOpts = { new: true };
    if (mongoSession) updateOpts.session = mongoSession;

    const updatedProduct = await Product.findOneAndUpdate(
      {
        _id: productObjectId,
        company_id: companyObj,
        deletedAt: null,
      },
      { $set: { stock: stockFromLedger } },
      updateOpts,
    )
      .select("stock")
      .lean();
    productStock =
      updatedProduct != null ?
        Number(updatedProduct.stock) || 0
      : stockFromLedger;

    if (req) {
      const productName =
        product.product_name != null ? String(product.product_name).trim() : "";
      const nameLabel = productName || `id ${productIdStr}`;
      const description =
        `Product "${nameLabel}" stock synced from ledger (in ${totalIn}, out ${totalOut}): ` +
        `updated from ${previousStock} to ${productStock}.`;

      await createApplicationLog(
        req,
        {
          action: "Product stock synced from ledger",
          url:
            logUrl ||
            req.originalUrl ||
            req.path ||
            "/api/inventory_movements/stock-by-product",
          tags: ["product", "stock", "inventory_movement", "sync"],
          description: description,
          company_id: companyObj,
        },
        { session: mongoSession, silent: true },
      );
    }
  }

  return {
    success: true,
    status: 200,
    product_id: productIdStr,
    company_id: String(companyObj),
    product: {
      product_name: product.product_name,
      product_code: product.product_code,
      sku: product.sku,
      wholesale_price: product.wholesale_price,
      status: product.status,
      stock: productStock,
      previous_stock: previousStock,
    },
    qty_in: totalIn,
    qty_out: totalOut,
    net_qty,
    available_qty,
    stock_synced: previousStock !== stockFromLedger,
    warehouse_count: warehouses.length,
    warehouses,
  };
}

/**
 * GET stock for one product from `inventory_movements` ledger (in − out), per warehouse + totals.
 * Sets `product.stock` on the same product to ledger `available_qty` (max(0, net_qty)) when it differs.
 * `product_id` / `id`: path param or query. Tenant from `req.user.company_id`.
 */
async function findStockByProductId(req, res) {
  try {
    const companyObjectId = coalesceObjectId(req.user?.company_id);
    if (
      !companyObjectId ||
      !mongoose.Types.ObjectId.isValid(String(companyObjectId))
    ) {
      return res.status(400).json({
        success: false,
        status: 400,
        error: "company_id is required",
        message: "Authentication with company context is required",
      });
    }

    const rawProductId =
      req.params?.product_id ??
      req.params?.id ??
      req.query?.product_id ??
      req.query?.id;

    const result = await syncProductStockFromMovementLedger(
      rawProductId,
      companyObjectId,
      { req },
    );

    if (!result.success) {
      return res.status(result.status || 400).json(result);
    }

    return res.status(200).json(result);
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
 *
 * Flow:
 * 1. Validate body + tenant company
 * 2. Ensure product and both warehouses belong to the company and are active
 * 3. Check source warehouse has enough on-hand qty (ledger net)
 * 4. Atomically post OUT (from) + IN (to) movements linked by `reference_id`
 *
 * Body (aliases accepted): product_id, from_warehouse_id, to_warehouse_id, qty | quantity
 */
async function stockTransfer(req, res) {
  try {
    // --- Parse body (camelCase aliases for clients) ---
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const productIdRaw = body.product_id ?? body.productId;
    const fromWarehouseIdRaw =
      body.from_warehouse_id ?? body.from_warehouse ?? body.fromWarehouseId;
    const toWarehouseIdRaw =
      body.to_warehouse_id ?? body.to_warehouse ?? body.toWarehouseId;
    const qtyRaw = body.qty ?? body.quantity;

    // --- Request validation ---
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

    // Tenant scope: every lookup must match the authenticated user's company
    const companyFilter = {
      company_id: companyId,
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    };

    // --- Product must exist, be active, and belong to this company ---
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

    // --- Both warehouses must exist, be active, and belong to this company ---
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

    // --- Stock check on source warehouse (sum of in/out ledger for this product) ---
    const availableQty = await getLedgerNetQtyForWarehouse(
      productId,
      companyId,
      fromWarehouseId,
      null,
    );
    if (transferQty > availableQty) {
      const warehouseStock = await aggregateNetQtyByWarehouse(
        productId,
        companyId,
        null,
      );
      const stockByWarehouse = warehouseStock.map((row) => ({
        warehouse_id: String(row.warehouse_id),
        net_qty: toFiniteNumber(row.net_qty),
      }));

      return res.status(400).json({
        success: false,
        status: 400,
        error: "Insufficient stock",
        message:
          availableQty === 0 ?
            `No active ledger stock for this product in source warehouse ${fromWarehouseIdStr}. ` +
            `Only movements with status "active" and deletedAt null count. ` +
            `Stock by warehouse: ${stockByWarehouse.map((w) => `${w.warehouse_id}=${w.net_qty}`).join(", ") || "none"}`
          : `Insufficient stock in source warehouse: need ${transferQty}, available ${availableQty}`,
        product_id: productIdStr,
        company_id: String(companyId),
        from_warehouse_id: fromWarehouseIdStr,
        available_qty: availableQty,
        qty_needed: transferQty,
        stock_by_warehouse: stockByWarehouse,
      });
    }

    // Cost follows product wholesale price for both legs of the transfer
    const unitCost = toFiniteNumber(product.wholesale_price);
    const totalCost = Math.round(transferQty * unitCost * 100) / 100;

    /**
     * Creates paired OUT + IN movements inside one Mongo transaction (or sequential fallback).
     * `reference_id` ties both rows to the same logical transfer for reporting/audit.
     */
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

      // Reuse generic movement handler by temporarily shaping req.body (restore after)
      const bodyBefore = req.body;
      const paramsIdBefore = req.params?.id;

      // Leg 1: decrease stock at source warehouse
      req.body = {
        ...movementBase,
        warehouse_id: fromWarehouseIdStr,
        movement_type: "out",
      };
      const outResult = await runInventoryMovementTxnBody(req, session);

      // Leg 2: increase stock at destination warehouse
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

    // --- Run OUT+IN atomically when the deployment supports multi-doc transactions ---
    let txnResult = null;
    let txnError = null;
    let clientSession = null;

    try {
      clientSession = await mongoose.startSession();
      await clientSession.withTransaction(async () => {
        txnResult = await runTransferTxn(clientSession);
      });
    } catch (transactionStartError) {
      // Standalone Mongo / some hosts: retry without session so dev/single-node still works
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

    // Surface validation/business errors from movement handler (e.g. insufficient stock race)
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

    // Audit trail links both movement ids under one transfer reference
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

    // Clear cached list endpoints (e.g. GET /inventory_movements/get-all-active)
    await invalidateListCacheForReq(
      req,
      INVENTORY_MOVEMENTS_LIST_CACHE_MODULE,
      INVENTORY_MOVEMENTS_LIST_CACHE_ACTION,
    );

    return res.status(201).json({
      success: true,
      status: 201,
      message: `Transferred ${transferQty} unit(s) from ${fromLabel} to ${toLabel}`,
      data: {
        reference_id: String(transferReferenceId), // shared by OUT and IN rows
        out: outResult?.response?.data ?? null,
        in: inResult?.response?.data ?? null,
      },
    });
  } catch (error) {
    // Unexpected errors outside movement txn (DB, logging, etc.)
    console.error("❌ stockTransfer:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      error: error.message || "Internal server error",
    });
  }
}

// purchase_return/purchase_order_item_id/product_id
// purchase create

async function updateWholeSalePrice(req, res) {}
{
}

module.exports = {
  cost_of_goods_available,
  inventoryMovementsCreate,
  runInventoryMovementTxnBody,
  insertInventoryMovementRecord,
  buildActiveMovementLedgerMatch,
  aggregateNetQtyByWarehouse,
  getLedgerNetQtyForWarehouse,
  syncProductStockFromMovementLedger,
  findStockByProductId,
  stockTransfer,
  updateWholeSalePrice,
};
