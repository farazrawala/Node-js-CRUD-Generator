const mongoose = require("mongoose");
const PurchaseReturn = require("../models/purchase_return");
const PurchaseReturnItem = require("../models/purchase_return_item");
require("../models/purchase_order");
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
const { evaluateProductStockAlert } = require("./alerts");
const {
  isMongoTransactionUnsupportedError,
} = require("../utils/mongoTransactionSupport");

/**
 * Purchase return HTTP handlers: header + line items, inventory movement ledger (`inventory_movements` only),
 * and five GL postings per return (reversed vs PO — see transactionBulkCreate payloads).
 *
 * Standalone MongoDB: tries `withTransaction` first; on replica-set–only errors, retries without a session.
 */

/**
 * One entry per row sent to `transactionBulkCreate` in afterCreate/afterUpdate (order matters).
 * - `companyAccountField`: populated on `req.user.company_id` (auth middleware).
 * - `prAccountField`: optional field on the purchase_return document for that row’s `account_id`.
 */
const PURCHASE_RETURN_GL_LINE_META = [
  {
    description: "Purchase Return (credit)",
    prAccountField: null,
    companyAccountField: "default_purchase_account",
  },
  {
    description: "Purchase Return Shipment (credit)",
    prAccountField: null,
    companyAccountField: "default_shipping_account",
  },
  {
    description: "Purchase Return Discount (debit)",
    prAccountField: null,
    companyAccountField: "default_purchase_discount_account",
  },
  {
    description: "Mode of Payment (debit)",
    prAccountField: "payment_method_accounts_id",
    companyAccountField: "default_cash_account",
  },
  {
    description: "Accounts Payable (debit)",
    prAccountField: null,
    companyAccountField: "default_account_payable_account",
  },
];

/** Human-readable hint for API errors: which company / body fields to set for a failed GL row. */
function purchaseReturnGlLineFixHint(meta) {
  if (!meta) {
    return "Configure company default GL accounts and return payment fields.";
  }
  const parts = [];
  if (meta.companyAccountField) {
    parts.push(`company.${meta.companyAccountField}`);
  }
  if (meta.prAccountField) {
    parts.push(`purchase_return.body.${meta.prAccountField}`);
  }
  return parts.length ? `Set ${parts.join(" or ")}.` : "Configure GL accounts.";
}

/**
 * Augment bulk-create `failed` entries with line label, normalized missing list, and fix hints.
 * Keeps original keys (`index`, `missing`, …) for backward compatibility.
 */
function enrichPurchaseReturnGlFailures(failed) {
  if (!Array.isArray(failed)) return [];
  return failed.map((f) => {
    const idx = Number(f.index);
    const meta =
      Number.isFinite(idx) && idx >= 0 ?
        PURCHASE_RETURN_GL_LINE_META[idx]
      : null;
    const missing = Array.isArray(f.missing) ? f.missing : [];
    return {
      ...f,
      gl_line_index: idx,
      gl_line_description: meta?.description ?? `GL row ${idx}`,
      missing_fields: missing,
      where_to_fix: purchaseReturnGlLineFixHint(meta),
    };
  });
}

/** Single readable sentence for logs and `Error.message` (API error field). */
function formatPurchaseReturnGlBulkErrorMessage(enriched) {
  const lines = enriched.map((e) => {
    const miss =
      e.missing_fields?.length ?
        ` — missing: ${e.missing_fields.join(", ")}`
      : "";
    return `index ${e.gl_line_index} «${e.gl_line_description}»${miss}. ${e.where_to_fix}`;
  });
  return `Post-purchase_return transaction bulk insert failed. ${lines.join(" | ")}`;
}

/** Per-step wall-clock timings for `purchaseReturnCreate` (see JSDoc steps 1–20). */
function startPrCreateStepTimer() {
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
    log(logTag = "[purchase_return_create]") {
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
async function throwPurchaseReturnGlBulkFailed(_orderReq, failed) {
  const enriched = enrichPurchaseReturnGlFailures(failed);
  const msg = formatPurchaseReturnGlBulkErrorMessage(enriched);
  console.error(
    "⚠️ Post-purchase_return transaction bulk insert failed:",
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

function purchaseReturnLinesSubtotalSum(lineItems) {
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

/** `purchase_return_item` requires shipping fields; default when omitted (legacy payloads). */
function normalizeLineShippingFields(line) {
  const spu = parseFloat(String(line?.shipping_per_unit ?? "").trim());
  const ts = parseFloat(String(line?.total_shipping ?? "").trim());
  return {
    shipping_per_unit: Number.isFinite(spu) ? spu : 0,
    total_shipping: Number.isFinite(ts) ? ts : 0,
  };
}

function normalizePurchaseReturnNumericFields(obj) {
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
 * Build return line objects when the client sends parallel indexed fields on one object, e.g.
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

/** No-op placeholder for parity with PO create; return header has no name/email/phone fields. */
function ensurePurchaseReturnHeaderFields(_body, _user) {}

/**
 * Fills `payment_method_accounts_id` from `company.default_cash_account` when absent/invalid,
 * so the “Mode of Payment” transaction (bulk index 3) always has an `account_id` when possible.
 */
function resolvePrPaymentMethodAccount(body, user) {
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

/** Unique product ObjectId strings from return line rows or `built.docs`. */
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

function buildPurchaseReturnItemDocuments(prId, prSnapshot, lines, req) {
  const companyId = prSnapshot.company_id || req.user?.company_id;
  if (!companyId || !mongoose.Types.ObjectId.isValid(String(companyId))) {
    return {
      docs: [],
      error:
        "company_id is required on purchase return line items (set on the return or authenticated user)",
    };
  }
  const userId = req.user?._id;
  const docs = [];
  for (const line of lines) {
    const doc = {
      purchase_return_id: prId,
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

/**
 * Per `product_id` on return lines: any warehouse line (ledger path) and qty on lines without warehouse.
 * @param {object[]} lines Parsed return line payloads
 * @returns {Map<string, { hasWarehouseLine: boolean, qtyWithoutWarehouse: number }>}
 */
function summarizeLineStockByProduct(lines) {
  const map = new Map();
  for (const line of lines) {
    const productIdStr = String(line.product_id ?? "").trim();
    if (!productIdStr || !mongoose.Types.ObjectId.isValid(productIdStr)) {
      continue;
    }
    const lineQtyNum = Number(line.qty);
    if (!Number.isFinite(lineQtyNum) || lineQtyNum <= 0) {
      continue;
    }
    const warehouseIdStr =
      line.warehouse_id != null ? String(line.warehouse_id).trim() : "";
    const hasWarehouse =
      Boolean(warehouseIdStr) &&
      mongoose.Types.ObjectId.isValid(warehouseIdStr);
    const entry = map.get(productIdStr) || {
      hasWarehouseLine: false,
      qtyWithoutWarehouse: 0,
    };
    if (hasWarehouse) {
      entry.hasWarehouseLine = true;
    } else {
      entry.qtyWithoutWarehouse =
        Math.round((entry.qtyWithoutWarehouse + lineQtyNum) * 100) / 100;
    }
    map.set(productIdStr, entry);
  }
  return map;
}

/**
 * After return lines + optional `out` movements: ledger sync when any line has a warehouse;
 * subtract non-warehouse line qty via `decrementProductStockForReturnLine` (matches update + legacy create).
 */
async function reconcileProductStockAfterPrCreate({
  lines,
  companyId,
  mongoSession,
  req,
  prStepTimer = null,
}) {
  const productStockUpdates = [];
  const stockByProductId = new Map();
  const logUrl =
    req.originalUrl ||
    req.path ||
    "/api/purchase_return/purchase_return_create";
  const summary = summarizeLineStockByProduct(lines);

  for (const [productIdStr, info] of summary) {
    let onHand = null;

    if (info.hasWarehouseLine) {
      const endSync = prStepTimer?.start(
        3,
        "product stock sync from ledger (steps 3–4)",
        { product_id: productIdStr },
      );
      const syncResult = await syncProductStockFromMovementLedger(
        productIdStr,
        companyId,
        { req, mongoSession, logUrl },
      );
      endSync?.();
      if (!syncResult.success) {
        throw new Error(
          syncResult.message ||
            syncResult.error ||
            "Product stock sync from ledger failed",
        );
      }
      onHand = Number(syncResult.product?.stock) || 0;
      productStockUpdates.push({
        product_id: productIdStr,
        source: "ledger_sync",
        previous_stock: syncResult.product?.previous_stock,
        stock: onHand,
        qty_in: syncResult.qty_in,
        qty_out: syncResult.qty_out,
        warehouses: syncResult.warehouses,
      });
    }

    if (info.qtyWithoutWarehouse > 0) {
      const endBump = prStepTimer?.start(
        3,
        "product stock decrement (no warehouse)",
        {
          product_id: productIdStr,
          qty: info.qtyWithoutWarehouse,
        },
      );
      const bump = await decrementProductStockForReturnLine({
        productId: productIdStr,
        lineQty: info.qtyWithoutWarehouse,
        companyId,
        mongoSession,
      });
      endBump?.();
      onHand = Number(bump.stock);
      productStockUpdates.push({
        ...bump,
        source:
          info.hasWarehouseLine ?
            "non_warehouse_qty_after_ledger"
          : "non_warehouse_lines_only",
        qty_removed: info.qtyWithoutWarehouse,
      });
    }

    if (onHand != null) {
      stockByProductId.set(productIdStr, onHand);
    }
  }

  return { productStockUpdates, stockByProductId };
}

function shapePurchaseReturnWithItems(prPlain, items) {
  const purchase_return_items_total = items.reduce((sum, item) => {
    const sub = Number(item.subtotal);
    return sum + (Number.isFinite(sub) ? sub : 0);
  }, 0);
  return {
    ...prPlain,
    purchase_return_items: items,
    no_of_items: items.length,
    purchase_return_items_total,
  };
}

/**
 * Read `product.stock`, subtract return line qty, persist on `product` (before outbound movement).
 * @param {{ productId: unknown, lineQty: unknown, companyId: unknown, mongoSession?: object | null }} params
 */
async function decrementProductStockForReturnLine({
  productId,
  lineQty,
  companyId,
  mongoSession = null,
}) {
  const pid = coalesceObjectId(productId);
  const cid = coalesceObjectId(companyId);
  if (!pid || !mongoose.Types.ObjectId.isValid(String(pid))) {
    throw new Error("Valid product_id is required to update product stock");
  }
  if (!cid || !mongoose.Types.ObjectId.isValid(String(cid))) {
    throw new Error("company_id is required to update product stock");
  }

  const qtyToRemove = Number(lineQty);
  if (!Number.isFinite(qtyToRemove) || qtyToRemove <= 0) {
    throw new Error(
      "Each purchase return line needs a positive quantity to update product stock",
    );
  }

  let productQuery = Product.findOne({
    _id: pid,
    company_id: cid,
    status: "active",
    deletedAt: null,
  }).select("stock product_name");
  if (mongoSession) {
    productQuery = productQuery.session(mongoSession);
  }
  const productDoc = await productQuery.lean();
  if (!productDoc) {
    throw new Error(`Product not found for stock update (id ${String(pid)})`);
  }

  const previousStock = Number(productDoc.stock) || 0;
  if (previousStock < qtyToRemove) {
    const msg = `Insufficient product stock: need ${qtyToRemove}, available ${previousStock}`;
    const err = new Error(msg);
    err.statusCode = 400;
    err.clientErrorPayload = {
      success: false,
      status: 400,
      error: "Insufficient product stock",
      message: msg,
      details: msg,
      type: "validation",
      product_id: String(pid),
      previous_stock: previousStock,
      qty_needed: qtyToRemove,
    };
    throw err;
  }

  const nextStock = Math.round((previousStock - qtyToRemove) * 100) / 100;

  const updateOpts = mongoSession ? { session: mongoSession } : {};
  const updated = await Product.findOneAndUpdate(
    { _id: pid, company_id: cid, status: "active", deletedAt: null },
    { $set: { stock: nextStock } },
    { new: true, ...updateOpts },
  ).lean();

  if (!updated) {
    throw new Error(`Failed to update product stock (id ${String(pid)})`);
  }

  return {
    product_id: pid,
    product_name: productDoc.product_name,
    previous_stock: previousStock,
    stock: nextStock,
    qty_removed: qtyToRemove,
  };
}

async function getPurchaseReturnByReturnItem(req, res) {
  const idParam =
    req.params && req.params.id != null ? String(req.params.id).trim() : "";

  if (idParam && !mongoose.Types.ObjectId.isValid(idParam)) {
    return res.status(400).json({
      success: false,
      status: 400,
      error: "Invalid id",
      details: "id must be a valid purchase_return ObjectId",
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

  const response = await handleGenericGetAll(req, "purchase_return", {
    filter,
    excludeFields: [],
    sort: { createdAt: -1 },
    // ?populate=vendor_id:name → populated vendor with only `name` (+ _id). Comma-separate paths; use path:fields for projection.
    populate: buildPopulateFromQuery(req.query || {}, "purchase_return"),

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
      details: `purchase_return with id "${idParam}" not found`,
      type: "not_found",
    });
  }

  const prIds = response.data.map((o) => o._id).filter(Boolean);
  if (prIds.length === 0) {
    return res.status(response.status).json(response);
  }

  const itemFilter = {
    purchase_return_id: { $in: prIds },
    status: "active",
    deletedAt: null,
  };
  const items = await PurchaseReturnItem.find(itemFilter)
    .populate("product_id")
    .sort({ createdAt: 1 })
    .lean();

  const itemsByPrId = new Map();
  for (const id of prIds) {
    itemsByPrId.set(String(id), []);
  }
  for (const item of items) {
    const key = String(item.purchase_return_id);
    if (!itemsByPrId.has(key)) {
      itemsByPrId.set(key, []);
    }
    itemsByPrId.get(key).push(item);
  }

  const data = response.data.map((po) => {
    const purchase_return_items = itemsByPrId.get(String(po._id)) || [];
    const purchase_return_items_total = purchase_return_items.reduce(
      (sum, row) => {
        const sub = Number(row.subtotal);
        return sum + (Number.isFinite(sub) ? sub : 0);
      },
      0,
    );
    return {
      ...po,
      purchase_return_items,
      no_of_items: purchase_return_items.length,
      purchase_return_items_total,
    };
  });

  return res.status(response.status).json({
    ...response,
    data,
  });
}

async function getPurchaseReturnByReturnNo(req, res) {
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
  const popFields = buildPopulateFromQuery(req.query || {}, "purchase_return");
  const findOnePr = (extraFilter) => {
    let q = PurchaseReturn.findOne({ ...extraFilter, ...filter });
    for (const spec of popFields) {
      if (typeof spec === "string") {
        q = q.populate(spec);
      } else if (spec && typeof spec === "object" && spec.path) {
        q = q.populate(spec);
      }
    }
    return q;
  };

  let po = await findOnePr({ purchase_return_no: param });
  if (!po && mongoose.Types.ObjectId.isValid(param)) {
    po = await findOnePr({ _id: param });
  }

  if (!po) {
    return res.status(404).json({
      success: false,
      status: 404,
      error: "Record not found",
      details: `purchase_return with purchase_return_no or id "${param}" not found`,
      type: "not_found",
    });
  }

  const items = await PurchaseReturnItem.find({
    purchase_return_id: po._id,
    status: "active",
    deletedAt: null,
  })
    .populate("product_id")
    .sort({ createdAt: 1 })
    .lean();

  const data = shapePurchaseReturnWithItems(
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
 * POST /api/purchase_return/purchase_return_create
 *
 * Flow: (1) normalize header on `req.body`, (2) create PO + five GL rows inside a Mongo session when
 * possible, (3) create line items and inventory movements, (4) sync header totals from lines,
 * (5) return 201 with items and derived totals. On standalone MongoDB, the same steps run without a session.
 *
 * Collections (Mongo) — op = insert | update | delete | read; scope = one | many
 * Cost (relative): **low** = single cheap round-trip; **medium** = few docs or scales with L/N/P modestly;
 * **high** = hot path that grows with line count or scans/aggregates a large ledger.
 *
 * | Step | Collection              | Op                 | One or many  | Cost   | Notes |
 * |------|-------------------------|--------------------|--------------|--------|-------|
 * |    1 | purchase_order          | insert             | one          | low    | `handleGenericCreate` (header; model may assign `purchase_order_no`) |
 * |    2 | transaction             | insert             | many (5)     | medium | `transactionBulkCreate` in `afterCreate` — purchase, shipment, discount, payment, A/P |
 * |    3 | product                 | read / update      | one × P      | medium | `syncProductStockFromMovementLedger` (+ bump if no warehouse qty) |
 * |    5 | purchase_return_item     | insert             | many (1×)    | medium | `insertMany` via `buildPurchaseReturnItemDocuments` |
 * |    6 | inventory_movements     | insert             | one × N      | low    | `insertInventoryMovementRecord` — one row per warehouse line |
 * |    7 | product                 | read               | one × P      | medium | `evaluateProductStockAlert` — one read per distinct product |
 * |    8 | alerts                  | read               | one × P      | low    | Skip insert when active alert already exists |
 * |    9 | alerts                  | insert or update   | one × P      | low    | Insert alert when low; soft-delete when above threshold |
 * |   10 | logs                    | insert             | one × P      | low    | Stock alert audit when `alert_qty` > 0 |
 * |   11 | purchase_return_item     | read               | many         | medium | `syncHeaderTotalsFromLineItems` — single aggregation over return lines |
 * |   12 | purchase_return          | read               | one          | low    | `syncHeaderTotalsFromLineItems` — load discount/shipment |
 * |   13 | purchase_return          | update             | one          | low    | `syncHeaderTotalsFromLineItems` — set `lines_subtotal`, `total_amount` |
 * |   14 | purchase_return          | read               | one          | low    | `findById` for response payload |
 * |   15 | logs                    | insert             | one          | low    | `logRollbackFailure` — failure path only |
 *
 * Header-only create (no lines): steps 1–2 only; skips 3–18. L = line count; N = lines with valid `warehouse_id`; P = distinct `product_id` on lines.
 */
async function purchaseReturnCreate(req, res) {
  const originalRequestBody = req.body;
  const lineItemsFromClient = collectLineItems(originalRequestBody);
  let prStepTimer = null;

  try {
    // `handleGenericCreate` reads `req.body`; strip embedded line payloads and coerce numeric header fields.
    req.body = normalizePurchaseReturnNumericFields(
      stripLineItemKeysFromBody(originalRequestBody),
    );
    delete req.body._id;
    // Unique per company (partial index). Model pre-save assigns next `PO-####` when absent.
    // Drop client `purchase_order_no` so double-submit / fixed defaults cannot collide.
    delete req.body.purchase_return_no;
    ensurePurchaseReturnHeaderFields(req.body, req.user);
    // Mode-of-payment GL row needs `payment_method_accounts_id`; same fallback pattern as order / POS flows.
    resolvePrPaymentMethodAccount(req.body, req.user);

    req.body.lines_subtotal =
      purchaseReturnLinesSubtotalSum(lineItemsFromClient);

    const transaction_number = generateTransactionNumber();
    req.body.transaction_number = transaction_number;

    let mongooseClientSession = null;
    let purchaseReturnCreateResult = null;
    const persistedLineItems = [];
    const productStockUpdates = [];
    /** Set when `withTransaction` fails for a non–transaction-support reason, or when the non-session retry throws. */
    let createPipelineError = null;
    prStepTimer = startPrCreateStepTimer();

    /** Pass-through for `handleGenericCreate` / inventory helpers: include `session` only when a transaction is active. */
    const modelHelperOptions = (mongoSession) =>
      mongoSession ? { session: mongoSession } : {};

    /**
     * Runs inside one logical unit: purchase return document, GL postings, each `purchase_return_item`, optional outbound inventory ledger,
     * then header aggregate fields. Mutates outer `purchaseReturnCreateResult` and `persistedLineItems`.
     *
     * @param {object | null} mongoSession Mongoose client session when in a transaction; null on standalone mongod.
     */
    const runPurchaseReturnCreateBody = async (mongoSession) => {
      // step 1 start — purchase_order insert
      let step1Closed = false;
      let endStep1 = () => {};
      endStep1 = prStepTimer.start(1, "purchase_order insert");
      const closeStep1 = () => {
        if (!step1Closed) {
          step1Closed = true;
          endStep1();
        }
      };
      purchaseReturnCreateResult = await handleGenericCreate(
        req,
        "purchase_return",
        {
          ...modelHelperOptions(mongoSession),
          afterCreate: async (record, orderReq, sess) => {
            closeStep1();
            // step 1 end
            // step 2 start — transaction insert ×5 (GL)
            const endStep2 = prStepTimer.start(2, "transaction insert ×5 (GL)");
            const { created, failed } = await transactionBulkCreate(
              orderReq,
              [
                // [0]–[4] must stay aligned with PURCHASE_RETURN_GL_LINE_META for error messages.
                {
                  account_id: orderReq.user.company_id.default_purchase_account,
                  type: "credit",
                  amount: record?.lines_subtotal ?? 0,
                  reference_user_id: record?.vendor_id,
                  transaction_number,
                  description: "Purchase Return",
                  reference_id: {
                    module: "purchase_return",
                    ref_id: record._id,
                  },
                },

                {
                  account_id: orderReq.user.company_id.default_shipping_account,
                  type: "credit",
                  amount: record?.shipment ?? 0,
                  reference_user_id: record?.vendor_id,
                  transaction_number,
                  description: "Purchase Shipment",
                  reference_id: {
                    module: "purchase_return",
                    ref_id: record._id,
                  },
                },
                {
                  account_id:
                    orderReq.user.company_id.default_purchase_discount_account,
                  type: "debit",
                  amount: record?.discount ?? 0,
                  reference_user_id: record?.vendor_id,
                  transaction_number,
                  description: "Purchase Discount",
                },
                {
                  account_id: record?.payment_method_accounts_id,
                  type: "debit",
                  amount: record?.amount_paid ?? 0,
                  reference_user_id: record?.vendor_id,
                  transaction_number,
                  description: "Mode of Payment",
                  reference_id: {
                    module: "purchase_return",
                    ref_id: record._id,
                  },
                },
                {
                  account_id:
                    orderReq.user.company_id.default_account_payable_account,
                  type: "debit",
                  amount: req.body?.remaining_amount || 0,
                  reference_user_id: record?.vendor_id,
                  transaction_number,
                  description: "A/c Payable",
                  reference_id: {
                    module: "purchase_return",
                    ref_id: record._id,
                  },
                },
              ],
              { stopOnError: true, session: sess },
            );
            try {
              if (failed.length) {
                await throwPurchaseReturnGlBulkFailed(orderReq, failed);
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
        !purchaseReturnCreateResult?.success ||
        !purchaseReturnCreateResult.data
      ) {
        closeStep1();
        throwWithGenericFailure(
          purchaseReturnCreateResult,
          "Purchase return create failed",
        );
      }

      const newPurchaseReturnId = purchaseReturnCreateResult.data._id;
      // `req.user.company_id` may be populated `{ _id, ... }` from auth — normalize for line items / inventory.
      const companyId =
        coalesceObjectId(purchaseReturnCreateResult.data.company_id) ||
        coalesceObjectId(req.user?.company_id);

      // Header-only: steps 1–2 done; skip steps 3–19.
      if (lineItemsFromClient.length === 0) {
        return;
      }

      if (!companyId || !mongoose.Types.ObjectId.isValid(String(companyId))) {
        throw new Error(
          "company_id is required to create purchase return line items",
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
            "Each purchase return line needs a valid product_id and positive qty",
          );
        }
      }

      // step 5 start — purchase_return_item insertMany
      const built = buildPurchaseReturnItemDocuments(
        newPurchaseReturnId,
        purchaseReturnCreateResult.data,
        lineItemsFromClient,
        req,
      );
      if (built.error) {
        throw new Error(built.error);
      }
      if (built.docs.length !== lineItemsFromClient.length) {
        throw new Error("Could not build purchase return line documents");
      }

      const endStep5 = prStepTimer.start(5, "purchase_return_item insertMany", {
        line_count: built.docs.length,
      });
      const insertedLineDocs = await PurchaseReturnItem.insertMany(
        built.docs,
        sessionOpts(mongoSession),
      );
      endStep5();
      persistedLineItems.push(...insertedLineDocs);
      // step 5 end

      // step 6–11 start — inventory movement txn per line with warehouse_id
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
              "Each return line with a warehouse needs a finite unit price (price) and positive quantity for inventory movement",
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
            movement_type: "out",
            unit_cost: unitCost,
            total_cost: totalCostMovement,
            reference_type: "purchase_return",
            reference_id: newPurchaseReturnId,
            reference_name: "Purchase Return",
            company_id: companyId,
            status: "active",
          };

          const endSteps611 = prStepTimer.start(
            6,
            "inventory movement txn (steps 6–11)",
            { line_index: lineIndex, warehouse_id: warehouseIdStr },
          );
          try {
            await insertInventoryMovementRecord(req, mongoSession);
          } catch (inventoryMovementErr) {
            if (inventoryMovementErr.clientPayload) {
              throwWithGenericFailure(
                inventoryMovementErr.clientPayload,
                "Inventory movement for purchase return failed",
              );
            }
            throw inventoryMovementErr;
          } finally {
            endSteps611();
            req.body = bodyBeforeInventoryMovement;
            if (hadRouteParamId) {
              req.params.id = savedRouteParamId;
            } else {
              delete req.params.id;
            }
          }
        }
      }
      // step 6–11 end

      // step 3–4 start — product stock (ledger sync + non-warehouse bump)
      const stockReconcile = await reconcileProductStockAfterPrCreate({
        lines: lineItemsFromClient,
        companyId,
        mongoSession,
        req,
        prStepTimer,
      });
      productStockUpdates.push(...stockReconcile.productStockUpdates);
      // step 3–4 end

      // step 12–15 start — stock alerts per distinct product
      for (const [productIdStr, onHand] of stockReconcile.stockByProductId) {
        const endSteps1215 = prStepTimer.start(
          12,
          "stock alert (steps 12–15)",
          { product_id: productIdStr },
        );
        const alertResult = await evaluateProductStockAlert({
          req,
          productId: productIdStr,
          companyId,
          onHand,
          pathQty: onHand,
          session: mongoSession,
          logUrl:
            req.originalUrl ||
            req.path ||
            "/api/purchase_return/purchase_return_create",
        });
        endSteps1215();
        if (!alertResult.success) {
          throw new Error(
            alertResult.message ||
              alertResult.error ||
              "Product stock alert check failed",
          );
        }
      }
      // step 12–15 end

      // step 16–18 start — syncHeaderTotalsFromLineItems
      const endSteps1618 = prStepTimer.start(
        16,
        "syncHeaderTotalsFromLineItems (steps 16–18)",
      );
      await PurchaseReturn.syncHeaderTotalsFromLineItems(newPurchaseReturnId, {
        session: mongoSession,
      });
      endSteps1618();
      // step 16–18 end
    };

    // txn start — MongoDB transaction wrapper (or standalone retry)
    let endTxnWrap = () => {};
    endTxnWrap = prStepTimer.start("txn", "MongoDB transaction wrapper");
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
        await runPurchaseReturnCreateBody(mongooseClientSession);
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
          "[purchase_return] MongoDB transactions unavailable (e.g. standalone mongod); continuing without transaction",
        );
        try {
          persistedLineItems.length = 0;
          productStockUpdates.length = 0;
          purchaseReturnCreateResult = null;
          prStepTimer.resetSteps();
          const endTxnRetry = prStepTimer.start(
            "txn",
            "pipeline retry (no Mongo transaction)",
          );
          await runPurchaseReturnCreateBody(null);
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
      const stepTimingsOnError = prStepTimer.log(
        "[purchase_return_create] failed —",
      );
      console.error("Purchase Return creation error:", createPipelineError);
      // Step 20 — logs insert (failure path)
      await logRollbackFailure(req, createPipelineError, {
        action: "PURCHASE ORDER CREATE ROLLBACK",
        tags: ["api", "purchase_return", "rollback", "create"],
        fallbackUrl: "/api/purchase_return/purchase_return_create",
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
        errorMessage.includes("Post-purchase_return") ||
        errorMessage.includes("company_id is required");
      return res.status(isGeneralLedgerRelatedError ? 400 : 500).json({
        success: false,
        status: isGeneralLedgerRelatedError ? 400 : 500,
        error:
          isGeneralLedgerRelatedError ?
            "Purchase order creation rolled back"
          : "Failed to create purchase return",
        details: createPipelineError.message,
        step_timings_ms: stepTimingsOnError,
      });
    }

    if (
      !purchaseReturnCreateResult?.success ||
      !purchaseReturnCreateResult.data
    ) {
      return res
        .status(purchaseReturnCreateResult?.status || 400)
        .json(purchaseReturnCreateResult);
    }

    const createdPurchaseReturnId = purchaseReturnCreateResult.data._id;

    if (lineItemsFromClient.length === 0) {
      const stepTimingsHeaderOnly = prStepTimer.log();
      return res.status(201).json({
        ...purchaseReturnCreateResult,
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

    // step 19 start — purchase_order read (response reload)
    const endStep19 = prStepTimer.start(
      19,
      "purchase_order read (response reload)",
    );
    const headerReloadedFromDb = await PurchaseReturn.findById(
      createdPurchaseReturnId,
    ).lean();
    endStep19();
    // step 19 end

    const stepTimingsMs = prStepTimer.log();

    return res.status(201).json({
      ...purchaseReturnCreateResult,
      status: 201,
      data: {
        ...purchaseReturnCreateResult.data,
        ...headerReloadedFromDb,
      },
      items: persistedLineItems,
      items_total,
      product_stock_updates: productStockUpdates,
      wholesale_updates: [],
      step_timings_ms: stepTimingsMs,
    });
  } catch (unexpectedError) {
    if (prStepTimer) {
      prStepTimer.log("[purchase_return_create] unexpected —");
    }
    console.error("Purchase Return creation error:", unexpectedError);
    // step 20 start — rollback log (outer catch)
    await logRollbackFailure(req, unexpectedError, {
      action: "PURCHASE ORDER CREATE ROLLBACK",
      tags: ["api", "purchase_return", "rollback", "create", "outer"],
      fallbackUrl: "/api/purchase_return/purchase_return_create",
    });
    // step 20 end
    return res.status(500).json({
      success: false,
      message: "Failed to create purchase return",
      error: unexpectedError.message,
      ...(prStepTimer ? { step_timings_ms: prStepTimer.report() } : {}),
    });
  }
}

/**
 * PUT/PATCH purchase return — header update, GL rebuild, optional full line replace + inventory replay.
 *
 * Flow: (1) parse `collectLineItems` from body, (2) normalize header on `req.body` (restore `originalBody`
 * before response), (3) `handleGenericUpdate` inside `session.withTransaction` when supported,
 * (4) in `afterUpdate`: soft-delete prior `transaction` rows for this return's `transaction_number`, soft-delete
 *     prior `inventory_movements` with `reference_type: purchase_order`, then insert five new GL lines
 *     (same order as `purchaseReturnCreate` / `PURCHASE_RETURN_GL_LINE_META`),
 * (5) when client sends lines: replace all `purchase_return_item` rows, post new `in` movements per line
 *     with `warehouse_id` via `insertInventoryMovementRecord`, then stock reconcile for
 *     every product on old or new lines (sets `product.stock` from ledger `available_qty`),
 * (6) `PurchaseReturn.syncHeaderTotalsFromLineItems`.
 *
 * Header-only update (no lines in body): keeps existing line items and does not touch inventory movements
 * in the post-update block (GL + movement soft-delete in `afterUpdate` still runs on every successful header save).
 *
 * Standalone `mongod`: retries `runPurchaseReturnUpdateBody` without a session (partial writes possible on failure).
 *
 * Collections (Mongo) — op = insert | update | delete | read; scope = one | many
 * Cost (relative): **low** = single cheap round-trip; **medium** = few docs or scales modestly;
 * **high** = bulk soft-delete, ledger replay, or per-line movement txn (see `purchaseReturnCreate` table).
 *
 * | Step | When                                          | Collection              | Op               | One or many  | Cost   | Notes |
 * |------|-----------------------------------------------|-------------------------|--------------------|--------------|--------|-------|
 * |    1 | Pre-txn (no lines in body)                    | purchase_return_item     | read               | many         | medium | Sum subtotals → `lines_subtotal` on header |
 * |    2 | In txn — always                               | purchase_order          | update             | one          | low    | `handleGenericUpdate` (header fields) |
 * |    3 | In txn — always (`afterUpdate`)               | transaction             | update             | many         | medium | Soft-delete active rows for `transaction_number` |
 * |    4 | In txn — always (`afterUpdate`)               | transaction             | insert             | many (5)     | medium | `transactionBulkCreate` — new GL set |
 * |    5 | In txn — always (`afterUpdate`)               | inventory_movements     | update             | many         | high   | Soft-delete rows for this return `reference_id` |
 * |    6 | In txn — lines in body                        | purchase_return_item     | read               | many         | low    | Snapshot before replace (`product_id`) |
 * |    7 | In txn — lines in body                        | purchase_return_item     | delete             | many         | medium | `deleteMany` by `purchase_order_id` |
 * |    8 | In txn — lines in body                        | purchase_return_item     | insert             | many         | medium | `insertMany` from `built.docs` |
 * |    9 | In txn — lines in body (per line w/ warehouse) | inventory_movements     | insert             | one × N      | low    | `insertInventoryMovementRecord` |
 * |   10 | In txn — lines in body (per line w/ warehouse) | product                 | update             | one × N      | medium | Optional `wholesale_price` on `in` (weighted avg) |
 * |   11 | In txn — lines in body (per line w/ warehouse) | logs                    | insert             | one × N      | low    | Movement + optional wholesale audit rows |
 * |   12 | In txn — lines in body                        | product                 | read / update      | one × P      | high   | `syncProductStockFromMovementLedger` (ledger + stock + log) |
 * |   13 | In txn — lines in body                        | logs                    | insert             | one × P      | low    | Stock-sync audit when stock changed (same session) |
 * |   14 | In txn — always                               | purchase_order          | update             | one          | medium | `syncHeaderTotalsFromLineItems` (`lines_subtotal`, `total_amount`) |
 * |   15 | Post-txn success                              | purchase_return_item     | read               | many         | medium | Populate for response `data` |
 * |   16 | Post-txn success                              | purchase_order          | read               | one          | low    | Reload header for response |
 * |   17 | On failure                                    | logs                    | insert             | one          | low    | `logRollbackFailure` (`PURCHASE RETURN UPDATE ROLLBACK`) |
 *
 * P = distinct product ids on old ∪ new lines. N = lines with valid `warehouse_id`. Does not call
 * `decrementProductStockForReturnLine` (create-only direct `product.stock` bump).
 */
async function purchase_return_update(req, res) {
  const lines = collectLineItems(req.body);
  const originalBody = req.body;
  // `handleGenericUpdate` reads header fields only; strip embedded line keys from multipart / indexed payloads.
  req.body = normalizePurchaseReturnNumericFields(
    stripLineItemKeysFromBody(originalBody),
  );
  delete req.body._id;
  // Mode-of-payment GL row needs `payment_method_accounts_id`; same fallback as create when client omits it.
  resolvePrPaymentMethodAccount(req.body, req.user);

  const recordId = String(req.params?.id || "").trim();
  if (lines.length > 0) {
    req.body.lines_subtotal = purchaseReturnLinesSubtotalSum(lines);
  } else if (recordId && mongoose.Types.ObjectId.isValid(recordId)) {
    // Header-only update: derive subtotal from persisted lines so GL purchase line amount stays correct.
    const existingItems = await PurchaseReturnItem.find({
      purchase_return_id: recordId,
      status: "active",
      deletedAt: null,
    })
      .select("subtotal")
      .lean();
    req.body.lines_subtotal = purchaseReturnLinesSubtotalSum(existingItems);
  }

  let clientSession = null;
  let response = null;
  let txnError = null;
  /** Set when lines are replaced: product ids on old rows vs incoming `built.docs` + ledger stock sync. */
  let prLineReplaceSnapshot = null;

  /** @param {import("mongoose").ClientSession | null} mongoSession */
  const runPurchaseReturnUpdateBody = async (mongoSession) => {
    response = await handleGenericUpdate(req, "purchase_return", {
      ...(mongoSession ? { session: mongoSession } : {}),
      afterUpdate: async (record, orderReq, _existing, sess) => {
        const transaction_number = record?.transaction_number;
        // Invalidate old GL rows (soft delete) before inserting the replacement set for this return.
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

        // Prior inbound movements for this return are inactive so new line qty is not double-counted in the ledger.
        const invMovementSoftDelete = await InventoryMovements.updateMany(
          {
            reference_type: "purchase_return",
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
            // Same five rows / index order as create — keep in sync with PURCHASE_RETURN_GL_LINE_META.
            {
              account_id: orderReq.user.company_id.default_purchase_account,
              type: "credit",
              amount: record?.lines_subtotal ?? 0,
              reference_user_id: record?.vendor_id,
              transaction_number,
              description: "Purchase Return",
              reference_id: {
                module: "purchase_return",
                ref_id: record._id,
              },
            },
            {
              account_id: orderReq.user.company_id.default_shipping_account,
              type: "credit",
              amount: record?.shipment ?? 0,
              reference_user_id: record?.vendor_id,
              transaction_number,
              description: "Purchase Shipment",
              reference_id: {
                module: "purchase_return",
                ref_id: record._id,
              },
            },
            {
              account_id:
                orderReq.user.company_id.default_purchase_discount_account,
              type: "debit",
              amount: record?.discount ?? 0,
              reference_user_id: record?.vendor_id,
              transaction_number,
              description: "Purchase Discount",
            },
            {
              account_id: record?.payment_method_accounts_id,
              type: "debit",
              amount: record?.amount_paid ?? 0,
              reference_user_id: record?.vendor_id,
              transaction_number,
              description: "Mode of Payment",
              reference_id: {
                module: "purchase_return",
                ref_id: record._id,
              },
            },
            {
              account_id:
                orderReq.user.company_id.default_account_payable_account,
              type: "debit",
              amount: req.body?.remaining_amount || 0,
              reference_user_id: record?.vendor_id,
              transaction_number,
              description: "A/c Payable",
              reference_id: {
                module: "purchase_return",
                ref_id: record._id,
              },
            },
          ],
          { stopOnError: true, session: sess },
        );
        if (failed.length) {
          await throwPurchaseReturnGlBulkFailed(orderReq, failed);
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
      throwWithGenericFailure(response, "Purchase return update failed");
    }

    const prId = response.data._id;

    if (lines.length > 0) {
      const built = buildPurchaseReturnItemDocuments(
        prId,
        response.data,
        lines,
        req,
      );
      if (built.error) {
        throw new Error(built.error);
      }

      // Snapshot existing lines before replace (for ledger stock sync and API metadata).
      let existingPrItemsQuery = PurchaseReturnItem.find({
        purchase_return_id: prId,
        status: "active",
        deletedAt: null,
      }).select("product_id qty price subtotal");
      if (mongoSession) {
        existingPrItemsQuery = existingPrItemsQuery.session(mongoSession);
      }
      const existingPrItems = await existingPrItemsQuery.lean();

      const previous_product_ids =
        collectUniqueProductIdsFromLineRows(existingPrItems);
      const new_product_ids = collectUniqueProductIdsFromLineRows(built.docs);

      // Full line replace: delete all items for this return, then insert the new set from the request.
      await PurchaseReturnItem.deleteMany(
        { purchase_return_id: prId },
        sessionOpts(mongoSession),
      );
      await PurchaseReturnItem.insertMany(
        built.docs,
        sessionOpts(mongoSession),
      );

      // Outbound ledger per line (lines without valid `warehouse_id` are skipped — no movement, no stock path).
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
            "Each return line with a warehouse needs a finite unit price (price) and positive quantity for inventory movement",
          );
        }
        const totalCostMovement = Math.round(lineQtyNum * unitCost * 100) / 100;

        // `insertInventoryMovementRecord` expects movement fields on `req.body`; save/restore header + route id.
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
          movement_type: "out",
          unit_cost: unitCost,
          total_cost: totalCostMovement,
          reference_type: "purchase_return",
          reference_id: prId,
          reference_name: "Purchase Return",
          company_id: companyIdForMovement,
          status: "active",
        };

        try {
          await insertInventoryMovementRecord(req, mongoSession);
        } catch (inventoryMovementErr) {
          if (inventoryMovementErr.clientPayload) {
            throwWithGenericFailure(
              inventoryMovementErr.clientPayload,
              "Inventory movement for purchase return update failed",
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

      // Reconcile `product.stock` from movement ledger after new `out` rows are posted.
      const companyIdForStock =
        coalesceObjectId(response.data.company_id) ||
        coalesceObjectId(req.user?.company_id);
      const productIdsToSync = [
        ...new Set([...previous_product_ids, ...new_product_ids]),
      ];
      const stockSyncResults = [];
      for (const pid of productIdsToSync) {
        const syncResult = await syncProductStockFromMovementLedger(
          pid,
          companyIdForStock,
          {
            req,
            mongoSession,
            logUrl: req.originalUrl || "/api/purchase_return/update",
          },
        );
        if (!syncResult.success) {
          throwWithGenericFailure(
            syncResult,
            `Stock sync failed for product ${pid}`,
          );
        }
        stockSyncResults.push({
          product_id: syncResult.product_id,
          stock_synced: syncResult.stock_synced,
          previous_stock: syncResult.product?.previous_stock,
          stock: syncResult.product?.stock,
          net_qty: syncResult.net_qty,
          qty_in: syncResult.qty_in,
          qty_out: syncResult.qty_out,
        });

        const onHandAfterSync = Number(syncResult.product?.stock);
        const alertResult = await evaluateProductStockAlert({
          req,
          productId: String(pid),
          companyId: companyIdForStock,
          onHand: onHandAfterSync,
          pathQty: onHandAfterSync,
          session: mongoSession,
          logUrl: req.originalUrl || req.path || "/api/purchase_return/update",
        });
        if (!alertResult.success) {
          throw new Error(
            alertResult.message ||
              alertResult.error ||
              "Product stock alert check failed",
          );
        }
      }

      prLineReplaceSnapshot = {
        previous_product_ids,
        new_product_ids,
        stock_sync: stockSyncResults,
      };

      await PurchaseReturn.syncHeaderTotalsFromLineItems(prId, {
        session: mongoSession || undefined,
      });
    } else {
      // No new lines in payload: header totals still reconciled from existing `purchase_return_item` rows.
      await PurchaseReturn.syncHeaderTotalsFromLineItems(prId, {
        session: mongoSession || undefined,
      });
    }
  };

  try {
    clientSession = await mongoose.startSession();
    await clientSession.withTransaction(async () => {
      await runPurchaseReturnUpdateBody(clientSession);
    });
  } catch (e) {
    // Same standalone retry pattern as `purchaseReturnCreate` / `order_save`.
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
        "[purchase_return] MongoDB transactions unavailable (e.g. standalone mongod); continuing without transaction",
      );
      try {
        response = null;
        await runPurchaseReturnUpdateBody(null);
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

  // Failure path — `logs` row (`PURCHASE RETURN UPDATE ROLLBACK`) + client JSON.
  if (txnError) {
    await logRollbackFailure(req, txnError, {
      action: "PURCHASE RETURN UPDATE ROLLBACK",
      tags: ["api", "purchase_return", "rollback", "update"],
      fallbackUrl: "/api/purchase_return/update",
    });
    if (txnError.clientErrorPayload) {
      const p = txnError.clientErrorPayload;
      return res.status(p.status || 400).json({
        success: false,
        message: "Purchase return update rolled back",
        ...p,
      });
    }
    const msg = String(txnError.message || "");
    const is400 =
      msg.includes("Post-purchase_return") ||
      msg.includes("company_id is required") ||
      msg.includes("Validation failed") ||
      msg.includes("Missing required fields");
    return res.status(is400 ? 400 : 500).json({
      success: false,
      status: is400 ? 400 : 500,
      error: "Purchase return update rolled back",
      details: txnError.message,
    });
  }

  if (!response || !response.success || !response.data) {
    return res
      .status(response && response.status ? response.status : 400)
      .json(response);
  }

  const prId = response.data._id;

  // Success: reload lines + header for shaped `data` (post-txn read; not inside the session).
  const items = await PurchaseReturnItem.find({
    purchase_return_id: prId,
    status: "active",
    deletedAt: null,
  })
    .populate("product_id")
    .sort({ createdAt: 1 })
    .lean();

  const prFresh = await PurchaseReturn.findById(prId).lean();
  const data = shapePurchaseReturnWithItems(prFresh || response.data, items);

  return res.status(200).json({
    success: true,
    status: 200,
    data,
    wholesale_updates: [], // reserved; create may populate wholesale side-effects in future
    ...(prLineReplaceSnapshot ? { line_replace: prLineReplaceSnapshot } : {}),
  });
}

module.exports = {
  purchaseReturnCreate,
  purchase_return_update,
  getPurchaseReturnByReturnItem,
  getPurchaseReturnByReturnNo,
  // purchase_orderUpdate,
  // purchase_orderById,
  // getAllpurchase_order,
  // getallpurchase_orderactive,
  // purchase_orderdelete,
  // findActiveBlogByTitle,
  // findBlogByParams,
};
