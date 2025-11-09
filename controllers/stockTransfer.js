const mongoose = require("mongoose");
const Product = require("../models/product");
const Warehouse = require("../models/warehouse");
const StockTransfer = require("../models/stock_transfer");
const routeRegistry = require("../utils/routeRegistry");

function buildActiveFilter(companyId) {
  const baseFilter = {
    $or: [
      { deletedAt: { $exists: false } },
      { deletedAt: null }
    ]
  };

  if (companyId) {
    return {
      ...baseFilter,
      company_id: companyId
    };
  }

  return baseFilter;
}

function buildRedirectUrl(basePath, params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      query.set(key, value);
    }
  });
  const queryString = query.toString();
  return queryString ? `${basePath}?${queryString}` : basePath;
}

async function renderStockTransfer(req, res) {
  try {
    const companyId = req.user && req.user.company_id ? req.user.company_id : null;
    const companyFilter = buildActiveFilter(companyId);

    const productDocs = await Product.find(companyFilter)
      .populate("warehouse_inventory.warehouse_id", "warehouse_name status")
      .sort({ product_name: 1 })
      .select("product_name product_code warehouse_inventory company_id")
      .lean();

    const warehouseDocs = await Warehouse.find(companyFilter)
      .sort({ warehouse_name: 1 })
      .select("warehouse_name warehouse_address status company_id")
      .lean();

    const recentTransfersDocs = await StockTransfer.find(companyFilter)
      .sort({ createdAt: -1 })
      .limit(20)
      .populate("product_id", "product_name product_code")
      .populate("from_warehouse_id", "warehouse_name")
      .populate("to_warehouse_id", "warehouse_name")
      .lean();

    const products = productDocs.map(doc => ({
      ...doc,
      _id: doc._id.toString(),
      warehouse_inventory: (doc.warehouse_inventory || []).map(entry => ({
        warehouse_id: entry.warehouse_id && entry.warehouse_id._id
          ? entry.warehouse_id._id.toString()
          : entry.warehouse_id
            ? entry.warehouse_id.toString()
            : "",
        warehouse_name: entry.warehouse_id && entry.warehouse_id.warehouse_name
          ? entry.warehouse_id.warehouse_name
          : "Unknown Warehouse",
        quantity: entry.quantity || 0,
        last_updated: entry.last_updated
      }))
    }));

    const warehouses = warehouseDocs.map(doc => ({
      ...doc,
      _id: doc._id.toString()
    }));

    const productInventoryMap = {};
    products.forEach(product => {
      productInventoryMap[product._id] = product.warehouse_inventory || [];
    });

    const recentTransfers = recentTransfersDocs.map(transfer => ({
      ...transfer,
      _id: transfer._id.toString(),
      product_id: transfer.product_id
        ? {
            ...transfer.product_id,
            _id: transfer.product_id._id ? transfer.product_id._id.toString() : transfer.product_id.toString()
          }
        : null,
      from_warehouse_id: transfer.from_warehouse_id
        ? {
            ...transfer.from_warehouse_id,
            _id: transfer.from_warehouse_id._id ? transfer.from_warehouse_id._id.toString() : transfer.from_warehouse_id.toString()
          }
        : null,
      to_warehouse_id: transfer.to_warehouse_id
        ? {
            ...transfer.to_warehouse_id,
            _id: transfer.to_warehouse_id._id ? transfer.to_warehouse_id._id.toString() : transfer.to_warehouse_id.toString()
          }
        : null
    }));

    const formDefaults = {
      product_id: req.query.product_id || "",
      from_warehouse_id: req.query.from_warehouse_id || "",
      to_warehouse_id: req.query.to_warehouse_id || "",
      quantity: req.query.quantity || "",
      notes: req.query.notes || ""
    };

    const customTabs = routeRegistry.getCustomTabs("products");

    res.render("admin/product-stock-transfer", {
      title: "Product Stock Transfer",
      modelName: "products",
      singularName: "product",
      titleCase: "Product",
      routes: req.routes || [],
      baseUrl: req.baseUrl,
      products,
      warehouses,
      recentTransfers,
      productInventoryMap,
      formDefaults,
      customTabs,
      customTabsActivePath: "/admin/products/stock-transfer"
    });
  } catch (error) {
    console.error("❌ Stock transfer page error:", error);
    req.flash("error", "Unable to load stock transfer page. Please try again.");
    res.redirect("/admin/products");
  }
}

async function updateParentWarehouseInventory(product) {
  const parentId =
    product.parent_product_id &&
    product.parent_product_id.toString() !== product._id.toString()
      ? product.parent_product_id.toString()
      : null;

  if (!parentId) {
    return;
  }

  const [parentProduct, variantProducts] = await Promise.all([
    Product.findById(parentId),
    Product.find({
      parent_product_id: parentId,
      $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }]
    }).select("warehouse_inventory")
  ]);

  if (!parentProduct) {
    return;
  }

  const aggregateMap = new Map();

  variantProducts.forEach(variant => {
    (variant.warehouse_inventory || []).forEach(entry => {
      const warehouseId = entry.warehouse_id
        ? entry.warehouse_id.toString()
        : null;
      if (!warehouseId) {
        return;
      }

      const record = aggregateMap.get(warehouseId) || {
        quantity: 0,
        last_updated: entry.last_updated || new Date()
      };

      record.quantity += entry.quantity || 0;

      if (
        entry.last_updated &&
        (!record.last_updated || entry.last_updated > record.last_updated)
      ) {
        record.last_updated = entry.last_updated;
      }

      aggregateMap.set(warehouseId, record);
    });
  });

  parentProduct.warehouse_inventory = Array.from(aggregateMap.entries()).map(
    ([warehouseId, data]) => ({
      warehouse_id: mongoose.Types.ObjectId.isValid(warehouseId)
        ? new mongoose.Types.ObjectId(warehouseId)
        : warehouseId,
      quantity: data.quantity,
      last_updated: data.last_updated || new Date()
    })
  );

  parentProduct.markModified("warehouse_inventory");

  if (product.updated_by && parentProduct.schema.paths.updated_by) {
    parentProduct.updated_by = product.updated_by;
  }

  await parentProduct.save();
}

async function processStockTransfer({
  productId,
  fromWarehouseId,
  toWarehouseId,
  quantity,
  notes,
  user
}) {
  const errors = [];
  const transferQty = parseInt(quantity, 10);

  if (!productId || !mongoose.Types.ObjectId.isValid(productId)) {
    errors.push("Select a valid product.");
  }

  if (!fromWarehouseId || !mongoose.Types.ObjectId.isValid(fromWarehouseId)) {
    errors.push("Select a valid source warehouse.");
  }

  if (!toWarehouseId || !mongoose.Types.ObjectId.isValid(toWarehouseId)) {
    errors.push("Select a valid destination warehouse.");
  }

  if (!Number.isFinite(transferQty) || transferQty <= 0) {
    errors.push("Transfer quantity must be greater than zero.");
  }

  if (
    fromWarehouseId &&
    toWarehouseId &&
    fromWarehouseId.toString() === toWarehouseId.toString()
  ) {
    errors.push("Source and destination warehouses must be different.");
  }

  if (errors.length > 0) {
    return { success: false, errors };
  }

  const companyId = user && user.company_id ? user.company_id : null;
  const companyFilter = companyId ? { company_id: companyId } : {};

  const product = await Product.findOne({
    _id: productId,
    ...companyFilter,
    $or: [
      { deletedAt: { $exists: false } },
      { deletedAt: null }
    ]
  });

  if (!product) {
    return {
      success: false,
      errors: ["Selected product was not found or is inactive."]
    };
  }

  const [fromWarehouse, toWarehouse] = await Promise.all([
    Warehouse.findOne({
      _id: fromWarehouseId,
      // ...companyFilter,
      $or: [
        { deletedAt: { $exists: false } },
        { deletedAt: null }
      ]
    }),
    Warehouse.findOne({
      _id: toWarehouseId,
      // ...companyFilter,
      $or: [
        { deletedAt: { $exists: false } },
        { deletedAt: null }
      ]
    })
  ]);

  if (!fromWarehouse) {
    return {
      success: false,
      errors: ["Source warehouse was not found or is inactive."],
      data: {
        fromWarehouse: fromWarehouse
      }
    };
  }

  if (!toWarehouse) {
    return {
      success: false,
      errors: ["Destination warehouse was not found or is inactive."]
    };
  }

  const fromBalanceBefore = product.getWarehouseQuantity(fromWarehouseId);
  if (fromBalanceBefore < transferQty) {
    return {
      success: false,
      errors: [
        `Insufficient quantity in ${fromWarehouse.warehouse_name}. Available: ${fromBalanceBefore}`
      ]
    };
  }

  const toBalanceBefore = product.getWarehouseQuantity(toWarehouseId);

  product.decreaseWarehouseQuantity(fromWarehouseId, transferQty);
  product.increaseWarehouseQuantity(toWarehouseId, transferQty);
  product.markModified("warehouse_inventory");

  if (user && user._id && product.schema.paths.updated_by) {
    product.updated_by = user._id;
  }

  await product.save();
  await updateParentWarehouseInventory(product);
  await product.populate("warehouse_inventory.warehouse_id", "warehouse_name");

  const transferRecord = await StockTransfer.create({
    product_id: productId,
    from_warehouse_id: fromWarehouseId,
    to_warehouse_id: toWarehouseId,
    quantity: transferQty,
    notes,
    transfer_status: "Completed",
    transfer_date: new Date(),
    from_balance_before: fromBalanceBefore,
    from_balance_after: fromBalanceBefore - transferQty,
    to_balance_before: toBalanceBefore,
    to_balance_after: toBalanceBefore + transferQty,
    company_id: companyId || undefined,
    created_by: user && user._id ? user._id : undefined,
    updated_by: user && user._id ? user._id : undefined
  });

  const populatedTransfer = await StockTransfer.findById(transferRecord._id)
    .populate("product_id", "product_name product_code")
    .populate("from_warehouse_id", "warehouse_name")
    .populate("to_warehouse_id", "warehouse_name")
    .lean();

  const message = `Moved ${transferQty} ${transferQty === 1 ? "unit" : "units"} from ${fromWarehouse.warehouse_name} to ${toWarehouse.warehouse_name}.`;

  return {
    success: true,
    message,
    transfer: populatedTransfer,
    product: product.toObject()
  };
}

async function handleStockTransfer(req, res) {
  const { product_id, from_warehouse_id, to_warehouse_id, quantity, notes } = req.body;
  const redirectUrl = buildRedirectUrl("/admin/products/stock-transfer", {
    product_id,
    from_warehouse_id,
    to_warehouse_id,
    quantity,
    notes
  });

  try {
    const result = await processStockTransfer({
      productId: product_id,
      fromWarehouseId: from_warehouse_id,
      toWarehouseId: to_warehouse_id,
      quantity,
      notes,
      user: req.user
    });

    if (!result.success) {
      req.flash("error", result.errors.join(" "));
      return res.redirect(redirectUrl);
    }

    req.flash("success", result.message);
    return res.redirect(buildRedirectUrl("/admin/products/stock-transfer", { product_id }));
  } catch (error) {
    console.error("❌ Stock transfer error:", error);
    req.flash("error", error.message || "Unable to complete stock transfer. Please try again.");
    return res.redirect(redirectUrl);
  }
}

async function apiCreateStockTransfer(req, res) {
  try {
    const result = await processStockTransfer({
      productId: req.body.product_id || req.body.productId,
      fromWarehouseId: req.body.from_warehouse_id || req.body.fromWarehouseId,
      toWarehouseId: req.body.to_warehouse_id || req.body.toWarehouseId,
      quantity: req.body.quantity,
      notes: req.body.notes,
      user: req.user
    });

    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: "Unable to complete stock transfer",
        errors: result.errors
      });
    }

    return res.status(201).json({
      success: true,
      message: result.message,
      data: {
        transfer: result.transfer,
        product: result.product
      }
    });
  } catch (error) {
    console.error("❌ API stock transfer error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error"
    });
  }
}

async function apiGetStockTransfers(req, res) {
  try {
    const companyId = req.user && req.user.company_id ? req.user.company_id : null;
    const filter = buildActiveFilter(companyId);

    if (req.query.product_id) {
      if (!mongoose.Types.ObjectId.isValid(req.query.product_id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid product_id provided"
        });
      }
      filter.product_id = req.query.product_id;
    }

    if (req.query.from_warehouse_id) {
      if (!mongoose.Types.ObjectId.isValid(req.query.from_warehouse_id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid from_warehouse_id provided"
        });
      }
      filter.from_warehouse_id = req.query.from_warehouse_id;
    }

    if (req.query.to_warehouse_id) {
      if (!mongoose.Types.ObjectId.isValid(req.query.to_warehouse_id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid to_warehouse_id provided"
        });
      }
      filter.to_warehouse_id = req.query.to_warehouse_id;
    }

    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    const [transfers, total] = await Promise.all([
      StockTransfer.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("product_id", "product_name product_code")
        .populate("from_warehouse_id", "warehouse_name")
        .populate("to_warehouse_id", "warehouse_name")
        .lean(),
      StockTransfer.countDocuments(filter)
    ]);

    return res.status(200).json({
      success: true,
      data: transfers,
      pagination: {
        total,
        page,
        limit,
        hasNextPage: skip + transfers.length < total,
        hasPrevPage: page > 1
      }
    });
  } catch (error) {
    console.error("❌ API get stock transfers error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error"
    });
  }
}

module.exports = {
  renderStockTransfer,
  handleStockTransfer,
  processStockTransfer,
  apiCreateStockTransfer,
  apiGetStockTransfers
};
