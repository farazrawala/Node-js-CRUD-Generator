/**
 * Data sources for the automation "API Request" step.
 *
 *   pos_order          — order status from this company's POS orders
 *   pos_delivery       — courier / tracking for an order
 *   pos_products       — product search (name, SKU, barcode)
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

const formatMoney = (n) => `PKR ${Math.round(Number(n) || 0).toLocaleString("en-US")}`;

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
    .select("name qty")
    .sort({ createdAt: 1 })
    .lean();
  const shown = items.slice(0, 5).map((i) => `${Number(i.qty) || 1}× ${i.name || "Item"}`);
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
  return low === high ? formatMoney(low) : `${formatMoney(low)} – ${formatMoney(high).replace(/^PKR\s*/, "")}`;
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
async function posProducts({ companyId, vars, appUrl }) {
  const mongoose = require("mongoose");
  const Product = require("../../models/product");
  const WarehouseInventory = require("../../models/warehouse_inventory");
  const query = String(vars.search_query ?? "").trim();
  const words = query.split(/\s+/).filter(Boolean).slice(0, 6);
  if (!words.length) return { ok: false, vars: {}, products: [], summary: "No search text" };

  const base = { company_id: companyId, deletedAt: null, status: "active" };
  const matchesWords = words.map((w) => {
    const rx = new RegExp(escapeRegex(w), "i");
    return { $or: [{ product_name: rx }, { sku: rx }, { product_code: rx }, { barcode: w }] };
  });
  const fields = "product_name sku product_type product_price";
  const products = await Product.find({ ...base, $and: [TOP_LEVEL, ...matchesWords] })
    .select(fields)
    .limit(PRODUCT_RESULT_LIMIT)
    .lean();
  if (products.length < PRODUCT_RESULT_LIMIT) {
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
        .limit(PRODUCT_RESULT_LIMIT - products.length)
        .lean();
      products.push(...parents);
    }
  }
  if (!products.length) return { ok: false, vars: {}, products: [], summary: `No products match “${query}”` };

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
      name: p.product_name || "Product",
      sku: isInternalSku(sku) ? "" : sku,
      price: priceRange(own.length ? own.map((v) => v.product_price) : [p.product_price]) || formatMoney(p.product_price),
      stock: qty > 0 ? `In stock (${qty})` : "Out of stock",
      url: linkTo(p._id),
    };
  });
  return {
    ok: true,
    products: list,
    vars: {
      product_count: String(list.length),
      product_name: list[0].name,
      product_price: list[0].price,
      product_stock: list[0].stock,
      product_sku: list[0].sku,
      product_url: list[0].url,
    },
    summary: `${list.length} product${list.length === 1 ? "" : "s"} found`,
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
async function runApi(source, data, vars, scope) {
  const args = { ...scope, data: data || {}, vars: vars || {} };
  switch (source) {
    case "pos_order":
      return posOrder(args);
    case "pos_delivery":
      return posDelivery(args);
    case "pos_products":
      return posProducts(args);
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
};
