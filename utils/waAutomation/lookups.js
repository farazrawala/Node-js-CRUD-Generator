/**
 * Data sources for the automation "API Request" step.
 *
 *   pos_order          — order status from this company's POS orders
 *   pos_delivery       — courier / tracking for an order
 *   pos_products       — product search (name, SKU, barcode)
 *   pos_select_product — the result the customer picked (1, 2, 3)
 *   pos_add_to_cart    — saves that product and a quantity on the chat cart
 *   pos_cancel_request — tags the order `customer_cancel` for the team; never cancels it
 *   http               — a custom HTTP request to the business's own API
 *
 * Each returns `{ ok, vars, products?, summary, notice? }` for the engine.
 * In test mode (the builder's test chat) nothing is written and only GET
 * requests are really sent.
 */
const dns = require("dns").promises;
const net = require("net");
const { interpolate, orderNumberCandidates } = require("./messageFormat");

const HTTP_TIMEOUT_MS = 10000;
const HTTP_MAX_RESPONSE_BYTES = 512 * 1024;
const PRODUCT_RESULT_LIMIT = 3;
const BROWSE_PAGE_SIZE = 10;

const ORDER_STATUS_LABELS = {
  active: "Active",
  placed: "Placed",
  confirmed: "Confirmed",
  duplicate: "Duplicate",
  packed: "Packed",
  products_skipped: "On hold",
  delivered: "Delivered",
  draft: "Draft",
  pending: "Pending",
  in_transit: "In transit",
  on_hold: "On hold",
  cancelled: "Cancelled",
  failed: "Failed",
  processing: "Processing",
  return: "Returned",
  return_received: "Return received",
};
/** Statuses where the order has not left the store yet. */
const CANCELLABLE_STATUSES = new Set(["active", "placed", "confirmed", "pending", "draft", "on_hold", "processing"]);

const statusLabel = (status) =>
  ORDER_STATUS_LABELS[status] ||
  String(status || "Unknown")
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());

const formatMoney = (n) => `Rs. ${Math.round(Number(n) || 0).toLocaleString("en-US")}.00`;

function formatDate(date) {
  const d = date ? new Date(date) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Karachi" });
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function phoneVariants(phone) {
  // Lazy: controllers/chat requires this module indirectly
  const { phoneMatchVariants } = require("../../controllers/chat");
  return phoneMatchVariants(phone);
}

// ── POS orders ──────────────────────────────────────────────────────

/**
 * Anyone with an order number can see its status; `requirePhone` (cancellation
 * requests) also needs the order to be placed with the customer's WhatsApp number.
 */
async function findOrder({ companyId, phone, vars, test, requirePhone = false }) {
  const Order = require("../../models/order");
  const candidates = orderNumberCandidates(vars.order_number);
  if (!candidates.length) {
    return { error: { ok: false, vars: {}, summary: "No order number to look up" } };
  }
  const order = await Order.findOne({
    company_id: companyId,
    deletedAt: null,
    status: "active",
    $or: [{ order_no: { $in: candidates } }, { integration_order_id: { $in: candidates } }],
  })
    .sort({ createdAt: -1 })
    .lean();
  if (!order) {
    return { error: { ok: false, vars: {}, summary: `Order ${candidates[0]} not found` } };
  }

  let notice = "";
  if (requirePhone) {
    if (test) {
      notice = "Test chat skips the phone check. On WhatsApp only the customer's own orders can be cancelled.";
    } else {
      const theirs = new Set(phoneVariants(order.phone));
      const matches = phoneVariants(phone).some((v) => theirs.has(v));
      if (!matches) {
        return {
          error: {
            ok: false,
            vars: {},
            summary: `Order ${order.order_no} is not linked to this customer's phone number`,
          },
        };
      }
    }
  }
  return { order, notice };
}

async function orderVars(order) {
  const OrderItem = require("../../models/order_item");
  const items = await OrderItem.find({ order_id: order._id, deletedAt: null, status: "active" })
    .select("name qty product_id")
    .sort({ createdAt: 1 })
    .lean();
  const ids = items.map((i) => i.product_id).filter(Boolean);
  const Product = require("../../models/product");
  const unitRows = ids.length
    ? await Product.find({ _id: { $in: ids }, deletedAt: null }).select("unit").lean()
    : [];
  const unitBy = new Map(unitRows.map((row) => [String(row._id), row.unit]));
  const shown = items.slice(0, 5).map((i) =>
    formatCartLine({
      qty: Number(i.qty) || 1,
      name: i.name || "Item",
      measure: unitBy.get(String(i.product_id)) || "",
    }),
  );
  if (items.length > 5) shown.push(`+${items.length - 5} more`);

  const total = Number(order.total_amount) || 0;
  const received = Number(order.amount_received) || 0;
  return {
    order_number: order.order_no || order.integration_order_id || "",
    order_date: formatDate(order.createdAt),
    order_status: statusLabel(order.order_status),
    order_total: formatMoney(total),
    payment_status: total > 0 && received >= total ? "Paid" : received > 0 ? "Partly paid" : "Not paid yet",
    order_items: shown.join(", "),
    item_count: String(items.length),
    can_cancel: CANCELLABLE_STATUSES.has(order.order_status) ? "yes" : "no",
    customer_name: order.name || "",
  };
}

async function posOrder(args) {
  const { order, notice, error } = await findOrder(args);
  if (error) return error;
  return { ok: true, vars: await orderVars(order), summary: `found ${order.order_no}`, notice };
}

async function posDelivery(args) {
  const { order, notice, error } = await findOrder(args);
  if (error) return error;
  let courierName = "";
  if (order.courier_id) {
    const Courier = require("../../models/courier");
    const courier = await Courier.findById(order.courier_id).select("name type").lean();
    courierName = courier?.name || courier?.type || "";
  }
  const vars = {
    ...(await orderVars(order)),
    delivery_status: order.tracking_status || statusLabel(order.order_status),
    courier_name: courierName || "Not assigned yet",
    tracking_number: order.courier_tracking_number || "Not available yet",
    tracking_details: order.tracking_details || "",
  };
  return { ok: true, vars, summary: `found ${order.order_no} (${vars.delivery_status})`, notice };
}

async function posCancelRequest(args) {
  const { order, notice, error } = await findOrder({ ...args, requirePhone: true });
  if (error) return error;
  const vars = await orderVars(order);
  if (vars.can_cancel !== "yes") {
    return { ok: false, vars, summary: `${order.order_no} is ${vars.order_status} and can't be cancelled online` };
  }
  if (args.test) {
    return {
      ok: true,
      vars: { ...vars, cancel_reference: order.order_no },
      summary: `${order.order_no} can be cancelled`,
      notice: [notice, "Test chat: the order was not tagged."].filter(Boolean).join(" "),
    };
  }
  const Order = require("../../models/order");
  await Order.updateOne({ _id: order._id }, { $addToSet: { tags: "customer_cancel" } });
  return {
    ok: true,
    vars: { ...vars, cancel_reference: order.order_no },
    summary: `${order.order_no} tagged “customer_cancel” for your team`,
  };
}

// ── POS products ────────────────────────────────────────────────────

/** Database ids and import ids ("shopify-1063…") mean nothing to a customer. */
const isInternalSku = (sku) => /^[a-f0-9]{24}$/i.test(sku) || /^[a-z]+-\d{6,}$/i.test(sku);

function priceRange(prices) {
  const valid = prices.map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (!valid.length) return "";
  const low = Math.min(...valid);
  const high = Math.max(...valid);
  return low === high ? formatMoney(low) : `${formatMoney(low)} – ${formatMoney(high).replace(/^Rs\.\s*/, "")}`;
}

/** Not a variant: no parent (null, missing or legacy ""), or a legacy parent pointing at itself — as the public shop lists them. */
const TOP_LEVEL = {
  $or: [{ parent_product_id: { $not: { $type: "objectId" } } }, { $expr: { $eq: ["$parent_product_id", "$_id"] } }],
};
const IS_VARIANT = { parent_product_id: { $type: "objectId" }, $expr: { $ne: ["$parent_product_id", "$_id"] } };

/** Public shop link for a product, when the company's store is public and the POS address is known. */
async function productLinkBuilder(companyId, appUrl) {
  const base = String(appUrl || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) return () => "";
  const Company = require("../../models/company");
  const company = await Company.findById(companyId).select("company_slug display_store_on_bigcommerce status").lean();
  if (!company?.display_store_on_bigcommerce || company.status !== "active") return () => "";
  const store = encodeURIComponent(String(company.company_slug || company._id));
  return (productId) => `${base}/shop/${store}/product/${productId}`;
}

/**
 * Products as a customer sees them: a parent (with its variants' prices and stock
 * rolled up) or a product without variants. A variant's SKU or barcode finds its parent.
 */
const QTY_UNIT = "kgs?|kilograms?|kilos?|gms?|grams?|ltr|litres?|liters?|mls?|pcs?|pieces?|boxes?|dozen";

/**
 * "Sugar 2 kg" is the product Sugar and a quantity of 2.
 * A bare name, SKU or barcode is left as typed.
 */
function splitSearchQuantity(raw) {
  const text = String(raw || "").trim().replace(/\s+/g, " ");
  if (!text) return { query: "", quantity: "" };
  const token = new RegExp(`\\b(\\d+(?:\\.\\d+)?)\\s*(?:${QTY_UNIT})\\b`, "i");
  const match = text.match(token);
  if (!match) return { query: text, quantity: "" };
  const qty = parseOrderQuantity(match[1]);
  const query = text.replace(match[0], " ").replace(/\s+/g, " ").trim();
  if (!qty || !query) return { query: text, quantity: "" };
  return { query, quantity: String(qty) };
}

function idList(raw) {
  if (Array.isArray(raw)) return raw.map((id) => String(id || "").trim()).filter(Boolean);
  return String(raw || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

function readCategoryRows(vars) {
  const raw = vars?.category_rows;
  if (Array.isArray(raw)) return raw.filter((row) => row && row.id && row.name);
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((row) => row && row.id && row.name);
    } catch {
      return [];
    }
  }
  return [];
}

/** "1", "1." and "1️⃣" are category numbers. Anything else is typed text. */
function menuNumber(raw) {
  const text = String(raw || "").trim();
  const caps = ["0️⃣", "1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
  const emoji = caps.indexOf(text);
  if (emoji >= 0) return emoji;
  const match = text.match(/^(\d{1,2})\.?$/);
  return match ? Number(match[1]) : 0;
}

/**
 * A reply on the category list: a category number, "more", or a product name.
 * `rows` is the current page. `hasMore` adds option 11 (or the next number).
 */
function classifyBrowseReply(raw, { rows = [], hasMore = false } = {}) {
  const text = String(raw || "").trim();
  const norm = text.toLowerCase();
  if (!norm) return { kind: "invalid" };
  if (/^(more|next)$/.test(norm)) return hasMore ? { kind: "more_categories" } : { kind: "name", query: text };
  const num = menuNumber(text);
  if (num >= 1 && num <= rows.length) return { kind: "category", index: num - 1 };
  if (num === rows.length + 1 && hasMore) return { kind: "more_categories" };
  const named = rows.findIndex((row) => String(row.name || "").trim().toLowerCase() === norm);
  if (named >= 0) return { kind: "category", index: named };
  return { kind: "name", query: text };
}

function categoryLines(rows, hasMore) {
  const lines = rows.map((row, i) => `${i + 1}. ${row.name}`);
  if (hasMore) lines.push(`${rows.length + 1}. More`);
  return lines.join("\n");
}

async function shopCategories(companyId) {
  const mongoose = require("mongoose");
  const Category = require("../../models/category");
  const Product = require("../../models/product");
  const { decodeHtmlEntities } = require("../decodeHtmlEntities");
  const company = new mongoose.Types.ObjectId(String(companyId));
  const [categories, counts] = await Promise.all([
    Category.find({ company_id: companyId, deletedAt: null, status: "active", isActive: { $ne: false } })
      .select("name parent_id")
      .lean(),
    Product.aggregate([
      { $match: { company_id: company, deletedAt: null, status: "active" } },
      { $unwind: "$category_id" },
      { $group: { _id: "$category_id", n: { $sum: 1 } } },
    ]).catch(() => []),
  ]);
  const countOf = new Map(counts.map((row) => [String(row._id), Number(row.n) || 0]));
  const byParent = new Map();
  for (const category of categories) {
    const parent = category.parent_id ? String(category.parent_id) : "";
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(String(category._id));
  }
  const descendants = (id, seen = new Set()) => {
    const key = String(id);
    if (seen.has(key)) return [];
    seen.add(key);
    const kids = byParent.get(key) || [];
    return [key, ...kids.flatMap((kid) => descendants(kid, seen))];
  };
  const roots = categories.filter((category) => !category.parent_id);
  const ranked = (roots.length ? roots : categories)
    .map((category) => {
      const ids = descendants(category._id);
      const n = ids.reduce((sum, id) => sum + (countOf.get(id) || 0), 0);
      return { id: String(category._id), name: decodeHtmlEntities(category.name || "").trim(), ids, n };
    })
    .filter((row) => row.name && row.n > 0)
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  return ranked;
}

async function posCategories({ companyId, vars }) {
  const paging = vars?.category_paging === "more";
  const page = paging ? Math.max(0, Number(vars?.category_page) || 0) : 0;
  const ranked = await shopCategories(companyId);
  if (!ranked.length) return { ok: false, vars: { pick_kind: "categories" }, products: [], summary: "No categories" };
  const start = page * BROWSE_PAGE_SIZE;
  const slice = ranked.slice(start, start + BROWSE_PAGE_SIZE);
  if (!slice.length) return { ok: false, vars: {}, products: [], summary: "No more categories" };
  const hasMore = start + slice.length < ranked.length;
  const rows = slice.map((row) => ({ id: row.id, name: row.name, ids: row.ids.join(",") }));
  return {
    ok: true,
    products: [],
    vars: {
      pick_kind: "categories",
      category_page: String(page),
      category_paging: "",
      category_has_more: hasMore ? "yes" : "no",
      category_rows: JSON.stringify(rows),
      category_list: categoryLines(rows, hasMore),
      quantity: "",
    },
    summary: `${slice.length} categories`,
  };
}

async function posProducts({ companyId, vars, appUrl, data }) {
  const mongoose = require("mongoose");
  const Product = require("../../models/product");
  const WarehouseInventory = require("../../models/warehouse_inventory");
  const pageSize = Math.min(BROWSE_PAGE_SIZE, Math.max(1, Number(data?.pageSize || vars?.page_size) || PRODUCT_RESULT_LIMIT));
  const byName = Boolean(data?.byName);
  const categoryIds = !byName && vars?.browse_mode === "category" ? idList(vars?.browse_category_ids) : [];
  const skip = byName ? 0 : Math.max(0, Number(vars?.browse_offset) || 0);
  const rawQuery = !byName && vars?.browse_mode === "name" && vars?.browse_query ? vars.browse_query : vars?.search_query;
  const parsed = categoryIds.length ? { query: String(vars?.search_query || "").trim(), quantity: "" } : splitSearchQuantity(rawQuery);
  const query = parsed.query;

  const base = { company_id: companyId, deletedAt: null, status: "active" };
  const fields = "product_name sku product_type product_price unit";
  let products = [];
  if (categoryIds.length) {
    const ids = categoryIds.map((id) => new mongoose.Types.ObjectId(id));
    products = await Product.find({ ...base, ...TOP_LEVEL, category_id: { $in: ids } })
      .select(fields)
      .sort({ product_name: 1 })
      .skip(skip)
      .limit(pageSize)
      .lean();
  } else {
    const words = query.split(/\s+/).filter(Boolean).slice(0, 6);
    if (!words.length) return { ok: false, vars: { search_query: query, quantity: "" }, products: [], summary: "No search text" };
    const matchesWords = words.map((w) => {
      const rx = new RegExp(escapeRegex(w), "i");
      return { $or: [{ product_name: rx }, { sku: rx }, { product_code: rx }, { barcode: w }] };
    });
    products = await Product.find({ ...base, $and: [TOP_LEVEL, ...matchesWords] })
      .select(fields)
      .sort({ product_name: 1 })
      .skip(skip)
      .limit(pageSize)
      .lean();
    if (skip === 0 && products.length < pageSize) {
      // A variant's own SKU / barcode → show its parent
      const variants = await Product.find({ ...base, ...IS_VARIANT, $and: matchesWords })
        .select("parent_product_id")
        .limit(20)
        .lean();
      const have = new Set(products.map((p) => String(p._id)));
      const parentIds = [...new Set(variants.map((v) => String(v.parent_product_id)))].filter((id) => !have.has(id));
      if (parentIds.length) {
        const parents = await Product.find({ ...base, _id: { $in: parentIds }, $and: [TOP_LEVEL] })
          .select(fields)
          .limit(pageSize - products.length)
          .lean();
        products.push(...parents);
      }
    }
  }
  if (!products.length) {
    return {
      ok: false,
      vars: { search_query: query, quantity: "" },
      products: [],
      summary: `No products match “${query}”`,
    };
  }

  const parentIds = products.filter((p) => p.product_type === "Variable").map((p) => p._id);
  const variants = parentIds.length
    ? await Product.find({ ...base, parent_product_id: { $in: parentIds }, _id: { $nin: parentIds } })
        .select("parent_product_id product_price")
        .lean()
    : [];
  const linkTo = await productLinkBuilder(companyId, appUrl);
  const stockRows = await WarehouseInventory.aggregate([
    {
      $match: {
        company_id: new mongoose.Types.ObjectId(String(companyId)),
        product_id: { $in: [...products, ...variants].map((p) => p._id) },
        deletedAt: null,
      },
    },
    { $group: { _id: "$product_id", qty: { $sum: "$quantity" } } },
  ]).catch(() => []);
  const stockBy = new Map(stockRows.map((r) => [String(r._id), Number(r.qty) || 0]));

  const list = products.map((p) => {
    const own = variants.filter((v) => String(v.parent_product_id) === String(p._id));
    const qty = [p, ...own].reduce((sum, item) => sum + Math.max(0, stockBy.get(String(item._id)) || 0), 0);
    const sku = String(p.sku || "").trim();
    return {
      id: String(p._id),
      name: p.product_name || "Product",
      sku: isInternalSku(sku) ? "" : sku,
      price: priceRange(own.length ? own.map((v) => v.product_price) : [p.product_price]) || formatMoney(p.product_price),
      stock: qty > 0 ? `In stock (${qty})` : "Out of stock",
      url: linkTo(p._id),
      unit: p.unit || "",
    };
  });
  const statedQty = parsed.quantity && list.length === 1;
  return {
    ok: true,
    products: list,
    vars: {
      search_query: query,
      quantity: categoryIds.length ? "" : parsed.quantity,
      browse_mode: categoryIds.length ? "category" : "name",
      browse_offset: String(skip),
      browse_query: categoryIds.length ? "" : query,
      browse_category_ids: categoryIds.join(","),
      page_size: String(pageSize),
      pick_kind: "products",
      product_count: String(list.length),
      product_name: list[0].name,
      product_price: list[0].price,
      product_stock: list[0].stock,
      product_sku: list[0].sku,
      product_url: list[0].url,
      ...(statedQty ? { last_choice: "1" } : {}),
    },
    summary: `${list.length} product${list.length === 1 ? "" : "s"} found`,
  };
}

/** "Product 1" / "1" → the first result from the last search. */
function pickedProduct(lastChoice, products) {
  const list = Array.isArray(products) ? products : [];
  const text = String(lastChoice || "").trim();
  const n = text.match(/(\d+)\s*$/);
  if (n) {
    const index = Number(n[1]) - 1;
    if (list[index]) return list[index];
  }
  const wanted = text.toLowerCase();
  return list.find((p) => String(p.name || "").trim().toLowerCase() === wanted) || null;
}

function variantLabel(name, parentName) {
  const raw = String(name || "").trim();
  const parent = String(parentName || "").trim();
  if (parent && raw.toLowerCase().startsWith(parent.toLowerCase())) {
    const rest = raw.slice(parent.length).replace(/^[\s\-–—:[\]]+/, "").replace(/\]$/, "").trim();
    if (rest) return rest;
  }
  return raw || "Option";
}

/**
 * The result the customer picked (reply "1" on a product menu). Fills the product
 * variables and, when that product has variants, a numbered list of them.
 */
async function posSelectProduct({ companyId, vars, products }) {
  const list = Array.isArray(products) ? products : [];
  const picked = pickedProduct(vars?.last_choice, list);
  if (!picked) return { ok: false, vars: {}, products: list, summary: "That product is not in the results" };

  let rows = [];
  if (picked.id && companyId) {
    const Product = require("../../models/product");
    rows = await Product.find({
      company_id: companyId,
      deletedAt: null,
      status: "active",
      parent_product_id: picked.id,
    })
      .select("product_name sku product_price")
      .lean();
    rows = rows.filter((row) => String(row._id) !== String(picked.id));
  }
  const variantList = rows.map((row, i) => `${i + 1}. ${variantLabel(row.product_name, picked.name)}`).join("\n");
  return {
    ok: true,
    products: list,
    vars: {
      product_name: picked.name,
      product_sku: picked.sku || "",
      product_price: picked.price || "",
      product_stock: picked.stock || "",
      product_url: picked.url || "",
      product_unit: displayUnit(picked.unit),
      has_variants: rows.length ? "yes" : "no",
      variant_list: variantList,
      selected_product_id: String(picked.id || ""),
    },
    summary: `Selected ${picked.name}`,
  };
}

/** "1", "5 kg", "5kg" → 5. Anything without a positive number is not a quantity. */
function parseOrderQuantity(raw) {
  const match = String(raw ?? "").match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const n = Math.round(Number(match[1]));
  if (!Number.isFinite(n) || n < 1 || n > 100000) return null;
  return n;
}

function readCartLines(vars) {
  const raw = vars?.cart_lines;
  if (Array.isArray(raw)) return raw.filter((line) => line && line.product_id);
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((line) => line && line.product_id);
    } catch {
      return [];
    }
  }
  return [];
}

/** Product unit as the customer should read it. Piece stays a plain count. */
function displayUnit(unit) {
  const key = String(unit || "").trim().toLowerCase();
  if (!key || key === "piece" || key === "others") return "";
  return key;
}

/** "3 kg Sugar", or "3× Sugar" when the product is sold by the piece. */
function formatCartLine(line) {
  const qty = Number(line?.qty) || 0;
  const unit = displayUnit(line?.measure);
  const name = line?.name || "Item";
  const variant = line?.variant_name ? ` (${line.variant_name})` : "";
  return unit ? `${qty} ${unit} ${name}${variant}` : `${qty}× ${name}${variant}`;
}

function quantityLabel(qty, measure) {
  const unit = displayUnit(measure);
  return unit ? `${qty} ${unit}` : `${qty}×`;
}

function cartState(lines) {
  const count = lines.reduce((sum, line) => sum + (Number(line.qty) || 0), 0);
  const total = lines.reduce((sum, line) => sum + (Number(line.qty) || 0) * (Number(line.unit) || 0), 0);
  return {
    cart_lines: lines,
    cart_count: String(count),
    cart_items: lines.map((line) => formatCartLine(line)).join("\n"),
    cart_total: formatMoney(total),
  };
}

function addCartLine(lines, line) {
  const next = lines.map((row) => ({ ...row }));
  const key = `${line.product_id}|${line.variant_id || ""}`;
  const existing = next.find((row) => `${row.product_id}|${row.variant_id || ""}` === key);
  if (existing) {
    existing.qty += line.qty;
    if (!existing.measure && line.measure) existing.measure = line.measure;
  } else next.push({ ...line });
  return next;
}

async function availableQty(companyId, productId) {
  if (!companyId || !productId) return 0;
  const mongoose = require("mongoose");
  const WarehouseInventory = require("../../models/warehouse_inventory");
  const rows = await WarehouseInventory.aggregate([
    {
      $match: {
        company_id: new mongoose.Types.ObjectId(String(companyId)),
        product_id: new mongoose.Types.ObjectId(String(productId)),
        deletedAt: null,
      },
    },
    { $group: { _id: null, qty: { $sum: "$quantity" } } },
  ]).catch(() => []);
  return Math.max(0, Number(rows[0]?.qty) || 0);
}

/**
 * Adds the chosen product to this chat's cart when the quantity is in stock.
 * "5 kg" counts as 5. Stock is the same warehouse total the product list showed.
 */
async function posAddToCart({ companyId, vars, products }) {
  const list = Array.isArray(products) ? products : [];
  const qty = parseOrderQuantity(vars?.quantity);
  if (!qty) return { ok: false, vars: {}, products: list, summary: "That is not a quantity" };

  const productId = String(vars?.selected_product_id || "");
  const known = list.find((p) => p.id === productId) || list.find((p) => p.name === vars?.product_name);
  const id = productId || String(known?.id || "");
  if (!id) return { ok: false, vars: {}, products: list, summary: "No product is selected" };

  const Product = require("../../models/product");
  const doc = await Product.findOne({ _id: id, company_id: companyId, deletedAt: null })
    .select("product_name product_price unit")
    .lean();
  if (!doc) return { ok: false, vars: {}, products: list, summary: "Product is no longer available" };

  const available = await availableQty(companyId, id);
  const variantId = String(vars?.selected_variant_id || "");
  const lines = readCartLines(vars);
  const already = lines
    .filter((line) => line.product_id === id && String(line.variant_id || "") === variantId)
    .reduce((sum, line) => sum + (Number(line.qty) || 0), 0);
  if (already + qty > available) {
    const left = Math.max(0, available - already);
    return {
      ok: false,
      vars: {},
      products: list,
      summary: left > 0 ? `Only ${left} available (${available} in stock)` : "Out of stock",
    };
  }

  const measure = doc.unit || known?.unit || "";
  const next = await withMeasures(
    companyId,
    addCartLine(lines, {
      product_id: id,
      variant_id: variantId,
      name: doc.product_name || vars.product_name || "Product",
      variant_name: String(vars?.variant_name || "").trim(),
      qty,
      unit: Number(doc.product_price) || 0,
      measure,
    }),
  );
  return {
    ok: true,
    products: list,
    vars: {
      quantity: String(qty),
      product_unit: displayUnit(measure),
      quantity_label: quantityLabel(qty, measure),
      ...cartState(next),
    },
    summary: `Added ${quantityLabel(qty, measure)} ${doc.product_name || "product"} (${available} in stock)`,
  };
}

/** Older cart lines stored the price in `unit` and had no product measure. */
async function withMeasures(companyId, lines) {
  const missing = lines.filter((line) => !displayUnit(line.measure) && line.product_id && !line.measure);
  if (!missing.length || !companyId) return lines;
  const Product = require("../../models/product");
  const docs = await Product.find({
    _id: { $in: missing.map((line) => line.product_id) },
    company_id: companyId,
    deletedAt: null,
  })
    .select("unit")
    .lean()
    .catch(() => []);
  const byId = new Map(docs.map((doc) => [String(doc._id), doc.unit || ""]));
  return lines.map((line) => (line.measure ? line : { ...line, measure: byId.get(String(line.product_id)) || "" }));
}

const SKIP_EMAIL = /^(skip|no|none|nahi|na|n\/a|-|no email)$/i;

/** Blank when the customer skips. `null` when they typed something that is not an email. */
function optionalOrderEmail(raw) {
  const text = String(raw ?? "").trim();
  if (!text || SKIP_EMAIL.test(text)) return "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return null;
  return text;
}

/**
 * Creates a POS order from the chat cart after the customer has given their name.
 * The phone saved on the order is the WhatsApp number. Email is left blank.
 * Returns the new order number.
 */
async function posPlaceOrder({ companyId, phone: chatPhone, vars, products, test }) {
  const list = Array.isArray(products) ? products : [];
  const lines = readCartLines(vars);
  if (!lines.length) return { ok: false, vars: {}, products: list, summary: "The cart is empty" };

  const name = String(vars?.order_customer_name || "").trim().slice(0, 120);
  if (!name) return { ok: false, vars: {}, products: list, summary: "A name is required" };

  const phone = String(chatPhone || vars?.customer_phone || "").replace(/^\+/, "").replace(/\D/g, "");
  if (!/^\d{10,15}$/.test(phone)) return { ok: false, vars: {}, products: list, summary: "This chat has no phone number" };

  const measured = await withMeasures(companyId, lines);
  const orderItems = measured.map((line) => formatCartLine(line)).join(", ");
  const total = lines.reduce((sum, line) => sum + (Number(line.qty) || 0) * (Number(line.unit) || 0), 0);
  const placed = {
    order_status: "Placed",
    order_total: formatMoney(total),
    order_items: orderItems,
    payment_status: "Not paid yet",
    item_count: String(lines.length),
    customer_name: name,
  };

  if (test) {
    return {
      ok: true,
      products: list,
      vars: { ...placed, order_number: "ORD-TEST" },
      summary: "Test chat: order was not saved",
      notice: "Test chat: no order was created.",
    };
  }

  const Company = require("../../models/company");
  const User = require("../../models/user");
  const [company, actor] = await Promise.all([
    Company.findById(companyId).lean(),
    User.findOne({ company_id: companyId, deletedAt: null }).select("_id name").lean(),
  ]);
  if (!company || !actor) return { ok: false, vars: {}, products: list, summary: "This store cannot save orders yet" };
  if (!company.warehouse_id) {
    const WarehouseInventory = require("../../models/warehouse_inventory");
    const stocked = await WarehouseInventory.findOne({
      company_id: companyId,
      product_id: lines[0].product_id,
      deletedAt: null,
      quantity: { $gt: 0 },
    })
      .select("warehouse_id")
      .lean();
    if (stocked?.warehouse_id) company.warehouse_id = stocked.warehouse_id;
  }

  const body = {
    name,
    phone,
    email: "",
    order_status: "placed",
    amount_received: 0,
    discount: 0,
    shipment: 0,
    note: "Placed on WhatsApp",
  };
  measured.forEach((line, i) => {
    body[`product_id[${i}]`] = line.product_id;
    body[`qty[${i}]`] = String(line.qty);
    body[`price[${i}]`] = String(Number(line.unit) || 0);
    body[`name[${i}]`] = line.variant_name ? `${line.name} (${line.variant_name})` : line.name;
  });

  const req = { body, user: { _id: actor._id, name: actor.name, company_id: company } };
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return payload;
    },
  };

  try {
    const { order_save } = require("../../controllers/order");
    await order_save(req, res);
  } catch (err) {
    return { ok: false, vars: {}, products: list, summary: err?.message || "Order could not be saved" };
  }

  const saved = res.body?.data;
  if (!res.body?.success || !saved?.order_no) {
    const message = res.body?.message || res.body?.error || res.body?.details || "Order could not be saved";
    return { ok: false, vars: {}, products: list, summary: String(message).slice(0, 300) };
  }

  return {
    ok: true,
    products: list,
    vars: { ...placed, order_number: saved.order_no, order_total: formatMoney(saved.total_amount ?? total) },
    summary: `Placed ${saved.order_no}`,
  };
}

// ── Custom HTTP ─────────────────────────────────────────────────────

/** Loopback, private, link-local, CGNAT, multicast and reserved ranges. */
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === "::" || v === "::1") return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v);
  }
  return true;
}

/** Only public http(s) hosts — the server must not be used to reach its own network. */
async function assertPublicUrl(url) {
  if (!/^https?:$/.test(url.protocol)) throw new Error("Only http:// and https:// URLs are allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error("Requests to local addresses are not allowed");
  }
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new Error("Requests to private network addresses are not allowed");
  }
}

/** "data.status", "data[].name" (first item), "items.0.price" */
function getPath(obj, path) {
  let cur = obj;
  for (const part of String(path || "")
    .replace(/\[\]/g, ".0")
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean)) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function stringifyValue(value) {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value).slice(0, 500);
  return String(value);
}

async function httpRequest({ data, vars, test }) {
  const method = String(data.method || "GET").toUpperCase();
  let url;
  try {
    url = new URL(interpolate(data.url, vars).trim());
  } catch {
    return { ok: false, vars: {}, summary: "The API URL is not valid" };
  }
  for (const p of data.params || []) {
    if (p?.key) url.searchParams.set(interpolate(p.key, vars), interpolate(p.value, vars));
  }
  const target = `${method} ${url.host}${url.pathname}`;

  if (test && method !== "GET") {
    return {
      ok: true,
      vars: {},
      summary: `${target} — not sent from the test chat, treated as success`,
    };
  }

  try {
    await assertPublicUrl(url);
  } catch (err) {
    return { ok: false, vars: {}, summary: `${target} blocked: ${err.message}` };
  }

  const headers = { Accept: "application/json" };
  for (const h of data.headers || []) {
    if (h?.key) headers[interpolate(h.key, vars).trim()] = interpolate(h.value, vars);
  }
  const options = { method, headers, redirect: "manual", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) };
  if (method !== "GET" && method !== "HEAD" && String(data.body || "").trim()) {
    options.body = interpolate(data.body, vars);
    if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
      headers["Content-Type"] = "application/json";
    }
  }

  let res;
  let text = "";
  try {
    res = await fetch(url, options);
    const buf = Buffer.from(await res.arrayBuffer());
    text = buf.subarray(0, HTTP_MAX_RESPONSE_BYTES).toString("utf8");
  } catch (err) {
    const reason = err?.name === "TimeoutError" ? `timed out after ${HTTP_TIMEOUT_MS / 1000}s` : err?.message || "failed";
    return { ok: false, vars: {}, summary: `${target} ${reason}` };
  }

  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  const ok = res.status >= 200 && res.status < 300;
  const mapped = {};
  if (ok && json != null) {
    for (const m of data.mapping || []) {
      // Variable names are plain words ({{order_status}}), never "a.b" or "$x".
      const variable = String(m?.variable || "").trim().replace(/\W/g, "_");
      if (m?.field && variable) mapped[variable] = stringifyValue(getPath(json, m.field));
    }
  }
  return {
    ok,
    vars: mapped,
    summary: `${target} → ${res.status}`,
    response: { status: res.status, body: text.slice(0, 2000) },
  };
}

/**
 * Run one API step. `scope`: `{ companyId, phone, test }`.
 */
/** Category number, "more", or a product name from the opening question. */
async function posBrowseChoice({ companyId, vars, appUrl }) {
  const rows = readCategoryRows(vars);
  const choice = classifyBrowseReply(vars?.order_pick, { rows, hasMore: vars?.category_has_more === "yes" });
  if (choice.kind === "invalid") return { ok: false, vars: {}, products: [], summary: "No choice" };
  if (choice.kind === "more_categories") {
    return posCategories({
      companyId,
      vars: { ...vars, category_paging: "more", category_page: String((Number(vars?.category_page) || 0) + 1) },
    });
  }
  if (choice.kind === "category") {
    const row = rows[choice.index];
    const found = await posProducts({
      companyId,
      appUrl,
      data: { pageSize: BROWSE_PAGE_SIZE },
      vars: {
        ...vars,
        browse_mode: "category",
        browse_category_ids: row.ids || row.id,
        browse_offset: "0",
        page_size: String(BROWSE_PAGE_SIZE),
        search_query: row.name,
        quantity: "",
      },
    });
    if (!found.ok) return found;
    return { ...found, vars: { ...found.vars, pick_kind: "products", search_query: row.name } };
  }
  const found = await posProducts({
    companyId,
    appUrl,
    data: { pageSize: BROWSE_PAGE_SIZE, byName: true },
    vars: { ...vars, search_query: choice.query, browse_offset: "0" },
  });
  if (!found.ok) return found;
  return { ...found, vars: { ...found.vars, pick_kind: "products" } };
}

/** The next 10 products in the same category or name search. */
async function posMoreProducts(args) {
  const offset = (Number(args.vars?.browse_offset) || 0) + (Number(args.vars?.page_size) || BROWSE_PAGE_SIZE);
  const found = await posProducts({
    ...args,
    data: { pageSize: BROWSE_PAGE_SIZE },
    vars: { ...args.vars, browse_offset: String(offset), page_size: String(BROWSE_PAGE_SIZE) },
  });
  if (!found.ok) return { ok: false, vars: {}, products: [], summary: "No more products" };
  return found;
}

async function runApi(source, data, vars, scope) {
  const args = { ...scope, data: data || {}, vars: vars || {} };
  switch (source) {
    case "pos_order":
      return posOrder(args);
    case "pos_delivery":
      return posDelivery(args);
    case "pos_products":
      return posProducts(args);
    case "pos_categories":
      return posCategories(args);
    case "pos_browse_choice":
      return posBrowseChoice(args);
    case "pos_more_products":
      return posMoreProducts(args);
    case "pos_select_product":
      return posSelectProduct(args);
    case "pos_add_to_cart":
      return posAddToCart(args);
    case "pos_place_order":
      return posPlaceOrder(args);
    case "pos_cancel_request":
      return posCancelRequest(args);
    case "http":
    default:
      return httpRequest(args);
  }
}

module.exports = {
  runApi,
  httpRequest,
  isPrivateAddress,
  assertPublicUrl,
  getPath,
  statusLabel,
  formatMoney,
  parseOrderQuantity,
  splitSearchQuantity,
  classifyBrowseReply,
  optionalOrderEmail,
  cartState,
  addCartLine,
};
