const mongoose = require("mongoose");
const StockMovement = require("../models/stock_movement");
const WarehouseInventory = require("../models/warehouse_inventory");
require("../models/order_item");
require("../models/purchase_order_item");
const {
  handleGenericGetAll,
  buildPopulateFromQuery,
  parseSearchFieldsFromQuery,
} = require("../utils/modelHelper");

function toObjectId(id) {
  if (!id || !mongoose.Types.ObjectId.isValid(id)) return null;
  return new mongoose.Types.ObjectId(id);
}

/** Populate polymorphic line refs (PO line vs order line) for API responses. */
async function hydrateMovementRefs(docs) {
  if (!docs) return docs;
  const list = Array.isArray(docs) ? docs : [docs];
  for (const m of list) {
    if (!m) continue;
    const st = m.source_type;
    try {
      if (st === "purchase_order_item" && m.reference_id) {
        await StockMovement.populate(m, {
          path: "reference_id",
          model: "purchase_order_item",
          strictPopulate: false,
        });
      } else if (st === "order_item" && m.order_item_id) {
        await StockMovement.populate(m, {
          path: "order_item_id",
          model: "order_item",
          strictPopulate: false,
        });
      }
    } catch (_) {
      /* invalid or missing ref */
    }
  }
  return docs;
}

function normalizeDirection(direction) {
  return direction === "out" ? "out" : "in";
}

function getSignedQuantity(direction, quantity) {
  const qty = Number(quantity || 0);
  return normalizeDirection(direction) === "out" ? -qty : qty;
}

/**
 * Stable key for deduplicating movement + inventory side effects (retries, double POST).
 * Caller may override with body.idempotency_key.
 */
function buildDefaultIdempotencyKey(body, doc) {
  const explicit = String(body.idempotency_key ?? "").trim();
  if (explicit) return explicit.slice(0, 200);
  if (doc.order_item_id && doc.type && doc.direction) {
    return `oi:${String(doc.order_item_id)}:${doc.type}:${doc.direction}`.slice(
      0,
      200,
    );
  }
  if (doc.reference_id && doc.type && doc.direction) {
    return `ref:${String(doc.reference_id)}:${doc.type}:${doc.direction}`.slice(
      0,
      200,
    );
  }
  if (doc.adjustment_id && doc.type && doc.direction) {
    return `adj:${String(doc.adjustment_id)}:${doc.type}:${doc.direction}`.slice(
      0,
      200,
    );
  }
  return null;
}

async function applyWarehouseInventoryDelta({
  productId,
  warehouseId,
  quantityDelta,
  user,
  companyId: companyIdOverride = null,
  session = null,
}) {
  const companyId = companyIdOverride || user?.company_id || null;
  if (!companyId) {
    throw new Error(
      "company_id is required for warehouse inventory updates (user or explicit companyId)",
    );
  }

  const filter = {
    product_id: productId,
    warehouse_id: warehouseId,
    company_id: companyId,
    $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }],
  };

  let q = WarehouseInventory.findOne(filter);
  if (session) q = q.session(session);
  let inventory = await q;

  if (!inventory) {
    if (quantityDelta < 0) {
      throw new Error("Insufficient inventory to subtract stock");
    }

    const row = {
      product_id: productId,
      warehouse_id: warehouseId,
      quantity: 0,
      company_id: companyId,
      created_by: user?._id || undefined,
      updated_by: user?._id || undefined,
    };
    if (session) {
      const [created] = await WarehouseInventory.create([row], { session });
      inventory = created;
    } else {
      inventory = new WarehouseInventory(row);
      await inventory.save();
    }
  }

  const nextQty = Number(inventory.quantity || 0) + Number(quantityDelta || 0);
  if (nextQty < 0) {
    throw new Error("Insufficient inventory quantity");
  }

  inventory.quantity = nextQty;
  if (user?._id) {
    inventory.updated_by = user._id;
  }

  await inventory.save(session ? { session } : {});
  return inventory;
}

/**
 * Same behavior as POST /api/stock_movement/create (inventory + movement).
 * Use from other controllers instead of HTTP self-calls.
 *
 * @param {{ body: object, user?: object, session?: import("mongoose").ClientSession | null }} params
 * body.idempotency_key optional override; otherwise derived from order_item_id / reference_id / adjustment_id.
 * When `session` is omitted, movement + inventory run in their own MongoDB transaction (replica set / Atlas).
 * When `session` is set, writes use that session (caller must run inside session.withTransaction).
 * @returns {Promise<{ success: boolean, status?: number, data?: object, message?: string }>}
 */
async function createStockMovementRecord({ body, user, session: outerSession }) {
  const productId = toObjectId(body.product_id || body.productId);
  const warehouseId = toObjectId(body.warehouse_id || body.warehouseId);
  const quantity = Number(body.quantity);
  const direction = normalizeDirection(body.direction);
  const type = body.type;
  let referenceId = toObjectId(body.reference_id);
  let orderItemId = toObjectId(body.order_item_id);
  const adjustmentId = toObjectId(body.adjustment_id);
  const stRaw = String(body.source_type || "").trim();
  if (!orderItemId && referenceId && stRaw === "order_item") {
    orderItemId = referenceId;
    referenceId = null;
  }
  let adjustmentIdFinal = adjustmentId;
  if (!adjustmentIdFinal && referenceId && stRaw === "adjustment") {
    adjustmentIdFinal = referenceId;
    referenceId = null;
  }

  if (
    !productId ||
    !warehouseId ||
    !type ||
    !Number.isFinite(quantity) ||
    quantity <= 0
  ) {
    return {
      success: false,
      status: 400,
      message:
        "product_id, warehouse_id, type, direction and positive quantity are required",
    };
  }

  const doc = {
    product_id: productId,
    warehouse_id: warehouseId,
    type,
    quantity,
    direction,
    reason: body.reason || undefined,
    created_by: user?._id || undefined,
    updated_by: user?._id || undefined,
    status: body.status || "active",
  };
  if (referenceId) {
    doc.reference_id = referenceId;
  }
  if (orderItemId) {
    doc.order_item_id = orderItemId;
  }
  if (adjustmentIdFinal) {
    doc.adjustment_id = adjustmentIdFinal;
  }

  const resolvedCompanyId = user?.company_id || body.company_id;
  if (
    !resolvedCompanyId ||
    !mongoose.Types.ObjectId.isValid(resolvedCompanyId)
  ) {
    return {
      success: false,
      status: 400,
      message: "company_id is required (user.company_id or body.company_id)",
    };
  }
  if (
    user?.company_id &&
    body.company_id &&
    String(user.company_id) !== String(body.company_id)
  ) {
    return {
      success: false,
      status: 400,
      message: "body.company_id does not match authenticated user company",
    };
  }
  doc.company_id = resolvedCompanyId;

  const idempotencyKey = buildDefaultIdempotencyKey(body, doc);
  if (idempotencyKey) {
    doc.idempotency_key = idempotencyKey;
    let idemQ = StockMovement.findOne({
      company_id: resolvedCompanyId,
      idempotency_key: idempotencyKey,
      status: "active",
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    });
    if (outerSession) idemQ = idemQ.session(outerSession);
    const existing = await idemQ.lean();
    if (existing) {
      const hydrated = await StockMovement.findById(existing._id);
      await hydrateMovementRefs(hydrated);
      return {
        success: true,
        status: 200,
        data: hydrated,
        message: "Stock movement already applied (idempotent)",
      };
    }
  }

  if (orderItemId && type && direction) {
    let oiQ = StockMovement.findOne({
      company_id: resolvedCompanyId,
      order_item_id: orderItemId,
      type,
      direction,
      status: "active",
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    });
    if (outerSession) oiQ = oiQ.session(outerSession);
    const existingLine = await oiQ.lean();
    if (existingLine) {
      const hydrated = await StockMovement.findById(existingLine._id);
      await hydrateMovementRefs(hydrated);
      return {
        success: true,
        status: 200,
        data: hydrated,
        message: "Stock movement already applied (idempotent)",
      };
    }
  }

  const insertMovementAndInventory = async (session) => {
    const [created] = await StockMovement.create([doc], { session });
    await applyWarehouseInventoryDelta({
      productId,
      warehouseId,
      quantityDelta: getSignedQuantity(direction, quantity),
      user,
      companyId: resolvedCompanyId,
      session,
    });
    return created;
  };

  if (outerSession) {
    try {
      const movement = await insertMovementAndInventory(outerSession);
      await hydrateMovementRefs(movement);
      return {
        success: true,
        status: 201,
        data: movement,
        message: "Stock movement created and warehouse inventory updated",
      };
    } catch (err) {
      if (err && err.code === 11000) {
        if (idempotencyKey) {
          let dupQ = StockMovement.findOne({
            company_id: resolvedCompanyId,
            idempotency_key: idempotencyKey,
            status: "active",
            $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
          });
          dupQ = dupQ.session(outerSession);
          const existing = await dupQ;
          if (existing) {
            await hydrateMovementRefs(existing);
            return {
              success: true,
              status: 200,
              data: existing,
              message: "Stock movement already applied (idempotent)",
            };
          }
        }
        if (orderItemId && type && direction) {
          let oiDup = StockMovement.findOne({
            company_id: resolvedCompanyId,
            order_item_id: orderItemId,
            type,
            direction,
            status: "active",
            $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
          });
          oiDup = oiDup.session(outerSession);
          const existingOi = await oiDup;
          if (existingOi) {
            await hydrateMovementRefs(existingOi);
            return {
              success: true,
              status: 200,
              data: existingOi,
              message: "Stock movement already applied (idempotent)",
            };
          }
        }
      }
      throw err;
    }
  }

  const session = await mongoose.startSession();
  try {
    let movement;
    await session.withTransaction(async () => {
      movement = await insertMovementAndInventory(session);
    });
    await hydrateMovementRefs(movement);
    return {
      success: true,
      status: 201,
      data: movement,
      message: "Stock movement created and warehouse inventory updated",
    };
  } catch (err) {
    if (err && err.code === 11000) {
      if (idempotencyKey) {
        const existing = await StockMovement.findOne({
          company_id: resolvedCompanyId,
          idempotency_key: idempotencyKey,
          status: "active",
          $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
        });
        if (existing) {
          await hydrateMovementRefs(existing);
          return {
            success: true,
            status: 200,
            data: existing,
            message: "Stock movement already applied (idempotent)",
          };
        }
      }
      if (orderItemId && type && direction) {
        const existingOi = await StockMovement.findOne({
          company_id: resolvedCompanyId,
          order_item_id: orderItemId,
          type,
          direction,
          status: "active",
          $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
        });
        if (existingOi) {
          await hydrateMovementRefs(existingOi);
          return {
            success: true,
            status: 200,
            data: existingOi,
            message: "Stock movement already applied (idempotent)",
          };
        }
      }
    }
    throw err;
  } finally {
    session.endSession();
  }
}

async function createStockMovement(req, res) {
  try {
    const result = await createStockMovementRecord({
      body: req.body || {},
      user: req.user,
    });

    if (!result.success) {
      return res.status(result.status || 400).json({
        success: false,
        message: result.message,
      });
    }

    return res.status(201).json({
      success: true,
      message: result.message,
      data: result.data,
    });
  } catch (error) {
    console.error("❌ createStockMovement error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error",
    });
  }
}

async function updateStockMovement(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid movement id" });
    }

    const movementPre = await StockMovement.findOne({
      _id: id,
      $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }],
    });

    if (!movementPre) {
      return res
        .status(404)
        .json({ success: false, message: "Stock movement not found" });
    }

    const newProductId =
      toObjectId(req.body.product_id || req.body.productId) ||
      movementPre.product_id;
    const newWarehouseId =
      toObjectId(req.body.warehouse_id || req.body.warehouseId) ||
      movementPre.warehouse_id;
    const newQuantity =
      req.body.quantity !== undefined ?
        Number(req.body.quantity)
      : Number(movementPre.quantity);
    const newDirection =
      req.body.direction !== undefined ?
        normalizeDirection(req.body.direction)
      : movementPre.direction;

    if (!Number.isFinite(newQuantity) || newQuantity <= 0) {
      return res.status(400).json({
        success: false,
        message: "quantity must be a positive number",
      });
    }

    const oldDelta = getSignedQuantity(
      movementPre.direction,
      movementPre.quantity,
    );
    const newDelta = getSignedQuantity(newDirection, newQuantity);

    const invCompanyId = movementPre.company_id || req.user?.company_id;
    if (!invCompanyId) {
      return res.status(400).json({
        success: false,
        message:
          "Cannot sync inventory: movement has no company_id and user has no company context",
      });
    }

    const session = await mongoose.startSession();
    let movementOut;
    try {
      await session.withTransaction(async () => {
        const movement = await StockMovement.findOne({
          _id: id,
          $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }],
        }).session(session);

        if (!movement) {
          const nf = new Error("Stock movement not found");
          nf.status = 404;
          throw nf;
        }

        await applyWarehouseInventoryDelta({
          productId: movement.product_id,
          warehouseId: movement.warehouse_id,
          quantityDelta: -oldDelta,
          user: req.user,
          companyId: invCompanyId,
          session,
        });

        await applyWarehouseInventoryDelta({
          productId: newProductId,
          warehouseId: newWarehouseId,
          quantityDelta: newDelta,
          user: req.user,
          companyId: invCompanyId,
          session,
        });

        movement.product_id = newProductId;
        movement.warehouse_id = newWarehouseId;
        movement.quantity = newQuantity;
        movement.direction = newDirection;
        movement.type = req.body.type || movement.type;
        movement.reason =
          req.body.reason !== undefined ? req.body.reason : movement.reason;
        movement.updated_by = req.user?._id || movement.updated_by;
        movement.status = req.body.status || movement.status;

        if (req.body.reference_id !== undefined) {
          movement.reference_id =
            toObjectId(req.body.reference_id) || undefined;
        }
        if (req.body.order_item_id !== undefined) {
          movement.order_item_id =
            toObjectId(req.body.order_item_id) || undefined;
        }
        if (req.body.adjustment_id !== undefined) {
          movement.adjustment_id =
            toObjectId(req.body.adjustment_id) || undefined;
        }

        await movement.save({ session });
        movementOut = movement;
      });
    } finally {
      session.endSession();
    }

    await hydrateMovementRefs(movementOut);

    return res.status(200).json({
      success: true,
      message: "Stock movement updated and warehouse inventory synced",
      data: movementOut,
    });
  } catch (error) {
    if (error && error.status === 404) {
      return res
        .status(404)
        .json({ success: false, message: "Stock movement not found" });
    }
    console.error("❌ updateStockMovement error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error",
    });
  }
}

async function deleteStockMovement(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid movement id" });
    }

    const movementPre = await StockMovement.findOne({
      _id: id,
      $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }],
    });

    if (!movementPre) {
      return res
        .status(404)
        .json({ success: false, message: "Stock movement not found" });
    }

    const oldDelta = getSignedQuantity(
      movementPre.direction,
      movementPre.quantity,
    );
    const invCompanyId = movementPre.company_id || req.user?.company_id;
    if (!invCompanyId) {
      return res.status(400).json({
        success: false,
        message:
          "Cannot sync inventory: movement has no company_id and user has no company context",
      });
    }

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const movement = await StockMovement.findOne({
          _id: id,
          $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }],
        }).session(session);

        if (!movement) {
          const nf = new Error("Stock movement not found");
          nf.status = 404;
          throw nf;
        }

        await applyWarehouseInventoryDelta({
          productId: movement.product_id,
          warehouseId: movement.warehouse_id,
          quantityDelta: -oldDelta,
          user: req.user,
          companyId: invCompanyId,
          session,
        });

        movement.deletedAt = new Date();
        movement.status = "inactive";
        movement.updated_by = req.user?._id || movement.updated_by;
        await movement.save({ session });
      });
    } finally {
      session.endSession();
    }

    return res.status(200).json({
      success: true,
      message: "Stock movement deleted and warehouse inventory reverted",
    });
  } catch (error) {
    if (error && error.status === 404) {
      return res
        .status(404)
        .json({ success: false, message: "Stock movement not found" });
    }
    console.error("❌ deleteStockMovement error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error",
    });
  }
}

async function getStockMovementById(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid movement id" });
    }

    const movement = await StockMovement.findOne({
      _id: id,
      $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }],
    })
      .populate("product_id", "product_name product_code")
      .populate("warehouse_id", "warehouse_name");

    if (!movement) {
      return res
        .status(404)
        .json({ success: false, message: "Stock movement not found" });
    }

    await hydrateMovementRefs(movement);

    return res.status(200).json({ success: true, data: movement });
  } catch (error) {
    console.error("❌ getStockMovementById error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error",
    });
  }
}

async function getAllStockMovements(req, res) {
  try {
    const filter = {
      $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }],
    };

    if (req.user?.company_id) {
      filter.company_id = req.user.company_id;
    }
    if (
      req.query.product_id &&
      mongoose.Types.ObjectId.isValid(req.query.product_id)
    ) {
      filter.product_id = req.query.product_id;
    }
    if (
      req.query.warehouse_id &&
      mongoose.Types.ObjectId.isValid(req.query.warehouse_id)
    ) {
      filter.warehouse_id = req.query.warehouse_id;
    }
    if (req.query.direction) {
      filter.direction = normalizeDirection(req.query.direction);
    }
    if (req.query.type) {
      filter.type = req.query.type;
    }

    const data = await StockMovement.find(filter)
      .sort({ createdAt: -1 })
      .populate("product_id", "product_name product_code")
      .populate("warehouse_id", "warehouse_name");

    await hydrateMovementRefs(data);

    return res.status(200).json({ success: true, count: data.length, data });
  } catch (error) {
    console.error("❌ getAllStockMovements error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error",
    });
  }
}

/**
 * Active stock movements only; populate from query (same rules as dynamic CRUD).
 *
 * Examples:
 * - ?populate=product_id,warehouse_id
 * - ?product_id=true&warehouse_id=true  (populate only; use real id in filter another way — prefer populate=)
 * - Filter by warehouse: ?warehouse_id=507f1f77bcf86cd799439011 (24-char ObjectId)
 */
async function getAllStockMovementsActive(req, res) {
  try {
    const filter = {
      status: "active",
      $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }],
    };

    if (req.user?.company_id) {
      filter.company_id = req.user.company_id;
    }
    if (
      req.query.product_id &&
      mongoose.Types.ObjectId.isValid(String(req.query.product_id).trim())
    ) {
      filter.product_id = String(req.query.product_id).trim();
    }
    if (
      req.query.warehouse_id &&
      mongoose.Types.ObjectId.isValid(String(req.query.warehouse_id).trim())
    ) {
      filter.warehouse_id = String(req.query.warehouse_id).trim();
    }
    if (req.query.direction) {
      filter.direction = normalizeDirection(req.query.direction);
    }
    if (req.query.type) {
      filter.type = req.query.type;
    }

    const populate = buildPopulateFromQuery(req.query, "stock_movement");

    const response = await handleGenericGetAll(req, "stock_movement", {
      filter,
      populate,
      sort: { createdAt: -1 },
      limit: req.query.limit ? parseInt(req.query.limit, 10) : null,
      skip: req.query.skip ? parseInt(req.query.skip, 10) || 0 : 0,
      search: req.query.search,
      searchFields: parseSearchFieldsFromQuery(req.query.searchFields),
    });

    if (response.success && Array.isArray(response.data)) {
      await hydrateMovementRefs(response.data);
    }

    return res.status(response.status || 200).json(response);
  } catch (error) {
    console.error("❌ getAllStockMovementsActive error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error",
    });
  }
}

module.exports = {
  createStockMovement,
  createStockMovementRecord,
  hydrateMovementRefs,
  updateStockMovement,
  deleteStockMovement,
  getStockMovementById,
  getAllStockMovements,
  getAllStockMovementsActive,
};
