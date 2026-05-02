const mongoose = require("mongoose");
const Product = require("../models/product");
const Warehouse = require("../models/warehouse");
const WarehouseInventory = require("../models/warehouse_inventory");
const StockTransfer = require("../models/stock_transfer");
const routeRegistry = require("../utils/routeRegistry");

function buildActiveFilter(companyId) {
  const baseFilter = {
    $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }],
  };

  if (companyId) {
    return {
      ...baseFilter,
      company_id: companyId,
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
    const companyId =
      req.user && req.user.company_id ? req.user.company_id : null;
    const companyFilter = buildActiveFilter(companyId);

    const productDocs = await Product.find(companyFilter)
      .sort({ product_name: 1 })
      .select("product_name product_code company_id")
      .lean();

    const invMatch = {
      quantity: { $gt: 0 },
      status: "active",
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    };
    if (companyId) {
      invMatch.company_id = companyId;
    }

    const invRows = await WarehouseInventory.find(invMatch)
      .populate("warehouse_id", "name code status")
      .populate("product_id", "product_name product_code")
      .lean();

    const invByProduct = new Map();
    for (const row of invRows) {
      if (!row.product_id) continue;
      const pid = row.product_id._id.toString();
      if (!invByProduct.has(pid)) invByProduct.set(pid, []);
      const wid = row.warehouse_id;
      invByProduct.get(pid).push({
        warehouse_id:
          wid && wid._id ? wid._id.toString()
          : row.warehouse_id ? row.warehouse_id.toString()
          : "",
        warehouse_name: wid && wid.name ? wid.name : "Unknown Warehouse",
        quantity: row.quantity || 0,
        last_updated: row.updatedAt,
      });
    }

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

    const products = productDocs.map((doc) => ({
      ...doc,
      _id: doc._id.toString(),
      warehouse_inventory: invByProduct.get(doc._id.toString()) || [],
    }));

    const warehouses = warehouseDocs.map((doc) => ({
      ...doc,
      _id: doc._id.toString(),
    }));

    const productInventoryMap = {};
    products.forEach((product) => {
      productInventoryMap[product._id] = product.warehouse_inventory || [];
    });

    const recentTransfers = recentTransfersDocs.map((transfer) => ({
      ...transfer,
      _id: transfer._id.toString(),
      product_id:
        transfer.product_id ?
          {
            ...transfer.product_id,
            _id:
              transfer.product_id._id ?
                transfer.product_id._id.toString()
              : transfer.product_id.toString(),
          }
        : null,
      from_warehouse_id:
        transfer.from_warehouse_id ?
          {
            ...transfer.from_warehouse_id,
            _id:
              transfer.from_warehouse_id._id ?
                transfer.from_warehouse_id._id.toString()
              : transfer.from_warehouse_id.toString(),
          }
        : null,
      to_warehouse_id:
        transfer.to_warehouse_id ?
          {
            ...transfer.to_warehouse_id,
            _id:
              transfer.to_warehouse_id._id ?
                transfer.to_warehouse_id._id.toString()
              : transfer.to_warehouse_id.toString(),
          }
        : null,
    }));

    const formDefaults = {
      product_id: req.query.product_id || "",
      from_warehouse_id: req.query.from_warehouse_id || "",
      to_warehouse_id: req.query.to_warehouse_id || "",
      quantity: req.query.quantity || "",
      notes: req.query.notes || "",
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
      customTabsActivePath: "/admin/products/stock-transfer",
    });
  } catch (error) {
    console.error("❌ Stock transfer page error:", error);
    req.flash("error", "Unable to load stock transfer page. Please try again.");
    res.redirect("/admin/products");
  }
}

async function processStockTransfer({
  productId,
  fromWarehouseId,
  toWarehouseId,
  quantity,
  notes,
  user,
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
  if (!companyId) {
    return {
      success: false,
      errors: [
        "Company context is required. Log in with a user that has company_id set.",
      ],
    };
  }
  const companyFilter = { company_id: companyId };

  const product = await Product.findOne({
    _id: productId,
    ...companyFilter,
    $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }],
  });

  if (!product) {
    return {
      success: false,
      errors: ["Selected product was not found or is inactive."],
    };
  }

  const [fromWarehouse, toWarehouse] = await Promise.all([
    Warehouse.findOne({
      _id: fromWarehouseId,
      $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }],
    }),
    Warehouse.findOne({
      _id: toWarehouseId,
      $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }],
    }),
  ]);

  if (!fromWarehouse) {
    return {
      success: false,
      errors: ["Source warehouse was not found or is inactive."],
    };
  }

  if (!toWarehouse) {
    return {
      success: false,
      errors: ["Destination warehouse was not found or is inactive."],
    };
  }

  const invBase = {
    product_id: productId,
    $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }],
    status: "active",
    ...companyFilter,
  };

  const fromInv = await WarehouseInventory.findOne({
    ...invBase,
    warehouse_id: fromWarehouseId,
  });

  const fromBalanceBefore = fromInv ? Number(fromInv.quantity) : 0;

  if (fromBalanceBefore < transferQty) {
    const fromLabel = fromWarehouse.name || "source warehouse";
    return {
      success: false,
      errors: [
        `Insufficient quantity in ${fromLabel}. Available: ${fromBalanceBefore}`,
      ],
    };
  }

  let toInv = await WarehouseInventory.findOne({
    ...invBase,
    warehouse_id: toWarehouseId,
  });

  const toBalanceBefore = toInv ? Number(toInv.quantity) : 0;

  let transferRecord;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      fromInv.quantity = fromBalanceBefore - transferQty;
      if (user && user._id) {
        fromInv.updated_by = user._id;
      }
      await fromInv.save({ session });

      if (!toInv) {
        toInv = new WarehouseInventory({
          product_id: productId,
          warehouse_id: toWarehouseId,
          quantity: 0,
          company_id: companyId,
          created_by: user && user._id ? user._id : undefined,
          updated_by: user && user._id ? user._id : undefined,
        });
      }
      toInv.quantity = toBalanceBefore + transferQty;
      if (user && user._id) {
        toInv.updated_by = user._id;
      }
      await toInv.save({ session });

      const [created] = await StockTransfer.create(
        [
          {
            product_id: productId,
            from_warehouse_id: fromWarehouseId,
            to_warehouse_id: toWarehouseId,
            quantity: transferQty,
            notes,
            transfer_status: "completed",
            transfer_date: new Date(),
            from_balance_before: fromBalanceBefore,
            from_balance_after: fromBalanceBefore - transferQty,
            to_balance_before: toBalanceBefore,
            to_balance_after: toBalanceBefore + transferQty,
            company_id: companyId,
            created_by: user && user._id ? user._id : undefined,
            updated_by: user && user._id ? user._id : undefined,
          },
        ],
        { session },
      );
      transferRecord = created;
    });
  } catch (err) {
    console.error("❌ Stock transfer transaction error:", err);
    return {
      success: false,
      errors: [
        err.message ||
          "Transfer could not be completed. Use a MongoDB replica set if transaction support is required.",
      ],
    };
  } finally {
    session.endSession();
  }

  const populatedTransfer = await StockTransfer.findById(transferRecord._id)
    .populate("product_id", "product_name product_code")
    .populate("from_warehouse_id", "name")
    .populate("to_warehouse_id", "name")
    .lean();

  const fromLabel = fromWarehouse.name || "source";
  const toLabel = toWarehouse.name || "destination";
  const message = `Moved ${transferQty} ${transferQty === 1 ? "unit" : "units"} from ${fromLabel} to ${toLabel}.`;

  return {
    success: true,
    message,
    transfer: populatedTransfer,
    product: product.toObject(),
  };
}

async function handleStockTransfer(req, res) {
  const { product_id, from_warehouse_id, to_warehouse_id, quantity, notes } =
    req.body;
  const redirectUrl = buildRedirectUrl("/admin/products/stock-transfer", {
    product_id,
    from_warehouse_id,
    to_warehouse_id,
    quantity,
    notes,
  });

  try {
    const result = await processStockTransfer({
      productId: product_id,
      fromWarehouseId: from_warehouse_id,
      toWarehouseId: to_warehouse_id,
      quantity,
      notes,
      user: req.user,
    });

    if (!result.success) {
      req.flash("error", result.errors.join(" "));
      return res.redirect(redirectUrl);
    }

    req.flash("success", result.message);
    return res.redirect(
      buildRedirectUrl("/admin/products/stock-transfer", { product_id }),
    );
  } catch (error) {
    console.error("❌ Stock transfer error:", error);
    req.flash(
      "error",
      error.message || "Unable to complete stock transfer. Please try again.",
    );
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
      user: req.user,
    });

    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: "Unable to complete stock transfer",
        errors: result.errors,
      });
    }

    return res.status(201).json({
      success: true,
      message: result.message,
      data: {
        transfer: result.transfer,
        product: result.product,
      },
    });
  } catch (error) {
    console.error("❌ API stock transfer error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error",
    });
  }
}

async function apiGetStockTransfers(req, res) {
  try {
    const companyId =
      req.user && req.user.company_id ? req.user.company_id : null;
    const filter = buildActiveFilter(companyId);

    if (req.query.product_id) {
      if (!mongoose.Types.ObjectId.isValid(req.query.product_id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid product_id provided",
        });
      }
      filter.product_id = req.query.product_id;
    }

    if (req.query.from_warehouse_id) {
      if (!mongoose.Types.ObjectId.isValid(req.query.from_warehouse_id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid from_warehouse_id provided",
        });
      }
      filter.from_warehouse_id = req.query.from_warehouse_id;
    }

    if (req.query.to_warehouse_id) {
      if (!mongoose.Types.ObjectId.isValid(req.query.to_warehouse_id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid to_warehouse_id provided",
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
      StockTransfer.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      data: transfers,
      pagination: {
        total,
        page,
        limit,
        hasNextPage: skip + transfers.length < total,
        hasPrevPage: page > 1,
      },
    });
  } catch (error) {
    console.error("❌ API get stock transfers error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error",
    });
  }
}

module.exports = {
  renderStockTransfer,
  handleStockTransfer,
  processStockTransfer,
  apiCreateStockTransfer,
  apiGetStockTransfers,
};
