/**
 * Public guest storefront API (`/api/shop/:companySlug/*`).
 * No auth required — company resolved from slug + marketplace visibility flag.
 */

const mongoose = require("mongoose");
const Company = require("../models/company");
const Product = require("../models/product");
const Category = require("../models/category");
const Brand = require("../models/brands");
const Account = require("../models/account");
const Order = require("../models/order");
const OrderItem = require("../models/order_item");
const User = require("../models/user");
const WarehouseInventory = require("../models/warehouse_inventory");
const {
  coalesceObjectId,
  parseSearchFieldsFromQuery,
} = require("../utils/modelHelper");
const {
  allowAddToCartWhenStockInsufficient,
} = require("../utils/companyProductSettings");
const {
  buildUserCompanyPopulate,
  normalizePopulatedCompanyForClient,
} = require("../utils/userCompanyPopulate");
const { order_save } = require("./order");

const DEFAULT_SEARCH_FIELDS = [
  "product_name",
  "product_code",
  "sku",
  "barcode",
];

const SHOP_PRODUCT_SELECT = [
  "_id",
  "product_name",
  "product_code",
  "sku",
  "barcode",
  "product_price",
  "show_on_bigcommerce",
  "bigcommerce_price",
  "bigcommerce_hold_qty",
  "product_description",
  "product_image",
  "product_image_thumbnail_url",
  "multi_images",
  "brand_id",
  "category_id",
  "status",
  "product_type",
  "company_id",
  "parent_product_id",
  "createdAt",
].join(" ");

function jsonError(res, status, message, extra = {}) {
  return res.status(status).json({
    success: false,
    status,
    error: message,
    message,
    ...extra,
  });
}

function jsonSuccess(res, status, data, message, meta = {}) {
  const body = { success: true, status, data, ...meta };
  if (message) body.message = message;
  return res.status(status).json(body);
}

function isValidObjectId(value) {
  const id = coalesceObjectId(value);
  return id != null && mongoose.Types.ObjectId.isValid(String(id));
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function roundStockQty(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function roundMoney2(n) {
  const x = typeof n === "number" ? n : Number(String(n ?? "").trim());
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

function parseMaybeJson(value, fallback = {}) {
  if (value == null || value === "") return fallback;
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function parseShippingSettings(company) {
  return parseMaybeJson(company?.shipping_settings, {});
}

function parseBigcommerceSettings(company) {
  return parseMaybeJson(company?.bigcommerce_settings, {});
}

/** Resolve store unit price: ecommerce price when set, else product_price, else fallback. */
function resolveShopUnitPrice(product, fallback = 0) {
  const bc = Number(product?.bigcommerce_price);
  if (Number.isFinite(bc) && bc > 0) return roundMoney2(bc);
  const price = Number(product?.product_price);
  if (Number.isFinite(price) && price > 0) return roundMoney2(price);
  const fb = Number(fallback);
  if (Number.isFinite(fb) && fb > 0) return roundMoney2(fb);
  return 0;
}

function companyIdQueryValues(companyIds) {
  const values = [];
  for (const id of companyIds) {
    if (!id) continue;
    values.push(id);
    const asString = String(id);
    if (!values.some((v) => String(v) === asString)) {
      values.push(asString);
    }
  }
  return values;
}

async function resolveMarketplaceCatalogCompanyIds(rootCompanyId) {
  const rootId = coalesceObjectId(rootCompanyId);
  if (!rootId) return [];

  const ids = [rootId];
  const branches = await Company.find({
    company_id: rootId,
    status: "active",
    deletedAt: null,
  })
    .select("_id")
    .lean();

  for (const branch of branches) {
    const branchId = coalesceObjectId(branch?._id);
    if (branchId) ids.push(branchId);
  }

  const self = await Company.findOne({
    _id: rootId,
    status: "active",
    deletedAt: null,
  })
    .select("company_id")
    .lean();
  const parentId = coalesceObjectId(self?.company_id);
  if (parentId && !ids.some((id) => String(id) === String(parentId))) {
    ids.push(parentId);
  }

  return ids;
}

/**
 * Public store gate: active + not deleted + listed on marketplace/storefront.
 */
async function loadPublicShopCompany(companySlug) {
  const raw = String(companySlug ?? "").trim();
  if (!raw) {
    return { ok: false, status: 400, message: "companySlug is required" };
  }

  const filter = {
    status: "active",
    deletedAt: null,
    display_store_on_bigcommerce: true,
  };

  if (isValidObjectId(raw)) {
    filter._id = coalesceObjectId(raw);
  } else {
    filter.company_slug = raw;
  }

  const company = await Company.findOne(filter).lean();
  if (!company) {
    return { ok: false, status: 404, message: "Store not found" };
  }

  const companyId = coalesceObjectId(company._id);
  const catalogCompanyIds =
    await resolveMarketplaceCatalogCompanyIds(companyId);

  return {
    ok: true,
    company,
    companyId,
    catalogCompanyIds,
    companyIdValues: companyIdQueryValues(catalogCompanyIds),
  };
}

function normalizeThemeColor(value) {
  const raw = String(value || "")
    .trim()
    .replace(/^#/, "");
  if (!/^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw)) return null;
  // Expand shorthand (#f80) so clients always receive a 6-digit hex.
  const hex = raw.length === 3 ? raw.replace(/./g, (char) => char + char) : raw;
  return `#${hex.toLowerCase()}`;
}

function toPublicStoreDto(company) {
  const shipping = parseShippingSettings(company);
  const bcSettings = parseBigcommerceSettings(company);
  const tagline =
    bcSettings.tagline ||
    bcSettings.store_tagline ||
    bcSettings.description ||
    company.company_description ||
    null;

  const storeStatusRaw = String(
    bcSettings.store_status ||
      bcSettings.open_status ||
      shipping.store_status ||
      "",
  )
    .trim()
    .toLowerCase();
  let store_status = null;
  if (storeStatusRaw === "open" || storeStatusRaw === "closed") {
    store_status = storeStatusRaw;
  }

  const deliveryCharge = roundMoney2(
    shipping.delivery_charge ??
      shipping.standard_delivery_fee ??
      shipping.shipping_fee ??
      shipping.shipping_charge ??
      0,
  );

  const methodsFromSettings =
    Array.isArray(shipping.methods) ? shipping.methods
    : Array.isArray(shipping.delivery_methods) ? shipping.delivery_methods
    : null;

  let delivery_methods =
    methodsFromSettings && methodsFromSettings.length ?
      methodsFromSettings.map((m, idx) => ({
        id: String(m.id || m.code || m.key || `method_${idx}`),
        label: String(m.label || m.name || "Delivery"),
        charge: roundMoney2(m.charge ?? m.fee ?? m.price ?? deliveryCharge),
      }))
    : [
        {
          id: "standard",
          label: "Standard Delivery",
          charge: deliveryCharge,
        },
      ];

  const pickupEnabled =
    shipping.enable_pickup === true ||
    shipping.allow_pickup === true ||
    shipping.store_pickup === true ||
    String(shipping.enable_pickup || "").toLowerCase() === "true";

  if (
    pickupEnabled &&
    !delivery_methods.some(
      (m) => /pickup/i.test(m.id) || /pickup/i.test(m.label),
    )
  ) {
    delivery_methods.push({
      id: "pickup",
      label: "Store Pickup",
      charge: 0,
    });
  }

  return {
    _id: company._id,
    company_name: company.company_name,
    company_slug: company.company_slug,
    company_logo: company.company_logo || null,
    company_banner: company.company_banner || null,
    company_phone: company.company_phone || null,
    company_email: company.company_email || null,
    company_address: company.company_address || null,
    whatsapp_number: company.whatsapp_number || null,
    theme_color: normalizeThemeColor(company.theme_color),
    tagline,
    store_status,
    delivery_methods,
    preferred_courier: company.preferred_courier || null,
  };
}

async function loadShopPaymentMethods(companyId) {
  // Public storefront: only cash/bank style methods (current_asset).
  // Do not expose Accounts Receivable to customers.
  const accounts = await Account.find({
    company_id: companyId,
    account_type: "current_asset",
    status: "active",
    deletedAt: null,
  })
    .select("_id name account_type account_number")
    .sort({ name: 1 })
    .lean();

  return (accounts || []).map((a) => ({
    id: a._id,
    name: a.name,
    account_type: a.account_type,
    code: /cash/i.test(String(a.name || "")) ? "cash" : "account",
  }));
}

async function mapProductIdsToAvailableQty(productIds, catalogCompanyIds) {
  const oids = [
    ...new Set(
      (productIds || [])
        .map((id) => coalesceObjectId(id))
        .filter(Boolean)
        .map((id) => String(id)),
    ),
  ].map((id) => coalesceObjectId(id));

  const map = new Map();
  for (const id of oids) map.set(String(id), 0);
  if (!oids.length) return map;

  const companyOids = (catalogCompanyIds || [])
    .map((id) => coalesceObjectId(id))
    .filter(Boolean);

  const match = {
    product_id: { $in: oids },
    status: "active",
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  };
  if (companyOids.length) {
    match.company_id =
      companyOids.length === 1 ? companyOids[0] : { $in: companyOids };
  }

  const rows = await WarehouseInventory.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$product_id",
        total_qty: { $sum: { $ifNull: ["$quantity", 0] } },
      },
    },
  ]);

  for (const row of rows) {
    map.set(String(row._id), roundStockQty(row.total_qty));
  }

  const products = await Product.find({ _id: { $in: oids } })
    .select("_id bigcommerce_hold_qty")
    .lean();

  for (const product of products) {
    const key = String(product._id);
    const onHand = Number(map.get(key)) || 0;
    const holdQty = Number(product.bigcommerce_hold_qty) || 0;
    map.set(key, roundStockQty(Math.max(0, onHand - holdQty)));
  }

  return map;
}

function enrichProductRow(row, availableQty, allowOversell, priceFallback = 0) {
  const qty = Number(availableQty) || 0;
  const unit_price = resolveShopUnitPrice(row, priceFallback);
  const ownList = Number(row.product_price);
  const list_price = roundMoney2(
    Number.isFinite(ownList) && ownList > 0 ? ownList
    : Number(priceFallback) > 0 ? Number(priceFallback)
    : 0,
  );
  const is_available = allowOversell || qty > 0;
  let discount_percent = null;
  if (list_price > 0 && unit_price < list_price) {
    discount_percent = Math.round(
      ((list_price - unit_price) / list_price) * 100,
    );
  }

  return {
    _id: row._id,
    product_name: row.product_name,
    product_code: row.product_code,
    sku: row.sku,
    barcode: row.barcode,
    product_description: row.product_description,
    product_image: row.product_image,
    product_image_thumbnail_url: row.product_image_thumbnail_url,
    multi_images: row.multi_images,
    brand_id: row.brand_id,
    category_id: row.category_id,
    status: row.status,
    product_type: row.product_type,
    parent_product_id: row.parent_product_id || null,
    createdAt: row.createdAt,
    unit_price,
    list_price: list_price > unit_price ? list_price : null,
    discount_percent,
    available_qty: qty,
    in_stock: qty > 0,
    is_available,
    stock_status: qty > 0 ? "in_stock" : "out_of_stock",
  };
}

/** Prefer variant media; fall back to parent when the variant has none. */
function applyParentMediaFallback(variantDto, parentRow) {
  if (!variantDto || !parentRow) return variantDto;
  const parentImage = parentRow.product_image || null;
  const parentThumb =
    parentRow.product_image_thumbnail_url || parentRow.product_image || null;
  const hasImage = Boolean(variantDto.product_image);
  const hasThumb = Boolean(variantDto.product_image_thumbnail_url);
  if (hasImage && hasThumb) return variantDto;
  return {
    ...variantDto,
    product_image: hasImage ? variantDto.product_image : parentImage,
    product_image_thumbnail_url:
      hasThumb ?
        variantDto.product_image_thumbnail_url
      : parentThumb || parentImage,
  };
}

const DEFAULT_STOCK_THRESHOLD = 10;

function parseStockFilterQuery(query = {}) {
  const thresholdRaw =
    query.stock_threshold ?? query.stockThreshold ?? query.threshold;
  let threshold = DEFAULT_STOCK_THRESHOLD;
  if (thresholdRaw != null && String(thresholdRaw).trim() !== "") {
    const n = Number(String(thresholdRaw).trim());
    if (Number.isFinite(n) && n >= 0) threshold = n;
  }

  const statusRaw = String(
    query.stock_status ?? query.stockStatus ?? query.stock_filter ?? "",
  )
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  if (["in_stock", "instock", "in", "available"].includes(statusRaw)) {
    return { mode: "in_stock", threshold, min: threshold, exclusiveMin: true };
  }
  if (["low_stock", "lowstock", "low"].includes(statusRaw)) {
    return {
      mode: "low_stock",
      threshold,
      min: 0,
      exclusiveMin: true,
      max: threshold,
      exclusiveMax: true,
    };
  }
  if (["out_of_stock", "outofstock", "out", "oos"].includes(statusRaw)) {
    return { mode: "out_of_stock", threshold, max: 0 };
  }
  return null;
}

async function aggregateProductStockTotals(companyIds) {
  const companyOids = (companyIds || [])
    .map((id) => coalesceObjectId(id))
    .filter(Boolean);
  if (!companyOids.length) return [];

  return WarehouseInventory.aggregate([
    {
      $match: {
        company_id: { $in: companyOids },
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
}

async function resolveStockFilterConstraint(companyIds, stockFilter) {
  if (!stockFilter) return null;

  const totals = await aggregateProductStockTotals(companyIds);
  const inventoryIds = [];
  const matched = [];

  for (const row of totals) {
    if (!row?._id) continue;
    inventoryIds.push(row._id);
    const qty = Number(row.total_qty) || 0;

    if (stockFilter.mode === "in_stock") {
      if (qty > stockFilter.threshold) matched.push(row._id);
    } else if (stockFilter.mode === "low_stock") {
      if (qty > 0 && qty < stockFilter.threshold) matched.push(row._id);
    } else if (stockFilter.mode === "out_of_stock") {
      if (qty <= 0) matched.push(row._id);
    }
  }

  if (stockFilter.mode === "out_of_stock") {
    if (!inventoryIds.length) {
      return { ids: null, match: null, empty: false };
    }
    return {
      ids: null,
      match: {
        $or: [
          ...(matched.length ? [{ _id: { $in: matched } }] : []),
          { _id: { $nin: inventoryIds } },
        ],
      },
      empty: false,
    };
  }

  return { ids: matched, match: null, empty: matched.length === 0 };
}

function resolveProductSort(sortRaw) {
  const key = String(sortRaw || "default")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  switch (key) {
    case "newest":
    case "default":
      return { createdAt: -1 };
    case "price_asc":
    case "price_low":
    case "price_low_to_high":
      return { product_price: 1, createdAt: -1 };
    case "price_desc":
    case "price_high":
    case "price_high_to_low":
      return { product_price: -1, createdAt: -1 };
    case "name_asc":
    case "name_a_z":
      return { product_name: 1 };
    case "name_desc":
    case "name_z_a":
      return { product_name: -1 };
    default:
      return { createdAt: -1 };
  }
}

function parseCartLines(body = {}) {
  const items = body.items || body.lines || body.cart || [];
  if (Array.isArray(items) && items.length) {
    return items
      .map((row) => ({
        product_id: coalesceObjectId(row.product_id || row.id || row._id),
        qty: Number(row.qty ?? row.quantity ?? 1) || 1,
      }))
      .filter((row) => row.product_id);
  }

  const lines = [];
  if (body && typeof body === "object") {
    for (const key of Object.keys(body)) {
      const m = key.match(/^product_id\[(\d+)\]$/);
      if (!m) continue;
      const i = m[1];
      const product_id = coalesceObjectId(body[key]);
      if (!product_id) continue;
      const qty = Number(body[`qty[${i}]`] ?? body[`quantity[${i}]`] ?? 1) || 1;
      lines.push({ product_id, qty });
    }
  }
  return lines;
}

async function resolveShopActorUser(company) {
  const companyId = coalesceObjectId(company._id);
  const populate = [buildUserCompanyPopulate()];

  const tryUser = async (id) => {
    const oid = coalesceObjectId(id);
    if (!oid) return null;
    const user = await User.findOne({
      _id: oid,
      status: "active",
      deletedAt: null,
    })
      .populate(populate)
      .lean();
    return user || null;
  };

  let user = await tryUser(company.created_by);
  if (!user) {
    user = await User.findOne({
      company_id: companyId,
      status: "active",
      deletedAt: null,
      role: { $in: ["USER", "ADMIN"] },
    })
      .sort({ createdAt: 1 })
      .populate(populate)
      .lean();
  }

  if (!user) return null;

  // Ensure company on actor is the store company with GL defaults.
  if (!user.company_id || typeof user.company_id !== "object") {
    user.company_id = company;
  } else if (String(user.company_id._id) !== String(companyId)) {
    user.company_id = company;
  }
  normalizePopulatedCompanyForClient(user.company_id);
  return user;
}

function resolveDeliveryCharge(company, deliveryMethodId) {
  const dto = toPublicStoreDto(company);
  const methodId = String(deliveryMethodId || "").trim();
  if (!methodId) {
    return dto.delivery_methods[0]?.charge ?? 0;
  }
  const match = dto.delivery_methods.find(
    (m) =>
      String(m.id) === methodId ||
      String(m.label).toLowerCase() === methodId.toLowerCase(),
  );
  if (match) return roundMoney2(match.charge);
  if (/pickup/i.test(methodId)) return 0;
  return dto.delivery_methods[0]?.charge ?? 0;
}

function toPublicOrderDto(order, items = []) {
  return {
    _id: order._id,
    order_no: order.order_no,
    order_status: order.order_status,
    order_type: order.order_type,
    name: order.name,
    phone: order.phone,
    email: order.email,
    address: order.address,
    city: order.city,
    state: order.state,
    zip: order.zip,
    country: order.country,
    description: order.description,
    lines_subtotal: order.lines_subtotal,
    discount: order.discount,
    shipment: order.shipment,
    total_amount: order.total_amount,
    amount_received: order.amount_received,
    payment_method_accounts_id: order.payment_method_accounts_id,
    createdAt: order.createdAt,
    items: (items || []).map((item) => ({
      _id: item._id,
      product_id: item.product_id,
      name: item.name,
      qty: item.qty,
      price: item.price,
      subtotal: item.subtotal,
    })),
  };
}

/** GET /api/shop/:companySlug */
async function getShopStore(req, res) {
  try {
    const loaded = await loadPublicShopCompany(req.params.companySlug);
    if (!loaded.ok) return jsonError(res, loaded.status, loaded.message);

    const payment_methods = await loadShopPaymentMethods(loaded.companyId);
    const data = {
      ...toPublicStoreDto(loaded.company),
      payment_methods,
    };
    return jsonSuccess(res, 200, data);
  } catch (error) {
    console.error("[shop] getShopStore:", error);
    return jsonError(res, 500, error.message || "Failed to load store");
  }
}

/** GET /api/shop/:companySlug/categories */
async function getShopCategories(req, res) {
  try {
    const loaded = await loadPublicShopCompany(req.params.companySlug);
    if (!loaded.ok) return jsonError(res, loaded.status, loaded.message);

    const filter = {
      company_id:
        loaded.companyIdValues.length === 1 ?
          loaded.companyIdValues[0]
        : { $in: loaded.companyIdValues },
      status: "active",
      deletedAt: null,
    };

    const data = await Category.find(filter)
      .select(
        "_id name slug description image icon color sort_order parent_id company_id isActive status",
      )
      .sort({ sort_order: 1, name: 1 })
      .lean();

    return jsonSuccess(res, 200, data, null, { total: data.length });
  } catch (error) {
    console.error("[shop] getShopCategories:", error);
    return jsonError(res, 500, error.message || "Failed to load categories");
  }
}

/** GET /api/shop/:companySlug/brands */
async function getShopBrands(req, res) {
  try {
    const loaded = await loadPublicShopCompany(req.params.companySlug);
    if (!loaded.ok) return jsonError(res, loaded.status, loaded.message);

    const filter = {
      company_id:
        loaded.companyIdValues.length === 1 ?
          loaded.companyIdValues[0]
        : { $in: loaded.companyIdValues },
      status: "active",
      deletedAt: null,
    };

    const data = await Brand.find(filter)
      .select("_id name slug description image parent_id company_id status")
      .sort({ name: 1 })
      .lean();

    return jsonSuccess(res, 200, data, null, { total: data.length });
  } catch (error) {
    console.error("[shop] getShopBrands:", error);
    return jsonError(res, 500, error.message || "Failed to load brands");
  }
}

/** GET /api/shop/:companySlug/products */
async function getShopProducts(req, res) {
  try {
    const loaded = await loadPublicShopCompany(req.params.companySlug);
    if (!loaded.ok) return jsonError(res, loaded.status, loaded.message);

    const companyOids = loaded.catalogCompanyIds
      .map((id) => coalesceObjectId(id))
      .filter(Boolean);

    const filter = {
      company_id:
        loaded.companyIdValues.length === 1 ?
          loaded.companyIdValues[0]
        : { $in: loaded.companyIdValues },
      status: "active",
      deletedAt: null,
      // List one card per product family: standalone products + parent rows.
      // Hide child variants (parent_product_id pointing at another product).
      $and: [
        {
          $or: [
            // null, missing, or legacy "" all mean "not a child".
            { parent_product_id: { $not: { $type: "objectId" } } },
            // Legacy parents point at themselves.
            { $expr: { $eq: ["$parent_product_id", "$_id"] } },
          ],
        },
      ],
    };

    const rawCategory =
      req.query.category ?? req.query.category_id ?? req.query.categoryId;
    if (rawCategory != null && String(rawCategory).trim() !== "") {
      const categoryOid = coalesceObjectId(rawCategory);
      if (!categoryOid || !isValidObjectId(categoryOid)) {
        return jsonError(res, 400, "category must be a valid ObjectId");
      }
      filter.category_id = categoryOid;
    }

    const brandId = coalesceObjectId(
      req.query.brand ?? req.query.brand_id ?? req.query.brandId,
    );
    if (brandId) filter.brand_id = brandId;

    const search = req.query.search ? String(req.query.search).trim() : "";
    if (search) {
      const fields =
        parseSearchFieldsFromQuery(req.query.searchFields) ||
        DEFAULT_SEARCH_FIELDS;
      const regex = { $regex: escapeRegex(search), $options: "i" };
      filter.$and = [
        ...(filter.$and || []),
        { $or: fields.map((field) => ({ [field]: regex })) },
      ];
    }

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const skip =
      req.query.skip != null ?
        Math.max(parseInt(req.query.skip, 10) || 0, 0)
      : (page - 1) * limit;

    const stockFilter = parseStockFilterQuery(req.query || {});
    if (stockFilter) {
      const stockConstraint = await resolveStockFilterConstraint(
        companyOids,
        stockFilter,
      );
      if (stockConstraint?.empty) {
        return jsonSuccess(res, 200, [], null, {
          total: 0,
          page,
          limit,
          skip,
        });
      }
      if (stockConstraint?.match) {
        filter.$and = [...(filter.$and || []), stockConstraint.match];
      } else if (Array.isArray(stockConstraint?.ids)) {
        filter._id = { $in: stockConstraint.ids };
      }
    }

    const priceMin = Number(req.query.price_min ?? req.query.min_price);
    const priceMax = Number(req.query.price_max ?? req.query.max_price);
    if (Number.isFinite(priceMin) || Number.isFinite(priceMax)) {
      filter.product_price = {};
      if (Number.isFinite(priceMin)) filter.product_price.$gte = priceMin;
      if (Number.isFinite(priceMax)) filter.product_price.$lte = priceMax;
    }

    const sort = resolveProductSort(req.query.sort ?? req.query.sortBy);
    const allowOversell = allowAddToCartWhenStockInsufficient(loaded.company);

    const warehouseInventoryMatch = {
      status: "active",
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
      company_id:
        companyOids.length === 1 ? companyOids[0] : { $in: companyOids },
    };

    const [rows, total] = await Promise.all([
      Product.find(filter)
        .select(SHOP_PRODUCT_SELECT)
        .populate("brand_id", "name")
        .populate("category_id", "name")
        .populate({
          path: "warehouse_inventory",
          match: warehouseInventoryMatch,
          select: "warehouse_id quantity status company_id",
        })
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean({ virtuals: true }),
      Product.countDocuments(filter),
    ]);

    const parentIds = rows.map((row) => row._id);
    const variants =
      parentIds.length ?
        await Product.find({
          parent_product_id: { $in: parentIds },
          _id: { $nin: parentIds },
          company_id:
            loaded.companyIdValues.length === 1 ?
              loaded.companyIdValues[0]
            : { $in: loaded.companyIdValues },
          status: "active",
          deletedAt: null,
        })
          .select(SHOP_PRODUCT_SELECT)
          .populate("brand_id", "name")
          .populate("category_id", "name")
          .sort({ product_name: 1 })
          .lean({ virtuals: true })
      : [];

    const allProductIds = [
      ...parentIds,
      ...variants.map((variant) => variant._id),
    ];
    const qtyMap = await mapProductIdsToAvailableQty(
      allProductIds,
      loaded.catalogCompanyIds,
    );
    const parentPriceById = new Map(
      rows.map((row) => [String(row._id), resolveShopUnitPrice(row)]),
    );
    const parentRowById = new Map(rows.map((row) => [String(row._id), row]));
    const variantsByParent = new Map();
    for (const variant of variants) {
      const key = String(variant.parent_product_id);
      const parentRow = parentRowById.get(key);
      const parentPrice = parentPriceById.get(key) || 0;
      const enriched = applyParentMediaFallback(
        enrichProductRow(
          variant,
          qtyMap.get(String(variant._id)),
          allowOversell,
          parentPrice,
        ),
        parentRow,
      );
      variantsByParent.set(key, [
        ...(variantsByParent.get(key) || []),
        enriched,
      ]);
    }

    const data = rows.map((row) => {
      const enriched = enrichProductRow(
        row,
        qtyMap.get(String(row._id)),
        allowOversell,
      );
      const productVariants = variantsByParent.get(String(row._id)) || [];
      if (!productVariants.length) return { ...enriched, variants: [] };

      const availableVariants = productVariants.filter(
        (variant) => variant.is_available,
      );
      const pricedVariants = productVariants.filter(
        (variant) => Number(variant.unit_price) > 0,
      );
      const displayVariant =
        availableVariants.find((variant) => Number(variant.unit_price) > 0) ||
        pricedVariants[0] ||
        availableVariants[0] ||
        productVariants[0];

      const unit_price =
        Number(displayVariant?.unit_price) > 0 ?
          displayVariant.unit_price
        : enriched.unit_price;

      return {
        ...enriched,
        unit_price,
        list_price:
          Number(displayVariant?.list_price) > 0 ?
            displayVariant.list_price
          : enriched.list_price,
        discount_percent:
          displayVariant?.discount_percent ?? enriched.discount_percent,
        available_qty: productVariants.reduce(
          (sum, variant) => sum + (Number(variant.available_qty) || 0),
          0,
        ),
        is_available: availableVariants.length > 0,
        in_stock: availableVariants.length > 0,
        stock_status:
          availableVariants.length > 0 ? "in_stock" : "out_of_stock",
        variants: productVariants,
      };
    });

    return jsonSuccess(res, 200, data, null, {
      total,
      page,
      limit,
      skip,
    });
  } catch (error) {
    console.error("[shop] getShopProducts:", error);
    return jsonError(res, 500, error.message || "Failed to load products");
  }
}

/**
 * POST /api/shop/:companySlug/cart/validate
 * Availability-only check (plan #17): product is available.
 * Does not validate existence messaging, company ownership, active flag,
 * price changes, or requested quantity sufficiency.
 */
async function validateShopCart(req, res) {
  try {
    const loaded = await loadPublicShopCompany(req.params.companySlug);
    if (!loaded.ok) return jsonError(res, loaded.status, loaded.message);

    const lines = parseCartLines(req.body);
    if (!lines.length) {
      return jsonError(res, 400, "Cart items are required");
    }

    const allowOversell = allowAddToCartWhenStockInsufficient(loaded.company);
    const productIds = lines.map((l) => l.product_id);
    const qtyMap = await mapProductIdsToAvailableQty(
      productIds,
      loaded.catalogCompanyIds,
    );

    const results = lines.map((line) => {
      const available_qty = Number(qtyMap.get(String(line.product_id))) || 0;
      const is_available = allowOversell || available_qty > 0;
      return {
        product_id: line.product_id,
        qty: line.qty,
        available_qty,
        is_available,
      };
    });

    const unavailable = results.filter((r) => !r.is_available);
    const ok = unavailable.length === 0;

    return jsonSuccess(
      res,
      200,
      {
        ok,
        lines: results,
        unavailable,
      },
      ok ?
        "Cart products are available"
      : "Some products in your cart are no longer available. Please review your cart.",
    );
  } catch (error) {
    console.error("[shop] validateShopCart:", error);
    return jsonError(res, 500, error.message || "Failed to validate cart");
  }
}

/** POST /api/shop/:companySlug/orders */
async function createShopOrder(req, res) {
  try {
    const loaded = await loadPublicShopCompany(req.params.companySlug);
    if (!loaded.ok) return jsonError(res, loaded.status, loaded.message);

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const customer =
      body.customer && typeof body.customer === "object" ? body.customer : body;

    const name = String(
      customer.customer_name || customer.name || customer.full_name || "",
    ).trim();
    const phone = String(customer.phone || customer.mobile || "").trim();
    const address = String(
      customer.address || customer.delivery_address || "",
    ).trim();
    const area = String(
      customer.area || customer.locality || customer.state || "",
    ).trim();
    const city = String(customer.city || "").trim();

    if (!name) return jsonError(res, 400, "Full name is required");
    if (!phone) return jsonError(res, 400, "Mobile number is required");
    if (!address) return jsonError(res, 400, "Address is required");
    if (!area) return jsonError(res, 400, "Area / locality is required");
    if (!city) return jsonError(res, 400, "City is required");

    const lines = parseCartLines(body);
    if (!lines.length) {
      return jsonError(res, 400, "Order items are required");
    }

    const idempotencyKey = String(
      body.client_order_id || body.idempotency_key || body.idempotencyKey || "",
    ).trim();
    if (idempotencyKey) {
      const existing = await Order.findOne({
        company_id: {
          $in:
            loaded.companyIdValues.length ?
              loaded.companyIdValues
            : [loaded.companyId],
        },
        integration_order_id: `shop:${idempotencyKey}`,
        deletedAt: null,
      }).lean();
      if (existing) {
        const items = await OrderItem.find({
          order_id: existing._id,
          status: "active",
          deletedAt: null,
        })
          .sort({ createdAt: 1 })
          .lean();
        return jsonSuccess(
          res,
          200,
          toPublicOrderDto(existing, items),
          "Order already created",
        );
      }
    }

    const productIds = lines.map((l) => l.product_id);
    const products = await Product.find({
      _id: { $in: productIds },
      company_id:
        loaded.companyIdValues.length === 1 ?
          loaded.companyIdValues[0]
        : { $in: loaded.companyIdValues },
      status: "active",
      deletedAt: null,
    })
      .select(SHOP_PRODUCT_SELECT)
      .lean();

    const productById = new Map(products.map((p) => [String(p._id), p]));
    const missing = lines.filter((l) => !productById.has(String(l.product_id)));
    if (missing.length) {
      return jsonError(
        res,
        400,
        "Some products in your cart are no longer available in the requested quantity. Please review your cart.",
        { unavailable_product_ids: missing.map((m) => m.product_id) },
      );
    }

    const parentIds = [
      ...new Set(
        products
          .map((product) => coalesceObjectId(product.parent_product_id))
          .filter(
            (parentId) =>
              parentId &&
              !productById.has(String(parentId)) &&
              !products.some((p) => String(p._id) === String(parentId)),
          )
          .map((id) => String(id)),
      ),
    ].map((id) => coalesceObjectId(id));

    const parentRows =
      parentIds.length ?
        await Product.find({
          _id: { $in: parentIds },
          company_id:
            loaded.companyIdValues.length === 1 ?
              loaded.companyIdValues[0]
            : { $in: loaded.companyIdValues },
          status: "active",
          deletedAt: null,
        })
          .select("_id product_price bigcommerce_price parent_product_id")
          .lean()
      : [];
    const parentById = new Map(parentRows.map((p) => [String(p._id), p]));
    for (const product of products) {
      parentById.set(String(product._id), product);
    }

    const allowOversell = allowAddToCartWhenStockInsufficient(loaded.company);
    const qtyMap = await mapProductIdsToAvailableQty(
      productIds,
      loaded.catalogCompanyIds,
    );

    const stockIssues = [];
    for (const line of lines) {
      const available = Number(qtyMap.get(String(line.product_id))) || 0;
      const qty = Number(line.qty) || 0;
      if (qty <= 0) {
        stockIssues.push(line.product_id);
        continue;
      }
      if (!allowOversell && available < qty) {
        stockIssues.push(line.product_id);
      }
    }
    if (stockIssues.length) {
      return jsonError(
        res,
        409,
        "Some products in your cart are no longer available in the requested quantity. Please review your cart.",
        { unavailable_product_ids: stockIssues },
      );
    }

    const shipment = resolveDeliveryCharge(
      loaded.company,
      body.delivery_method || body.deliveryMethod || body.shipping_method,
    );

    const discount = roundMoney2(0);
    const orderBody = {
      name,
      phone,
      email: String(customer.email || "").trim() || undefined,
      address,
      state: area,
      city,
      zip:
        String(customer.postal_code || customer.zip || "").trim() || undefined,
      country: String(customer.country || "").trim() || undefined,
      description:
        String(
          customer.delivery_instructions ||
            customer.additional_instructions ||
            customer.description ||
            "",
        ).trim() || undefined,
      discount,
      discount_percentage: 0,
      shipment,
      amount_received: roundMoney2(body.amount_received ?? 0),
      change_given: 0,
      order_type: "shop",
      order_status: "placed",
    };

    if (idempotencyKey) {
      orderBody.integration_order_id = `shop:${idempotencyKey}`;
    }

    const payMethod =
      coalesceObjectId(
        body.payment_method_id ||
          body.payment_method_accounts_id ||
          body.posPayMethod ||
          body.payment_method,
      ) || null;
    if (payMethod) {
      orderBody.payment_method_accounts_id = payMethod;
      orderBody.posPayMethod = payMethod;
    }

    lines.forEach((line, index) => {
      const product = productById.get(String(line.product_id));
      const parentId = coalesceObjectId(product?.parent_product_id);
      const parent =
        parentId && String(parentId) !== String(product?._id) ?
          parentById.get(String(parentId))
        : null;
      const parentPrice = parent ? resolveShopUnitPrice(parent) : 0;
      const price = resolveShopUnitPrice(product, parentPrice);
      orderBody[`product_id[${index}]`] = String(line.product_id);
      orderBody[`qty[${index}]`] = String(line.qty);
      orderBody[`price[${index}]`] = String(price);
    });

    // Never trust client company_id / totals
    delete orderBody.company_id;
    delete orderBody.total;
    delete orderBody.total_amount;
    delete orderBody.subtotal;
    delete orderBody.lines_subtotal;

    const actor = await resolveShopActorUser(loaded.company);
    if (!actor) {
      return jsonError(
        res,
        500,
        "Store is not configured to accept orders yet",
      );
    }

    // Ensure populated company is the public store (with default accounts).
    const storeCompany =
      actor.company_id && typeof actor.company_id === "object" ?
        {
          ...loaded.company,
          ...Object.fromEntries(
            Object.entries(actor.company_id).filter(([k]) =>
              String(k).startsWith("default_"),
            ),
          ),
          warehouse_id:
            actor.company_id.warehouse_id || loaded.company.warehouse_id,
          _id: loaded.companyId,
        }
      : loaded.company;
    normalizePopulatedCompanyForClient(storeCompany);

    req.user = {
      ...actor,
      _id: actor._id,
      company_id: storeCompany,
    };
    req.body = orderBody;

    // Reuse POS transactional create (GL + order_item + stock outbound).
    return order_save(req, res);
  } catch (error) {
    console.error("[shop] createShopOrder:", error);
    return jsonError(res, 500, error.message || "Failed to place order");
  }
}

/** GET /api/shop/:companySlug/orders/:orderId */
async function getShopOrder(req, res) {
  try {
    const loaded = await loadPublicShopCompany(req.params.companySlug);
    if (!loaded.ok) return jsonError(res, loaded.status, loaded.message);

    const param = String(req.params.orderId || "").trim();
    if (!param) return jsonError(res, 400, "orderId is required");

    const companyFilter = {
      company_id:
        loaded.companyIdValues.length === 1 ?
          loaded.companyIdValues[0]
        : { $in: loaded.companyIdValues },
      status: "active",
      deletedAt: null,
      order_type: { $in: ["shop", "website", "online"] },
    };

    let order = await Order.findOne({
      ...companyFilter,
      order_no: param,
    }).lean();
    if (!order && isValidObjectId(param)) {
      order = await Order.findOne({
        ...companyFilter,
        _id: coalesceObjectId(param),
      }).lean();
    }

    if (!order) {
      return jsonError(res, 404, "Order not found");
    }

    const items = await OrderItem.find({
      order_id: order._id,
      status: "active",
      deletedAt: null,
    })
      .sort({ createdAt: 1 })
      .lean();

    return jsonSuccess(res, 200, toPublicOrderDto(order, items));
  } catch (error) {
    console.error("[shop] getShopOrder:", error);
    return jsonError(res, 500, error.message || "Failed to load order");
  }
}

module.exports = {
  getShopStore,
  getShopCategories,
  getShopBrands,
  getShopProducts,
  validateShopCart,
  createShopOrder,
  getShopOrder,
};
