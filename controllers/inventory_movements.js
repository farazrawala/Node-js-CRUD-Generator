const mongoose = require("mongoose");
const {
  handleGenericCreate,
  handleGenericGetById,
  handleGenericUpdate,
  coalesceObjectId,
} = require("../utils/modelHelper");
const { createApplicationLog } = require("../utils/applicationLogs");
const { isMongoTransactionUnsupportedError } = require("../utils/mongoTransactionSupport");
const InventoryMovements = require("../models/inventory_movements");

function toFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
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
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
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
      return res
        .status(errorResponsePayload.status)
        .json(errorResponsePayload);
    }
    return res.status(500).json({
      success: false,
      status: 500,
      error: txnError.message || "Inventory movement save failed",
    });
  }

  if (txnResult?.logWholesale) {
    const { productName, previousWholesale, nextWholesale } =
      txnResult.logWholesale;
    const previousWholesaleText =
      previousWholesale == null || previousWholesale === "" ?
        "n/a"
      : String(previousWholesale);
    const nextWholesaleText =
      nextWholesale == null || nextWholesale === "" ? "n/a" : String(nextWholesale);
    const namePart = productName ? ` "${productName}"` : "";
    const productIdFromBody = req.body.product_id;
    const productIdForDescription =
      productIdFromBody instanceof mongoose.Types.ObjectId ?
        String(productIdFromBody)
      : String(productIdFromBody).trim();
    const description =
      `wholesale_price for product${namePart} (id ${productIdForDescription}) ` +
      `changed from ${previousWholesaleText} to ${nextWholesaleText}.`;
    await createApplicationLog(req, {
      action: "Product wholesale_price updated",
      url:
        req.originalUrl || req.path || "/api/inventory_movements/save",
      tags: ["wholesale_price", "product", "inventory_movement"],
      description,
    });
  }

  const { response, consoleLog } = txnResult;
  return res.status(response.status).json({
    consoleLog,
    ...response,
  });
}

module.exports = {
  inventoryMovementsCreate,
};
