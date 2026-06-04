const mongoose = require("mongoose");
const PurchaseOrder = require("../models/purchase_order");
const PurchaseOrderItem = require("../models/purchase_order_item");
const WarehouseInventory = require("../models/warehouse_inventory");
const Product = require("../models/product");

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
const { insertInventoryMovementRecord } = require("./inventory_movements");
const {
  isMongoTransactionUnsupportedError,
} = require("../utils/mongoTransactionSupport");
const { createApplicationLog } = require("../utils/applicationLogs");

/**
 * Purchase order HTTP handlers: header + line items, inventory movement ledger (`inventory_movements` only),
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

/** Per-step wall-clock timings for `purchaseOrderCreate` (see JSDoc steps 1–20). */
function startPoCreateStepTimer() {
  const pipelineStartMs = Date.now();
  const steps = [];

  return {
    /**
     * @param {number|string} step Step id from ops table (e.g. 1, "3-4", "6-11")
     * @param {string} label Short description
     * @param {object} [extra] e.g. `{ line_index: 0 }`
     * @returns {() => void} Call when the step finishes
     */
    start(step, label, extra = {}) {
      const t0 = Date.now();
      return (endExtra = {}) => {
        steps.push({
          step,
          label,
          duration_ms: Date.now() - t0,
          ...extra,
          ...endExtra,
        });
      };
    },
    resetSteps() {
      steps.length = 0;
    },
    report() {
      return {
        steps: [...steps],
        total_ms: Date.now() - pipelineStartMs,
      };
    },
    log(logTag = "[purchase_order_create]") {
      const report = this.report();
      const lines = report.steps.map((s) => {
        const bits = [`step ${s.step} ${s.label}: ${s.duration_ms}ms`];
        if (s.line_index != null) bits.push(`line=${s.line_index}`);
        if (s.product_id != null) bits.push(`product=${s.product_id}`);
        return `  ${bits.join(" ")}`;
      });
      console.log(
        `${logTag} step timings — total ${report.total_ms}ms` +
          (lines.length ? `\n${lines.join("\n")}` : " (no steps recorded)"),
      );
      return report;
    },
  };
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

/** Unique product ObjectId strings from PO line rows or `built.docs`. */
function collectUniqueProductIdsFromLineRows(rows) {
  const seen = new Set();
  const ids = [];
  for (const row of rows || []) {
    const id = coalesceObjectId(row?.product_id);
    const str = id != null ? String(id) : "";
    if (str && mongoose.Types.ObjectId.isValid(str) && !seen.has(str)) {
      seen.add(str);
      ids.push(str);
    }
  }
  return ids;
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

function sessionOpts(sess) {
  return sess ? { session: sess } : {};
}

/** Soft-delete active GL rows for one `transaction_number` (PO update / replace). */
async function softDeleteActiveGlByTransactionNumber({
  transactionNumber,
  mongoSession = null,
  userId = null,
}) {
  const txnNo = String(transactionNumber ?? "").trim();
  if (!txnNo) {
    return { modifiedCount: 0, matchedCount: 0 };
  }

  const $set = {
    deletedAt: new Date(),
    status: "inactive",
  };
  const userIdStr = String(userId ?? "").trim();
  if (userId != null && mongoose.Types.ObjectId.isValid(userIdStr)) {
    $set.updated_by =
      userId instanceof mongoose.Types.ObjectId ?
        userId
      : new mongoose.Types.ObjectId(userIdStr);
  }

  return Transaction.updateMany(
    {
      transaction_number: txnNo,
      status: "active",
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    },
    { $set },
    sessionOpts(mongoSession),
  );
}

/** Five GL postings for a PO — same row order as `PURCHASE_ORDER_GL_LINE_META` / create. */
async function rebuildPurchaseOrderGlTransactions(
  record,
  orderReq,
  remainingAmount,
  mongoSession,
) {
  const transaction_number = record?.transaction_number;
  const { created, failed } = await transactionBulkCreate(
    orderReq,
    [
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
        account_id: orderReq.user.company_id.default_purchase_discount_account,
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
        account_id: orderReq.user.company_id.default_account_payable_account,
        type: "credit",
        amount: remainingAmount || 0,
        reference_user_id: record?.vendor_id,
        transaction_number,
        description: "A/c Payable",
        reference_id: {
          module: "purchase_order",
          ref_id: record._id,
        },
      },
    ],
    { stopOnError: true, session: mongoSession },
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
  return { created, failed };
}

/**
 * Line replace teardown: GL soft-delete (step 2), movement soft-delete (step 3), line `deleteMany` (step 6).
 * Call after snapshotting existing `purchase_order_item` rows.
 */
async function teardownPurchaseOrderForLineReplace({
  purchaseOrderId,
  transactionNumber,
  companyId,
  mongoSession = null,
  userId = null,
}) {
  const poIdStr = String(purchaseOrderId ?? "").trim();
  if (!mongoose.Types.ObjectId.isValid(poIdStr)) {
    throw new Error("Valid purchase_order id is required for line replace teardown");
  }

  const transactions = await softDeleteActiveGlByTransactionNumber({
    transactionNumber,
    mongoSession,
    userId,
  });
  if (transactions.modifiedCount > 0) {
    console.log(
      "✅ Transaction rows soft-deleted:",
      transactions.modifiedCount,
    );
  }

  const inventoryMovements =
    await InventoryMovements.softDeleteActiveByReference({
      referenceType: "purchase_order",
      referenceId: purchaseOrderId,
      companyId,
      session: mongoSession,
      userId,
    });
  if (inventoryMovements.modifiedCount > 0) {
    console.log(
      "✅ Inventory movement rows soft-deleted:",
      inventoryMovements.modifiedCount,
    );
  }

  const lineItems = await PurchaseOrderItem.deleteMany(
    { purchase_order_id: purchaseOrderId },
    sessionOpts(mongoSession),
  );
  if (lineItems.deletedCount > 0) {
    console.log(
      "✅ Purchase order line items removed:",
      lineItems.deletedCount,
    );
  }

  return { transactions, inventoryMovements, lineItems };
}

function roundPoMoney(n) {
  return Math.round(Number(n) * 100) / 100;
}

/** Per product: inbound qty and extended cost (qty × line `price`) for lines with a valid `warehouse_id`. */
function summarizePoWarehouseInboundByProduct(lines) {
  const map = new Map();
  for (const line of lines || []) {
    const productIdStr = String(line.product_id ?? "").trim();
    const warehouseIdStr =
      line.warehouse_id != null ? String(line.warehouse_id).trim() : "";
    if (!productIdStr || !mongoose.Types.ObjectId.isValid(productIdStr)) {
      continue;
    }
    if (!warehouseIdStr || !mongoose.Types.ObjectId.isValid(warehouseIdStr)) {
      continue;
    }
    const qty = Number(line.qty);
    const unitCost = Number(line.price);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    if (!Number.isFinite(unitCost) || unitCost < 0) continue;

    const entry = map.get(productIdStr) || { qty: 0, extendedCost: 0 };
    entry.qty = roundPoMoney(entry.qty + qty);
    entry.extendedCost = roundPoMoney(entry.extendedCost + qty * unitCost);
    map.set(productIdStr, entry);
  }
  return map;
}

/** Application log when `product.wholesale_price` changes on a PO flow. */
async function logProductWholesalePriceChange(
  req,
  {
    productIdStr,
    productName,
    wholesaleBefore,
    averageCost,
    companyId,
    mongoSession = null,
    fallbackUrl = "/api/purchase_order/purchase_order_create",
  },
) {
  const namePart =
    productName && String(productName).trim() ?
      ` "${String(productName).trim()}"`
    : "";
  const description =
    `Wholesale price of product${namePart} (id ${productIdStr}) has been updated ` +
    `from ${wholesaleBefore} to ${averageCost}.`;
  await createApplicationLog(
    req,
    {
      action: "Product wholesale_price updated",
      url: req?.originalUrl || req?.path || fallbackUrl,
      tags: ["wholesale_price", "product", "purchase_order"],
      description,
      company_id: companyId,
    },
    { session: mongoSession, silent: true },
  );
}

/** Sum `warehouse_inventory.quantity` for one product (all warehouses, tenant-scoped). */
async function sumWarehouseInventoryQtyForProduct(
  productId,
  companyId,
  mongoSession = null,
) {
  const pid = coalesceObjectId(productId);
  const cid = coalesceObjectId(companyId);
  if (!pid || !cid) return 0;

  let agg = WarehouseInventory.aggregate([
    {
      $match: {
        product_id: pid,
        company_id: cid,
        status: "active",
        $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
      },
    },
    { $group: { _id: null, total: { $sum: "$quantity" } } },
  ]);
  if (mongoSession) agg = agg.session(mongoSession);
  const rows = await agg;
  return Math.max(0, roundPoMoney(rows[0]?.total || 0));
}

/**
 * Weighted-average `product.wholesale_price` from warehouse on-hand + PO inbound cost.
 *
 * previous_total = warehouse_qty × current wholesale_price
 * new_total = inbound qty × line unit cost (`price`)
 * average_cost = (previous_total + new_total) / (warehouse_qty + inbound qty)
 *
 * @param {object} options
 * @param {object[]} options.lines PO line payloads
 * @param {*} options.companyId
 * @param {object} req Express request (for application log URL / user)
 * @param {object|null} [options.mongoSession]
 */
async function applyWholesalePriceRemoveForPoLines({
  lines,
  companyId,
  req,
  mongoSession = null,
}) {
  const removedByProduct = summarizePoWarehouseInboundByProduct(lines);
  const wholesaleUpdates = [];

  for (const [productIdStr, removed] of removedByProduct) {
    const removedQty = removed.qty;
    const removedCost = removed.extendedCost;
    if (removedQty <= 0) continue;

    const warehouseQty = await sumWarehouseInventoryQtyForProduct(
      productIdStr,
      companyId,
      mongoSession,
    );
    const warehouseQtyBeforeRemove = roundPoMoney(warehouseQty + removedQty);

    const pid = coalesceObjectId(productIdStr);
    const cid = coalesceObjectId(companyId);
    let productQuery = Product.findOne({
      _id: pid,
      company_id: cid,
      status: "active",
      deletedAt: null,
    }).select("product_name wholesale_price");
    if (mongoSession) productQuery = productQuery.session(mongoSession);
    const productDoc = await productQuery.lean();
    if (!productDoc) {
      throw new Error(
        `Product not found for wholesale price reverse (id ${productIdStr})`,
      );
    }

    const wholesaleBefore =
      Number.isFinite(Number(productDoc.wholesale_price)) ?
        Number(productDoc.wholesale_price)
      : 0;
    const grandTotalBefore = roundPoMoney(
      warehouseQtyBeforeRemove * wholesaleBefore,
    );
    const grandTotalAfter = roundPoMoney(grandTotalBefore - removedCost);
    const averageCost =
      warehouseQty > 0 ?
        roundPoMoney(Math.max(0, grandTotalAfter) / warehouseQty)
      : 0;

    if (roundPoMoney(wholesaleBefore) === roundPoMoney(averageCost)) {
      continue;
    }

    const updateOpts = mongoSession ? { session: mongoSession } : {};
    const updated = await Product.findOneAndUpdate(
      { _id: pid, company_id: cid, status: "active", deletedAt: null },
      { $set: { wholesale_price: averageCost } },
      { new: true, ...updateOpts },
    ).lean();

    if (!updated) {
      throw new Error(
        `Failed to reverse wholesale_price for product (id ${productIdStr})`,
      );
    }

    wholesaleUpdates.push({
      product_id: productIdStr,
      product_name: productDoc.product_name,
      warehouse_qty_after_reverse: warehouseQty,
      removed_qty: removedQty,
      removed_cost: removedCost,
      wholesale_price_before: wholesaleBefore,
      grand_total_before: grandTotalBefore,
      grand_total_after: grandTotalAfter,
      wholesale_price: averageCost,
      direction: "remove",
    });

    await logProductWholesalePriceChange(req, {
      productIdStr,
      productName: productDoc.product_name,
      wholesaleBefore,
      averageCost,
      companyId: cid,
      mongoSession,
      fallbackUrl: "/api/purchase_order/update",
    });
  }

  return wholesaleUpdates;
}

async function applyWholesalePriceWeightedAverageForPoLines({
  lines,
  companyId,
  req,
  mongoSession = null,
}) {
  const inboundByProduct = summarizePoWarehouseInboundByProduct(lines);
  const wholesaleUpdates = [];

  for (const [productIdStr, inbound] of inboundByProduct) {
    const currentQty = inbound.qty;
    const newTotal = inbound.extendedCost;
    if (currentQty <= 0) continue;

    const warehouseQty = await sumWarehouseInventoryQtyForProduct(
      productIdStr,
      companyId,
      mongoSession,
    );

    const pid = coalesceObjectId(productIdStr);
    const cid = coalesceObjectId(companyId);
    let productQuery = Product.findOne({
      _id: pid,
      company_id: cid,
      status: "active",
      deletedAt: null,
    }).select("product_name wholesale_price");
    if (mongoSession) productQuery = productQuery.session(mongoSession);
    const productDoc = await productQuery.lean();
    if (!productDoc) {
      throw new Error(
        `Product not found for wholesale price update (id ${productIdStr})`,
      );
    }

    const wholesaleBefore =
      Number.isFinite(Number(productDoc.wholesale_price)) ?
        Number(productDoc.wholesale_price)
      : 0;
    const previousTotal = roundPoMoney(warehouseQty * wholesaleBefore);
    const totalQty = roundPoMoney(warehouseQty + currentQty);
    const grandTotal = roundPoMoney(previousTotal + newTotal);
    const averageCost =
      totalQty > 0 ?
        roundPoMoney(grandTotal / totalQty)
      : roundPoMoney(newTotal / currentQty);

    const updateOpts = mongoSession ? { session: mongoSession } : {};
    const updated = await Product.findOneAndUpdate(
      { _id: pid, company_id: cid, status: "active", deletedAt: null },
      { $set: { wholesale_price: averageCost } },
      { new: true, ...updateOpts },
    ).lean();

    if (!updated) {
      throw new Error(
        `Failed to update wholesale_price for product (id ${productIdStr})`,
      );
    }

    wholesaleUpdates.push({
      product_id: productIdStr,
      product_name: productDoc.product_name,
      warehouse_qty_before: warehouseQty,
      inbound_qty: currentQty,
      total_qty: totalQty,
      wholesale_price_before: wholesaleBefore,
      previous_total: previousTotal,
      new_total: newTotal,
      grand_total: grandTotal,
      wholesale_price: averageCost,
      direction: "inbound",
    });

    if (roundPoMoney(wholesaleBefore) !== roundPoMoney(averageCost)) {
      await logProductWholesalePriceChange(req, {
        productIdStr,
        productName: productDoc.product_name,
        wholesaleBefore,
        averageCost,
        companyId: cid,
        mongoSession,
      });
    }
  }

  return wholesaleUpdates;
}

/**
 * Apply warehouse on-hand after PO line items and `inventory_movements` inserts (create step 3–4; update line replace).
 * Only updates `warehouse_inventory` (lines with valid `warehouse_id`). Does not change `product.stock`.
 *
 * @param {object[]} lines `poLinePayloads` — parsed client lines (same order as `savedPurchaseOrderItems`).
 * @param {object[]} insertedLineDocs `savedPurchaseOrderItems` — rows from `insertMany`.
 * @param {object[]} [reverseLines] `previousPoLinesBeforeReplace` — snapshot before line replace (update only).
 * @returns {{ productStockUpdates: object[] }} Audit entries for API `product_stock_updates` (warehouse rows only).
 */
async function applyWarehouseInventoryForPoLines({
  lines: poLinePayloads,
  insertedLineDocs: savedPurchaseOrderItems,
  companyId: tenantCompanyId,
  mongoSession,
  req,
  reverseLines: previousPoLinesBeforeReplace = [],
}) {
  const stockChangeAuditLog =
    await WarehouseInventory.applyStockChangesFromLines({
      inboundLines: poLinePayloads,
      savedLineItemRows: savedPurchaseOrderItems,
      reverseLines: previousPoLinesBeforeReplace,
      companyId: tenantCompanyId,
      session: mongoSession,
      userId: req.user?._id,
    });

  return { productStockUpdates: stockChangeAuditLog };
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
 * Flow: (1) normalize header on `req.body` (including `lines_subtotal` / `total_amount` from parsed lines),
 * (2) create PO + five GL rows inside a Mongo session when possible, (3) line items, movements, warehouse stock,
 * (4) return 201 with items. On standalone MongoDB, the same steps run without a session.
 *
 * Collections (Mongo) — op = insert | update | delete | read; scope = one | many
 * Cost (relative): **low** = single cheap round-trip; **medium** = few docs or scales with L/N/P modestly;
 * **high** = hot path that grows with line count or scans/aggregates a large ledger.
 *
 * | Step | Collection              | Op                 | One or many  | Cost   | Notes |
 * |------|-------------------------|--------------------|--------------|--------|-------|
 * |    1 | purchase_order          | insert             | one          | low    | `handleGenericCreate` (header; model may assign `purchase_order_no`) |
 * |    2 | transaction             | insert             | many (5)     | medium | `transactionBulkCreate` in `afterCreate` — purchase, shipment, discount, payment, A/P |
 * |    3 | warehouse_inventory     | read / upsert      | one × N      | medium | `applyWarehouseInventoryForPoLines` (warehouse lines only) |
 * |    5 | purchase_order_item     | insert             | many (1×)    | medium | `insertMany` via `buildPurchaseOrderItemDocuments` |
 * |    6 | inventory_movements     | insert             | one × N      | low    | `insertInventoryMovementRecord` — one row per warehouse line |
 * |  6b | product                 | read / update      | one × P      | medium | `applyWholesalePriceWeightedAverageForPoLines` — weighted `wholesale_price` |
 * |    7 | purchase_order          | read               | one          | low    | `findById` for response payload (totals from step 1 insert) |
 * |    8 | logs                    | insert             | one          | low    | `logRollbackFailure` — failure path only |
 *
 * Create skips `syncHeaderTotalsFromLineItems`: step 1 uses the same parsed lines as `insertMany`;
 * `purchase_order` `pre('validate')` sets `total_amount` on insert. Updates still sync after line replace.
 *
 * Header-only create (no lines): steps 1–2 only; skips 3–7. L = line count; N = lines with valid `warehouse_id`.
 */
async function purchaseOrderCreate(req, res) {
  const originalRequestBody = req.body;
  const lineItemsFromClient = collectLineItems(originalRequestBody);
  let poStepTimer = null;

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

    // Same line objects as insertMany — header totals on step 1 insert (no post-line sync on create).
    req.body.lines_subtotal =
      purchaseOrderLinesSubtotalSum(lineItemsFromClient);

    const transaction_number = generateTransactionNumber();
    req.body.transaction_number = transaction_number;

    let mongooseClientSession = null;
    let purchaseOrderCreateResult = null;
    const persistedLineItems = [];
    const productStockUpdates = [];
    const wholesaleUpdates = [];
    /** Set when `withTransaction` fails for a non–transaction-support reason, or when the non-session retry throws. */
    let createPipelineError = null;
    poStepTimer = startPoCreateStepTimer();

    /** Pass-through for `handleGenericCreate` / inventory helpers: include `session` only when a transaction is active. */
    const modelHelperOptions = (mongoSession) =>
      mongoSession ? { session: mongoSession } : {};

    /**
     * Runs inside one logical unit: PO document, GL postings, each `purchase_order_item`, optional inbound inventory ledger,
     * then header aggregate fields. Mutates outer `purchaseOrderCreateResult` and `persistedLineItems`.
     *
     * @param {object | null} mongoSession Mongoose client session when in a transaction; null on standalone mongod.
     */
    const runPurchaseOrderCreateBody = async (mongoSession) => {
      // step 1 start — purchase_order insert
      let step1Closed = false;
      let endStep1 = () => {};
      endStep1 = poStepTimer.start(1, "purchase_order insert");
      const closeStep1 = () => {
        if (!step1Closed) {
          step1Closed = true;
          endStep1();
        }
      };
      purchaseOrderCreateResult = await handleGenericCreate(
        req,
        "purchase_order",
        {
          ...modelHelperOptions(mongoSession),
          afterCreate: async (record, orderReq, sess) => {
            closeStep1();
            // step 1 end
            // step 2 start — transaction insert ×5 (GL)
            const endStep2 = poStepTimer.start(2, "transaction insert ×5 (GL)");
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
            try {
              if (failed.length) {
                await throwPurchaseOrderGlBulkFailed(orderReq, failed);
              }
            } finally {
              endStep2();
            }
            // step 2 end
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
        closeStep1();
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

      // Header-only: steps 1–2 done; skip steps 3–7.
      if (lineItemsFromClient.length === 0) {
        return;
      }

      if (!companyId || !mongoose.Types.ObjectId.isValid(String(companyId))) {
        throw new Error(
          "company_id is required to create purchase order line items",
        );
      }

      for (
        let lineIndex = 0;
        lineIndex < lineItemsFromClient.length;
        lineIndex++
      ) {
        const line = lineItemsFromClient[lineIndex];
        const productIdStr = String(line.product_id).trim();
        const lineQtyNum = Number(line.qty);
        if (
          !productIdStr ||
          !mongoose.Types.ObjectId.isValid(productIdStr) ||
          !Number.isFinite(lineQtyNum) ||
          lineQtyNum <= 0
        ) {
          throw new Error(
            "Each purchase order line needs a valid product_id and positive qty",
          );
        }
      }

      // step 5 start — purchase_order_item insertMany
      const built = buildPurchaseOrderItemDocuments(
        newPurchaseOrderId,
        purchaseOrderCreateResult.data,
        lineItemsFromClient,
        req,
      );
      if (built.error) {
        throw new Error(built.error);
      }
      if (built.docs.length !== lineItemsFromClient.length) {
        throw new Error("Could not build purchase order line documents");
      }

      const endStep5 = poStepTimer.start(5, "purchase_order_item insertMany", {
        line_count: built.docs.length,
      });
      const insertedLineDocs = await PurchaseOrderItem.insertMany(
        built.docs,
        sessionOpts(mongoSession),
      );
      endStep5();
      persistedLineItems.push(...insertedLineDocs);
      // step 5 end

      // step 6 start — inventory_movements insert per line with warehouse_id
      for (
        let lineIndex = 0;
        lineIndex < lineItemsFromClient.length;
        lineIndex++
      ) {
        const line = lineItemsFromClient[lineIndex];
        const productIdStr = String(line.product_id).trim();
        const lineQtyNum = Number(line.qty);
        const warehouseIdStr =
          line.warehouse_id != null ? String(line.warehouse_id).trim() : "";

        if (warehouseIdStr && mongoose.Types.ObjectId.isValid(warehouseIdStr)) {
          const unitCost = Number(line.price);
          if (!Number.isFinite(unitCost) || unitCost < 0) {
            throw new Error(
              "Each PO line with a warehouse needs a finite unit price (price) and positive quantity for inventory movement",
            );
          }
          const totalCostMovement =
            Math.round(lineQtyNum * unitCost * 100) / 100;

          // `insertInventoryMovementRecord` → `handleGenericCreate`; uses the real Express `req`
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

          const endStep6 = poStepTimer.start(6, "inventory_movements insert", {
            line_index: lineIndex,
            warehouse_id: warehouseIdStr,
          });
          try {
            await insertInventoryMovementRecord(req, mongoSession);
          } catch (inventoryMovementErr) {
            if (inventoryMovementErr.clientPayload) {
              throwWithGenericFailure(
                inventoryMovementErr.clientPayload,
                "Inventory movement for purchase order failed",
              );
            }
            throw inventoryMovementErr;
          } finally {
            endStep6();
            req.body = bodyBeforeInventoryMovement;
            if (hadRouteParamId) {
              req.params.id = savedRouteParamId;
            } else {
              delete req.params.id;
            }
          }
        }
      }
      // step 6 end

      // Weighted-average wholesale_price (warehouse qty × current cost + inbound line cost)
      const wholesaleRows = await applyWholesalePriceWeightedAverageForPoLines({
        lines: lineItemsFromClient,
        companyId,
        req,
        mongoSession,
      });
      wholesaleUpdates.push(...wholesaleRows);

      // step 3–4 start — warehouse_inventory upsert
      const stockReconcile = await applyWarehouseInventoryForPoLines({
        lines: lineItemsFromClient,
        insertedLineDocs: persistedLineItems,
        companyId,
        mongoSession,
        req,
      });
      productStockUpdates.push(...stockReconcile.productStockUpdates);
      // step 3–4 end
    };

    // txn start — MongoDB transaction wrapper (or standalone retry)
    let endTxnWrap = () => {};
    endTxnWrap = poStepTimer.start("txn", "MongoDB transaction wrapper");
    let txnWrapEnded = false;
    const finishTxnWrap = (extra) => {
      if (!txnWrapEnded) {
        txnWrapEnded = true;
        endTxnWrap(extra);
      }
    };
    // Prefer a single multi-document transaction when the deployment supports it (replica set / Atlas).
    try {
      mongooseClientSession = await mongoose.startSession();
      await mongooseClientSession.withTransaction(async () => {
        await runPurchaseOrderCreateBody(mongooseClientSession);
      });
      finishTxnWrap({ mode: "mongodb_transaction" });
    } catch (mongoTransactionError) {
      // Standalone mongod cannot start transactions; same work without session (see utils/mongoTransactionSupport).
      if (isMongoTransactionUnsupportedError(mongoTransactionError)) {
        finishTxnWrap({ mode: "txn_unavailable_retry" });
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
          productStockUpdates.length = 0;
          wholesaleUpdates.length = 0;
          purchaseOrderCreateResult = null;
          poStepTimer.resetSteps();
          const endTxnRetry = poStepTimer.start(
            "txn",
            "pipeline retry (no Mongo transaction)",
          );
          await runPurchaseOrderCreateBody(null);
          endTxnRetry({ mode: "standalone_no_transaction" });
        } catch (nonSessionRetryError) {
          createPipelineError = nonSessionRetryError;
        }
      } else {
        finishTxnWrap({ mode: "mongodb_transaction_failed" });
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
    // txn end

    req.body = originalRequestBody;

    // `afterCreate` failures with statusCode 400 are surfaced by `handleGenericCreate`; thrown errors from the pipeline land here.
    if (createPipelineError) {
      // step 20 start — rollback log
      const stepTimingsOnError = poStepTimer.log(
        "[purchase_order_create] failed —",
      );
      console.error("Purchase Order creation error:", createPipelineError);
      // Step 20 — logs insert (failure path)
      await logRollbackFailure(req, createPipelineError, {
        action: "PURCHASE ORDER CREATE ROLLBACK",
        tags: ["api", "purchase_order", "rollback", "create"],
        fallbackUrl: "/api/purchase_order/purchase_order_create",
      });
      // step 20 end
      if (createPipelineError.clientErrorPayload) {
        return res.status(createPipelineError.clientErrorPayload.status).json({
          ...createPipelineError.clientErrorPayload,
          step_timings_ms: stepTimingsOnError,
        });
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
        step_timings_ms: stepTimingsOnError,
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
      const stepTimingsHeaderOnly = poStepTimer.log();
      return res.status(201).json({
        ...purchaseOrderCreateResult,
        status: 201,
        items: [],
        wholesale_updates: [],
        step_timings_ms: stepTimingsHeaderOnly,
      });
    }

    const items_total = persistedLineItems.reduce(
      (sumSubtotals, lineItemDoc) =>
        sumSubtotals + (Number(lineItemDoc.subtotal) || 0),
      0,
    );

    // step 7 start — purchase_order read (response reload)
    const endStep7 = poStepTimer.start(
      7,
      "purchase_order read (response reload)",
    );
    const headerReloadedFromDb = await PurchaseOrder.findById(
      createdPurchaseOrderId,
    ).lean();
    endStep7();
    // step 7 end

    const stepTimingsMs = poStepTimer.log();

    return res.status(201).json({
      ...purchaseOrderCreateResult,
      status: 201,
      data: {
        ...purchaseOrderCreateResult.data,
        ...headerReloadedFromDb,
      },
      items: persistedLineItems,
      items_total,
      product_stock_updates: productStockUpdates,
      wholesale_updates: wholesaleUpdates,
      step_timings_ms: stepTimingsMs,
    });
  } catch (unexpectedError) {
    if (poStepTimer) {
      poStepTimer.log("[purchase_order_create] unexpected —");
    }
    console.error("Purchase Order creation error:", unexpectedError);
    // step 20 start — rollback log (outer catch)
    await logRollbackFailure(req, unexpectedError, {
      action: "PURCHASE ORDER CREATE ROLLBACK",
      tags: ["api", "purchase_order", "rollback", "create", "outer"],
      fallbackUrl: "/api/purchase_order/purchase_order_create",
    });
    // step 20 end
    return res.status(500).json({
      success: false,
      message: "Failed to create purchase order",
      error: unexpectedError.message,
      ...(poStepTimer ? { step_timings_ms: poStepTimer.report() } : {}),
    });
  }
}

/**
 * PUT/PATCH purchase order — header update, GL rebuild, optional full line replace + inventory replay.
 *
 * Flow — **line replace** (steps 1–13): prep → PO update → validate/build/snapshot → teardown → GL → lines → stock.
 * **Header-only** (steps 1–3, 14–15): prep → PO update + GL in `afterUpdate` → response reads.
 *
 * Collections (Mongo) — op = insert | update | delete | read; scope = one | many
 * Cost (relative): **low** | **medium** | **high** (ledger aggregate / full scan).
 *
 * | Step | When              | Collection              | Op                 | One or many  | Cost   | Notes |
 * |------|-------------------|-------------------------|--------------------|--------------|--------|-------|
 * |    1 | Pre-txn           | —                       | —                  | —            | low    | `collectLineItems`, normalize header, `lines_subtotal` (from body lines or DB items) |
 * |    2 | In txn — always   | purchase_order          | update             | one          | low    | `handleGenericUpdate`; `total_amount` via model hook (one PO write) |
 * |    3 | In txn — header-only | transaction          | update + insert    | many (5)     | medium | In `afterUpdate`: soft-delete GL + `rebuildPurchaseOrderGlTransactions` |
 * |    4 | In txn — lines    | —                       | —                  | —            | low    | Validate each line (`product_id`, positive `qty`) |
 * |    5 | In txn — lines    | purchase_order_item     | —                  | —            | low    | `buildPurchaseOrderItemDocuments` |
 * |    6 | In txn — lines    | purchase_order_item     | read               | many         | low    | Snapshot existing lines before teardown |
 * |    7 | In txn — lines    | transaction, inventory_movements, purchase_order_item | update/delete | few–many | medium | `teardownPurchaseOrderForLineReplace` |
 * |    8 | In txn — lines    | transaction             | insert             | many (5)     | medium | `rebuildPurchaseOrderGlTransactions` (after teardown) |
 * |    9 | In txn — lines    | purchase_order_item     | insert             | many         | medium | `insertMany` |
 * |   10 | In txn — lines    | inventory_movements     | insert             | one × N      | low    | `insertInventoryMovementRecord` per warehouse line |
 * |   11 | In txn — lines    | warehouse_inventory, product, logs | read / update | one × R | medium | Reverse stock; `applyWholesalePriceRemoveForPoLines` + wholesale audit logs |
 * |   12 | In txn — lines    | product, logs           | read / update      | one × P      | medium | `applyWholesalePriceWeightedAverageForPoLines` + logs when price changes |
 * |   13 | In txn — lines    | warehouse_inventory     | read / upsert      | one × N      | medium | Inbound new line qty (`applyWarehouseInventoryForPoLines`) |
 * |   14 | Post-txn success  | purchase_order_item     | read               | many         | medium | Populate for response `data` |
 * |   15 | Post-txn success  | purchase_order          | read               | one          | low    | Reload header for response |
 * |   16 | On failure        | logs                    | insert             | one          | low    | `logRollbackFailure` (`PURCHASE ORDER UPDATE ROLLBACK`) |
 *
 * L = line count; N = warehouse lines; P = distinct products (wholesale); R = old lines reversed.
 */
async function purchase_order_update(req, res) {
  // step 1 start — parse lines + normalize header for `handleGenericUpdate`
  const lines = collectLineItems(req.body);
  const originalBody = req.body;
  req.body = normalizePurchaseOrderNumericFields(
    stripLineItemKeysFromBody(originalBody),
  );
  delete req.body._id;
  resolvePoPaymentMethodAccount(req.body, req.user);

  const recordId = String(req.params?.id || "").trim();
  if (lines.length > 0) {
    // step 1 — same parsed lines as insertMany; no post-line `syncHeaderTotalsFromLineItems`
    req.body.lines_subtotal = purchaseOrderLinesSubtotalSum(lines);
  } else if (recordId && mongoose.Types.ObjectId.isValid(recordId)) {
    // step 1 — header-only: subtotal from persisted lines for GL purchase debit
    const existingItems = await PurchaseOrderItem.find({
      purchase_order_id: recordId,
      status: "active",
      deletedAt: null,
    })
      .select("subtotal")
      .lean();
    req.body.lines_subtotal = purchaseOrderLinesSubtotalSum(existingItems);
  }
  // step 1 end

  let clientSession = null;
  let response = null;
  let txnError = null;
  const persistedLineItems = [];
  const productStockUpdates = [];
  const wholesaleUpdates = [];
  /** Set when lines are replaced: product ids on old rows vs incoming `built.docs` + stock sync. */
  let poLineReplaceSnapshot = null;

  /** @param {import("mongoose").ClientSession | null} mongoSession */
  const runPurchaseOrderUpdateBody = async (mongoSession) => {
    // step 2 start — purchase_order update (header)
    response = await handleGenericUpdate(req, "purchase_order", {
      ...(mongoSession ? { session: mongoSession } : {}),
      afterUpdate: async (record, orderReq, _existing, sess) => {
        // Header-only: step 3 — line replace runs steps 7–13 in the line block.
        if (lines.length === 0) {
          await softDeleteActiveGlByTransactionNumber({
            transactionNumber: record?.transaction_number,
            mongoSession: sess,
            userId: orderReq.user?._id,
          });
          await rebuildPurchaseOrderGlTransactions(
            record,
            orderReq,
            req.body?.remaining_amount,
            sess,
          );
        }
      },
      filter: { status: "active", deletedAt: null },
    });
    // step 2 end

    if (!response?.success || !response?.data) {
      throwWithGenericFailure(response, "Purchase order update failed");
    }

    const poId = response.data._id;

    if (lines.length > 0) {
      // steps 4–13 — full line replace + inventory
      const companyId =
        coalesceObjectId(response.data.company_id) ||
        coalesceObjectId(req.user?.company_id);

      if (!companyId || !mongoose.Types.ObjectId.isValid(String(companyId))) {
        throw new Error(
          "company_id is required to update purchase order line items",
        );
      }

      // step 4 start — validate line payloads
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex];
        const productIdStr = String(line.product_id).trim();
        const lineQtyNum = Number(line.qty);
        if (
          !productIdStr ||
          !mongoose.Types.ObjectId.isValid(productIdStr) ||
          !Number.isFinite(lineQtyNum) ||
          lineQtyNum <= 0
        ) {
          throw new Error(
            "Each purchase order line needs a valid product_id and positive qty",
          );
        }
      }
      // step 4 end

      // step 5 start — build purchase_order_item documents
      const built = buildPurchaseOrderItemDocuments(
        poId,
        response.data,
        lines,
        req,
      );
      if (built.error) {
        throw new Error(built.error);
      }
      if (built.docs.length !== lines.length) {
        throw new Error("Could not build purchase order line documents");
      }
      // step 5 end

      // step 6 start — snapshot existing lines before teardown
      let existingPoItemsQuery = PurchaseOrderItem.find({
        purchase_order_id: poId,
        status: "active",
        deletedAt: null,
      }).select("product_id qty price subtotal warehouse_id");
      if (mongoSession) {
        existingPoItemsQuery = existingPoItemsQuery.session(mongoSession);
      }
      const existingPoItems = await existingPoItemsQuery.lean();
      // step 6 end

      const previous_product_ids =
        collectUniqueProductIdsFromLineRows(existingPoItems);
      const new_product_ids = collectUniqueProductIdsFromLineRows(built.docs);

      // step 7 start — teardown: GL + movements soft-delete, line deleteMany
      await teardownPurchaseOrderForLineReplace({
        purchaseOrderId: poId,
        transactionNumber: response.data.transaction_number,
        companyId,
        mongoSession,
        userId: req.user?._id,
      });
      // step 7 end

      // step 8 start — transaction insert ×5 (GL rebuild after teardown)
      await rebuildPurchaseOrderGlTransactions(
        response.data,
        req,
        req.body?.remaining_amount,
        mongoSession,
      );
      // step 8 end

      // step 9 start — purchase_order_item insertMany
      const insertedLineDocs = await PurchaseOrderItem.insertMany(
        built.docs,
        sessionOpts(mongoSession),
      );
      persistedLineItems.push(...insertedLineDocs);
      // step 9 end

      // step 10 start — inventory_movements insert per warehouse line
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex];
        const lineQtyNum = Number(line.qty);
        const warehouseIdStr =
          line.warehouse_id != null ? String(line.warehouse_id).trim() : "";

        if (warehouseIdStr && mongoose.Types.ObjectId.isValid(warehouseIdStr)) {
          const unitCost = Number(line.price);
          if (!Number.isFinite(unitCost) || unitCost < 0) {
            throw new Error(
              "Each PO line with a warehouse needs a finite unit price (price) and positive quantity for inventory movement",
            );
          }
          const totalCostMovement =
            Math.round(lineQtyNum * unitCost * 100) / 100;

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
            company_id: companyId,
            status: "active",
          };

          try {
            await insertInventoryMovementRecord(req, mongoSession);
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
        }
      }
      // step 10 end

      // step 11 start — warehouse_inventory reverse (old PO line qty) + wholesale undo
      await WarehouseInventory.applyStockChangesFromLines({
        reverseLines: existingPoItems,
        inboundLines: [],
        savedLineItemRows: [],
        companyId,
        session: mongoSession,
        userId: req.user?._id,
      });
      const wholesaleReverseRows = await applyWholesalePriceRemoveForPoLines({
        lines: existingPoItems,
        companyId,
        req,
        mongoSession,
      });
      wholesaleUpdates.push(...wholesaleReverseRows);
      // step 11 end

      // step 12 start — weighted-average product.wholesale_price (new lines)
      const wholesaleRows = await applyWholesalePriceWeightedAverageForPoLines({
        lines,
        companyId,
        req,
        mongoSession,
      });
      wholesaleUpdates.push(...wholesaleRows);
      // step 12 end

      // step 13 start — warehouse_inventory inbound (new line qty)
      const stockReconcile = await applyWarehouseInventoryForPoLines({
        lines,
        insertedLineDocs: persistedLineItems,
        companyId,
        mongoSession,
        req,
        reverseLines: [],
      });
      productStockUpdates.push(...stockReconcile.productStockUpdates);
      // step 13 end

      poLineReplaceSnapshot = {
        previous_product_ids,
        new_product_ids,
        stock_sync: productStockUpdates,
        warehouse_inventory_updates: productStockUpdates,
        wholesale_updates: wholesaleUpdates,
      };
    }
    // Header-only: step 1 set `lines_subtotal`; step 2 is the only PO update; step 3 rebuilds GL.
  };

  // txn start — MongoDB transaction wrapper (or standalone retry)
  try {
    clientSession = await mongoose.startSession();
    await clientSession.withTransaction(async () => {
      await runPurchaseOrderUpdateBody(clientSession);
    });
  } catch (e) {
    // Same standalone retry pattern as `purchaseOrderCreate` / `order_save`.
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
        persistedLineItems.length = 0;
        productStockUpdates.length = 0;
        wholesaleUpdates.length = 0;
        poLineReplaceSnapshot = null;
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
  // txn end

  req.body = originalBody;

  // step 16 start — failure path (`logs` + client JSON)
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
  // step 16 end (failure)

  if (!response || !response.success || !response.data) {
    return res
      .status(response && response.status ? response.status : 400)
      .json(response);
  }

  const poId = response.data._id;

  // step 14 start — purchase_order_item read (response)
  const items = await PurchaseOrderItem.find({
    purchase_order_id: poId,
    status: "active",
    deletedAt: null,
  })
    .populate("product_id")
    .sort({ createdAt: 1 })
    .lean();
  // step 14 end

  // step 15 start — purchase_order read (response reload)
  const poFresh = await PurchaseOrder.findById(poId).lean();
  const data = shapePurchaseOrderWithItems(poFresh || response.data, items);
  // step 15 end

  const items_total = items.reduce(
    (sumSubtotals, lineItemDoc) =>
      sumSubtotals + (Number(lineItemDoc.subtotal) || 0),
    0,
  );

  return res.status(200).json({
    success: true,
    status: 200,
    data,
    items: persistedLineItems.length > 0 ? persistedLineItems : items,
    items_total,
    product_stock_updates: productStockUpdates,
    wholesale_updates: wholesaleUpdates,
    ...(poLineReplaceSnapshot ? { line_replace: poLineReplaceSnapshot } : {}),
  });
  // steps 14–15 complete — 200 response
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
