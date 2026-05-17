const mongoose = require("mongoose");
const PurchaseOrder = require("../models/purchase_order");
const PurchaseOrderItem = require("../models/purchase_order_item");

const Transaction = require("../models/transaction");
const InventoryMovements = require("../models/inventory_movements");

const {
  createTransactionsFromItems: transactionBulkCreate,
} = require("./transaction");
const { logRollbackFailure } = require("../utils/logControllerError");
const { generateTransactionNumber } = require("../utils/transactionNumber");
const {
  handleGenericCreate,
  handleGenericUpdate,
  handleGenericGetAll,
  coalesceObjectId,
  buildPopulateFromQuery,
} = require("../utils/modelHelper");
const { runInventoryMovementTxnBody } = require("./inventory_movements");
const { applyWarehouseInventoryDelta } = require("./stock_movement");
const {
  isMongoTransactionUnsupportedError,
} = require("../utils/mongoTransactionSupport");

/**
 * Purchase order HTTP handlers: header + line items, inventory movement ledger + warehouse qty,
 * and five GL postings per PO (same shape as order flow — see transactionBulkCreate payloads).
 *
 * Standalone MongoDB: tries `withTransaction` first; on replica-set–only errors, retries without a session.
 */

/**
 * One entry per row sent to `transactionBulkCreate` in afterCreate/afterUpdate (order matters).
 * - `companyAccountField`: populated on `req.user.company_id` (auth middleware).
 * - `poAccountField`: optional field on the purchase_order document for that row’s `account_id`.
 */
const PURCHASE_ORDER_GL_LINE_META = [
  {
    description: "Purchase Order (debit)",
    poAccountField: null,
    companyAccountField: "default_purchase_account",
  },
  {
    description: "Purchase Shipment (debit)",
    poAccountField: null,
    companyAccountField: "default_shipping_account",
  },
  {
    description: "Purchase Discount (credit)",
    poAccountField: null,
    companyAccountField: "default_purchase_discount_account",
  },
  {
    description: "Mode of Payment (credit)",
    // Cash/bank account for amount_paid — PO field or company default_cash_account
    poAccountField: "payment_method_accounts_id",
    companyAccountField: "default_cash_account",
  },
  {
    description: "Accounts Payable (credit)",
    poAccountField: null,
    companyAccountField: "default_account_payable_account",
  },
];

/** Human-readable hint for API errors: which company / body fields to set for a failed GL row. */
function purchaseOrderGlLineFixHint(meta) {
  if (!meta) {
    return "Configure company default GL accounts and PO payment fields.";
  }
  const parts = [];
  if (meta.companyAccountField) {
    parts.push(`company.${meta.companyAccountField}`);
  }
  if (meta.poAccountField) {
    parts.push(`purchase_order.body.${meta.poAccountField}`);
  }
  return parts.length ? `Set ${parts.join(" or ")}.` : "Configure GL accounts.";
}

/**
 * Augment bulk-create `failed` entries with line label, normalized missing list, and fix hints.
 * Keeps original keys (`index`, `missing`, …) for backward compatibility.
 */
function enrichPurchaseOrderGlFailures(failed) {
  if (!Array.isArray(failed)) return [];
  return failed.map((f) => {
    const idx = Number(f.index);
    const meta =
      Number.isFinite(idx) && idx >= 0 ?
        PURCHASE_ORDER_GL_LINE_META[idx]
      : null;
    const missing = Array.isArray(f.missing) ? f.missing : [];
    return {
      ...f,
      gl_line_index: idx,
      gl_line_description: meta?.description ?? `GL row ${idx}`,
      missing_fields: missing,
      where_to_fix: purchaseOrderGlLineFixHint(meta),
    };
  });
}

/** Single readable sentence for logs and `Error.message` (API error field). */
function formatPurchaseOrderGlBulkErrorMessage(enriched) {
  const lines = enriched.map((e) => {
    const miss =
      e.missing_fields?.length ?
        ` — missing: ${e.missing_fields.join(", ")}`
      : "";
    return `index ${e.gl_line_index} «${e.gl_line_description}»${miss}. ${e.where_to_fix}`;
  });
  return `Post-purchase_order transaction bulk insert failed. ${lines.join(" | ")}`;
}

/** GL lines failed: throw with statusCode 400 (rolled back + reason logged via `logRollbackFailure`). */
async function throwPurchaseOrderGlBulkFailed(_orderReq, failed) {
  const enriched = enrichPurchaseOrderGlFailures(failed);
  const msg = formatPurchaseOrderGlBulkErrorMessage(enriched);
  console.error(
    "⚠️ Post-purchase_order transaction bulk insert failed:",
    enriched,
  );
  const err = new Error(msg);
  err.statusCode = 400;
  err.details = enriched;
  err.responseType = "transaction_bulk";
  throw err;
}

/** Map handleGenericCreate failure objects to API JSON (keeps validation `details`, `missing`, etc.). */
function clientErrorFromGenericResponse(response, fallbackError) {
  if (response?.success && response?.data) return null;
  if (!response) {
    return {
      success: false,
      status: 500,
      error: fallbackError || "Request failed",
    };
  }
  const status = response.status || 400;
  const out = {
    success: false,
    status,
    error: response.error || fallbackError || "Request failed",
  };
  if (response.message != null) out.message = response.message;
  if (response.details != null) out.details = response.details;
  if (response.type != null) out.type = response.type;
  if (response.missing != null) out.missing = response.missing;
  if (response.required != null) out.required = response.required;
  if (response.received != null) out.received = response.received;
  return out;
}

/** Prefer validation `details` / `missing` strings for thrown Error.message (retry detection looks at message too). */
function logMessageFromGenericFailure(response, fallbackError) {
  const r = response || {};
  if (Array.isArray(r.details) && r.details.length) {
    return r.details.join("; ");
  }
  if (Array.isArray(r.missing) && r.missing.length) {
    return `Missing required fields: ${r.missing.join(", ")}`;
  }
  if (typeof r.details === "string" && r.details.trim()) {
    const headline = r.error || r.message || fallbackError || "Request failed";
    const d = r.details.trim();
    return headline !== d ? `${headline}: ${d}` : d;
  }
  return r.error || r.message || fallbackError || "Request failed";
}

/** Preserve full handleGenericCreate failure shape on the error for txn catch blocks (`clientErrorPayload`). */
function throwWithGenericFailure(response, fallbackError) {
  const err = new Error(logMessageFromGenericFailure(response, fallbackError));
  err.clientErrorPayload = clientErrorFromGenericResponse(
    response,
    fallbackError,
  );
  throw err;
}

function purchaseOrderLinesSubtotalSum(lineItems) {
  if (!Array.isArray(lineItems)) return 0;
  return Number(
    lineItems
      .reduce(
        (sum, l) => sum + (Number.isFinite(l.subtotal) ? l.subtotal : 0),
        0,
      )
      .toFixed(2),
  );
}

/** `purchase_order_item` requires shipping fields; default when omitted (legacy payloads). */
function normalizeLineShippingFields(line) {
  const spu = parseFloat(String(line?.shipping_per_unit ?? "").trim());
  const ts = parseFloat(String(line?.total_shipping ?? "").trim());
  return {
    shipping_per_unit: Number.isFinite(spu) ? spu : 0,
    total_shipping: Number.isFinite(ts) ? ts : 0,
  };
}

function normalizePurchaseOrderNumericFields(obj) {
  const out = { ...obj };
  for (const key of [
    "discount",
    "shipment",
    "lines_subtotal",
    "total_amount",
    "amount_paid",
  ]) {
    if (!(key in out)) continue;
    const v = out[key];
    if (v === "" || v === null || v === undefined) {
      delete out[key];
      continue;
    }
    const n = typeof v === "number" ? v : Number(String(v).trim());
    if (Number.isFinite(n)) out[key] = n;
    else delete out[key];
  }
  return out;
}

/** Same as order: qs / express-fileupload parseNested turn `product_id[0]` into nested structures. */
function indexedContainerLength(v) {
  if (v == null) return 0;
  if (Array.isArray(v)) return v.length;
  if (typeof v === "object") {
    const nums = Object.keys(v)
      .map((k) => parseInt(k, 10))
      .filter((n) => !Number.isNaN(n));
    if (nums.length === 0) return 0;
    return Math.max(...nums) + 1;
  }
  return 0;
}

function indexedContainerGet(v, i) {
  if (v == null) return undefined;
  if (Array.isArray(v)) return v[i];
  if (typeof v === "object") return v[i] ?? v[String(i)];
  return undefined;
}

/** e.g. product_id[0], qty[0], price[0] — raw flat keys (some clients / multipart) */
function parseBracketLineItems(body) {
  const byIndex = new Map();
  if (!body || typeof body !== "object") return [];
  for (const key of Object.keys(body)) {
    let m = key.match(/^product_id\[(\d+)\]$/);
    if (m) {
      const i = parseInt(m[1], 10);
      if (!byIndex.has(i)) byIndex.set(i, {});
      byIndex.get(i).product_id = body[key];
      continue;
    }
    m = key.match(/^qty\[(\d+)\]$/);
    if (m) {
      const i = parseInt(m[1], 10);
      if (!byIndex.has(i)) byIndex.set(i, {});
      byIndex.get(i).qty = body[key];
      continue;
    }
    m = key.match(/^price\[(\d+)\]$/);
    if (m) {
      const i = parseInt(m[1], 10);
      if (!byIndex.has(i)) byIndex.set(i, {});
      byIndex.get(i).price = body[key];
      continue;
    }
    m = key.match(/^total\[(\d+)\]$/);
    if (m) {
      const i = parseInt(m[1], 10);
      if (!byIndex.has(i)) byIndex.set(i, {});
      byIndex.get(i).total = body[key];
      continue;
    }
    m = key.match(/^warehouse_id\[(\d+)\]$/);
    if (m) {
      const i = parseInt(m[1], 10);
      if (!byIndex.has(i)) byIndex.set(i, {});
      byIndex.get(i).warehouse_id = body[key];
      continue;
    }
    m = key.match(/^shipping_per_unit\[(\d+)\]$/);
    if (m) {
      const i = parseInt(m[1], 10);
      if (!byIndex.has(i)) byIndex.set(i, {});
      byIndex.get(i).shipping_per_unit = body[key];
      continue;
    }
    m = key.match(/^total_shipping\[(\d+)\]$/);
    if (m) {
      const i = parseInt(m[1], 10);
      if (!byIndex.has(i)) byIndex.set(i, {});
      byIndex.get(i).total_shipping = body[key];
      continue;
    }
  }
  const sorted = [...byIndex.keys()].sort((a, b) => a - b);
  const lines = [];
  for (const i of sorted) {
    const row = byIndex.get(i);
    const qty = parseFloat(String(row.qty ?? "").trim());
    const price = parseFloat(String(row.price ?? "").trim());
    const fromTotal = parseFloat(String(row.total ?? "").trim());
    const subtotal =
      Number.isFinite(fromTotal) ? fromTotal
      : Number.isFinite(qty) && Number.isFinite(price) ? qty * price
      : NaN;
    lines.push({
      product_id: row.product_id,
      qty,
      price,
      subtotal,
      warehouse_id: row.warehouse_id,
      shipping_per_unit: row.shipping_per_unit,
      total_shipping: row.total_shipping,
    });
  }
  return lines.filter(
    (l) =>
      l.product_id &&
      String(l.product_id).trim() !== "" &&
      mongoose.Types.ObjectId.isValid(String(l.product_id).trim()) &&
      Number.isFinite(l.qty) &&
      Number.isFinite(l.price) &&
      Number.isFinite(l.subtotal),
  );
}

/**
 * Build PO line objects when the client sends parallel indexed fields on one object, e.g.
 * `product_id[]`, `qty[]`, `price[]`, `total[]` — or the same as array / `{ "0": …, "1": … }`
 * (common after `application/x-www-form-urlencoded` parsing).
 *
 * Line `subtotal` prefers a finite `total` cell when present; otherwise `qty * price` when both are finite.
 */
function parseLineItemsFromIndexedContainers(body) {
  if (!body || typeof body !== "object") return [];

  const productIdByIndex = body.product_id;
  const qtyByIndex = body.qty;
  const priceByIndex = body.price;
  const lineTotalByIndex = body.total;
  const warehouseIdByIndex = body.warehouse_id;
  const shippingPerUnitByIndex = body.shipping_per_unit;
  const totalShippingByIndex = body.total_shipping;

  const rowCount = Math.max(
    indexedContainerLength(productIdByIndex),
    indexedContainerLength(qtyByIndex),
    indexedContainerLength(priceByIndex),
    indexedContainerLength(lineTotalByIndex),
    indexedContainerLength(warehouseIdByIndex),
    indexedContainerLength(shippingPerUnitByIndex),
    indexedContainerLength(totalShippingByIndex),
  );
  if (rowCount === 0) return [];

  const lines = [];
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    const product_id = indexedContainerGet(productIdByIndex, rowIndex);
    const qtyRaw = indexedContainerGet(qtyByIndex, rowIndex);
    const priceRaw = indexedContainerGet(priceByIndex, rowIndex);
    const lineTotalRaw = indexedContainerGet(lineTotalByIndex, rowIndex);
    const warehouse_id = indexedContainerGet(warehouseIdByIndex, rowIndex);
    const shipping_per_unit = indexedContainerGet(
      shippingPerUnitByIndex,
      rowIndex,
    );
    const total_shipping = indexedContainerGet(totalShippingByIndex, rowIndex);

    const qty = parseFloat(String(qtyRaw ?? "").trim());
    const price = parseFloat(String(priceRaw ?? "").trim());
    const parsedLineTotal = parseFloat(String(lineTotalRaw ?? "").trim());
    const subtotal =
      Number.isFinite(parsedLineTotal) ? parsedLineTotal
      : Number.isFinite(qty) && Number.isFinite(price) ? qty * price
      : NaN;

    lines.push({
      product_id,
      qty,
      price,
      subtotal,
      warehouse_id,
      shipping_per_unit,
      total_shipping,
    });
  }

  return lines.filter(
    (line) =>
      line.product_id &&
      String(line.product_id).trim() !== "" &&
      mongoose.Types.ObjectId.isValid(String(line.product_id).trim()) &&
      Number.isFinite(line.qty) &&
      Number.isFinite(line.price) &&
      Number.isFinite(line.subtotal),
  );
}

function parseLegacyArrayLineItems(body) {
  const productIdArray =
    Array.isArray(body["product_id[]"]) ?
      body["product_id[]"]
    : [body["product_id[]"]].filter(Boolean);
  const qtyArray =
    Array.isArray(body["qty[]"]) ?
      body["qty[]"]
    : [body["qty[]"]].filter(Boolean);
  const priceArray =
    Array.isArray(body["price[]"]) ?
      body["price[]"]
    : [body["price[]"]].filter(Boolean);
  const totalArray =
    Array.isArray(body["total[]"]) ?
      body["total[]"]
    : [body["total[]"]].filter(Boolean);
  const warehouseIdArray =
    Array.isArray(body["warehouse_id[]"]) ?
      body["warehouse_id[]"]
    : [body["warehouse_id[]"]].filter(Boolean);
  const shippingPerUnitArray =
    Array.isArray(body["shipping_per_unit[]"]) ?
      body["shipping_per_unit[]"]
    : [body["shipping_per_unit[]"]].filter(Boolean);
  const totalShippingArray =
    Array.isArray(body["total_shipping[]"]) ?
      body["total_shipping[]"]
    : [body["total_shipping[]"]].filter(Boolean);
  if (productIdArray.length === 0) return [];
  return productIdArray
    .map((productId, index) => {
      const qty = parseFloat(String(qtyArray[index] ?? "").trim());
      const price = parseFloat(String(priceArray[index] ?? "").trim());
      const fromTotal = parseFloat(String(totalArray[index] ?? "").trim());
      const warehouse_id = warehouseIdArray[index];
      const shipping_per_unit = shippingPerUnitArray[index];
      const total_shipping = totalShippingArray[index];
      const subtotal =
        Number.isFinite(fromTotal) ? fromTotal
        : Number.isFinite(qty) && Number.isFinite(price) ? qty * price
        : NaN;
      return {
        product_id: productId,
        qty,
        price,
        subtotal,
        warehouse_id,
        shipping_per_unit,
        total_shipping,
      };
    })
    .filter(
      (l) =>
        l.product_id &&
        mongoose.Types.ObjectId.isValid(String(l.product_id).trim()) &&
        Number.isFinite(l.qty) &&
        Number.isFinite(l.price) &&
        Number.isFinite(l.subtotal),
    );
}

function parseProductIdsBodyArray(body) {
  if (!body.product_ids || !Array.isArray(body.product_ids)) return [];
  return body.product_ids
    .map((row) => {
      const qty = parseFloat(String(row.qty ?? "").trim());
      const price = parseFloat(String(row.price ?? "").trim());
      const subtotal =
        row.subtotal != null && String(row.subtotal).trim() !== "" ?
          parseFloat(String(row.subtotal).trim())
        : Number.isFinite(qty) && Number.isFinite(price) ? qty * price
        : NaN;
      return {
        product_id: row.product_id,
        qty,
        price,
        subtotal,
        warehouse_id: row.warehouse_id,
        shipping_per_unit: row.shipping_per_unit,
        total_shipping: row.total_shipping,
      };
    })
    .filter(
      (l) =>
        l.product_id &&
        mongoose.Types.ObjectId.isValid(String(l.product_id).trim()) &&
        Number.isFinite(l.qty) &&
        Number.isFinite(l.price) &&
        Number.isFinite(l.subtotal),
    );
}

function stripLineItemKeysFromBody(body) {
  const out = {};
  for (const k of Object.keys(body || {})) {
    if (
      /^(product_id|qty|price|total|warehouse_id|shipping_per_unit|total_shipping)\[\d+\]$/.test(
        k,
      )
    )
      continue;
    if (
      [
        "product_id[]",
        "qty[]",
        "price[]",
        "total[]",
        "warehouse_id[]",
        "shipping_per_unit[]",
        "total_shipping[]",
      ].includes(k)
    )
      continue;
    out[k] = body[k];
  }
  if (indexedContainerLength(out.product_id) > 0) {
    delete out.product_id;
    delete out.qty;
    delete out.price;
    delete out.total;
    delete out.warehouse_id;
    delete out.shipping_per_unit;
    delete out.total_shipping;
  }
  return out;
}

/** Defaults for minimal POS-style payloads (name/email/phone are required somewhere upstream). */
function ensurePurchaseOrderHeaderFields(body, user) {
  const b = body || {};
  if (!String(b.name ?? "").trim()) {
    b.name = "Purchase order";
  }
  if (!String(b.email ?? "").trim()) {
    b.email = user?.email || "pending@example.com";
  }
  if (!String(b.phone ?? "").trim()) {
    b.phone = String(user?.phone ?? "").trim() || "-";
  }
}

/**
 * Fills `payment_method_accounts_id` from `company.default_cash_account` when absent/invalid,
 * so the “Mode of Payment” transaction (bulk index 3) always has an `account_id` when possible.
 */
function resolvePoPaymentMethodAccount(body, user) {
  const b = body || {};
  if (!user?.company_id) return;
  const company = user.company_id;
  const raw = b.payment_method_accounts_id;
  if (
    raw != null &&
    raw !== "" &&
    mongoose.Types.ObjectId.isValid(String(raw).trim())
  ) {
    return;
  }
  const def = company.default_cash_account;
  if (def != null && mongoose.Types.ObjectId.isValid(String(def))) {
    b.payment_method_accounts_id = def;
  }
}

function collectLineItems(body) {
  let lines = parseBracketLineItems(body);
  if (lines.length === 0) lines = parseLineItemsFromIndexedContainers(body);
  if (lines.length === 0) lines = parseLegacyArrayLineItems(body);
  if (lines.length === 0) lines = parseProductIdsBodyArray(body);
  return lines;
}

function buildPurchaseOrderItemDocuments(poId, poSnapshot, lines, req) {
  const companyId = poSnapshot.company_id || req.user?.company_id;
  if (!companyId || !mongoose.Types.ObjectId.isValid(String(companyId))) {
    return {
      docs: [],
      error:
        "company_id is required on purchase order line items (set on the PO or authenticated user)",
    };
  }
  const userId = req.user?._id;
  const docs = [];
  for (const line of lines) {
    const doc = {
      purchase_order_id: poId,
      product_id: String(line.product_id).trim(),
      qty: line.qty,
      price: line.price,
      subtotal: line.subtotal,
      status: "active",
      deletedAt: null,
      company_id: companyId,
    };
    const wid =
      line.warehouse_id != null ? String(line.warehouse_id).trim() : "";
    if (wid && mongoose.Types.ObjectId.isValid(wid)) {
      doc.warehouse_id = wid;
    }
    if (userId) {
      doc.created_by = userId;
      doc.updated_by = userId;
    }
    const ship = normalizeLineShippingFields(line);
    doc.shipping_per_unit = ship.shipping_per_unit;
    doc.total_shipping = ship.total_shipping;
    docs.push(doc);
  }
  return { docs };
}

function shapePurchaseOrderWithItems(poPlain, items) {
  const purchase_order_items_total = items.reduce((sum, item) => {
    const sub = Number(item.subtotal);
    return sum + (Number.isFinite(sub) ? sub : 0);
  }, 0);
  return {
    ...poPlain,
    purchase_order_items: items,
    no_of_items: items.length,
    purchase_order_items_total,
  };
}

async function getPurchaseOrderByPurchaseItem(req, res) {
  const idParam =
    req.params && req.params.id != null ? String(req.params.id).trim() : "";

  if (idParam && !mongoose.Types.ObjectId.isValid(idParam)) {
    return res.status(400).json({
      success: false,
      status: 400,
      error: "Invalid id",
      details: "id must be a valid purchase_order ObjectId",
      type: "invalid_id",
    });
  }

  const filter = {
    status: "active",
    deletedAt: null,
    company_id: req.user.company_id,
  };
  if (idParam) {
    filter._id = idParam;
  }

  const response = await handleGenericGetAll(req, "purchase_order", {
    filter,
    excludeFields: [],
    sort: { createdAt: -1 },
    // ?populate=vendor_id:name → populated vendor with only `name` (+ _id). Comma-separate paths; use path:fields for projection.
    populate: buildPopulateFromQuery(req.query || {}, "purchase_order"),

    limit: req.query.limit ? parseInt(req.query.limit, 10) : null,
    skip: req.query.skip ? parseInt(req.query.skip, 10) : 0,
  });

  if (!response.success || !Array.isArray(response.data)) {
    return res.status(response.status).json(response);
  }

  if (idParam && response.data.length === 0) {
    return res.status(404).json({
      success: false,
      status: 404,
      error: "Record not found",
      details: `purchase_order with id "${idParam}" not found`,
      type: "not_found",
    });
  }

  const poIds = response.data.map((o) => o._id).filter(Boolean);
  if (poIds.length === 0) {
    return res.status(response.status).json(response);
  }

  const itemFilter = {
    purchase_order_id: { $in: poIds },
    status: "active",
    deletedAt: null,
  };
  const items = await PurchaseOrderItem.find(itemFilter)
    .populate("product_id")
    .sort({ createdAt: 1 })
    .lean();

  const itemsByPoId = new Map();
  for (const id of poIds) {
    itemsByPoId.set(String(id), []);
  }
  for (const item of items) {
    const key = String(item.purchase_order_id);
    if (!itemsByPoId.has(key)) {
      itemsByPoId.set(key, []);
    }
    itemsByPoId.get(key).push(item);
  }

  const data = response.data.map((po) => {
    const purchase_order_items = itemsByPoId.get(String(po._id)) || [];
    const purchase_order_items_total = purchase_order_items.reduce(
      (sum, row) => {
        const sub = Number(row.subtotal);
        return sum + (Number.isFinite(sub) ? sub : 0);
      },
      0,
    );
    return {
      ...po,
      purchase_order_items,
      no_of_items: purchase_order_items.length,
      purchase_order_items_total,
    };
  });

  return res.status(response.status).json({
    ...response,
    data,
  });
}

async function getPurchaseOrderByOrderNo(req, res) {
  const param = String(req.params.id || "").trim();
  if (!param) {
    return res.status(400).json({
      success: false,
      status: 400,
      error: "Record ID is required",
      details: "Please provide id in the URL parameters",
      type: "missing_id",
    });
  }

  const filter = { status: "active", deletedAt: null };
  const popFields = buildPopulateFromQuery(req.query || {}, "purchase_order");
  const findOnePo = (extraFilter) => {
    let q = PurchaseOrder.findOne({ ...extraFilter, ...filter });
    for (const spec of popFields) {
      if (typeof spec === "string") {
        q = q.populate(spec);
      } else if (spec && typeof spec === "object" && spec.path) {
        q = q.populate(spec);
      }
    }
    return q;
  };

  let po = await findOnePo({ purchase_order_no: param });
  if (!po && mongoose.Types.ObjectId.isValid(param)) {
    po = await findOnePo({ _id: param });
  }

  if (!po) {
    return res.status(404).json({
      success: false,
      status: 404,
      error: "Record not found",
      details: `purchase_order with purchase_order_no or id "${param}" not found`,
      type: "not_found",
    });
  }

  const items = await PurchaseOrderItem.find({
    purchase_order_id: po._id,
    status: "active",
    deletedAt: null,
  })
    .populate("product_id")
    .sort({ createdAt: 1 })
    .lean();

  const data = shapePurchaseOrderWithItems(
    po.toObject({ flattenMaps: true }),
    items,
  );

  return res.status(200).json({
    success: true,
    status: 200,
    data,
  });
}

/**
 * POST /api/purchase_order/purchase_order_create
 *
 * Flow: (1) normalize header on `req.body`, (2) create PO + five GL rows inside a Mongo session when
 * possible, (3) create line items, inventory movements, and warehouse qty, (4) sync header totals from lines,
 * (5) return 201 with items and derived totals. On standalone MongoDB, the same steps run without a session.
 */
async function purchaseOrderCreate(req, res) {
  const originalRequestBody = req.body;
  const lineItemsFromClient = collectLineItems(originalRequestBody);

  try {
    // `handleGenericCreate` reads `req.body`; strip embedded line payloads and coerce numeric header fields.
    req.body = normalizePurchaseOrderNumericFields(
      stripLineItemKeysFromBody(originalRequestBody),
    );
    delete req.body._id;
    // Unique per company (partial index). Model pre-save assigns next `PO-####` when absent.
    // Drop client `purchase_order_no` so double-submit / fixed defaults cannot collide.
    delete req.body.purchase_order_no;
    ensurePurchaseOrderHeaderFields(req.body, req.user);
    // Mode-of-payment GL row needs `payment_method_accounts_id`; same fallback pattern as order / POS flows.
    resolvePoPaymentMethodAccount(req.body, req.user);

    req.body.lines_subtotal =
      purchaseOrderLinesSubtotalSum(lineItemsFromClient);

    const transaction_number = generateTransactionNumber();
    req.body.transaction_number = transaction_number;

    let mongooseClientSession = null;
    let purchaseOrderCreateResult = null;
    const persistedLineItems = [];
    /** Set when `withTransaction` fails for a non–transaction-support reason, or when the non-session retry throws. */
    let createPipelineError = null;

    /** Pass-through for `handleGenericCreate` / inventory helpers: include `session` only when a transaction is active. */
    const modelHelperOptions = (mongoSession) =>
      mongoSession ? { session: mongoSession } : {};

    /**
     * Runs inside one logical unit: PO document, GL postings, each `purchase_order_item`, optional inbound inventory + warehouse qty,
     * then header aggregate fields. Mutates outer `purchaseOrderCreateResult` and `persistedLineItems`.
     *
     * @param {object | null} mongoSession Mongoose client session when in a transaction; null on standalone mongod.
     */
    const runPurchaseOrderCreateBody = async (mongoSession) => {
      purchaseOrderCreateResult = await handleGenericCreate(
        req,
        "purchase_order",
        {
          ...modelHelperOptions(mongoSession),
          afterCreate: async (record, orderReq, sess) => {
            const { created, failed } = await transactionBulkCreate(
              orderReq,
              [
                // [0]–[4] must stay aligned with PURCHASE_ORDER_GL_LINE_META for error messages.
                {
                  account_id: orderReq.user.company_id.default_purchase_account,
                  type: "debit",
                  amount: record?.lines_subtotal ?? 0,
                  reference_user_id: record?.vendor_id,
                  transaction_number,
                  description: "Purchase Order",
                  reference_id: {
                    module: "purchase_order",
                    ref_id: record._id,
                  },
                },

                {
                  account_id: orderReq.user.company_id.default_shipping_account,
                  type: "debit",
                  amount: record?.shipment ?? 0,
                  reference_user_id: record?.vendor_id,
                  transaction_number,
                  description: "Purchase Shipment",
                  reference_id: {
                    module: "purchase_order",
                    ref_id: record._id,
                  },
                },
                {
                  account_id:
                    orderReq.user.company_id.default_purchase_discount_account,
                  type: "credit",
                  amount: record?.discount ?? 0,
                  reference_user_id: record?.vendor_id,
                  transaction_number,
                  description: "Purchase Discount",
                },
                {
                  account_id: record?.payment_method_accounts_id,
                  type: "credit",
                  amount: record?.amount_paid ?? 0,
                  reference_user_id: record?.vendor_id,
                  transaction_number,
                  description: "Mode of Payment",
                  reference_id: {
                    module: "purchase_order",
                    ref_id: record._id,
                  },
                },
                {
                  account_id:
                    orderReq.user.company_id.default_account_payable_account,
                  type: "credit",
                  amount: req.body?.remaining_amount || 0,
                  reference_user_id: record?.vendor_id,
                  transaction_number,
                  description: "A/c Payable",
                  reference_id: {
                    module: "purchase_order",
                    ref_id: record._id,
                  },
                },
              ],
              { stopOnError: true, session: sess },
            );
            if (failed.length) {
              await throwPurchaseOrderGlBulkFailed(orderReq, failed);
            }
            if (created[0]?.data?._id) {
              console.log(
                "✅ Transaction(s) created:",
                created.map((c) => c.data._id),
              );
            }
          },
        },
      );

      if (
        !purchaseOrderCreateResult?.success ||
        !purchaseOrderCreateResult.data
      ) {
        throwWithGenericFailure(
          purchaseOrderCreateResult,
          "Purchase order create failed",
        );
      }

      const newPurchaseOrderId = purchaseOrderCreateResult.data._id;
      // `req.user.company_id` may be populated `{ _id, ... }` from auth — normalize for line items / inventory.
      const companyId =
        coalesceObjectId(purchaseOrderCreateResult.data.company_id) ||
        coalesceObjectId(req.user?.company_id);

      if (lineItemsFromClient.length === 0) {
        return;
      }

      if (!companyId || !mongoose.Types.ObjectId.isValid(String(companyId))) {
        throw new Error(
          "company_id is required to create purchase order line items",
        );
      }

      for (const line of lineItemsFromClient) {
        const shippingFields = normalizeLineShippingFields(line);
        const lineItemPayload = {
          purchase_order_id: newPurchaseOrderId,
          product_id: String(line.product_id).trim(),
          qty: line.qty,
          price: line.price,
          subtotal: line.subtotal,
          shipping_per_unit: shippingFields.shipping_per_unit,
          total_shipping: shippingFields.total_shipping,
          status: "active",
          company_id: companyId,
        };

        const warehouseIdStr =
          line.warehouse_id != null ? String(line.warehouse_id).trim() : "";
        if (warehouseIdStr && mongoose.Types.ObjectId.isValid(warehouseIdStr)) {
          lineItemPayload.warehouse_id = warehouseIdStr;
        }

        // `handleGenericCreate` only accepts line fields on `req.body`; stash header payload and restore after each line.
        const savedHeaderBody = req.body;
        req.body = lineItemPayload;
        const lineItemCreateResult = await handleGenericCreate(
          req,
          "purchase_order_item",
          modelHelperOptions(mongoSession),
        );
        req.body = savedHeaderBody;

        if (!lineItemCreateResult.success || !lineItemCreateResult.data) {
          throwWithGenericFailure(
            lineItemCreateResult,
            "Purchase order line item failed",
          );
        }

        if (warehouseIdStr && mongoose.Types.ObjectId.isValid(warehouseIdStr)) {
          const unitCost = Number(line.price);
          const lineQtyNum = Number(line.qty);
          if (
            !Number.isFinite(unitCost) ||
            unitCost < 0 ||
            !Number.isFinite(lineQtyNum) ||
            lineQtyNum <= 0
          ) {
            throw new Error(
              "Each PO line with a warehouse needs a finite unit price (price) and positive quantity for inventory movement",
            );
          }
          const totalCostMovement =
            Math.round(lineQtyNum * unitCost * 100) / 100;

          // `runInventoryMovementTxnBody` → `handleGenericCreate` uses the real Express `req`
          // (e.g. `req.get("Content-Type")`, `req.get("host")` for URLs). Use the live `req` and
          // restore `body` / `params.id` afterward; the helper temporarily overwrites `req.params.id`.
          const bodyBeforeInventoryMovement = req.body;
          const hadRouteParamId = Object.prototype.hasOwnProperty.call(
            req.params,
            "id",
          );
          const savedRouteParamId = hadRouteParamId ? req.params.id : undefined;

          req.body = {
            product_id: String(line.product_id).trim(),
            warehouse_id: warehouseIdStr,
            quantity: lineQtyNum,
            movement_type: "in",
            unit_cost: unitCost,
            total_cost: totalCostMovement,
            reference_type: "purchase_order",
            reference_id: newPurchaseOrderId,
            reference_name: "Purchase Order",
            company_id: companyId,
            status: "active",
          };

          try {
            await runInventoryMovementTxnBody(req, mongoSession);
          } catch (inventoryMovementErr) {
            if (inventoryMovementErr.clientPayload) {
              throwWithGenericFailure(
                inventoryMovementErr.clientPayload,
                "Inventory movement for purchase order failed",
              );
            }
            throw inventoryMovementErr;
          } finally {
            req.body = bodyBeforeInventoryMovement;
            if (hadRouteParamId) {
              req.params.id = savedRouteParamId;
            } else {
              delete req.params.id;
            }
          }

          await applyWarehouseInventoryDelta({
            productId: new mongoose.Types.ObjectId(
              String(line.product_id).trim(),
            ),
            warehouseId: new mongoose.Types.ObjectId(warehouseIdStr),
            quantityDelta: lineQtyNum,
            user: req.user,
            companyId,
            session: mongoSession,
          });
        }

        persistedLineItems.push(lineItemCreateResult.data);
      }

      await PurchaseOrder.syncHeaderTotalsFromLineItems(newPurchaseOrderId, {
        session: mongoSession,
      });
    };

    // Prefer a single multi-document transaction when the deployment supports it (replica set / Atlas).
    try {
      mongooseClientSession = await mongoose.startSession();
      await mongooseClientSession.withTransaction(async () => {
        await runPurchaseOrderCreateBody(mongooseClientSession);
      });
    } catch (mongoTransactionError) {
      // Standalone mongod cannot start transactions; same work without session (see utils/mongoTransactionSupport).
      if (isMongoTransactionUnsupportedError(mongoTransactionError)) {
        if (mongooseClientSession) {
          try {
            mongooseClientSession.endSession();
          } catch (_) {
            /* ignore */
          }
          mongooseClientSession = null;
        }
        console.warn(
          "[purchase_order] MongoDB transactions unavailable (e.g. standalone mongod); continuing without transaction",
        );
        try {
          persistedLineItems.length = 0;
          purchaseOrderCreateResult = null;
          await runPurchaseOrderCreateBody(null);
        } catch (nonSessionRetryError) {
          createPipelineError = nonSessionRetryError;
        }
      } else {
        createPipelineError = mongoTransactionError;
      }
    } finally {
      if (mongooseClientSession) {
        try {
          mongooseClientSession.endSession();
        } catch (_) {
          /* ignore */
        }
      }
    }

    req.body = originalRequestBody;

    // `afterCreate` failures with statusCode 400 are surfaced by `handleGenericCreate`; thrown errors from the pipeline land here.
    if (createPipelineError) {
      console.error("Purchase Order creation error:", createPipelineError);
      await logRollbackFailure(req, createPipelineError, {
        action: "PURCHASE ORDER CREATE ROLLBACK",
        tags: ["api", "purchase_order", "rollback", "create"],
        fallbackUrl: "/api/purchase_order/purchase_order_create",
      });
      if (createPipelineError.clientErrorPayload) {
        return res
          .status(createPipelineError.clientErrorPayload.status)
          .json(createPipelineError.clientErrorPayload);
      }
      const errorMessage = String(createPipelineError.message || "");
      const isGeneralLedgerRelatedError =
        errorMessage.includes("Post-purchase_order") ||
        errorMessage.includes("company_id is required");
      return res.status(isGeneralLedgerRelatedError ? 400 : 500).json({
        success: false,
        status: isGeneralLedgerRelatedError ? 400 : 500,
        error:
          isGeneralLedgerRelatedError ?
            "Purchase order creation rolled back"
          : "Failed to create purchase order",
        details: createPipelineError.message,
      });
    }

    if (
      !purchaseOrderCreateResult?.success ||
      !purchaseOrderCreateResult.data
    ) {
      return res
        .status(purchaseOrderCreateResult?.status || 400)
        .json(purchaseOrderCreateResult);
    }

    const createdPurchaseOrderId = purchaseOrderCreateResult.data._id;

    if (lineItemsFromClient.length === 0) {
      return res.status(201).json({
        ...purchaseOrderCreateResult,
        status: 201,
        items: [],
        // Legacy response key; wholesale is no longer derived from PO lines in this handler.
        wholesale_updates: [],
      });
    }

    const items_total = persistedLineItems.reduce(
      (sumSubtotals, lineItemDoc) =>
        sumSubtotals + (Number(lineItemDoc.subtotal) || 0),
      0,
    );

    const headerReloadedFromDb = await PurchaseOrder.findById(
      createdPurchaseOrderId,
    ).lean();

    return res.status(201).json({
      ...purchaseOrderCreateResult,
      status: 201,
      data: {
        ...purchaseOrderCreateResult.data,
        ...headerReloadedFromDb,
      },
      items: persistedLineItems,
      items_total,
      // Legacy response key; kept empty for clients that still read the field.
      wholesale_updates: [],
    });
  } catch (unexpectedError) {
    console.error("Purchase Order creation error:", unexpectedError);
    await logRollbackFailure(req, unexpectedError, {
      action: "PURCHASE ORDER CREATE ROLLBACK",
      tags: ["api", "purchase_order", "rollback", "create", "outer"],
      fallbackUrl: "/api/purchase_order/purchase_order_create",
    });
    return res.status(500).json({
      success: false,
      message: "Failed to create purchase order",
      error: unexpectedError.message,
    });
  }
}

/** PUT/update purchase_order: replace GL rows for `transaction_number` after header save. */
async function purchase_order_update(req, res) {
  // console.log(req.body);
  // return;

  const lines = collectLineItems(req.body);
  const originalBody = req.body;
  req.body = normalizePurchaseOrderNumericFields(
    stripLineItemKeysFromBody(originalBody),
  );
  delete req.body._id;
  // So the “Mode of Payment” GL line gets account_id when the client omits it on update payload.
  resolvePoPaymentMethodAccount(req.body, req.user);

  const recordId = String(req.params?.id || "").trim();
  if (lines.length > 0) {
    req.body.lines_subtotal = purchaseOrderLinesSubtotalSum(lines);
  } else if (recordId && mongoose.Types.ObjectId.isValid(recordId)) {
    const existingItems = await PurchaseOrderItem.find({
      purchase_order_id: recordId,
      status: "active",
      deletedAt: null,
    })
      .select("subtotal")
      .lean();
    req.body.lines_subtotal = purchaseOrderLinesSubtotalSum(existingItems);
  }

  let clientSession = null;
  let response = null;
  let txnError = null;

  const sessionOpts = (sess) => (sess ? { session: sess } : {});

  const runPurchaseOrderUpdateBody = async (mongoSession) => {
    response = await handleGenericUpdate(req, "purchase_order", {
      ...(mongoSession ? { session: mongoSession } : {}),
      afterUpdate: async (record, orderReq, _existing, sess) => {
        const transaction_number = record?.transaction_number;
        if (transaction_number) {
          const softDeleteTransc = await Transaction.updateMany(
            {
              transaction_number,
              status: "active",
              $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
            },
            {
              $set: {
                deletedAt: new Date(),
                status: "inactive",
                ...((
                  orderReq.user?._id &&
                  mongoose.Types.ObjectId.isValid(String(orderReq.user._id))
                ) ?
                  { updated_by: orderReq.user._id }
                : {}),
              },
            },
            sessionOpts(sess),
          );
          if (softDeleteTransc.modifiedCount > 0) {
            console.log(
              "✅ Transaction rows soft-deleted:",
              softDeleteTransc.modifiedCount,
            );
          }
        }

        const invMovementSoftDelete = await InventoryMovements.updateMany(
          {
            reference_type: "purchase_order",
            reference_id: record._id,
            status: "active",
            $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
          },
          {
            $set: {
              deletedAt: new Date(),
              status: "inactive",
              ...((
                orderReq.user?._id &&
                mongoose.Types.ObjectId.isValid(String(orderReq.user._id))
              ) ?
                { updated_by: orderReq.user._id }
              : {}),
            },
          },
          sessionOpts(sess),
        );
        if (invMovementSoftDelete.modifiedCount > 0) {
          console.log(
            "✅ Inventory movement rows soft-deleted:",
            invMovementSoftDelete.modifiedCount,
          );
        }

        const { created, failed } = await transactionBulkCreate(
          orderReq,
          [
            // Same five rows / index order as create — keep in sync with PURCHASE_ORDER_GL_LINE_META.
            {
              account_id: orderReq.user.company_id.default_purchase_account,
              type: "debit",
              amount: record?.lines_subtotal ?? 0,
              reference_user_id: record?.vendor_id,
              transaction_number,
              description: "Purchase Order",
              reference_id: {
                module: "purchase_order",
                ref_id: record._id,
              },
            },
            {
              account_id: orderReq.user.company_id.default_shipping_account,
              type: "debit",
              amount: record?.shipment ?? 0,
              reference_user_id: record?.vendor_id,
              transaction_number,
              description: "Purchase Shipment",
              reference_id: {
                module: "purchase_order",
                ref_id: record._id,
              },
            },
            {
              account_id:
                orderReq.user.company_id.default_purchase_discount_account,
              type: "credit",
              amount: record?.discount ?? 0,
              reference_user_id: record?.vendor_id,
              transaction_number,
              description: "Purchase Discount",
            },
            {
              account_id: record?.payment_method_accounts_id,
              type: "credit",
              amount: record?.amount_paid ?? 0,
              reference_user_id: record?.vendor_id,
              transaction_number,
              description: "Mode of Payment",
              reference_id: {
                module: "purchase_order",
                ref_id: record._id,
              },
            },
            {
              account_id:
                orderReq.user.company_id.default_account_payable_account,
              type: "credit",
              amount: req.body?.remaining_amount || 0,
              reference_user_id: record?.vendor_id,
              transaction_number,
              description: "A/c Payable",
              reference_id: {
                module: "purchase_order",
                ref_id: record._id,
              },
            },
          ],
          { stopOnError: true, session: sess },
        );
        if (failed.length) {
          await throwPurchaseOrderGlBulkFailed(orderReq, failed);
        }
        if (created[0]?.data?._id) {
          console.log(
            "✅ Transaction(s) created:",
            created.map((c) => c.data._id),
          );
        }
      },
      filter: { status: "active", deletedAt: null },
    });

    if (!response?.success || !response?.data) {
      throwWithGenericFailure(response, "Purchase order update failed");
    }

    const poId = response.data._id;

    if (lines.length > 0) {
      const built = buildPurchaseOrderItemDocuments(
        poId,
        response.data,
        lines,
        req,
      );
      if (built.error) {
        throw new Error(built.error);
      }
      await PurchaseOrderItem.deleteMany(
        { purchase_order_id: poId },
        sessionOpts(mongoSession),
      );
      await PurchaseOrderItem.insertMany(built.docs, sessionOpts(mongoSession));

      // Same as create: ledger row + warehouse qty for each line with `warehouse_id` (uses live `req` for modelHelper).
      const companyIdForMovement =
        coalesceObjectId(response.data.company_id) ||
        coalesceObjectId(req.user?.company_id);

      for (const line of lines) {
        const warehouseIdStr =
          line.warehouse_id != null ? String(line.warehouse_id).trim() : "";
        if (
          !warehouseIdStr ||
          !mongoose.Types.ObjectId.isValid(warehouseIdStr)
        ) {
          continue;
        }
        const unitCost = Number(line.price);
        const lineQtyNum = Number(line.qty);
        if (
          !Number.isFinite(unitCost) ||
          unitCost < 0 ||
          !Number.isFinite(lineQtyNum) ||
          lineQtyNum <= 0
        ) {
          throw new Error(
            "Each PO line with a warehouse needs a finite unit price (price) and positive quantity for inventory movement",
          );
        }
        const totalCostMovement = Math.round(lineQtyNum * unitCost * 100) / 100;

        const bodyBeforeInventoryMovement = req.body;
        const hadRouteParamId = Object.prototype.hasOwnProperty.call(
          req.params,
          "id",
        );
        const savedRouteParamId = hadRouteParamId ? req.params.id : undefined;

        req.body = {
          product_id: String(line.product_id).trim(),
          warehouse_id: warehouseIdStr,
          quantity: lineQtyNum,
          movement_type: "in",
          unit_cost: unitCost,
          total_cost: totalCostMovement,
          reference_type: "purchase_order",
          reference_id: poId,
          reference_name: "Purchase Order",
          company_id: companyIdForMovement,
          status: "active",
        };

        try {
          await runInventoryMovementTxnBody(req, mongoSession);
        } catch (inventoryMovementErr) {
          if (inventoryMovementErr.clientPayload) {
            throwWithGenericFailure(
              inventoryMovementErr.clientPayload,
              "Inventory movement for purchase order update failed",
            );
          }
          throw inventoryMovementErr;
        } finally {
          req.body = bodyBeforeInventoryMovement;
          if (hadRouteParamId) {
            req.params.id = savedRouteParamId;
          } else {
            delete req.params.id;
          }
        }

        await applyWarehouseInventoryDelta({
          productId: new mongoose.Types.ObjectId(
            String(line.product_id).trim(),
          ),
          warehouseId: new mongoose.Types.ObjectId(warehouseIdStr),
          quantityDelta: lineQtyNum,
          user: req.user,
          companyId: companyIdForMovement,
          session: mongoSession,
        });
      }

      await PurchaseOrder.syncHeaderTotalsFromLineItems(poId, {
        session: mongoSession || undefined,
      });
    } else {
      await PurchaseOrder.syncHeaderTotalsFromLineItems(poId, {
        session: mongoSession || undefined,
      });
    }
  };

  try {
    clientSession = await mongoose.startSession();
    await clientSession.withTransaction(async () => {
      await runPurchaseOrderUpdateBody(clientSession);
    });
  } catch (e) {
    if (isMongoTransactionUnsupportedError(e)) {
      if (clientSession) {
        try {
          clientSession.endSession();
        } catch (_) {
          /* ignore */
        }
        clientSession = null;
      }
      console.warn(
        "[purchase_order] MongoDB transactions unavailable (e.g. standalone mongod); continuing without transaction",
      );
      try {
        response = null;
        await runPurchaseOrderUpdateBody(null);
      } catch (e2) {
        txnError = e2;
      }
    } else {
      txnError = e;
    }
  } finally {
    if (clientSession) {
      try {
        clientSession.endSession();
      } catch (_) {
        /* ignore */
      }
    }
  }

  req.body = originalBody;

  if (txnError) {
    await logRollbackFailure(req, txnError, {
      action: "PURCHASE ORDER UPDATE ROLLBACK",
      tags: ["api", "purchase_order", "rollback", "update"],
      fallbackUrl: "/api/purchase_order/update",
    });
    if (txnError.clientErrorPayload) {
      const p = txnError.clientErrorPayload;
      return res.status(p.status || 400).json({
        success: false,
        message: "Purchase order update rolled back",
        ...p,
      });
    }
    const msg = String(txnError.message || "");
    const is400 =
      msg.includes("Post-purchase_order") ||
      msg.includes("company_id is required") ||
      msg.includes("Validation failed") ||
      msg.includes("Missing required fields");
    return res.status(is400 ? 400 : 500).json({
      success: false,
      status: is400 ? 400 : 500,
      error: "Purchase order update rolled back",
      details: txnError.message,
    });
  }

  if (!response || !response.success || !response.data) {
    return res
      .status(response && response.status ? response.status : 400)
      .json(response);
  }

  const poId = response.data._id;

  const items = await PurchaseOrderItem.find({
    purchase_order_id: poId,
    status: "active",
    deletedAt: null,
  })
    .populate("product_id")
    .sort({ createdAt: 1 })
    .lean();

  const poFresh = await PurchaseOrder.findById(poId).lean();
  const data = shapePurchaseOrderWithItems(poFresh || response.data, items);

  return res.status(200).json({
    success: true,
    status: 200,
    data,
    wholesale_updates: [],
  });
}

module.exports = {
  purchaseOrderCreate,
  purchase_order_update,
  getPurchaseOrderByPurchaseItem,
  getPurchaseOrderByOrderNo,
  // purchase_orderUpdate,
  // purchase_orderById,
  // getAllpurchase_order,
  // getallpurchase_orderactive,
  // purchase_orderdelete,
  // findActiveBlogByTitle,
  // findBlogByParams,
};
