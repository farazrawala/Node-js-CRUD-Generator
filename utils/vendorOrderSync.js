const Product = require("../models/product");
const Order = require("../models/order");
const OrderItem = require("../models/order_item");
const CompanyConnection = require("../models/company_connection");
const WarehouseInventory = require("../models/warehouse_inventory");
const VendorOrder = require("../models/vendor_order");
const { coalesceObjectId } = require("./modelHelper");

function toYesNo(value, fallback = "yes") {
  if (value === "yes" || value === "no") return value;
  if (value === true || value === "true" || value === 1 || value === "1") {
    return "yes";
  }
  if (value === false || value === "false" || value === 0 || value === "0") {
    return "no";
  }
  return fallback;
}

function connectionPartyId(value) {
  if (value == null) return "";
  if (typeof value === "object") {
    return String(value._id ?? value.id ?? "");
  }
  return String(value);
}

function connectionSyncOrderValue(connection) {
  const nested =
    connection?.product_settings && typeof connection.product_settings === "object"
      ? connection.product_settings
      : null;
  return connection?.sync_order_to_vendor ?? nested?.sync_order_to_vendor;
}

function isSyncOrderToVendorEnabled(connection) {
  return toYesNo(connectionSyncOrderValue(connection), "yes") === "yes";
}

function roundQty(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/**
 * Qty that should list on the origin (A) when B sells against A stock.
 * `alreadyDeducted` = B warehouse already reduced by this sale.
 */
function vendorQtyFromLocalStock(orderedQty, localOnHand, alreadyDeducted) {
  const ordered = roundQty(orderedQty);
  const local = roundQty(localOnHand);
  if (ordered <= 0) return 0;
  if (alreadyDeducted) {
    if (local < 0) return roundQty(Math.min(ordered, -local));
    return 0;
  }
  if (local >= ordered) return 0;
  return roundQty(ordered - Math.max(0, local));
}

/**
 * Partner company ids with an approved connection and `sync_order_to_vendor` enabled.
 * If any approved connection with that partner has the flag set to `no`, the partner is excluded.
 */
async function listApprovedVendorSyncPartnerIds(vendorCompanyId) {
  const vendorId = coalesceObjectId(vendorCompanyId);
  if (!vendorId) return [];

  const vendorKey = String(vendorId);
  const connections = await CompanyConnection.find({
    status: "approved",
    $or: [{ company_id: vendorId }, { target_company_id: vendorId }],
  })
    .select("company_id target_company_id sync_order_to_vendor product_settings")
    .lean();

  const blocked = new Set();
  const allowed = new Map();

  for (const connection of connections) {
    const companyKey = connectionPartyId(connection.company_id);
    const targetKey = connectionPartyId(connection.target_company_id);
    const otherKey = companyKey === vendorKey ? targetKey : companyKey;
    if (!otherKey || otherKey === vendorKey) continue;

    if (!isSyncOrderToVendorEnabled(connection)) {
      blocked.add(otherKey);
      allowed.delete(otherKey);
      continue;
    }
    if (blocked.has(otherKey) || allowed.has(otherKey)) continue;
    const oid = coalesceObjectId(otherKey);
    if (oid) allowed.set(otherKey, oid);
  }

  return Array.from(allowed.values());
}

async function findApprovedConnection(companyA, companyB) {
  const a = coalesceObjectId(companyA);
  const b = coalesceObjectId(companyB);
  if (!a || !b) return null;
  const rows = await CompanyConnection.find({
    status: "approved",
    $or: [
      { company_id: a, target_company_id: b },
      { company_id: b, target_company_id: a },
    ],
  }).lean();
  if (!rows.length) return null;
  if (rows.some((row) => !isSyncOrderToVendorEnabled(row))) return null;
  return rows[0];
}

async function mapLocalWarehouseQty(productIds, companyId) {
  const map = new Map();
  const oids = [
    ...new Set(
      (productIds || [])
        .map((id) => coalesceObjectId(id))
        .filter(Boolean)
        .map((id) => String(id)),
    ),
  ].map((id) => coalesceObjectId(id));
  for (const id of oids) map.set(String(id), 0);
  if (!oids.length || !companyId) return map;

  const rows = await WarehouseInventory.aggregate([
    {
      $match: {
        product_id: { $in: oids },
        company_id: coalesceObjectId(companyId),
        status: "active",
        $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
      },
    },
    {
      $group: {
        _id: "$product_id",
        total_qty: { $sum: { $ifNull: ["$quantity", 0] } },
      },
    },
  ]);
  for (const row of rows) {
    map.set(String(row._id), roundQty(row.total_qty));
  }
  return map;
}

function normalizeInputItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((row) => {
      const productId = coalesceObjectId(row?.product_id || row?.buyer_product_id);
      const qty = roundQty(row?.qty);
      if (!productId || qty <= 0) return null;
      return {
        product_id: productId,
        qty,
        name: row?.name || row?.product_name || row?.buyer_product_name || "",
        price: Number(row?.price) || 0,
        source_order_item_id: coalesceObjectId(row?._id || row?.source_order_item_id),
      };
    })
    .filter(Boolean);
}

async function loadItemsFromBuyerOrder(orderId, buyerCompanyId) {
  const order = await Order.findOne({
    _id: coalesceObjectId(orderId),
    company_id: coalesceObjectId(buyerCompanyId),
    deletedAt: null,
  }).lean();
  if (!order) {
    const err = new Error("Order not found for this company");
    err.statusCode = 404;
    throw err;
  }
  const lines = await OrderItem.find({
    order_id: order._id,
    company_id: order.company_id,
    status: "active",
    deletedAt: null,
  }).lean();
  return {
    order,
    items: lines.map((line) => ({
      product_id: coalesceObjectId(line.product_id),
      qty: roundQty(line.qty),
      name: line.name || "",
      price: Number(line.price) || 0,
      source_order_item_id: line._id,
    })),
  };
}

/**
 * Create vendor-order rows on origin companies for me-too lines that used A stock.
 * @returns {Promise<{ created: object[], skipped: object[] }>}
 */
async function syncBuyerOrderToVendor({
  buyerCompanyId,
  userId = null,
  orderId = null,
  order = null,
  items = null,
  alreadyDeducted = false,
} = {}) {
  const buyerId = coalesceObjectId(buyerCompanyId);
  if (!buyerId) {
    const err = new Error("Buyer company is required");
    err.statusCode = 400;
    throw err;
  }

  let sourceOrder = order || null;
  let inputItems = normalizeInputItems(items);

  if (orderId && !inputItems.length) {
    const loaded = await loadItemsFromBuyerOrder(orderId, buyerId);
    sourceOrder = loaded.order;
    inputItems = loaded.items;
    alreadyDeducted = true;
  } else if (orderId && !sourceOrder) {
    sourceOrder = await Order.findOne({
      _id: coalesceObjectId(orderId),
      company_id: buyerId,
      deletedAt: null,
    }).lean();
  }

  const skipped = [];
  if (!inputItems.length) {
    return { created: [], skipped: [{ reason: "no_items" }] };
  }

  if (sourceOrder?._id) {
    const existing = await VendorOrder.find({
      buyer_company_id: buyerId,
      source_order_id: sourceOrder._id,
      deletedAt: null,
    }).lean();
    if (existing.length) {
      return {
        created: existing,
        skipped: [{ reason: "already_synced", source_order_id: String(sourceOrder._id) }],
      };
    }
  }

  const productIds = inputItems.map((row) => row.product_id);
  const products = await Product.find({
    _id: { $in: productIds },
    company_id: buyerId,
    deletedAt: null,
  })
    .select(
      "_id product_name fetch_from_product_id fetch_from_company_id origin_qty",
    )
    .lean();
  const productById = new Map(products.map((row) => [String(row._id), row]));
  const localQtyByProduct = await mapLocalWarehouseQty(productIds, buyerId);

  const grouped = new Map();
  for (const line of inputItems) {
    const product = productById.get(String(line.product_id));
    if (!product) {
      skipped.push({
        product_id: String(line.product_id),
        reason: "product_not_found",
      });
      continue;
    }
    const originProductId = coalesceObjectId(product.fetch_from_product_id);
    const originCompanyId = coalesceObjectId(product.fetch_from_company_id);
    if (!originProductId || !originCompanyId) {
      skipped.push({
        product_id: String(product._id),
        product_name: product.product_name,
        reason: "not_me_too",
      });
      continue;
    }
    if (String(originCompanyId) === String(buyerId)) {
      skipped.push({
        product_id: String(product._id),
        reason: "same_company",
      });
      continue;
    }

    const localQty = localQtyByProduct.get(String(product._id)) || 0;
    const vendorQty = vendorQtyFromLocalStock(
      line.qty,
      localQty,
      alreadyDeducted,
    );
    if (vendorQty <= 0) {
      skipped.push({
        product_id: String(product._id),
        product_name: product.product_name,
        reason: "buyer_has_local_stock",
        ordered_qty: line.qty,
        local_qty: localQty,
      });
      continue;
    }

    const key = String(originCompanyId);
    if (!grouped.has(key)) {
      grouped.set(key, {
        originCompanyId,
        lines: [],
      });
    }
    grouped.get(key).lines.push({
      product,
      originProductId,
      originCompanyId,
      line,
      localQty,
      vendorQty,
    });
  }

  const created = [];
  for (const { originCompanyId, lines } of grouped.values()) {
    const connection = await findApprovedConnection(buyerId, originCompanyId);
    if (!connection) {
      for (const row of lines) {
        skipped.push({
          product_id: String(row.product._id),
          reason: "no_approved_connection",
        });
      }
      continue;
    }
    if (!isSyncOrderToVendorEnabled(connection)) {
      for (const row of lines) {
        skipped.push({
          product_id: String(row.product._id),
          reason: "sync_order_to_vendor_disabled",
        });
      }
      continue;
    }

    const originIds = lines.map((row) => row.originProductId);
    const originProducts = await Product.find({
      _id: { $in: originIds },
      company_id: originCompanyId,
      deletedAt: null,
    })
      .select("_id product_name")
      .lean();
    const originById = new Map(
      originProducts.map((row) => [String(row._id), row]),
    );

    const itemsPayload = [];
    for (const row of lines) {
      const origin = originById.get(String(row.originProductId));
      if (!origin) {
        skipped.push({
          product_id: String(row.product._id),
          reason: "origin_product_missing",
        });
        continue;
      }
      itemsPayload.push({
        origin_product_id: origin._id,
        origin_product_name: origin.product_name,
        buyer_product_id: row.product._id,
        buyer_product_name: row.product.product_name || row.line.name,
        qty: row.vendorQty,
        ordered_qty: row.line.qty,
        local_qty: row.localQty,
        price: row.line.price,
        source_order_item_id: row.line.source_order_item_id || undefined,
      });
    }
    if (!itemsPayload.length) continue;

    try {
      const doc = await VendorOrder.create({
        company_id: originCompanyId,
        buyer_company_id: buyerId,
        connection_id: connection._id,
        source_order_id: sourceOrder?._id || undefined,
        source_order_no: sourceOrder?.order_no || undefined,
        items: itemsPayload,
        status: "active",
        created_by: coalesceObjectId(userId) || undefined,
      });

      await Promise.all(
        itemsPayload.map((item) =>
          Product.updateOne(
            { _id: item.origin_product_id, company_id: originCompanyId },
            { $inc: { bigcommerce_hold_qty: item.qty } },
          ),
        ),
      );

      created.push(doc.toObject({ flattenMaps: true }));
    } catch (err) {
      if (err?.code === 11000 && sourceOrder?._id) {
        const existing = await VendorOrder.findOne({
          company_id: originCompanyId,
          source_order_id: sourceOrder._id,
          deletedAt: null,
        }).lean();
        if (existing) created.push(existing);
        continue;
      }
      throw err;
    }
  }

  return { created, skipped };
}

function shapeVendorOrder(row, myCompanyId) {
  const vendorId = row?.company_id?._id || row?.company_id;
  const buyerId = row?.buyer_company_id?._id || row?.buyer_company_id;
  const items = Array.isArray(row?.items) ? row.items : [];
  const connection =
    row?.connection_id && typeof row.connection_id === "object" ?
      {
        ...row.connection_id,
        sync_order_to_vendor: toYesNo(
          row.connection_id.sync_order_to_vendor,
          "yes",
        ),
      }
    : row?.connection_id;
  return {
    ...row,
    connection_id: connection,
    role:
      String(vendorId) === String(myCompanyId) ? "vendor" : "buyer",
    item_count: items.length,
    total_qty: roundQty(items.reduce((sum, item) => sum + (Number(item.qty) || 0), 0)),
  };
}

function flattenVendorOrderItems(rows, myCompanyId) {
  const out = [];
  for (const row of rows) {
    const shaped = shapeVendorOrder(row, myCompanyId);
    for (const item of row.items || []) {
      out.push({
        vendor_order_id: row._id,
        source_order_id: row.source_order_id,
        source_order_no: row.source_order_no,
        buyer_company_id: row.buyer_company_id,
        company_id: row.company_id,
        role: shaped.role,
        createdAt: row.createdAt,
        ...item,
      });
    }
  }
  return out;
}

/**
 * Sync recent me-too POS orders from connected buyers onto the origin company.
 */
async function backfillVendorOrdersForVendor(vendorCompanyId, userId = null) {
  const vendorId = coalesceObjectId(vendorCompanyId);
  if (!vendorId) return { created: 0 };

  const partnerIds = await listApprovedVendorSyncPartnerIds(vendorId);

  let created = 0;
  for (const otherId of partnerIds) {

    const orders = await Order.find({
      company_id: otherId,
      deletedAt: null,
      order_status: { $nin: ["cancelled", "failed", "draft", "drafted"] },
    })
      .sort({ createdAt: -1 })
      .limit(40)
      .select("_id")
      .lean();

    for (const order of orders) {
      try {
        const result = await syncBuyerOrderToVendor({
          buyerCompanyId: otherId,
          userId,
          orderId: order._id,
          alreadyDeducted: true,
        });
        created += Array.isArray(result?.created) ? result.created.length : 0;
      } catch (err) {
        console.warn(
          "[vendor-orders] backfill failed for order",
          String(order._id),
          err?.message || err,
        );
      }
    }
  }

  return { created };
}

module.exports = {
  isSyncOrderToVendorEnabled,
  listApprovedVendorSyncPartnerIds,
  vendorQtyFromLocalStock,
  syncBuyerOrderToVendor,
  backfillVendorOrdersForVendor,
  shapeVendorOrder,
  flattenVendorOrderItems,
};
