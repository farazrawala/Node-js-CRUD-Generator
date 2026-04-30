const mongoose = require("mongoose");
const StockMovement = require("../models/stock_movement");
const WarehouseInventory = require("../models/warehouse_inventory");

function toObjectId(id) {
  if (!id || !mongoose.Types.ObjectId.isValid(id)) return null;
  return new mongoose.Types.ObjectId(id);
}

function normalizeDirection(direction) {
  return direction === "out" ? "out" : "in";
}

function getSignedQuantity(direction, quantity) {
  const qty = Number(quantity || 0);
  return normalizeDirection(direction) === "out" ? -qty : qty;
}

async function applyWarehouseInventoryDelta({
  productId,
  warehouseId,
  quantityDelta,
  user,
}) {
  const filter = {
    product_id: productId,
    warehouse_id: warehouseId,
    $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }],
  };

  if (user?.company_id) {
    filter.company_id = user.company_id;
  }

  let inventory = await WarehouseInventory.findOne(filter);

  if (!inventory) {
    if (quantityDelta < 0) {
      throw new Error("Insufficient inventory to subtract stock");
    }

    inventory = new WarehouseInventory({
      product_id: productId,
      warehouse_id: warehouseId,
      quantity: 0,
      company_id: user?.company_id || undefined,
      created_by: user?._id || undefined,
      updated_by: user?._id || undefined,
    });
  }

  const nextQty = Number(inventory.quantity || 0) + Number(quantityDelta || 0);
  if (nextQty < 0) {
    throw new Error("Insufficient inventory quantity");
  }

  inventory.quantity = nextQty;
  if (user?._id) {
    inventory.updated_by = user._id;
  }

  await inventory.save();
  return inventory;
}

async function createStockMovement(req, res) {
  try {
    const productId = toObjectId(req.body.product_id || req.body.productId);
    const warehouseId = toObjectId(
      req.body.warehouse_id || req.body.warehouseId,
    );
    const quantity = Number(req.body.quantity);
    const direction = normalizeDirection(req.body.direction);
    const type = req.body.type;

    if (
      !productId ||
      !warehouseId ||
      !type ||
      !Number.isFinite(quantity) ||
      quantity <= 0
    ) {
      return res.status(400).json({
        success: false,
        message:
          "product_id, warehouse_id, type, direction and positive quantity are required",
      });
    }

    const movement = await StockMovement.create({
      product_id: productId,
      warehouse_id: warehouseId,
      type,
      quantity,
      direction,
      reason: req.body.reason || undefined,
      company_id: req.user?.company_id || req.body.company_id || undefined,
      created_by: req.user?._id || undefined,
      updated_by: req.user?._id || undefined,
      status: req.body.status || "active",
    });

    await applyWarehouseInventoryDelta({
      productId,
      warehouseId,
      quantityDelta: getSignedQuantity(direction, quantity),
      user: req.user,
    });

    return res.status(201).json({
      success: true,
      message: "Stock movement created and warehouse inventory updated",
      data: movement,
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

    const movement = await StockMovement.findOne({
      _id: id,
      $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }],
    });

    if (!movement) {
      return res
        .status(404)
        .json({ success: false, message: "Stock movement not found" });
    }

    const newProductId =
      toObjectId(req.body.product_id || req.body.productId) ||
      movement.product_id;
    const newWarehouseId =
      toObjectId(req.body.warehouse_id || req.body.warehouseId) ||
      movement.warehouse_id;
    const newQuantity =
      req.body.quantity !== undefined ?
        Number(req.body.quantity)
      : Number(movement.quantity);
    const newDirection =
      req.body.direction !== undefined ?
        normalizeDirection(req.body.direction)
      : movement.direction;

    if (!Number.isFinite(newQuantity) || newQuantity <= 0) {
      return res.status(400).json({
        success: false,
        message: "quantity must be a positive number",
      });
    }

    const oldDelta = getSignedQuantity(movement.direction, movement.quantity);
    const newDelta = getSignedQuantity(newDirection, newQuantity);

    await applyWarehouseInventoryDelta({
      productId: movement.product_id,
      warehouseId: movement.warehouse_id,
      quantityDelta: -oldDelta,
      user: req.user,
    });

    await applyWarehouseInventoryDelta({
      productId: newProductId,
      warehouseId: newWarehouseId,
      quantityDelta: newDelta,
      user: req.user,
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

    await movement.save();

    return res.status(200).json({
      success: true,
      message: "Stock movement updated and warehouse inventory synced",
      data: movement,
    });
  } catch (error) {
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

    const movement = await StockMovement.findOne({
      _id: id,
      $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }],
    });

    if (!movement) {
      return res
        .status(404)
        .json({ success: false, message: "Stock movement not found" });
    }

    const oldDelta = getSignedQuantity(movement.direction, movement.quantity);
    await applyWarehouseInventoryDelta({
      productId: movement.product_id,
      warehouseId: movement.warehouse_id,
      quantityDelta: -oldDelta,
      user: req.user,
    });

    movement.deletedAt = new Date();
    movement.status = "inactive";
    movement.updated_by = req.user?._id || movement.updated_by;
    await movement.save();

    return res.status(200).json({
      success: true,
      message: "Stock movement deleted and warehouse inventory reverted",
    });
  } catch (error) {
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

    return res.status(200).json({ success: true, count: data.length, data });
  } catch (error) {
    console.error("❌ getAllStockMovements error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error",
    });
  }
}

module.exports = {
  createStockMovement,
  updateStockMovement,
  deleteStockMovement,
  getStockMovementById,
  getAllStockMovements,
};
