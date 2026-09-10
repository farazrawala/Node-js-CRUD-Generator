const mongoose = require("mongoose");
const ProcessModel = require("../models/process");
const Category = require("../models/category");
const Brand = require("../models/brands");
const Product = require("../models/product");
const Order = require("../models/order");
const Company = require("../models/company");
const User = require("../models/user");
const WarehouseInventory = require("../models/warehouse_inventory");
const { createApplicationLog } = require("./applicationLogs");
const { applyOrderOutboundLines } = require("../controllers/order");
const {
  allowAddToCartWhenStockInsufficient,
} = require("./companyProductSettings");
const SyncCategory = require("../models/sync_category");
const SyncBrand = require("../models/sync_brand");
const SyncProduct = require("../models/sync_product");
const { coalesceObjectId } = require("./modelHelper");
const { recordOrderStatusUpdate } = require("./orderStatusHistory");
const { releaseProcessFromQueue } = require("./processQueue");
const {
  findIntegrationIfActive,
  logIntegrationInactiveSkip,
} = require("./integrationActiveGuard");

/**
 * Stock qty to push during sync_product.
 * Uses the greater of:
 *   - sum of active warehouse_inventory.quantity
 *   - product.origin_qty
 *
 * @param {Array<string|import("mongoose").Types.ObjectId>} productIds
 * @param {string|import("mongoose").Types.ObjectId|null} companyId
 * @returns {Promise<Map<string, {
 *   quantity: number,
 *   source: "origin_qty" | "warehouse_inventory.quantity",
 *   origin_qty: number,
 *   warehouse_qty: number,
 * }>>}
 */
async function resolveSyncStockTotals(productIds, companyId) {
  const ids = (Array.isArray(productIds) ? productIds : [])
    .map((id) => coalesceObjectId(id))
    .filter(Boolean);
  if (!ids.length) {
    return new Map();
  }

  const matchFilter = {
    product_id: { $in: ids },
    status: "active",
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  };
  const scopedCompanyId = coalesceObjectId(companyId);
  if (scopedCompanyId) {
    matchFilter.company_id = scopedCompanyId;
  }

  const warehouseByProduct = new Map();
  try {
    const grouped = await WarehouseInventory.aggregate([
      { $match: matchFilter },
      { $group: { _id: "$product_id", total: { $sum: "$quantity" } } },
    ]);
    for (const row of grouped) {
      warehouseByProduct.set(String(row._id), Number(row.total) || 0);
    }
  } catch (error) {
    console.warn(
      "Failed to aggregate warehouse inventory for product sync:",
      error?.message,
    );
  }

  const stockMap = new Map();
  try {
    const products = await Product.find({
      _id: { $in: ids },
      deletedAt: null,
    })
      .select("_id origin_qty")
      .lean();

    const seen = new Set();
    for (const row of products) {
      const id = String(row._id);
      seen.add(id);
      const warehouseQty = Number(warehouseByProduct.get(id)) || 0;
      const originQty = Number(row.origin_qty) || 0;
      const useOrigin = originQty >= warehouseQty && originQty > 0;
      stockMap.set(id, {
        quantity: useOrigin ? originQty : warehouseQty,
        source: useOrigin ? "origin_qty" : "warehouse_inventory.quantity",
        origin_qty: originQty,
        warehouse_qty: warehouseQty,
      });
    }

    for (const id of ids) {
      const key = String(id);
      if (seen.has(key)) continue;
      const warehouseQty = Number(warehouseByProduct.get(key)) || 0;
      stockMap.set(key, {
        quantity: warehouseQty,
        source: "warehouse_inventory.quantity",
        origin_qty: 0,
        warehouse_qty: warehouseQty,
      });
    }
  } catch (error) {
    console.warn(
      "Failed to apply origin_qty vs warehouse stock for product sync:",
      error?.message,
    );
    for (const id of ids) {
      const key = String(id);
      if (stockMap.has(key)) continue;
      const warehouseQty = Number(warehouseByProduct.get(key)) || 0;
      stockMap.set(key, {
        quantity: warehouseQty,
        source: "warehouse_inventory.quantity",
        origin_qty: 0,
        warehouse_qty: warehouseQty,
      });
    }
  }

  return stockMap;
}

function syncStockQuantity(stockMap, productId) {
  const row = stockMap?.get(String(productId));
  if (row == null) return 0;
  if (typeof row === "number") return Number(row) || 0;
  return Number(row.quantity) || 0;
}

const SYNC_QTY_FIELD_LABELS = {
  origin_qty: "Origin Quantity",
  "warehouse_inventory.quantity": "Warehouse Quantity",
};

function syncQtyFieldLabel(source) {
  return SYNC_QTY_FIELD_LABELS[source] || source || "none";
}

/**
 * Compact remark: `qty field: Origin Quantity (1487, 1992)`.
 */
function formatSyncStockFieldRemark(stockMap, productIds) {
  const ids = (Array.isArray(productIds) ? productIds : [productIds])
    .map((id) => String(id || ""))
    .filter(Boolean);
  const rows = ids
    .map((id) => stockMap?.get(id) || stockMap?.get(String(id)))
    .filter((row) => row && typeof row === "object");
  if (!rows.length) {
    return "qty field: none";
  }
  const sources = [...new Set(rows.map((row) => row.source))];
  if (sources.length === 1) {
    const qtys = rows.map((row) => row.quantity).join(", ");
    return `qty field: ${syncQtyFieldLabel(sources[0])} (${qtys})`;
  }
  return `qty field: ${rows
    .map((row) => `${syncQtyFieldLabel(row.source)}=${row.quantity}`)
    .join("; ")}`;
}

/** Same default as POS add-customer UI. */
const POS_DEFAULT_CUSTOMER_PASSWORD = "123456";

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function digitsOnlyPhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}

/**
 * POS customer email: use trimmed input if present; otherwise `{digits}@gmail.com` from phone.
 */
function resolvePosCustomerEmail(email, phone) {
  const trimmed = String(email || "").trim().toLowerCase();
  if (trimmed) return trimmed;
  const digits = digitsOnlyPhone(phone);
  if (digits) return `${digits}@gmail.com`;
  return `customer_${Date.now()}@gmail.com`;
}

/** User.phone is a digit string (max 13); never store as Number. */
function phoneToStoredValue(phone) {
  const digits = digitsOnlyPhone(phone).slice(0, 13);
  return digits || undefined;
}

/** Phone variants for match (exact, with/without country code, last 10 digits). */
function phoneMatchCandidates(phone) {
  const digits = digitsOnlyPhone(phone);
  if (!digits) return [];
  const variants = new Set([digits, digits.slice(0, 13)]);
  if (digits.startsWith("0") && digits.length > 1) {
    variants.add(digits.slice(1));
  }
  if (digits.startsWith("92") && digits.length > 2) {
    variants.add(digits.slice(2));
    variants.add(`0${digits.slice(2)}`);
  }
  if (digits.length === 10) {
    variants.add(`92${digits}`);
    variants.add(`0${digits}`);
  }
  if (digits.length === 11 && digits.startsWith("0")) {
    variants.add(`92${digits.slice(1)}`);
  }
  return [...variants].filter((v) => v && v.length >= 7).slice(0, 12);
}

/**
 * Map remote store shipping/billing into POS order address fields.
 * Prefers shipping address; falls back to billing.
 * Street stays in `address`; city/state/zip/country are separate columns.
 *
 * @param {object} remoteOrder
 * @param {"shopify"|"woocommerce"} store
 * @returns {{ address: string, city: string, state: string, zip: string, country: string }}
 */
function mapRemoteOrderAddressFields(remoteOrder, store) {
  const storeKey = String(store || "").toLowerCase();
  let street1 = "";
  let street2 = "";
  let city = "";
  let state = "";
  let zip = "";
  let country = "";

  if (storeKey === "shopify") {
    const shipping = remoteOrder?.shipping_address || {};
    const billing = remoteOrder?.billing_address || {};
    const src =
      shipping.address1 || shipping.city || shipping.zip ? shipping : billing;
    street1 = String(src.address1 || "").trim();
    street2 = String(src.address2 || "").trim();
    city = String(src.city || "").trim();
    state = String(src.province || src.province_code || "").trim();
    zip = String(src.zip || "").trim();
    country = String(src.country || src.country_code || "").trim();
  } else {
    // WooCommerce (and default)
    const shipping = remoteOrder?.shipping || {};
    const billing = remoteOrder?.billing || {};
    const src =
      shipping.address_1 || shipping.city || shipping.postcode ?
        shipping
      : billing;
    street1 = String(src.address_1 || "").trim();
    street2 = String(src.address_2 || "").trim();
    city = String(src.city || "").trim();
    state = String(src.state || "").trim();
    zip = String(src.postcode || "").trim();
    country = String(src.country || "").trim();
  }

  const address = [street1, street2].filter(Boolean).join(", ");
  return { address, city, state, zip, country };
}

/**
 * Find or create a POS customer for an imported online order.
 * 1) Match by phone (CUSTOMER) — preferred
 * 2) Match by email (CUSTOMER)
 * 3) Create new CUSTOMER
 * Returns user `_id` or null (order import continues without customer_id).
 */
async function findOrCreatePosCustomerFromBilling({
  name,
  email,
  phone,
  companyId,
  createdBy,
}) {
  const company_id = coalesceObjectId(companyId);
  if (!company_id) return null;

  const phoneDigits = phoneToStoredValue(phone);
  const phoneCandidates = phoneMatchCandidates(phone);
  let resolvedEmail = resolvePosCustomerEmail(email, phone);
  const displayName =
    String(name || "").trim() ||
    resolvedEmail.split("@")[0] ||
    "Online customer";
  const actor = coalesceObjectId(createdBy);

  // 1) Phone first
  if (phoneCandidates.length) {
    const last10 = digitsOnlyPhone(phone).slice(-10);
    const phoneOr = [{ phone: { $in: phoneCandidates } }];
    if (last10.length >= 7) {
      phoneOr.push({
        phone: { $regex: `${escapeRegex(last10)}$` },
      });
    }
    const byPhone = await User.findOne({
      company_id,
      deletedAt: null,
      role: "CUSTOMER",
      $or: phoneOr,
    })
      .select("_id")
      .lean();
    if (byPhone?._id) return byPhone._id;
  }

  // 2) Email
  let existing = await User.findOne({
    company_id,
    email: resolvedEmail,
    deletedAt: null,
    role: "CUSTOMER",
  })
    .select("_id")
    .lean();
  if (existing?._id) return existing._id;

  // Email taken by a non-CUSTOMER (e.g. staff) — use a customer-specific address.
  const emailTaken = await User.findOne({
    company_id,
    email: resolvedEmail,
    deletedAt: null,
  })
    .select("_id")
    .lean();
  if (emailTaken?._id) {
    const stamp = phoneDigits || String(Date.now());
    resolvedEmail = `customer_${stamp}@gmail.com`;
    existing = await User.findOne({
      company_id,
      email: resolvedEmail,
      deletedAt: null,
      role: "CUSTOMER",
    })
      .select("_id")
      .lean();
    if (existing?._id) return existing._id;
  }

  // 3) Create
  try {
    const payload = {
      name: displayName,
      email: resolvedEmail,
      password: POS_DEFAULT_CUSTOMER_PASSWORD,
      role: ["CUSTOMER"],
      company_id,
      status: "active",
    };
    if (phoneDigits) payload.phone = phoneDigits;
    if (actor) payload.created_by = actor;

    const created = await User.create(payload);
    return created._id;
  } catch (err) {
    if (err?.code === 11000) {
      // Race: prefer phone match, then email
      if (phoneCandidates.length) {
        const byPhone = await User.findOne({
          company_id,
          deletedAt: null,
          role: "CUSTOMER",
          phone: { $in: phoneCandidates },
        })
          .select("_id")
          .lean();
        if (byPhone?._id) return byPhone._id;
      }
      const again = await User.findOne({
        company_id,
        email: resolvedEmail,
        deletedAt: null,
        role: "CUSTOMER",
      })
        .select("_id")
        .lean();
      if (again?._id) return again._id;

      // Last resort: unique email + create again
      try {
        const retryEmail = `customer_${phoneDigits || Date.now()}_${Math.floor(Math.random() * 1e4)}@gmail.com`;
        const created = await User.create({
          name: displayName,
          email: retryEmail,
          password: POS_DEFAULT_CUSTOMER_PASSWORD,
          role: ["CUSTOMER"],
          company_id,
          status: "active",
          ...(phoneDigits ? { phone: phoneDigits } : {}),
          ...(actor ? { created_by: actor } : {}),
        });
        return created._id;
      } catch (retryErr) {
        console.error(
          "[fetch_order] Failed to create POS customer (retry):",
          retryErr?.message || retryErr,
        );
        return null;
      }
    }
    console.error(
      "[fetch_order] Failed to create POS customer:",
      err?.message || err,
      err?.errors ? JSON.stringify(err.errors) : "",
    );
    return null;
  }
}

function categorySlugFromName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function resolveCompanyId(process) {
  return coalesceObjectId(process?.company_id?._id || process?.company_id);
}

function resolveIntegrationId(process) {
  return coalesceObjectId(
    process?.integration_id?._id || process?.integration_id,
  );
}

/**
 * Map POS category ↔ store category (website id stored in refference_id).
 */
async function upsertSyncCategoryMapping({
  categoryId,
  integrationId,
  companyId,
  referenceId,
  createdBy,
}) {
  const category_id = coalesceObjectId(categoryId);
  const integration_id = coalesceObjectId(integrationId);
  const company_id = coalesceObjectId(companyId);
  const refference_id = String(referenceId ?? "").trim();

  if (!category_id || !integration_id || !company_id || !refference_id) {
    return null;
  }

  const actor = coalesceObjectId(createdBy);
  const filter = {
    category_id,
    integration_id,
    company_id,
    deletedAt: null,
  };

  const existing = await SyncCategory.findOne(filter).lean();
  if (existing) {
    if (String(existing.refference_id) === refference_id) {
      return existing;
    }
    return SyncCategory.findByIdAndUpdate(
      existing._id,
      {
        refference_id,
        status: "active",
        updated_by: actor,
      },
      { new: true },
    ).lean();
  }

  return SyncCategory.create({
    category_id,
    integration_id,
    company_id,
    refference_id,
    status: "active",
    created_by: actor,
  });
}

/** Map POS brand ↔ store brand (website id in refference_id). */
async function upsertSyncBrandMapping({
  brandId,
  integrationId,
  companyId,
  referenceId,
  createdBy,
}) {
  const brand_id = coalesceObjectId(brandId);
  const integration_id = coalesceObjectId(integrationId);
  const company_id = coalesceObjectId(companyId);
  const refference_id = String(referenceId ?? "").trim();

  if (!brand_id || !integration_id || !company_id || !refference_id) {
    return null;
  }

  const actor = coalesceObjectId(createdBy);
  const filter = {
    brand_id,
    integration_id,
    company_id,
    deletedAt: null,
  };

  const existing = await SyncBrand.findOne(filter).lean();
  if (existing) {
    if (String(existing.refference_id) === refference_id) {
      return existing;
    }
    return SyncBrand.findByIdAndUpdate(
      existing._id,
      {
        refference_id,
        status: "active",
        updated_by: actor,
      },
      { new: true },
    ).lean();
  }

  return SyncBrand.create({
    brand_id,
    integration_id,
    company_id,
    refference_id,
    status: "active",
    created_by: actor,
  });
}

/** Map POS product ↔ store product (website id in refference_id). */
function normalizeSyncProductType(value) {
  return String(value ?? "").trim().toLowerCase() === "variable" ?
      "Variable"
    : "Single";
}

async function upsertSyncProductMapping({
  productId,
  integrationId,
  companyId,
  referenceId,
  createdBy,
  productType,
  req = null,
}) {
  const product_id = coalesceObjectId(productId);
  const integration_id = coalesceObjectId(integrationId);
  const company_id = coalesceObjectId(companyId);
  const refference_id = String(referenceId ?? "").trim();

  if (!product_id || !integration_id || !company_id || !refference_id) {
    return null;
  }

  const activeIntegration = await findIntegrationIfActive(
    integration_id,
    company_id,
  );
  if (!activeIntegration) {
    await logIntegrationInactiveSkip(req, {
      action: "sync_product_mapping",
      integrationId: integration_id,
      companyId: company_id,
      productId: product_id,
      createdBy,
      message:
        "Skipped sync_product mapping create/update: integration is inactive",
      extra: {
        source: "upsertSyncProductMapping",
        refference_id,
      },
    });
    return null;
  }

  // Fall back to the POS product's own type when the caller doesn't supply one,
  // so the mapping row always reflects the current product_type.
  let resolvedType = productType;
  if (resolvedType == null) {
    const productDoc = await Product.findById(product_id)
      .select("product_type")
      .lean();
    resolvedType = productDoc?.product_type;
  }
  const product_type = normalizeSyncProductType(resolvedType);

  const actor = coalesceObjectId(createdBy);
  const filter = {
    product_id,
    integration_id,
    company_id,
    deletedAt: null,
  };

  const existing = await SyncProduct.findOne(filter).lean();
  if (existing) {
    if (
      String(existing.refference_id) === refference_id &&
      existing.product_type === product_type
    ) {
      return existing;
    }
    return SyncProduct.findByIdAndUpdate(
      existing._id,
      {
        refference_id,
        product_type,
        status: "active",
        updated_by: actor,
      },
      { new: true },
    ).lean();
  }

  return SyncProduct.create({
    product_id,
    integration_id,
    company_id,
    refference_id,
    product_type,
    status: "active",
    created_by: actor,
  });
}

/**
 * Soft-unlink a POS product from a store integration (does not delete the
 * remote Shopify/WooCommerce product). Cancels queued sync_product jobs so
 * they cannot recreate the mapping.
 */
async function unlinkSyncProductMapping({
  mappingId,
  productId,
  integrationId,
  companyId,
  updatedBy,
} = {}) {
  const mapping_id = coalesceObjectId(mappingId);
  const product_id = coalesceObjectId(productId);
  const integration_id = coalesceObjectId(integrationId);
  const company_id = coalesceObjectId(companyId);
  const actor = coalesceObjectId(updatedBy);

  if (!mapping_id && (!product_id || !integration_id)) {
    return {
      ok: false,
      status: 400,
      error: "product_id and integration_id are required (or pass mapping _id)",
    };
  }

  const filter = { deletedAt: null };
  if (mapping_id) filter._id = mapping_id;
  if (product_id) filter.product_id = product_id;
  if (integration_id) filter.integration_id = integration_id;
  if (company_id) filter.company_id = company_id;

  const existing = await SyncProduct.findOne(filter);
  if (!existing) {
    return {
      ok: false,
      status: 404,
      error: "Store mapping not found",
    };
  }

  const now = new Date();
  const update = {
    deletedAt: now,
    status: "inactive",
  };
  if (actor) update.updated_by = actor;

  const mapping = await SyncProduct.findByIdAndUpdate(existing._id, update, {
    new: true,
  }).lean();

  const pendingFilter = {
    product_id: existing.product_id,
    integration_id: existing.integration_id,
    action: "sync_product",
    progress: "not_started",
    deletedAt: null,
  };
  if (existing.company_id) {
    pendingFilter.company_id = existing.company_id;
  }

  const pending = await ProcessModel.find(pendingFilter)
    .select("_id company_id")
    .lean();
  let cancelled_processes = 0;
  if (pending.length) {
    await ProcessModel.updateMany(
      { _id: { $in: pending.map((row) => row._id) } },
      {
        $set: {
          status: "inactive",
          progress: "added_new",
          remarks: "Cancelled: product unlinked from store",
          ...(actor ? { updated_by: actor } : {}),
        },
      },
    );
    await Promise.all(
      pending.map((row) => releaseProcessFromQueue(row).catch(() => false)),
    );
    cancelled_processes = pending.length;
  }

  return { ok: true, mapping, cancelled_processes };
}

async function findPosProductBySyncReference(
  integrationId,
  companyId,
  referenceId,
) {
  const integration_id = coalesceObjectId(integrationId);
  const company_id = coalesceObjectId(companyId);
  const refference_id = String(referenceId ?? "").trim();

  if (!integration_id || !company_id || !refference_id) {
    return null;
  }

  const row = await SyncProduct.findOne({
    integration_id,
    company_id,
    refference_id,
    status: "active",
    deletedAt: null,
  }).lean();

  if (!row?.product_id) {
    return null;
  }

  return Product.findOne({
    _id: coalesceObjectId(row.product_id),
    deletedAt: null,
  }).lean();
}

function orderExternalRef(platform, remoteId) {
  const id = String(remoteId ?? "").trim();
  if (!id) {
    return "";
  }
  return `${platform}:order:${id}`;
}

function resolveIntegrationOrderId(store, remoteOrder, remoteId) {
  if (store === "woocommerce") {
    const orderNo = remoteOrder?.number;
    if (orderNo != null && String(orderNo).trim() !== "") {
      return String(orderNo).trim();
    }
  }
  if (store === "shopify") {
    const orderNo = remoteOrder?.order_number ?? remoteOrder?.name;
    if (orderNo != null && String(orderNo).trim() !== "") {
      return String(orderNo).trim();
    }
  }
  return remoteId != null ? String(remoteId).trim() : "";
}

async function findExistingOrderByExternalRef(
  companyId,
  externalRef,
  integrationId,
) {
  const company_id = coalesceObjectId(companyId);
  const integration_id = coalesceObjectId(integrationId);
  const description = String(externalRef ?? "").trim();
  if (!company_id || !description) {
    return null;
  }

  const filter = {
    company_id,
    description,
    deletedAt: null,
  };
  if (integration_id) {
    filter.integration_id = integration_id;
  }

  return Order.findOne(filter).lean();
}

async function findExistingImportedOrder(
  companyId,
  { externalRef, integrationId, integrationOrderId },
) {
  const byRef = await findExistingOrderByExternalRef(
    companyId,
    externalRef,
    integrationId,
  );
  if (byRef) {
    return byRef;
  }

  const company_id = coalesceObjectId(companyId);
  const integration_id = coalesceObjectId(integrationId);
  const integration_order_id = String(integrationOrderId ?? "").trim();
  if (!company_id || !integration_id || !integration_order_id) {
    return null;
  }

  return Order.findOne({
    company_id,
    integration_id,
    integration_order_id,
    deletedAt: null,
  }).lean();
}

async function resolvePosProductForRemoteLine({
  integrationId,
  companyId,
  remoteProductId,
  remoteVariantId,
  sku,
  name,
  store,
}) {
  const integration_id = coalesceObjectId(integrationId);
  const company_id = coalesceObjectId(companyId);
  const storeKey = String(store || "").trim().toLowerCase();
  const productId =
    remoteProductId != null && remoteProductId !== "" ?
      String(remoteProductId).trim()
    : "";
  const variantId =
    remoteVariantId != null && remoteVariantId !== "" ?
      String(remoteVariantId).trim()
    : "";

  if (integration_id && (productId || variantId)) {
    if (productId && variantId) {
      const byComposite = await findPosProductBySyncReference(
        integration_id,
        company_id,
        `${productId}:${variantId}`,
      );
      if (byComposite) {
        return byComposite;
      }
    }

    if (variantId && (storeKey === "shopify" || storeKey === "woocommerce")) {
      const byVariant = await findPosProductBySyncReference(
        integration_id,
        company_id,
        variantId,
      );
      if (byVariant) {
        return byVariant;
      }
    }

    if (productId) {
      const byProduct = await findPosProductBySyncReference(
        integration_id,
        company_id,
        productId,
      );
      if (byProduct) {
        return byProduct;
      }
    }
  }

  if (sku) {
    const trimmedSku = String(sku).trim();
    const bySku = await findExistingProductBySku(trimmedSku, company_id);
    if (bySku) {
      return bySku;
    }

    if (storeKey === "shopify") {
      const shopifySkuMatch = trimmedSku.match(/^shopify-(\d+)$/i);
      if (shopifySkuMatch && integration_id) {
        const extractedId = shopifySkuMatch[1];
        if (extractedId && extractedId !== productId) {
          const byExtractedRef = await findPosProductBySyncReference(
            integration_id,
            company_id,
            extractedId,
          );
          if (byExtractedRef) {
            return byExtractedRef;
          }
        }
        const byGeneratedSku = await findExistingProductBySku(
          trimmedSku,
          company_id,
        );
        if (byGeneratedSku) {
          return byGeneratedSku;
        }
      }
    }
  }

  if (name) {
    return findExistingProductByName(name, company_id);
  }

  return null;
}

function resolveRemoteLineVariantId(line, store) {
  const storeKey = String(store || "").trim().toLowerCase();
  if (storeKey === "woocommerce") {
    return line?.variation_id;
  }
  return line?.variant_id;
}

async function buildPosOrderLineItemsFromRemote(remoteOrder, store, ctx) {
  const { process, stats } = ctx;
  const companyId = ctx.companyId || resolveCompanyId(process);
  const integrationId = resolveIntegrationId(process);
  const storeKey = String(store || "").trim().toLowerCase();
  const lineItems =
    Array.isArray(remoteOrder?.line_items) ? remoteOrder.line_items : [];
  const orderItemsPayload = [];
  let linesSubtotal = 0;
  let linesSkipped = 0;
  let remoteBillableLines = 0;

  for (const line of lineItems) {
    const qty = Number(line?.quantity) || 0;
    const price = Number(line?.price) || 0;
    if (qty <= 0) {
      continue;
    }
    remoteBillableLines += 1;

    const product = await resolvePosProductForRemoteLine({
      integrationId,
      companyId,
      remoteProductId: line?.product_id,
      remoteVariantId: resolveRemoteLineVariantId(line, storeKey),
      sku: line?.sku,
      name: line?.name,
      store: storeKey,
    });

    if (!product?._id) {
      linesSkipped += 1;
      if (stats) {
        stats.lines_skipped += 1;
      }
      continue;
    }

    const subtotal = Math.round(price * qty * 100) / 100;
    linesSubtotal += subtotal;
    orderItemsPayload.push({
      product_id: product._id,
      name: String(
        line?.name || product.product_name || product.name || "Item",
      ).trim(),
      price,
      qty,
      subtotal,
      company_id: companyId,
      origin_company_id:
        coalesceObjectId(product.fetch_from_company_id) || companyId,
      created_by: coalesceObjectId(
        process?.created_by?._id || process?.created_by,
      ),
      status: "active",
    });
  }

  if (linesSubtotal === 0) {
    linesSubtotal = fallbackRemoteOrderLinesSubtotal(remoteOrder, storeKey);
  }

  return {
    orderItemsPayload,
    linesSubtotal,
    linesSkipped,
    remoteBillableLines,
  };
}

async function backfillPosOrderLinesIfEmpty(existing, remoteOrder, store, ctx) {
  const OrderItem = require("../models/order_item");
  const existingCount = await OrderItem.countDocuments({
    order_id: existing._id,
    status: "active",
    deletedAt: null,
  });
  if (existingCount > 0) {
    return null;
  }

  const built = await buildPosOrderLineItemsFromRemote(remoteOrder, store, ctx);
  const { orderItemsPayload, linesSkipped, remoteBillableLines } = built;
  if (!orderItemsPayload.length) {
    return {
      lines_inserted: 0,
      lines_skipped: linesSkipped,
      remote_billable_lines: remoteBillableLines,
      backfilled: false,
    };
  }

  const { process, stats, req } = ctx;
  const companyId = existing.company_id || ctx.companyId || resolveCompanyId(process);
  const createdBy = coalesceObjectId(
    process?.created_by?._id || process?.created_by || existing?.created_by,
  );
  for (const item of orderItemsPayload) {
    await OrderItem.create({
      ...item,
      order_id: existing._id,
      company_id: companyId,
      created_by: item.created_by || createdBy,
    });
    if (stats) {
      stats.lines_inserted += 1;
    }
  }

  const nextStatus = resolveFetchOrderImportStatus({
    linesSkipped,
    linesInserted: orderItemsPayload.length,
    remoteBillableLines,
    remoteOrder,
    store,
  });
  const patch = {
    lines_subtotal: built.linesSubtotal,
    order_status: nextStatus,
  };
  await Order.updateOne({ _id: existing._id }, { $set: patch });

  if (nextStatus !== String(existing.order_status || "").trim()) {
    await recordOrderStatusUpdate({
      orderId: existing._id,
      orderStatus: nextStatus,
      companyId,
      userId: process?.created_by?._id || process?.created_by,
    });
  }

  await Order.syncHeaderTotalsFromLineItems(existing._id);

  try {
    await applyFetchOrderOutboundInventory({
      req,
      process,
      companyId,
      order: { ...existing, ...patch, _id: existing._id },
      lines: orderItemsPayload.map((item) => ({
        product_id: item.product_id,
        qty: item.qty,
        price: item.price,
      })),
      store,
      stats,
    });
  } catch (err) {
    console.warn(
      "[fetch_order] backfill inventory skipped:",
      err?.message || err,
    );
  }

  return {
    lines_inserted: orderItemsPayload.length,
    lines_skipped: linesSkipped,
    remote_billable_lines: remoteBillableLines,
    backfilled: true,
    order_status: nextStatus,
  };
}

/** WooCommerce `status` → POS `order_status` (see ORDER_STATUS_VALUES in models/order.js). */
function mapWooOrderStatus(status) {
  const map = {
    pending: "pending_payment",
    processing: "processing",
    "on-hold": "on_hold",
    completed: "completed",
    cancelled: "cancelled",
    refunded: "refunded",
    failed: "failed",
    trash: "cancelled",
  };
  return map[String(status || "").toLowerCase()] || "placed";
}

/** POS order_status when importing from store: skipped/missing lines → products_skipped. */
function resolveFetchOrderImportStatus({
  linesSkipped = 0,
  linesInserted = 0,
  remoteBillableLines = 0,
  remoteOrder,
  store,
} = {}) {
  if (Number(linesSkipped) > 0) {
    return "products_skipped";
  }
  if (Number(linesInserted) === 0 && Number(remoteBillableLines) > 0) {
    return "products_skipped";
  }
  if (
    Number(linesInserted) === 0 &&
    remoteOrder &&
    fallbackRemoteOrderLinesSubtotal(remoteOrder, store) > 0
  ) {
    return "products_skipped";
  }
  return "placed";
}

/** When no POS line items were built, preserve store subtotal on the order header. */
function fallbackRemoteOrderLinesSubtotal(remoteOrder, store) {
  const round2 = (n) => Math.round(n * 100) / 100;
  const storeKey = String(store || "").toLowerCase();

  if (storeKey === "shopify") {
    const subtotal = Number(remoteOrder?.subtotal_price);
    if (Number.isFinite(subtotal) && subtotal >= 0) {
      return round2(subtotal);
    }
  } else {
    const subtotal = Number(remoteOrder?.subtotal);
    if (Number.isFinite(subtotal) && subtotal >= 0) {
      return round2(subtotal);
    }
  }

  const total = Number(remoteOrder?.total);
  if (!Number.isFinite(total) || total < 0) {
    return 0;
  }

  const shipping =
    storeKey === "shopify" ?
      Number(remoteOrder?.total_shipping_price_set?.shop_money?.amount) ||
      Number(remoteOrder?.total_shipping_price_set?.presentment_money?.amount) ||
      0
    : Number(remoteOrder?.shipping_total) || 0;
  const discount =
    storeKey === "shopify" ?
      Number(remoteOrder?.total_discounts) || 0
    : Number(remoteOrder?.discount_total) || 0;

  return round2(Math.max(0, total - shipping + discount));
}

function mapShopifyOrderStatus(financialStatus, fulfillmentStatus) {
  const fin = String(financialStatus || "").toLowerCase();
  const fulf = String(fulfillmentStatus || "").toLowerCase();

  if (fin === "refunded" || fin === "partially_refunded") {
    return "refunded";
  }
  if (fin === "voided") {
    return "cancelled";
  }
  if (fin === "paid" && (fulf === "fulfilled" || fulf === "partial")) {
    return "completed";
  }
  if (fin === "paid") {
    return "confirmed";
  }
  if (fin === "pending" || fin === "authorized") {
    return "pending";
  }
  if (fulf === "fulfilled") {
    return "delivered";
  }
  return "placed";
}

/**
 * Raw store status for `order.order_website_status`.
 * WooCommerce → `status`; Shopify → `financial_status` (fallback fulfillment_status).
 */
function resolveOrderWebsiteStatus(remoteOrder, store) {
  const Order = require("../models/order");
  const allowed = new Set(
    Order.ORDER_WEBSITE_STATUS_VALUES || [
      "pending",
      "confirmed",
      "shipped",
      "delivered",
      "cancelled",
      "refunded",
    ],
  );
  const storeKey = String(store || "").toLowerCase();
  let raw = "";
  if (storeKey === "shopify") {
    raw =
      remoteOrder?.financial_status ||
      remoteOrder?.fulfillment_status ||
      "";
  } else {
    raw = remoteOrder?.status || "";
  }
  const normalized = String(raw || "")
    .trim()
    .toLowerCase();
  if (normalized && allowed.has(normalized)) {
    return normalized;
  }
  return "pending";
}

/** Parse `description` like `shopify:order:123` → `{ store, remoteId }`. */
function parseOrderExternalRef(description) {
  const raw = String(description ?? "").trim();
  const match = raw.match(/^(shopify|woocommerce):order:(.+)$/i);
  if (!match) {
    return null;
  }
  return {
    store: match[1].toLowerCase(),
    remoteId: match[2].trim(),
  };
}

function resolveRemoteOrderIdFromPosOrder(order, store) {
  const parsed = parseOrderExternalRef(order?.description);
  if (parsed?.remoteId) {
    return parsed.remoteId;
  }
  const integrationOrderId = String(order?.integration_order_id ?? "").trim();
  if (integrationOrderId) {
    return integrationOrderId;
  }
  return "";
}

function buildPosOrderHeaderFromRemote(remoteOrder, store, ctx) {
  const { companyId, process, integrationId } = ctx;
  const storeKey = String(store || "").toLowerCase();
  const remoteId =
    storeKey === "shopify" ? remoteOrder?.id : remoteOrder?.id;
  const integrationOrderId = resolveIntegrationOrderId(
    storeKey,
    remoteOrder,
    remoteId,
  );

  let resolvedName = "";
  let customerEmail = "";
  let customerPhone = "";

  if (storeKey === "shopify") {
    const billing = remoteOrder?.billing_address || {};
    const shipping = remoteOrder?.shipping_address || {};
    const customer = remoteOrder?.customer || {};
    const customerName = [billing.first_name, billing.last_name]
      .filter(Boolean)
      .join(" ")
      .trim();
    const shippingName = [shipping.first_name, shipping.last_name]
      .filter(Boolean)
      .join(" ")
      .trim();
    resolvedName =
      customerName ||
      shippingName ||
      [customer.first_name, customer.last_name].filter(Boolean).join(" ").trim();
    customerEmail =
      remoteOrder?.email ||
      customer.email ||
      billing.email ||
      shipping.email ||
      "";
    customerPhone =
      billing.phone || shipping.phone || customer.phone || "";
  } else {
    const billing = remoteOrder?.billing || {};
    const shipping = remoteOrder?.shipping || {};
    const customerName = [billing.first_name, billing.last_name]
      .filter(Boolean)
      .join(" ")
      .trim();
    const shippingName = [shipping.first_name, shipping.last_name]
      .filter(Boolean)
      .join(" ")
      .trim();
    resolvedName = customerName || shippingName;
    customerEmail = billing.email || shipping.email || "";
    customerPhone = billing.phone || shipping.phone || "";
  }

  const addressFields = mapRemoteOrderAddressFields(remoteOrder, storeKey);
  const discount =
    storeKey === "shopify" ?
      Number(remoteOrder?.total_discounts) || 0
    : Number(remoteOrder?.discount_total) || 0;
  const shipment =
    storeKey === "shopify" ?
      Number(remoteOrder?.total_shipping_price_set?.shop_money?.amount) ||
      Number(remoteOrder?.total_shipping_price_set?.presentment_money?.amount) ||
      0
    : Number(remoteOrder?.shipping_total) || 0;
  const amountReceived =
    storeKey === "shopify" ?
      Number(remoteOrder?.total_price) || 0
    : Number(remoteOrder?.total) || 0;

  let linesSubtotal = 0;
  const lineItems =
    Array.isArray(remoteOrder?.line_items) ? remoteOrder.line_items : [];
  for (const line of lineItems) {
    const qty = Number(line?.quantity) || 0;
    const price = Number(line?.price) || 0;
    if (qty > 0) {
      linesSubtotal += Math.round(price * qty * 100) / 100;
    }
  }
  if (linesSubtotal === 0) {
    linesSubtotal = fallbackRemoteOrderLinesSubtotal(remoteOrder, storeKey);
  }

  const orderStatus =
    storeKey === "shopify" ?
      mapShopifyOrderStatus(
        remoteOrder?.financial_status,
        remoteOrder?.fulfillment_status,
      )
    : mapWooOrderStatus(remoteOrder?.status);

  return {
    name:
      resolvedName ||
      `${storeKey === "shopify" ? "Shopify" : "WooCommerce"} #${integrationOrderId || remoteId}`,
    email: customerEmail,
    phone: customerPhone,
    address: addressFields.address,
    city: addressFields.city,
    state: addressFields.state,
    zip: addressFields.zip,
    country: addressFields.country,
    integration_order_id: integrationOrderId,
    discount,
    shipment,
    lines_subtotal: linesSubtotal,
    amount_received: amountReceived,
    order_status: orderStatus,
    order_website_status: resolveOrderWebsiteStatus(remoteOrder, storeKey),
    integration_id: coalesceObjectId(integrationId),
    company_id: coalesceObjectId(companyId),
    customerResolve: {
      name: resolvedName,
      email: customerEmail,
      phone: customerPhone,
      companyId,
      createdBy: process?.created_by?._id || process?.created_by,
    },
  };
}

/**
 * Apply store order header fields onto an existing POS order (pull_order).
 * Does not replace line items or re-run inventory.
 */
async function updatePosOrderFromRemote(existing, remoteOrder, store, ctx) {
  const header = buildPosOrderHeaderFromRemote(remoteOrder, store, ctx);
  const patch = {
    name: header.name,
    email: header.email,
    phone: header.phone,
    address: header.address,
    city: header.city,
    state: header.state,
    zip: header.zip,
    country: header.country,
    integration_order_id: header.integration_order_id,
    discount: header.discount,
    shipment: header.shipment,
    lines_subtotal: header.lines_subtotal,
    amount_received: header.amount_received,
    order_website_status: header.order_website_status,
  };

  const previousStatus = String(existing?.order_status || "").trim();
  if (header.order_status && header.order_status !== previousStatus) {
    patch.order_status = header.order_status;
  }

  if (!existing?.customer_id && header.customerResolve) {
    const customerId = await findOrCreatePosCustomerFromBilling(
      header.customerResolve,
    );
    if (customerId) {
      patch.customer_id = customerId;
    }
  }

  await Order.updateOne({ _id: existing._id }, { $set: patch });

  if (patch.order_status && patch.order_status !== previousStatus) {
    await recordOrderStatusUpdate({
      orderId: existing._id,
      orderStatus: patch.order_status,
      companyId: header.company_id,
      userId: header.customerResolve?.createdBy,
    });
  }

  return { updated: true, orderId: existing._id };
}

/**
 * POS order_status → Shopify fulfillment sync action for push_order.
 * Shopify does not mirror OMS statuses on the order resource; use Fulfillment Orders API.
 */
function mapPosOrderStatusToShopifyFulfillmentAction(posStatus) {
  const s = String(posStatus || "").trim().toLowerCase();
  if (s === "cancelled" || s === "duplicate") {
    return "cancel";
  }
  if (s === "on_hold") {
    return "hold";
  }
  if (s === "delivered" || s === "completed") {
    return "deliver";
  }
  if (["packed", "in_transit", "shipped"].includes(s)) {
    return "ship_with_tracking";
  }
  if (
    ["processing", "confirmed", "placed", "active"].includes(s)
  ) {
    return "release_hold";
  }
  return "none";
}

/**
 * OMS courier tracking_status → Shopify fulfillment event status
 * (drives badges like Confirmed, In transit, Out for delivery, Delivered).
 */
function mapTrackingStatusToShopifyFulfillmentEvent(trackingStatus, orderStatus) {
  const raw = String(trackingStatus || "").trim();
  const s = raw.toLowerCase().replace(/[\s-]+/g, "_");

  const direct = {
    unbooked: "confirmed",
    booked: "confirmed",
    picked: "picked_up",
    in_transit: "in_transit",
    dispatched: "in_transit",
    out_for_delivery: "out_for_delivery",
    delivered: "delivered",
    completed: "delivered",
    returned: "failure",
    cancelled: "failure",
    failed: "failure",
    exception: "failure",
    arrived: "in_transit",
  };
  if (direct[s]) {
    return direct[s];
  }

  if (/unbooked|pending/.test(s)) return "confirmed";
  if (/booked|created|consignment/.test(s)) return "confirmed";
  if (/pick/.test(s)) return "picked_up";
  if (/out.*delivery/.test(s)) return "out_for_delivery";
  if (/deliver/.test(s)) return "delivered";
  if (/transit|dispatch|depart/.test(s)) return "in_transit";

  const order = String(orderStatus || "").trim().toLowerCase();
  if (["in_transit", "shipped"].includes(order)) return "in_transit";
  if (["delivered", "completed"].includes(order)) return "delivered";
  if (["packed"].includes(order) && raw) return "confirmed";

  return raw ? "confirmed" : null;
}

/** POS order_status → WooCommerce order status. */
function mapPosOrderStatusToWoo(posStatus) {
  const map = {
    pending: "pending",
    on_hold: "on-hold",
    processing: "processing",
    confirmed: "processing",
    placed: "processing",
    active: "processing",
    packed: "processing",
    in_transit: "processing",
    delivered: "completed",
    completed: "completed",
    cancelled: "cancelled",
    failed: "failed",
    refunded: "refunded",
    return: "refunded",
    return_received: "refunded",
    duplicate: "cancelled",
    draft: "pending",
  };
  return map[String(posStatus || "").trim().toLowerCase()] || "processing";
}

const POS_ORDER_TRACKING_META_KEYS = Object.freeze({
  courier_name: "pos_courier_name",
  tracking_number: "pos_tracking_number",
  tracking_status: "pos_tracking_status",
});

const { normalizeProviderKey } = require("../src/couriers/constants");

function formatCourierDisplayName(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return normalizeProviderKey(raw) || raw;
}

/** Public tracking page URL for known Pakistani couriers (Shopify tracking_info.url). */
function buildCourierTrackingUrl(courierName, trackingNumber) {
  const id = String(trackingNumber || "").trim();
  if (!id) return "";
  const key = String(courierName || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
  if (key === "tcs") {
    return `https://www.tcsexpress.com/track/?consignmentNo=${encodeURIComponent(id)}`;
  }
  if (key === "leopard" || key === "leopards" || key === "lcs") {
    return `https://www.leopardscourier.com/tracking/?cn=${encodeURIComponent(id)}`;
  }
  if (key === "blueex") {
    return `https://www.blue-ex.com/tracking?cn=${encodeURIComponent(id)}`;
  }
  if (key === "m&p" || key === "mnp" || key === "mp") {
    return `https://www.mulphilog.com/tracking/${encodeURIComponent(id)}`;
  }
  if (key === "callcourier") {
    return `https://callcourier.com.pk/tracking/?tc=${encodeURIComponent(id)}`;
  }
  if (key === "trax") {
    return `https://sonic.pk/tracking?tracking_number=${encodeURIComponent(id)}`;
  }
  if (key === "postex" || key === "post-ex" || key === "postex.pk") {
    return `https://postex.pk/tracking?cn=${encodeURIComponent(id)}`;
  }
  return "";
}

function pickShipmentCourierCompany(shipment) {
  const req = shipment?.api_request;
  if (!req || typeof req !== "object") return "";
  return String(req.courierCompany || req.courier_company || "").trim();
}

/**
 * Resolve courier / tracking fields from a POS order for store push.
 * Prefers the booked carrier (e.g. Leopard via Flagship) over integration name.
 */
async function resolvePosOrderTrackingForPush(posOrder) {
  const orderId = coalesceObjectId(posOrder?._id);
  let courierName = "";

  if (orderId) {
    try {
      const CourierShipment = require("../src/models/courier_shipment.model");
      const shipment = await CourierShipment.findOne({
        order_id: orderId,
        deletedAt: null,
        tracking_number: { $nin: [null, ""] },
        shipment_status: { $nin: ["Cancelled", "Failed"] },
      })
        .sort({ created_at: -1 })
        .select("api_request courier")
        .lean();

      const carrier = pickShipmentCourierCompany(shipment);
      if (carrier) {
        courierName = formatCourierDisplayName(carrier);
      } else if (shipment?.courier) {
        courierName = formatCourierDisplayName(shipment.courier);
      }
    } catch {
      /* courier shipment model optional in some deployments */
    }
  }

  const embeddedCourier = posOrder?.courier_id;
  if (!courierName && embeddedCourier && typeof embeddedCourier === "object") {
    courierName = formatCourierDisplayName(
      embeddedCourier.type || embeddedCourier.name,
    );
  }

  if (!courierName) {
    const courierId = coalesceObjectId(posOrder?.courier_id);
    if (courierId) {
      const Courier = require("../models/courier");
      const courier = await Courier.findOne({
        _id: courierId,
        deletedAt: null,
      })
        .select("name type")
        .lean();
      courierName = formatCourierDisplayName(courier?.type || courier?.name);
    }
  }

  const tracking_number = String(posOrder?.courier_tracking_number || "").trim();
  const tracking_status = String(posOrder?.tracking_status || "").trim();

  return {
    courier_name: courierName,
    tracking_number,
    tracking_status,
    tracking_url: buildCourierTrackingUrl(courierName, tracking_number),
  };
}

function buildPosOrderTrackingMetaEntries(tracking) {
  return [
    {
      key: POS_ORDER_TRACKING_META_KEYS.courier_name,
      value: tracking?.courier_name || "",
    },
    {
      key: POS_ORDER_TRACKING_META_KEYS.tracking_number,
      value: tracking?.tracking_number || "",
    },
    {
      key: POS_ORDER_TRACKING_META_KEYS.tracking_status,
      value: tracking?.tracking_status || "",
    },
  ];
}

/** Merge WooCommerce order meta_data by key (updates existing rows by id). */
function mergeWooOrderMetaData(existingMeta, updates) {
  const merged = new Map();
  for (const row of Array.isArray(existingMeta) ? existingMeta : []) {
    const key = String(row?.key || "").trim();
    if (!key) {
      continue;
    }
    merged.set(key, { ...row, key });
  }

  for (const update of updates || []) {
    const key = String(update?.key || "").trim();
    if (!key) {
      continue;
    }
    const previous = merged.get(key);
    const value = String(update?.value ?? "");
    if (previous?.id) {
      merged.set(key, { id: previous.id, key, value });
    } else {
      merged.set(key, { key, value });
    }
  }

  return [...merged.values()];
}

function buildShopifyTrackingNote(tracking) {
  const lines = ["[POS Tracking]"];
  if (tracking?.courier_name) {
    lines.push(`Courier: ${tracking.courier_name}`);
  }
  if (tracking?.tracking_number) {
    lines.push(`Tracking: ${tracking.tracking_number}`);
  }
  if (tracking?.tracking_status) {
    lines.push(`Status: ${tracking.tracking_status}`);
  }
  lines.push(`Updated: ${new Date().toISOString()}`);
  return lines.join("\n");
}

function createPullOrderStats() {
  return {
    ...createFetchOrderStats(),
    updated: 0,
  };
}

function formatPullOrderBatchRemarks({
  fetched,
  inserted,
  updated,
  skipped,
  lines_inserted,
  lines_skipped,
  skipped_orders = [],
  isComplete,
  page,
}) {
  const summary =
    isComplete ?
      `Order pull completed: batch fetched ${fetched}, updated ${updated}, inserted ${inserted}, skipped ${skipped}, lines inserted ${lines_inserted}, lines skipped ${lines_skipped}.`
    : `Pull batch: fetched ${fetched}, updated ${updated}, inserted ${inserted}, skipped ${skipped}, lines inserted ${lines_inserted}, lines skipped ${lines_skipped}. Call execute-process again for page ${page + 1}.`;

  if (!skipped_orders.length) {
    return summary;
  }

  const reasons = skipped_orders.map(humanizeOrderSkipReason).join(" | ");
  return `${summary} Skip reasons: ${reasons}`;
}

async function finishPullOrderBatch(req, res, process, batchResult) {
  const { limit, page, hits, count } = resolveBatchPagination(process);
  const {
    fetched,
    inserted,
    updated = 0,
    skipped,
    isComplete,
    nextOffset,
    remarks,
    lines_inserted = 0,
    lines_skipped = 0,
    skipped_orders = [],
  } = batchResult;

  const newHits = hits + 1;
  const newCount = count + inserted + updated + skipped;
  const update = {
    hits: newHits,
    count: newCount,
    page: isComplete ? page : page + 1,
    progress: isComplete ? "completed" : "started",
    status: isComplete ? "completed" : "active",
    remarks,
  };

  if (nextOffset !== undefined) {
    update.offset = nextOffset;
  }

  await ProcessModel.findByIdAndUpdate(process._id, update);
  if (isComplete) {
    await releaseProcessFromQueue(process);
  }

  return res.status(200).json({
    success: true,
    message: remarks,
    data: {
      process_id: process._id,
      page: update.page,
      hits: newHits,
      count: newCount,
      progress: update.progress,
      status: update.status,
      batch: {
        fetched,
        inserted,
        updated,
        skipped,
        limit,
        lines_inserted,
        lines_skipped,
        skipped_orders,
      },
    },
  });
}

function createFetchOrderStats() {
  return {
    inserted: 0,
    skipped: 0,
    lines_inserted: 0,
    lines_skipped: 0,
    inventory_applied: 0,
    inventory_stock_awaiting: 0,
    skipped_orders: [],
  };
}

async function resolveCompanyForFetchOrderInventory(companyId) {
  const cid = coalesceObjectId(companyId);
  if (!cid) {
    return null;
  }

  return Company.findOne({
    _id: cid,
    status: "active",
    deletedAt: null,
  })
    .select("warehouse_id product_settings")
    .lean();
}

function buildFetchOrderInventoryReq(req, company, process) {
  const base = req || {};
  const user = base.user && typeof base.user === "object" ? { ...base.user } : {};
  user.company_id = company;
  if (!user._id && process?.created_by) {
    user._id = coalesceObjectId(process.created_by?._id || process.created_by);
  }
  return { ...base, user };
}

function isFetchOrderInventoryInsufficientError(err) {
  const msg = String(err?.message || "");
  const payload = err?.clientPayload || err?.clientErrorPayload || {};
  const details = String(payload.details || payload.error || "");
  const combined = `${msg} ${details}`.toLowerCase();
  return (
    combined.includes("insufficient warehouse inventory") ||
    combined.includes("insufficient stock") ||
    combined.includes("no warehouse with sufficient stock") ||
    combined.includes("cannot oversell") ||
    combined.includes("no warehouse for oversell") ||
    combined.includes("no warehouse available to absorb")
  );
}

/**
 * Deduct warehouse stock + insert outbound inventory_movements for a fetched website order.
 * Mirrors `order_save` step 5 via `applyOrderOutboundLines`.
 */
async function applyFetchOrderOutboundInventory({
  req,
  process,
  companyId,
  order,
  lines,
  store,
  stats = null,
}) {
  if (!order?._id || !Array.isArray(lines) || lines.length === 0) {
    return { applied: false, reason: "no_lines" };
  }

  const company = await resolveCompanyForFetchOrderInventory(companyId);
  if (!company) {
    return { applied: false, reason: "no_company" };
  }

  const inventoryReq = buildFetchOrderInventoryReq(req, company, process);
  const companyIdOid = coalesceObjectId(companyId);
  const companyIdForMovementOid =
    (
      companyIdOid &&
      mongoose.Types.ObjectId.isValid(String(companyIdOid))
    ) ?
      new mongoose.Types.ObjectId(String(companyIdOid))
    : null;

  try {
    const stockUpdates = await applyOrderOutboundLines({
      lines,
      orderId: order._id,
      orderNo: order.order_no,
      companyId: companyIdOid,
      companyIdOid: companyIdForMovementOid,
      req: inventoryReq,
      mongoSession: null,
      logUrl: fetchOrderLogUrl(req),
      allowInsufficientStock: allowAddToCartWhenStockInsufficient(company),
    });

    if (stats) {
      stats.inventory_applied = (stats.inventory_applied || 0) + 1;
    }

    return { applied: true, stock_updates: stockUpdates };
  } catch (err) {
    if (!isFetchOrderInventoryInsufficientError(err)) {
      throw err;
    }

    await Order.updateOne(
      { _id: order._id },
      { $addToSet: { tags: "stock_awaiting" } },
    );

    if (stats) {
      stats.inventory_stock_awaiting =
        (stats.inventory_stock_awaiting || 0) + 1;
    }

    if (req) {
      void createApplicationLog(
        req,
        {
          action: `Fetch order inventory skipped :: ${order.order_no || order._id}`,
          url: fetchOrderLogUrl(req),
          tags: fetchOrderStoreTags(store, "inventory_skipped"),
          description: {
            process_id: process?._id ? String(process._id) : null,
            store: store ?? null,
            pos_order_id: String(order._id),
            pos_order_no: order.order_no ?? null,
            error: err?.message || String(err),
            message:
              `Order imported but stock not deducted (${order.order_no || order._id}): ${err?.message || err}`,
          },
          reference_id: order._id,
          reference_type: "order",
          company_id: companyId,
          created_by: process?.created_by?._id || process?.created_by,
        },
        { silent: true },
      );
    }

    return {
      applied: false,
      reason: "insufficient_stock",
      error: err?.message || String(err),
    };
  }
}

function recordOrderSkip(stats, entry, logCtx = {}) {
  const skipEntry = {
    store: entry.store,
    remote_id: entry.remote_id ?? null,
    order_number: entry.order_number ?? null,
    reason: entry.reason,
    detail: entry.detail ?? null,
    unmatched_lines: entry.unmatched_lines ?? null,
  };
  stats.skipped += 1;
  stats.skipped_orders.push(skipEntry);

  if (logCtx.req) {
    if (skipEntry.reason === "import_error") {
      void logFetchOrderFailed(logCtx.req, {
        process: logCtx.process,
        companyId: logCtx.companyId,
        store: skipEntry.store,
        remoteId: skipEntry.remote_id,
        orderNumber: skipEntry.order_number,
        errorMessage: skipEntry.detail,
      });
    } else {
      void logFetchOrderSkipped(logCtx.req, {
        process: logCtx.process,
        companyId: logCtx.companyId,
        skipEntry,
      });
    }
  }
}

function humanizeOrderSkipReason(entry) {
  const label =
    entry.order_number != null && entry.order_number !== "" ?
      `${entry.store} #${entry.order_number}`
    : `${entry.store} id ${entry.remote_id ?? "?"}`;

  switch (entry.reason) {
    case "already_imported":
      return `${label}: already imported${entry.detail ? ` (${entry.detail})` : ""}`;
    case "missing_remote_id":
      return `${label}: missing store order ID`;
    case "no_line_items":
      return `${label}: order has no line items`;
    case "no_matching_products": {
      const lineDetail =
        Array.isArray(entry.unmatched_lines) && entry.unmatched_lines.length > 0 ?
          ` — unmatched: ${entry.unmatched_lines
            .map(
              (line) =>
                `"${line.name || "item"}" (product_id=${line.product_id ?? "n/a"}, sku=${line.sku || "n/a"})`,
            )
            .join("; ")}`
        : "";
      return `${label}: no POS products matched${lineDetail}`;
    }
    case "import_error":
      return `${label}: import failed — ${entry.detail || "unknown error"}`;
    default:
      return `${label}: ${entry.reason}${entry.detail ? ` — ${entry.detail}` : ""}`;
  }
}

function formatFetchOrderBatchRemarks({
  fetched,
  inserted,
  skipped,
  lines_inserted,
  lines_skipped,
  skipped_orders = [],
  isComplete,
  page,
  inventory_applied = 0,
  inventory_stock_awaiting = 0,
}) {
  const inventoryNote =
    inventory_applied || inventory_stock_awaiting ?
      ` Inventory deducted ${inventory_applied}, stock awaiting ${inventory_stock_awaiting}.`
    : "";

  const summary =
    isComplete ?
      `Order import completed: batch fetched ${fetched}, inserted ${inserted}, skipped ${skipped}, lines inserted ${lines_inserted}, lines skipped ${lines_skipped}.${inventoryNote}`
    : `Batch complete: fetched ${fetched}, inserted ${inserted}, skipped ${skipped}, lines inserted ${lines_inserted}, lines skipped ${lines_skipped}.${inventoryNote} Call execute-process again for page ${page + 1}.`;

  if (!skipped_orders.length) {
    return summary;
  }

  const reasons = skipped_orders.map(humanizeOrderSkipReason).join(" | ");
  return `${summary} Skip reasons: ${reasons}`;
}

/** One-shot poll of newest store orders (only missing rows are inserted). */
function formatFetchLatestOrderRemarks({
  fetched,
  inserted,
  skipped,
  lines_inserted,
  lines_skipped,
  skipped_orders = [],
  limit,
}) {
  const summary = `Latest order poll: checked ${fetched} newest (limit ${limit}), inserted ${inserted}, already in POS ${skipped}, lines inserted ${lines_inserted}, lines skipped ${lines_skipped}.`;

  if (!skipped_orders.length) {
    return summary;
  }

  const errors = skipped_orders.filter((e) => e.reason === "import_error");
  if (!errors.length) {
    return summary;
  }

  const reasons = errors.map(humanizeOrderSkipReason).join(" | ");
  return `${summary} Errors: ${reasons}`;
}

function fetchOrderLogUrl(req) {
  return req?.originalUrl || req?.path || req?.url || "/api/process/execute-process";
}

function fetchOrderStoreTags(store, outcome) {
  const normalized = String(store || "").trim().toLowerCase();
  const tags = ["fetch_order"];
  if (normalized) {
    tags.push(normalized);
    if (outcome) {
      tags.push(`${outcome}_${normalized}`);
    }
  }
  return tags;
}

function formatFetchOrderRemoteLabel(store, remoteId, orderNumber) {
  const normalized = String(store || "").trim().toLowerCase();
  if (orderNumber != null && orderNumber !== "") {
    return `${normalized} #${orderNumber}`;
  }
  return `${normalized} id ${remoteId ?? "?"}`;
}

async function logFetchOrderImported(
  req,
  { process, companyId, store, remoteId, orderNumber, posOrderId, posOrderNo, lineCount },
) {
  const label = formatFetchOrderRemoteLabel(store, remoteId, orderNumber);
  await createApplicationLog(
    req,
    {
      action: `Fetch order imported :: ${label}`,
      url: fetchOrderLogUrl(req),
      tags: fetchOrderStoreTags(store, "imported"),
      description: {
        process_id: process?._id ? String(process._id) : null,
        store,
        remote_id: remoteId ?? null,
        order_number: orderNumber ?? null,
        integration_order_id: orderNumber ?? null,
        pos_order_id: posOrderId ? String(posOrderId) : null,
        pos_order_no: posOrderNo ?? null,
        lines_inserted: lineCount ?? 0,
        message: `Imported ${label} as POS ${posOrderNo || posOrderId}`,
      },
      reference_id: posOrderId,
      reference_type: "order",
      company_id: companyId,
      created_by: process?.created_by?._id || process?.created_by,
    },
    { silent: true },
  );
}

async function logFetchOrderSkipped(
  req,
  { process, companyId, skipEntry },
) {
  const label = formatFetchOrderRemoteLabel(
    skipEntry?.store,
    skipEntry?.remote_id,
    skipEntry?.order_number,
  );
  await createApplicationLog(
    req,
    {
      action: `Fetch order skipped :: ${label}`,
      url: fetchOrderLogUrl(req),
      tags: fetchOrderStoreTags(skipEntry?.store, "skipped"),
      description: {
        process_id: process?._id ? String(process._id) : null,
        store: skipEntry?.store ?? null,
        remote_id: skipEntry?.remote_id ?? null,
        order_number: skipEntry?.order_number ?? null,
        reason: skipEntry?.reason ?? null,
        detail: skipEntry?.detail ?? null,
        unmatched_lines: skipEntry?.unmatched_lines ?? null,
        message: humanizeOrderSkipReason(skipEntry),
      },
      reference_id: process?._id,
      reference_type: "process",
      company_id: companyId,
      created_by: process?.created_by?._id || process?.created_by,
    },
    { silent: true },
  );
}

async function logFetchOrderFailed(
  req,
  { process, companyId, store, remoteId, orderNumber, errorMessage },
) {
  const label = formatFetchOrderRemoteLabel(store, remoteId, orderNumber);
  await createApplicationLog(
    req,
    {
      action: `Fetch order failed :: ${label}`,
      url: fetchOrderLogUrl(req),
      tags: fetchOrderStoreTags(store, "failed"),
      description: {
        process_id: process?._id ? String(process._id) : null,
        store,
        remote_id: remoteId ?? null,
        order_number: orderNumber ?? null,
        error: errorMessage || "unknown error",
        message: `Import failed for ${label}: ${errorMessage || "unknown error"}`,
      },
      reference_id: process?._id,
      reference_type: "process",
      company_id: companyId,
      created_by: process?.created_by?._id || process?.created_by,
    },
    { silent: true },
  );
}

async function logFetchOrderBatchFailed(
  req,
  { process, companyId, store, errorMessage },
) {
  await createApplicationLog(
    req,
    {
      action: `Fetch order batch failed :: ${store || "store"}`,
      url: fetchOrderLogUrl(req),
      tags: fetchOrderStoreTags(store, "failed"),
      description: {
        process_id: process?._id ? String(process._id) : null,
        store: store ?? null,
        error: errorMessage || "unknown error",
        message: `Order fetch batch failed: ${errorMessage || "unknown error"}`,
      },
      reference_id: process?._id,
      reference_type: "process",
      company_id: companyId,
      created_by: process?.created_by?._id || process?.created_by,
    },
    { silent: true },
  );
}

async function findExistingBrandByName(name, companyId) {
  const trimmed = String(name || "").trim();
  if (!trimmed) {
    return null;
  }

  const filter = {
    deletedAt: null,
    name: { $regex: new RegExp(`^${escapeRegex(trimmed)}$`, "i") },
  };

  const companyCriteria = buildCompanyIdCriteria(companyId);
  if (companyCriteria) {
    filter.$and = [companyCriteria];
  }

  return Brand.findOne(filter).lean();
}

async function findExistingBrandBySlug(slug, companyId) {
  const trimmed = String(slug || "").trim();
  if (!trimmed) {
    return null;
  }

  const filter = {
    deletedAt: null,
    slug: { $regex: new RegExp(`^${escapeRegex(trimmed)}$`, "i") },
  };

  const companyCriteria = buildCompanyIdCriteria(companyId);
  if (companyCriteria) {
    filter.$and = [companyCriteria];
  }

  return Brand.findOne(filter).lean();
}

async function findExistingBrand(name, slug, companyId) {
  const byName = await findExistingBrandByName(name, companyId);
  if (byName) {
    return byName;
  }
  if (slug) {
    return findExistingBrandBySlug(slug, companyId);
  }
  return null;
}

async function findExistingProductBySku(sku, companyId) {
  const trimmed = String(sku || "").trim();
  if (!trimmed) {
    return null;
  }

  const filter = {
    deletedAt: null,
    $or: [
      { sku: { $regex: new RegExp(`^${escapeRegex(trimmed)}$`, "i") } },
      { product_code: { $regex: new RegExp(`^${escapeRegex(trimmed)}$`, "i") } },
    ],
  };

  const companyCriteria = buildCompanyIdCriteria(companyId);
  if (companyCriteria) {
    filter.$and = [companyCriteria];
  }

  return Product.findOne(filter).lean();
}

async function findExistingProductByName(name, companyId) {
  const trimmed = String(name || "").trim();
  if (!trimmed) {
    return null;
  }

  const filter = {
    deletedAt: null,
    product_name: { $regex: new RegExp(`^${escapeRegex(trimmed)}$`, "i") },
  };

  const companyCriteria = buildCompanyIdCriteria(companyId);
  if (companyCriteria) {
    filter.$and = [companyCriteria];
  }

  return Product.findOne(filter).lean();
}

async function findExistingProduct(sku, name, companyId) {
  if (sku) {
    const bySku = await findExistingProductBySku(sku, companyId);
    if (bySku) {
      return bySku;
    }
  }
  if (name) {
    return findExistingProductByName(name, companyId);
  }
  return null;
}

function resolveBatchPagination(process) {
  const limit = Math.max(1, Math.min(Number(process.limit) || 5, 100));
  const page = Math.max(1, Number(process.page) || 1);
  const hits = Number(process.hits) || 0;
  const count = Number(process.count) || 0;
  const progress = process.progress || "not_started";
  const offset = Number(process.offset) || 0;
  return { limit, page, hits, count, progress, offset };
}

const FETCH_LATEST_ORDER_DEFAULT_LIMIT = 20;

/** Batch size for `fetch_latest_order` (default 20, minimum 20, max 100). */
function resolveLatestOrderBatchLimit(process) {
  const raw = Number(process?.limit);
  const limit =
    raw > 0 ? raw : FETCH_LATEST_ORDER_DEFAULT_LIMIT;
  return Math.max(
    FETCH_LATEST_ORDER_DEFAULT_LIMIT,
    Math.min(limit, 100),
  );
}

function dispatchByStoreType(req, res, process, handlers) {
  const storeType = process.integration_id?.store_type;
  if (storeType === "woocommerce" && handlers.woocommerce) {
    return handlers.woocommerce(req, res, process);
  }
  if (storeType === "shopify" && handlers.shopify) {
    return handlers.shopify(req, res, process);
  }
  return res.status(400).json({
    success: false,
    message: `Unsupported or missing store type for this action: ${storeType || "unknown"}`,
  });
}

function buildCompanyIdCriteria(companyId) {
  if (!companyId) {
    return null;
  }
  const objectId = coalesceObjectId(companyId);
  const asString = String(objectId);
  return {
    $or: [{ company_id: objectId }, { company_id: asString }],
  };
}

async function findExistingCategoryByName(name, companyId) {
  const trimmed = String(name || "").trim();
  if (!trimmed) {
    return null;
  }

  const filter = {
    deletedAt: null,
    name: { $regex: new RegExp(`^${escapeRegex(trimmed)}$`, "i") },
  };

  const companyCriteria = buildCompanyIdCriteria(companyId);
  if (companyCriteria) {
    filter.$and = [companyCriteria];
  }

  return Category.findOne(filter).lean();
}

async function findExistingCategoryBySlug(slug, companyId) {
  const trimmed = String(slug || "").trim();
  if (!trimmed) {
    return null;
  }

  const filter = {
    deletedAt: null,
    slug: { $regex: new RegExp(`^${escapeRegex(trimmed)}$`, "i") },
  };

  const companyCriteria = buildCompanyIdCriteria(companyId);
  if (companyCriteria) {
    filter.$and = [companyCriteria];
  }

  return Category.findOne(filter).lean();
}

async function findExistingCategory(name, slug, companyId) {
  const byName = await findExistingCategoryByName(name, companyId);
  if (byName) {
    return byName;
  }
  if (slug) {
    return findExistingCategoryBySlug(slug, companyId);
  }
  return null;
}

/**
 * Resolve POS parent_id from WooCommerce category.parent (remote id).
 * Uses wooToLocalCategoryIds first, then name/slug lookup against POS.
 */
async function resolveWooCommerceParentId(
  remote,
  companyId,
  client,
  remoteById,
  wooToLocalCategoryIds,
) {
  const wooParentId = Number(remote?.parent) || 0;
  if (!wooParentId) {
    return null;
  }

  if (wooToLocalCategoryIds.has(wooParentId)) {
    return wooToLocalCategoryIds.get(wooParentId);
  }

  let parentRemote = remoteById.get(wooParentId);
  if (!parentRemote) {
    try {
      const parentResponse = await client.get(
        `products/categories/${wooParentId}`,
      );
      parentRemote = parentResponse?.data;
      if (parentRemote?.id != null) {
        remoteById.set(Number(parentRemote.id), parentRemote);
      }
    } catch (error) {
      console.warn(
        `WooCommerce parent category ${wooParentId} not found:`,
        error?.response?.data || error.message,
      );
      return null;
    }
  }

  const parentName = String(parentRemote?.name || "").trim();
  const parentSlug =
    String(parentRemote?.slug || "").trim() ||
    categorySlugFromName(parentName);

  const parentCategory = await findExistingCategory(
    parentName,
    parentSlug,
    companyId,
  );

  if (parentCategory?._id) {
    wooToLocalCategoryIds.set(wooParentId, parentCategory._id);
    return parentCategory._id;
  }

  return null;
}

/** Import parents before children when both are in the same API page. */
function sortWooCategoriesForImport(categories) {
  const byId = new Map(
    categories.map((cat) => [Number(cat.id), cat]),
  );

  const depth = (cat, seen = new Set()) => {
    const parentId = Number(cat?.parent) || 0;
    if (!parentId) {
      return 0;
    }
    const catId = Number(cat.id);
    if (seen.has(catId)) {
      return 0;
    }
    seen.add(catId);
    const parent = byId.get(parentId);
    return parent ? 1 + depth(parent, seen) : 1;
  };

  return [...categories].sort(
    (a, b) => depth(a) - depth(b) || Number(a.id) - Number(b.id),
  );
}

async function finishFetchCategoryBatch(req, res, process, batchResult) {
  const { limit, page, hits, count } = resolveBatchPagination(process);
  const {
    fetched,
    inserted,
    skipped,
    isComplete,
    nextOffset,
    remarks,
    parent_found = 0,
    parent_inserted = 0,
    parent_linked = 0,
    parent_unresolved = 0,
    parent_linked_categories = [],
    sync_category_mapped = 0,
  } = batchResult;

  const newHits = hits + 1;
  const newCount = count + inserted + skipped;
  const update = {
    hits: newHits,
    count: newCount,
    page: isComplete ? page : page + 1,
    progress: isComplete ? "completed" : "started",
    status: isComplete ? "completed" : "active",
    remarks,
  };

  if (nextOffset !== undefined) {
    update.offset = nextOffset;
  }

  await ProcessModel.findByIdAndUpdate(process._id, update);
  if (isComplete) {
    await releaseProcessFromQueue(process);
  }

  return res.status(200).json({
    success: true,
    message: remarks,
    data: {
      process_id: process._id,
      page: update.page,
      hits: newHits,
      count: newCount,
      progress: update.progress,
      status: update.status,
      batch: {
        fetched,
        inserted,
        skipped,
        limit,
        parent_found,
        parent_inserted,
        parent_linked,
        parent_unresolved,
        parent_linked_categories,
        sync_category_mapped,
      },
    },
  });
}

async function failFetchCategoryBatch(process, res, errorMessage, errorDetail) {
  const message = formatProcessRemarks(errorMessage, "Process batch failed.");
  const detail = formatProcessRemarks(errorDetail, message);
  await ProcessModel.findByIdAndUpdate(process._id, {
    progress: "failed",
    status: "failed",
    remarks: message,
  });
  await releaseProcessFromQueue(process);

  return res.status(500).json({
    success: false,
    message,
    error: detail,
  });
}

async function finishFetchBrandBatch(req, res, process, batchResult) {
  const { limit, page, hits, count } = resolveBatchPagination(process);
  const {
    fetched,
    inserted,
    skipped,
    isComplete,
    nextOffset,
    remarks,
    parent_found = 0,
    parent_inserted = 0,
    parent_linked = 0,
    parent_unresolved = 0,
    parent_linked_brands = [],
    sync_brand_mapped = 0,
  } = batchResult;

  const newHits = hits + 1;
  const newCount = count + inserted + skipped;
  const update = {
    hits: newHits,
    count: newCount,
    page: isComplete ? page : page + 1,
    progress: isComplete ? "completed" : "started",
    status: isComplete ? "completed" : "active",
    remarks,
  };

  if (nextOffset !== undefined) {
    update.offset = nextOffset;
  }

  await ProcessModel.findByIdAndUpdate(process._id, update);
  if (isComplete) {
    await releaseProcessFromQueue(process);
  }

  return res.status(200).json({
    success: true,
    message: remarks,
    data: {
      process_id: process._id,
      page: update.page,
      hits: newHits,
      count: newCount,
      progress: update.progress,
      status: update.status,
      batch: {
        fetched,
        inserted,
        skipped,
        limit,
        parent_found,
        parent_inserted,
        parent_linked,
        parent_unresolved,
        parent_linked_brands,
        sync_brand_mapped,
      },
    },
  });
}

const failFetchBrandBatch = failFetchCategoryBatch;

async function finishFetchProductBatch(req, res, process, batchResult) {
  const { limit, page, hits, count } = resolveBatchPagination(process);
  const {
    fetched,
    inserted,
    updated = 0,
    skipped,
    isComplete,
    nextOffset,
    remarks,
    categories_found = 0,
    categories_inserted = 0,
    products_category_linked = 0,
    variations_fetched = 0,
    variations_inserted = 0,
    variations_updated = 0,
  } = batchResult;

  const newHits = hits + 1;
  const newCount = count + inserted + updated + skipped;
  const update = {
    hits: newHits,
    count: newCount,
    page: isComplete ? page : page + 1,
    progress: isComplete ? "completed" : "started",
    status: isComplete ? "completed" : "active",
    remarks,
  };

  if (nextOffset !== undefined) {
    update.offset = nextOffset;
  }

  await ProcessModel.findByIdAndUpdate(process._id, update);
  if (isComplete) {
    await releaseProcessFromQueue(process);
  }

  return res.status(200).json({
    success: true,
    message: remarks,
    data: {
      process_id: process._id,
      page: update.page,
      hits: newHits,
      count: newCount,
      progress: update.progress,
      status: update.status,
      batch: {
        fetched,
        inserted,
        updated,
        skipped,
        limit,
        categories_found,
        categories_inserted,
        products_category_linked,
        variations_fetched,
        variations_inserted,
        variations_updated,
      },
    },
  });
}

const failFetchProductBatch = failFetchCategoryBatch;

async function finishFetchOrderBatch(req, res, process, batchResult) {
  const { limit, page, hits, count } = resolveBatchPagination(process);
  const {
    fetched,
    inserted,
    skipped,
    isComplete,
    nextOffset,
    remarks,
    lines_inserted = 0,
    lines_skipped = 0,
    skipped_orders = [],
  } = batchResult;

  const newHits = hits + 1;
  const newCount = count + inserted + skipped;
  const update = {
    hits: newHits,
    count: newCount,
    page: isComplete ? page : page + 1,
    progress: isComplete ? "completed" : "started",
    status: isComplete ? "completed" : "active",
    remarks,
  };

  if (nextOffset !== undefined) {
    update.offset = nextOffset;
  }

  await ProcessModel.findByIdAndUpdate(process._id, update);
  if (isComplete) {
    await releaseProcessFromQueue(process);
  }

  return res.status(200).json({
    success: true,
    message: remarks,
    data: {
      process_id: process._id,
      page: update.page,
      hits: newHits,
      count: newCount,
      progress: update.progress,
      status: update.status,
      batch: {
        fetched,
        inserted,
        skipped,
        limit,
        lines_inserted,
        lines_skipped,
        skipped_orders,
      },
    },
  });
}

const failFetchOrderBatch = failFetchCategoryBatch;
const failPullOrderBatch = failFetchOrderBatch;

/** Single poll — keep process active for recurring cron / queue runs. */
async function finishFetchLatestOrderBatch(req, res, process, batchResult) {
  const { limit, hits, count } = resolveBatchPagination(process);
  const {
    fetched,
    inserted,
    skipped,
    remarks,
    lines_inserted = 0,
    lines_skipped = 0,
    skipped_orders = [],
  } = batchResult;

  const newHits = hits + 1;
  const newCount = count + inserted;

  await ProcessModel.findByIdAndUpdate(process._id, {
    hits: newHits,
    count: newCount,
    page: 1,
    progress: "not_started",
    status: "active",
    remarks,
  });

  return res.status(200).json({
    success: true,
    message: remarks,
    data: {
      process_id: process._id,
      page: 1,
      hits: newHits,
      count: newCount,
      progress: "not_started",
      status: "active",
      batch: {
        fetched,
        inserted,
        skipped,
        limit,
        lines_inserted,
        lines_skipped,
        skipped_orders,
      },
    },
  });
}

function formatProcessRemarks(value, fallback = "") {
  if (value == null || value === "") return fallback;
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    if (value.errors != null) {
      return typeof value.errors === "string" ?
          value.errors
        : JSON.stringify(value.errors);
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

const PROCESS_REMARKS_MAX_LENGTH = 4000;

function truncateProcessRemarks(text) {
  const value = String(text || "").trim();
  if (value.length <= PROCESS_REMARKS_MAX_LENGTH) {
    return value;
  }
  return `${value.slice(0, PROCESS_REMARKS_MAX_LENGTH - 20)}…[truncated]`;
}

/**
 * Extract a human-readable error from axios errors, API JSON bodies, or Error objects.
 */
function extractProcessErrorMessage(source) {
  if (source == null) {
    return "Unknown process error";
  }
  if (typeof source === "string") {
    return source.trim() || "Unknown process error";
  }

  const responseData = source.response?.data;
  if (responseData != null) {
    if (typeof responseData === "string" && responseData.trim()) {
      return responseData.trim();
    }
    if (typeof responseData.message === "string" && responseData.message.trim()) {
      return responseData.message.trim();
    }
    if (typeof responseData.error === "string" && responseData.error.trim()) {
      return responseData.error.trim();
    }
    if (responseData.errors != null) {
      return formatProcessRemarks(responseData.errors);
    }
    try {
      return JSON.stringify(responseData);
    } catch {
      return String(responseData);
    }
  }

  if (typeof source.message === "string" && source.message.trim()) {
    const genericAxios = /^Request failed with status code \d+$/i.test(
      source.message,
    );
    if (!genericAxios || !source.response) {
      return source.message.trim();
    }
  }

  if (source.error != null) {
    return formatProcessRemarks(source.error);
  }

  if (source instanceof Error) {
    return source.message || "Unknown process error";
  }

  try {
    return JSON.stringify(source);
  } catch {
    return String(source);
  }
}

function buildProcessFailureRemarks(process, exactError) {
  const action = String(process?.action || "process").trim();
  const productName =
    process?.product_id?.product_name ||
    process?.product_id?.name ||
    process?.product_id?.sku ||
    "";
  const categoryName = process?.category_id?.name || "";
  const brandName = process?.brand_id?.name || "";

  let subject = "";
  if (productName) {
    subject = productName;
  } else if (categoryName) {
    subject = categoryName;
  } else if (brandName) {
    subject = brandName;
  }

  const prefix = subject ? `${action} (${subject}): ` : `${action}: `;
  return truncateProcessRemarks(`${prefix}${exactError}`);
}

function buildProcessFailureLogDescription(process, remarks) {
  const lines = [remarks];
  if (process?._id) {
    lines.push(`process_id: ${process._id}`);
  }
  if (process?.action) {
    lines.push(`action: ${process.action}`);
  }
  const integrationName =
    process?.integration_id?.name ||
    process?.integration_id?.store_type ||
    process?.integration_id;
  if (integrationName) {
    lines.push(`integration: ${integrationName}`);
  }
  return lines.join("\n");
}

/**
 * Mark process failed, store exact error in remarks, and write a logs row.
 */
async function recordProcessFailure(req, process, errorSource, options = {}) {
  if (!process?._id) {
    return null;
  }

  const exactError = extractProcessErrorMessage(errorSource);
  const remarks = buildProcessFailureRemarks(process, exactError);

  await markProcessOutcome(process._id, "failed", remarks);

  try {
    const { logControllerError } = require("./logControllerError");
    await logControllerError(req, buildProcessFailureLogDescription(process, remarks), {
      action: `PROCESS ${String(process.action || "job").toUpperCase()} FAILED`,
      tags: ["process", "error", String(process.action || "process")],
      fallbackUrl:
        options.fallbackUrl ||
        `/api/process/execute-process/${process._id}`,
      fallbackCompanyId: resolveCompanyId(process),
    });
  } catch (logErr) {
    console.warn("[process] failure log:", logErr?.message || logErr);
  }

  return { remarks, exactError };
}

/**
 * Intercept res.status/json so failed handler responses update remarks + logs.
 */
function attachProcessFailureHooks(req, res, process) {
  if (!process?._id || res._processFailureHooksAttached) {
    return;
  }
  res._processFailureHooksAttached = true;

  let pendingStatus = Number(res.statusCode) || 200;
  const originalStatus = res.status.bind(res);
  const originalJson = res.json.bind(res);

  res.status = function processStatus(code) {
    pendingStatus = Number(code) || 200;
    return originalStatus(code);
  };

  res.json = function processJson(payload) {
    const isFailure =
      pendingStatus >= 400 ||
      (payload && typeof payload === "object" && payload.success === false);

    if (isFailure) {
      recordProcessFailure(req, process, payload || { message: `HTTP ${pendingStatus}` }, {
        fallbackUrl: req.originalUrl || req.path || undefined,
      }).catch((err) => {
        console.warn("[process] record failure:", err?.message || err);
      });
    }

    return originalJson(payload);
  };
}

async function markProcessOutcome(processId, status, remarks) {
  const update = { status, remarks: formatProcessRemarks(remarks) };
  if (status === "completed") {
    update.progress = "completed";
  } else if (status === "failed") {
    update.progress = "failed";
  } else if (status === "active") {
    update.progress = "started";
  }

  const doc = await ProcessModel.findByIdAndUpdate(
    processId,
    update,
    { new: true },
  ).lean();
  if (
    doc &&
    (["completed", "failed", "inactive"].includes(status) ||
      ["completed", "failed"].includes(doc.progress))
  ) {
    await releaseProcessFromQueue(doc);
  }
}

module.exports = {
  categorySlugFromName,
  resolveCompanyId,
  resolveIntegrationId,
  resolveSyncStockTotals,
  syncStockQuantity,
  formatSyncStockFieldRemark,
  upsertSyncCategoryMapping,
  upsertSyncBrandMapping,
  upsertSyncProductMapping,
  unlinkSyncProductMapping,
  findPosProductBySyncReference,
  orderExternalRef,
  resolveIntegrationOrderId,
  findExistingOrderByExternalRef,
  findExistingImportedOrder,
  resolvePosProductForRemoteLine,
  buildPosOrderLineItemsFromRemote,
  backfillPosOrderLinesIfEmpty,
  resolveFetchOrderImportStatus,
  mapWooOrderStatus,
  mapShopifyOrderStatus,
  resolveOrderWebsiteStatus,
  parseOrderExternalRef,
  resolveRemoteOrderIdFromPosOrder,
  buildPosOrderHeaderFromRemote,
  updatePosOrderFromRemote,
  mapPosOrderStatusToWoo,
  mapPosOrderStatusToShopifyFulfillmentAction,
  mapTrackingStatusToShopifyFulfillmentEvent,
  resolvePosOrderTrackingForPush,
  buildPosOrderTrackingMetaEntries,
  mergeWooOrderMetaData,
  buildShopifyTrackingNote,
  buildCourierTrackingUrl,
  POS_ORDER_TRACKING_META_KEYS,
  fallbackRemoteOrderLinesSubtotal,
  createFetchOrderStats,
  createPullOrderStats,
  recordOrderSkip,
  formatFetchOrderBatchRemarks,
  formatFetchLatestOrderRemarks,
  formatPullOrderBatchRemarks,
  logFetchOrderImported,
  logFetchOrderSkipped,
  logFetchOrderFailed,
  logFetchOrderBatchFailed,
  resolveBatchPagination,
  resolveLatestOrderBatchLimit,
  FETCH_LATEST_ORDER_DEFAULT_LIMIT,
  dispatchByStoreType,
  findExistingCategoryByName,
  findExistingCategoryBySlug,
  findExistingCategory,
  findExistingBrandByName,
  findExistingBrandBySlug,
  findExistingBrand,
  findExistingProductBySku,
  findExistingProductByName,
  findExistingProduct,
  resolveWooCommerceParentId,
  sortWooCategoriesForImport,
  finishFetchCategoryBatch,
  finishFetchBrandBatch,
  finishFetchProductBatch,
  finishFetchOrderBatch,
  finishFetchLatestOrderBatch,
  finishPullOrderBatch,
  failFetchCategoryBatch,
  failFetchBrandBatch,
  failFetchProductBatch,
  failFetchOrderBatch,
  failPullOrderBatch,
  markProcessOutcome,
  formatProcessRemarks,
  extractProcessErrorMessage,
  recordProcessFailure,
  attachProcessFailureHooks,
  coalesceObjectId,
  findOrCreatePosCustomerFromBilling,
  mapRemoteOrderAddressFields,
  resolvePosCustomerEmail,
  applyFetchOrderOutboundInventory,
};
