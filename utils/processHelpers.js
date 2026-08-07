const ProcessModel = require("../models/process");
const Category = require("../models/category");
const Brand = require("../models/brands");
const Product = require("../models/product");
const Order = require("../models/order");
const User = require("../models/user");
const { createApplicationLog } = require("./applicationLogs");
const SyncCategory = require("../models/sync_category");
const SyncBrand = require("../models/sync_brand");
const SyncProduct = require("../models/sync_product");
const { coalesceObjectId } = require("./modelHelper");
const { releaseProcessFromQueue } = require("./processQueue");
const {
  findIntegrationIfActive,
  logIntegrationInactiveSkip,
} = require("./integrationActiveGuard");

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
  sku,
  name,
}) {
  const integration_id = coalesceObjectId(integrationId);
  const company_id = coalesceObjectId(companyId);

  if (integration_id && remoteProductId != null && remoteProductId !== "") {
    const mapped = await findPosProductBySyncReference(
      integration_id,
      company_id,
      String(remoteProductId),
    );
    if (mapped) {
      return mapped;
    }
  }

  if (sku) {
    const bySku = await findExistingProductBySku(sku, company_id);
    if (bySku) {
      return bySku;
    }
  }

  if (name) {
    return findExistingProductByName(name, company_id);
  }

  return null;
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

function createFetchOrderStats() {
  return {
    inserted: 0,
    skipped: 0,
    lines_inserted: 0,
    lines_skipped: 0,
    skipped_orders: [],
  };
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
}) {
  const summary =
    isComplete ?
      `Order import completed: batch fetched ${fetched}, inserted ${inserted}, skipped ${skipped}, lines inserted ${lines_inserted}, lines skipped ${lines_skipped}.`
    : `Batch complete: fetched ${fetched}, inserted ${inserted}, skipped ${skipped}, lines inserted ${lines_inserted}, lines skipped ${lines_skipped}. Call execute-process again for page ${page + 1}.`;

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
  upsertSyncCategoryMapping,
  upsertSyncBrandMapping,
  upsertSyncProductMapping,
  findPosProductBySyncReference,
  orderExternalRef,
  resolveIntegrationOrderId,
  findExistingOrderByExternalRef,
  findExistingImportedOrder,
  resolvePosProductForRemoteLine,
  mapWooOrderStatus,
  mapShopifyOrderStatus,
  resolveOrderWebsiteStatus,
  fallbackRemoteOrderLinesSubtotal,
  createFetchOrderStats,
  recordOrderSkip,
  formatFetchOrderBatchRemarks,
  formatFetchLatestOrderRemarks,
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
  failFetchCategoryBatch,
  failFetchBrandBatch,
  failFetchProductBatch,
  failFetchOrderBatch,
  markProcessOutcome,
  formatProcessRemarks,
  extractProcessErrorMessage,
  recordProcessFailure,
  attachProcessFailureHooks,
  coalesceObjectId,
  findOrCreatePosCustomerFromBilling,
  mapRemoteOrderAddressFields,
  resolvePosCustomerEmail,
};
