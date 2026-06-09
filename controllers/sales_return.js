const mongoose = require("mongoose");
const SalesReturn = require("../models/sales_return");
const SalesReturnItem = require("../models/sales_return_item");
require("../models/order");
const Product = require("../models/product");
const WarehouseInventory = require("../models/warehouse_inventory");

const Account = require("../models/account");
const Company = require("../models/company");
const Transaction = require("../models/transaction");
const InventoryMovements = require("../models/inventory_movements");

const {
  createTransactionsFromItems: transactionBulkCreate,
} = require("./transaction");
const { logRollbackFailure } = require("../utils/logControllerError");
const { createApplicationLog } = require("../utils/applicationLogs");
const { generateTransactionNumber } = require("../utils/transactionNumber");
const {
  handleGenericCreate,
  handleGenericUpdate,
  handleGenericGetAll,
  coalesceObjectId,
  buildPopulateFromQuery,
  activeNotDeletedCriteria,
} = require("../utils/modelHelper");
const {
  insertInventoryMovementRecord,
  syncProductStockFromMovementLedger,
} = require("./inventory_movements");
const { evaluateProductStockAlert } = require("./alerts");
const {
  isMongoTransactionUnsupportedError,
} = require("../utils/mongoTransactionSupport");

/**
 * Sales return HTTP handlers: header + line items, inventory movement ledger (`inventory_movements` only),
 * and five GL postings per return (reversed vs order — see transactionBulkCreate payloads).
 *
 * Standalone MongoDB: tries `withTransaction` first; on replica-set–only errors, retries without a session.
 */

/**
 * One entry per row sent to `transactionBulkCreate` in afterCreate/afterUpdate (order matters).
 * - `companyAccountField`: populated on `req.user.company_id` (auth middleware).
 * - `srAccountField`: optional field on the sales_return document for that row’s `account_id`.
 */
const SALES_RETURN_GL_LINE_META = [
  {
    description: "Sales Return (debit)",
    srAccountField: null,
    companyAccountField: "default_sales_account",
  },
  {
    description: "Sales Return Shipment (debit)",
    srAccountField: null,
    companyAccountField: "default_shipping_account",
  },
  {
    description: "Sales Return Discount (credit)",
    srAccountField: null,
    companyAccountField: "default_sales_discount_account",
  },
  {
    description: "Mode of Payment (credit)",
    srAccountField: "payment_method_accounts_id",
    companyAccountField: "default_cash_account",
  },
  {
    description: "Accounts Receivable (credit)",
    srAccountField: null,
    companyAccountField: "default_account_receivable_account",
  },
];

/** Legacy tenants: resolve GL ids by signup COA name when `company.default_*` was never set. */
const SR_GL_ACCOUNT_NAME_FALLBACKS = {
  default_sales_account: /^sales$/i,
  default_shipping_account: /^shipping$/i,
  default_sales_discount_account: /^sales discount$/i,
  default_cash_account: /^cash$/i,
  default_account_receivable_account: /^accounts receivable$/i,
};

const SR_GL_ACCOUNT_TYPE_FALLBACKS = {
  default_sales_account: "revenue",
  default_shipping_account: "operating_expense",
  default_sales_discount_account: "other",
  default_cash_account: "current_asset",
  default_account_receivable_account: "account_receivable",
};

function pickObjectId(value) {
  return coalesceObjectId(value);
}

function activeAccountFilter(companyId) {
  return {
    company_id: companyId,
    status: "active",
    ...activeNotDeletedCriteria(),
  };
}

async function findCompanyAccountByName(
  companyId,
  namePattern,
  session = null,
) {
  let q = Account.findOne({
    ...activeAccountFilter(companyId),
    name: namePattern,
  })
    .select("_id name")
    .sort({ createdAt: 1 });
  if (session) q = q.session(session);
  return q.lean();
}

async function findCompanyAccountByType(
  companyId,
  accountType,
  session = null,
) {
  let q = Account.findOne({
    ...activeAccountFilter(companyId),
    account_type: accountType,
  })
    .select("_id name")
    .sort({ createdAt: 1 });
  if (session) q = q.session(session);
  return q.lean();
}

async function resolveOneCompanyGlAccount(
  companyId,
  field,
  companyDoc,
  session = null,
) {
  const fromCompany = pickObjectId(companyDoc?.[field]);
  if (fromCompany && mongoose.Types.ObjectId.isValid(String(fromCompany))) {
    return fromCompany;
  }

  const namePattern = SR_GL_ACCOUNT_NAME_FALLBACKS[field];
  if (namePattern) {
    const byName = await findCompanyAccountByName(
      companyId,
      namePattern,
      session,
    );
    if (byName?._id) return pickObjectId(byName._id);
  }

  const accountType = SR_GL_ACCOUNT_TYPE_FALLBACKS[field];
  if (accountType) {
    const byType = await findCompanyAccountByType(
      companyId,
      accountType,
      session,
    );
    if (byType?._id) return pickObjectId(byType._id);
  }

  return null;
}

/**
 * Resolve five company GL account ids for SR postings. Heals missing `company.default_*`
 * from signup COA names/types when found (same pattern as adjustment create).
 */
async function resolveSalesReturnGlAccounts(orderReq, session = null) {
  const companyDoc = orderReq?.user?.company_id;
  const companyId = pickObjectId(companyDoc);
  if (!companyId) {
    const err = new Error(
      "company_id is required for sales return GL postings",
    );
    err.statusCode = 400;
    throw err;
  }

  const resolved = {};
  const patch = {};
  for (const meta of SALES_RETURN_GL_LINE_META) {
    const field = meta.companyAccountField;
    if (!field) continue;
    const id = await resolveOneCompanyGlAccount(
      companyId,
      field,
      companyDoc,
      session,
    );
    resolved[field] = id;
    if (id && !pickObjectId(companyDoc?.[field])) {
      patch[field] = id;
    }
  }

  if (Object.keys(patch).length) {
    await Company.updateOne(
      { _id: companyId },
      { $set: patch },
      session ? { session } : {},
    );
    if (companyDoc && typeof companyDoc === "object") {
      for (const [key, value] of Object.entries(patch)) {
        companyDoc[key] = value;
      }
    }
  }

  const missing = SALES_RETURN_GL_LINE_META.filter(
    (meta) => meta.companyAccountField && !resolved[meta.companyAccountField],
  ).map((meta) => `company.${meta.companyAccountField}`);

  if (missing.length) {
    const err = new Error(
      `Configure company default GL accounts (${missing.join(", ")}). ` +
        "Create chart-of-accounts rows or set defaults on the company record.",
    );
    err.statusCode = 400;
    err.details = { missing_company_fields: missing };
    throw err;
  }

  return resolved;
}

/** Five GL rows for create/update — order must match SALES_RETURN_GL_LINE_META. */
function buildSalesReturnGlTransactionItems(
  record,
  transaction_number,
  remainingAmount,
  glAccounts,
) {
  return [
    {
      account_id: glAccounts.default_sales_account,
      type: "debit",
      amount: record?.lines_subtotal ?? 0,
      reference_user_id: record?.customer_id,
      transaction_number,
      description: "Sales Return",
      reference_id: {
        module: "sales_return",
        ref_id: record._id,
      },
    },
    {
      account_id: glAccounts.default_shipping_account,
      type: "debit",
      amount: record?.shipment ?? 0,
      reference_user_id: record?.customer_id,
      transaction_number,
      description: "Sales Shipment",
      reference_id: {
        module: "sales_return",
        ref_id: record._id,
      },
    },
    {
      account_id: glAccounts.default_sales_discount_account,
      type: "credit",
      amount: record?.discount ?? 0,
      reference_user_id: record?.customer_id,
      transaction_number,
      description: "Sales Discount",
    },
    {
      account_id: record?.payment_method_accounts_id,
      type: "credit",
      amount: record?.lines_subtotal ?? 0,
      reference_user_id: record?.customer_id,
      transaction_number,
      description: "Mode of Payment",
      reference_id: {
        module: "sales_return",
        ref_id: record._id,
      },
    },
    {
      account_id: glAccounts.default_account_receivable_account,
      type: "credit",
      amount: remainingAmount || 0,
      reference_user_id: record?.customer_id,
      transaction_number,
      description: "A/c Receivable",
      reference_id: {
        module: "sales_return",
        ref_id: record._id,
      },
    },
  ];
}

/** Human-readable hint for API errors: which company / body fields to set for a failed GL row. */
function salesReturnGlLineFixHint(meta) {
  if (!meta) {
    return "Configure company default GL accounts and return payment fields.";
  }
  const parts = [];
  if (meta.companyAccountField) {
    parts.push(`company.${meta.companyAccountField}`);
  }
  if (meta.srAccountField) {
    parts.push(`sales_return.body.${meta.srAccountField}`);
  }
  return parts.length ? `Set ${parts.join(" or ")}.` : "Configure GL accounts.";
}

/**
 * Augment bulk-create `failed` entries with line label, normalized missing list, and fix hints.
 * Keeps original keys (`index`, `missing`, …) for backward compatibility.
 */
function enrichSalesReturnGlFailures(failed) {
  if (!Array.isArray(failed)) return [];
  return failed.map((f) => {
    const idx = Number(f.index);
    const meta =
      Number.isFinite(idx) && idx >= 0 ? SALES_RETURN_GL_LINE_META[idx] : null;
    const missing = Array.isArray(f.missing) ? f.missing : [];
    return {
      ...f,
      gl_line_index: idx,
      gl_line_description: meta?.description ?? `GL row ${idx}`,
      missing_fields: missing,
      where_to_fix: salesReturnGlLineFixHint(meta),
      message: f.message,
      error: f.error,
    };
  });
}

/** Single readable sentence for logs and `Error.message` (API error field). */
function formatSalesReturnGlBulkErrorMessage(enriched) {
  const lines = enriched.map((e) => {
    const miss =
      e.missing_fields?.length ?
        ` — missing: ${e.missing_fields.join(", ")}`
      : "";
    const reason =
      e.message && e.message !== e.error ? ` — ${e.message}`
      : e.error && !String(e.error).startsWith("Post-sales_return") ?
        ` — ${e.error}`
      : "";
    return `index ${e.gl_line_index} «${e.gl_line_description}»${miss}${reason}. ${e.where_to_fix}`;
  });
  return `Post-sales_return transaction bulk insert failed. ${lines.join(" | ")}`;
}

/** Per-step wall-clock timings for `salesReturnCreate` (see JSDoc steps 1–20). */
function startSrCreateStepTimer() {
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
    log(logTag = "[sales_return_create]") {
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
async function throwSalesReturnGlBulkFailed(_orderReq, failed) {
  const enriched = enrichSalesReturnGlFailures(failed);
  const msg = formatSalesReturnGlBulkErrorMessage(enriched);
  console.error(
    "⚠️ Post-sales_return transaction bulk insert failed:",
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
      message: fallbackError || "Request failed",
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

  if (!out.message) {
    if (Array.isArray(out.details) && out.details.length) {
      out.message = out.details
        .map((d) =>
          typeof d === "string" ? d
          : d?.field ? `${d.field}: ${d.message}`
          : String(d?.message ?? d),
        )
        .filter(Boolean)
        .join("; ");
    } else if (typeof out.details === "string" && out.details.trim()) {
      out.message = out.details.trim();
    } else if (Array.isArray(out.missing) && out.missing.length) {
      out.message = `Missing required fields: ${out.missing.join(", ")}`;
    }
  }
  if (!out.message) {
    out.message = out.error;
  }

  return out;
}

/** Prefer validation `details` / `missing` strings for thrown Error.message (retry detection looks at message too). */
function logMessageFromGenericFailure(response, fallbackError) {
  const r = response || {};
  if (typeof r.message === "string" && r.message.trim()) {
    return r.message.trim();
  }
  if (Array.isArray(r.details) && r.details.length) {
    return r.details
      .map((d) =>
        typeof d === "string" ? d
        : d?.field ? `${d.field}: ${d.message}`
        : String(d?.message ?? d),
      )
      .filter(Boolean)
      .join("; ");
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

function salesReturnLinesSubtotalSum(lineItems) {
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

/** `sales_return_item` requires shipping fields; default when omitted (legacy payloads). */
function normalizeLineShippingFields(line) {
  const spu = parseFloat(String(line?.shipping_per_unit ?? "").trim());
  const ts = parseFloat(String(line?.total_shipping ?? "").trim());
  return {
    shipping_per_unit: Number.isFinite(spu) ? spu : 0,
    total_shipping: Number.isFinite(ts) ? ts : 0,
  };
}

function normalizeSalesReturnNumericFields(obj) {
  const out = { ...obj };
  for (const key of [
    "discount",
    "shipment",
    "lines_subtotal",
    "total_amount",
    "amount_refunded",
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
function ensureSalesReturnHeaderFields(_body, _user) {}

/**
 * Fills `payment_method_accounts_id` from `company.default_cash_account` when absent/invalid,
 * so the “Mode of Payment” transaction (bulk index 3) always has an `account_id` when possible.
 */
function resolveSrPaymentMethodAccount(body, user) {
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

function buildSalesReturnItemDocuments(prId, prSnapshot, lines, req) {
  const companyId = prSnapshot.company_id || req.user?.company_id;
  if (!companyId || !mongoose.Types.ObjectId.isValid(String(companyId))) {
    return {
      docs: [],
      error:
        "company_id is required on sales return line items (set on the return or authenticated user)",
    };
  }
  const userId = req.user?._id;
  const docs = [];
  for (const line of lines) {
    const doc = {
      sales_return_id: prId,
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

/** Soft-delete active GL rows for one `transaction_number` (PR update / delete). */
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

function resolveDefaultWarehouseId(req) {
  const co = req?.user?.company_id;
  if (!co || typeof co !== "object") return null;
  return coalesceObjectId(co.warehouse_id);
}

function warehouseStockKey(productId, warehouseId) {
  return `${String(productId).trim()}:${String(warehouseId).trim()}`;
}

function buildMovementQtyMapFromMovements(movements) {
  const map = new Map();
  for (const mov of movements || []) {
    const pid = mov.product_id != null ? String(mov.product_id).trim() : "";
    const wid = mov.warehouse_id != null ? String(mov.warehouse_id).trim() : "";
    const qty = Number(mov.quantity);
    if (
      !pid ||
      !mongoose.Types.ObjectId.isValid(pid) ||
      !wid ||
      !mongoose.Types.ObjectId.isValid(wid) ||
      !Number.isFinite(qty) ||
      qty <= 0
    ) {
      continue;
    }
    const key = warehouseStockKey(pid, wid);
    map.set(key, Math.round(((map.get(key) || 0) + qty) * 100) / 100);
  }
  return map;
}

function findPriorWarehouseForProduct(oldMap, productIdStr) {
  const prefix = `${String(productIdStr).trim()}:`;
  for (const key of oldMap.keys()) {
    if (key.startsWith(prefix)) return key.split(":")[1];
  }
  return null;
}

/**
 * Delete / void sales return: reverse inbound stock and insert reversal `out` movements
 * from prior `in` snapshot (SR create posts inbound stock when customer returns goods).
 */
async function applySalesReturnDeleteInventoryRestore({
  oldInMovements,
  existingReturnItems,
  salesReturnId,
  companyId,
  req,
  mongoSession = null,
  logUrl = "/api/sales_return/sales_return_delete",
}) {
  const oldMap = buildMovementQtyMapFromMovements(oldInMovements);

  if (oldMap.size === 0 && (existingReturnItems || []).length > 0) {
    const defaultWarehouseId = resolveDefaultWarehouseId(req);
    for (const item of existingReturnItems) {
      const pid = item.product_id != null ? String(item.product_id).trim() : "";
      const qty = Number(item.qty);
      if (
        !pid ||
        !mongoose.Types.ObjectId.isValid(pid) ||
        !Number.isFinite(qty) ||
        qty <= 0
      ) {
        continue;
      }
      const wid =
        (
          item.warehouse_id != null &&
          mongoose.Types.ObjectId.isValid(String(item.warehouse_id).trim())
        ) ?
          String(item.warehouse_id).trim()
        : findPriorWarehouseForProduct(oldMap, pid) ||
          ((
            defaultWarehouseId &&
            mongoose.Types.ObjectId.isValid(String(defaultWarehouseId))
          ) ?
            String(defaultWarehouseId).trim()
          : null);
      if (!wid) continue;
      const key = warehouseStockKey(pid, wid);
      oldMap.set(key, Math.round(((oldMap.get(key) || 0) + qty) * 100) / 100);
    }
  }

  const priceByProduct = new Map();
  for (const item of existingReturnItems || []) {
    const pid = item.product_id != null ? String(item.product_id).trim() : "";
    if (!pid || priceByProduct.has(pid)) continue;
    const p = Number(item.price);
    if (Number.isFinite(p) && p >= 0) {
      priceByProduct.set(pid, p);
    }
  }

  const productStockUpdates = [];
  let reversalMovementsInserted = 0;

  for (const [key, lineQtyNum] of oldMap.entries()) {
    const [productIdStr, warehouseIdStr] = key.split(":");
    const unitCost = Number(priceByProduct.get(productIdStr));
    if (!Number.isFinite(unitCost) || unitCost < 0) {
      throw new Error(
        `Each return line needs a finite unit price (price) for inventory reversal (product ${productIdStr})`,
      );
    }

    try {
      const whChange = await WarehouseInventory.applyQuantityDelta({
        productId: productIdStr,
        warehouseId: warehouseIdStr,
        companyId,
        qtyDelta: -lineQtyNum,
        userId: req.user?._id,
        session: mongoSession,
      });
      if (whChange) {
        productStockUpdates.push({
          ...whChange,
          source: "warehouse_inventory",
          qty_delta_reason: "sales_return_delete_reverse",
        });
      }
    } catch (whErr) {
      const whMsg = String(
        whErr?.message || "Warehouse inventory reversal failed",
      );
      const mapped = new Error(whMsg);
      mapped.clientErrorPayload = {
        success: false,
        status: 400,
        error: "Warehouse inventory reversal failed",
        message: whMsg,
        details: whMsg,
        type: "validation",
        product_id: productIdStr,
        warehouse_id: warehouseIdStr,
        qty_reverse: lineQtyNum,
      };
      throw mapped;
    }

    await insertSalesReturnInventoryMovement(req, {
      productId: productIdStr,
      warehouseId: warehouseIdStr,
      quantity: lineQtyNum,
      unitCost,
      referenceId: salesReturnId,
      referenceName: "Sales Return Delete",
      companyId,
      mongoSession,
      movementType: "out",
    });
    reversalMovementsInserted += 1;
  }

  const summary = summarizeLineStockByProduct(existingReturnItems || []);
  for (const [productIdStr, info] of summary) {
    if (info.hasWarehouseLine) {
      const syncResult = await syncProductStockFromMovementLedger(
        productIdStr,
        companyId,
        { req, mongoSession, logUrl },
      );
      if (!syncResult.success) {
        throw new Error(
          syncResult.message ||
            syncResult.error ||
            "Product stock sync from ledger failed",
        );
      }
      productStockUpdates.push({
        product_id: productIdStr,
        source: "ledger_sync",
        previous_stock: syncResult.product?.previous_stock,
        stock: syncResult.product?.stock,
        qty_in: syncResult.qty_in,
        qty_out: syncResult.qty_out,
        warehouses: syncResult.warehouses,
      });
    }
    if (info.qtyWithoutWarehouse > 0) {
      const bump = await decrementProductStockForReturnLineDelete({
        productId: productIdStr,
        lineQty: info.qtyWithoutWarehouse,
        companyId,
        mongoSession,
      });
      productStockUpdates.push({ ...bump, source: "product_stock_reverse" });
    }
  }

  return { productStockUpdates, reversalMovementsInserted };
}

async function insertSalesReturnInventoryMovement(
  req,
  {
    productId,
    warehouseId,
    quantity,
    unitCost,
    referenceId,
    referenceName,
    companyId,
    mongoSession,
    movementType = "in",
  },
) {
  const allocQty = Number(quantity);
  const totalCostMovement = Math.round(allocQty * unitCost * 100) / 100;
  const bodyBeforeInventoryMovement = req.body;
  const hadRouteParamId = Object.prototype.hasOwnProperty.call(
    req.params,
    "id",
  );
  const savedRouteParamId = hadRouteParamId ? req.params.id : undefined;

  req.body = {
    product_id: String(productId).trim(),
    warehouse_id: String(warehouseId).trim(),
    quantity: allocQty,
    movement_type: movementType,
    unit_cost: unitCost,
    total_cost: totalCostMovement,
    reference_type: "sales_return",
    reference_id: referenceId,
    reference_name: referenceName,
    company_id: companyId,
    status: "active",
  };

  try {
    await insertInventoryMovementRecord(req, mongoSession);
  } finally {
    req.body = bodyBeforeInventoryMovement;
    if (hadRouteParamId) {
      req.params.id = savedRouteParamId;
    } else {
      delete req.params.id;
    }
  }
}

/**
 * Inbound return line: add qty to line warehouse, then one inventory_movements `in` row.
 */
async function applySalesReturnInboundForLine({
  line,
  referenceId,
  referenceName = "Sales Return",
  companyId,
  req,
  mongoSession = null,
}) {
  const productIdStr = String(line.product_id ?? "").trim();
  const lineQtyNum = Number(line.qty);
  const unitCost = Number(line.price);

  if (
    !productIdStr ||
    !mongoose.Types.ObjectId.isValid(productIdStr) ||
    !Number.isFinite(lineQtyNum) ||
    lineQtyNum <= 0
  ) {
    throw new Error(
      "Each sales return line needs a valid product_id and positive qty",
    );
  }
  if (!Number.isFinite(unitCost) || unitCost < 0) {
    throw new Error(
      "Each return line needs a finite unit price (price) and positive quantity for inventory movement",
    );
  }

  const warehouseIdStr =
    line.warehouse_id != null ? String(line.warehouse_id).trim() : "";
  if (!warehouseIdStr || !mongoose.Types.ObjectId.isValid(warehouseIdStr)) {
    return [];
  }

  let whChange;
  try {
    whChange = await WarehouseInventory.applyQuantityDelta({
      productId: productIdStr,
      warehouseId: warehouseIdStr,
      companyId,
      qtyDelta: lineQtyNum,
      userId: req.user?._id,
      session: mongoSession,
    });
  } catch (err) {
    if (err.clientPayload) {
      throwWithGenericFailure(
        err.clientPayload,
        "Warehouse inventory update for sales return line failed",
      );
    }
    throw err;
  }

  await insertSalesReturnInventoryMovement(req, {
    productId: productIdStr,
    warehouseId: warehouseIdStr,
    quantity: lineQtyNum,
    unitCost,
    referenceId,
    referenceName,
    companyId,
    mongoSession,
    movementType: "in",
  });

  return whChange ? [{ ...whChange, source: "warehouse_inventory" }] : [];
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
 * add non-warehouse line qty via `incrementProductStockForReturnLine` (matches update + legacy create).
 */
async function reconcileProductStockAfterSrCreate({
  lines,
  companyId,
  mongoSession,
  req,
  srStepTimer = null,
}) {
  const productStockUpdates = [];
  const stockByProductId = new Map();
  const logUrl =
    req.originalUrl || req.path || "/api/sales_return/sales_return_create";
  const summary = summarizeLineStockByProduct(lines);

  for (const [productIdStr, info] of summary) {
    let onHand = null;

    if (info.hasWarehouseLine) {
      const endSync = srStepTimer?.start(
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
      const endBump = srStepTimer?.start(
        3,
        "product stock decrement (no warehouse)",
        {
          product_id: productIdStr,
          qty: info.qtyWithoutWarehouse,
        },
      );
      const bump = await incrementProductStockForReturnLine({
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

function shapeSalesReturnWithItems(prPlain, items) {
  const sales_return_items_total = items.reduce((sum, item) => {
    const sub = Number(item.subtotal);
    return sum + (Number.isFinite(sub) ? sub : 0);
  }, 0);
  return {
    ...prPlain,
    sales_return_items: items,
    no_of_items: items.length,
    sales_return_items_total,
  };
}

/**
 * Read `product.stock`, add return line qty for lines without warehouse (after inbound movement).
 */
async function incrementProductStockForReturnLine({
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

  const qtyToAdd = Number(lineQty);
  if (!Number.isFinite(qtyToAdd) || qtyToAdd <= 0) {
    throw new Error(
      "Each sales return line needs a positive quantity to update product stock",
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
  const nextStock = Math.round((previousStock + qtyToAdd) * 100) / 100;

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
    qty_added: qtyToAdd,
  };
}

/** Inverse of `incrementProductStockForReturnLine` — subtract qty when voiding a return. */
async function decrementProductStockForReturnLineDelete({
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
      "Each sales return line needs a positive quantity to reverse product stock",
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

async function getSalesReturnByReturnItem(req, res) {
  const idParam =
    req.params && req.params.id != null ? String(req.params.id).trim() : "";

  if (idParam && !mongoose.Types.ObjectId.isValid(idParam)) {
    return res.status(400).json({
      success: false,
      status: 400,
      error: "Invalid id",
      details: "id must be a valid sales_return ObjectId",
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

  const response = await handleGenericGetAll(req, "sales_return", {
    filter,
    excludeFields: [],
    sort: { createdAt: -1 },
    // ?populate=customer_id:name → populated vendor with only `name` (+ _id). Comma-separate paths; use path:fields for projection.
    populate: buildPopulateFromQuery(req.query || {}, "sales_return"),

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
      details: `sales_return with id "${idParam}" not found`,
      type: "not_found",
    });
  }

  const prIds = response.data.map((o) => o._id).filter(Boolean);
  if (prIds.length === 0) {
    return res.status(response.status).json(response);
  }

  const itemFilter = {
    sales_return_id: { $in: prIds },
    status: "active",
    deletedAt: null,
  };
  const items = await SalesReturnItem.find(itemFilter)
    .populate("product_id")
    .sort({ createdAt: 1 })
    .lean();

  const itemsBySrId = new Map();
  for (const id of prIds) {
    itemsBySrId.set(String(id), []);
  }
  for (const item of items) {
    const key = String(item.sales_return_id);
    if (!itemsBySrId.has(key)) {
      itemsBySrId.set(key, []);
    }
    itemsBySrId.get(key).push(item);
  }

  const data = response.data.map((po) => {
    const sales_return_items = itemsBySrId.get(String(po._id)) || [];
    const sales_return_items_total = sales_return_items.reduce((sum, row) => {
      const sub = Number(row.subtotal);
      return sum + (Number.isFinite(sub) ? sub : 0);
    }, 0);
    return {
      ...po,
      sales_return_items,
      no_of_items: sales_return_items.length,
      sales_return_items_total,
    };
  });

  return res.status(response.status).json({
    ...response,
    data,
  });
}

async function getSalesReturnByReturnNo(req, res) {
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
  const popFields = buildPopulateFromQuery(req.query || {}, "sales_return");
  const findOneSr = (extraFilter) => {
    let q = SalesReturn.findOne({ ...extraFilter, ...filter });
    for (const spec of popFields) {
      if (typeof spec === "string") {
        q = q.populate(spec);
      } else if (spec && typeof spec === "object" && spec.path) {
        q = q.populate(spec);
      }
    }
    return q;
  };

  let po = await findOneSr({ sales_return_no: param });
  if (!po && mongoose.Types.ObjectId.isValid(param)) {
    po = await findOneSr({ _id: param });
  }

  if (!po) {
    return res.status(404).json({
      success: false,
      status: 404,
      error: "Record not found",
      details: `sales_return with sales_return_no or id "${param}" not found`,
      type: "not_found",
    });
  }

  const items = await SalesReturnItem.find({
    sales_return_id: po._id,
    status: "active",
    deletedAt: null,
  })
    .populate("product_id")
    .sort({ createdAt: 1 })
    .lean();

  const data = shapeSalesReturnWithItems(
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
 * POST /api/sales_return/sales_return_create
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
 * |    1 | purchase_order          | insert             | one          | low    | `handleGenericCreate` (header; model may assign `order_no`) |
 * |    2 | transaction             | insert             | many (5)     | medium | `transactionBulkCreate` in `afterCreate` — purchase, shipment, discount, payment, A/P |
 * |    3 | product                 | read / update      | one × P      | medium | `syncProductStockFromMovementLedger` (+ bump if no warehouse qty) |
 * |    5 | sales_return_item     | insert             | many (1×)    | medium | `insertMany` via `buildSalesReturnItemDocuments` |
 * |    6 | inventory_movements     | insert             | one × N      | low    | `insertInventoryMovementRecord` — one row per warehouse line |
 * |    7 | product                 | read               | one × P      | medium | `evaluateProductStockAlert` — one read per distinct product |
 * |    8 | alerts                  | read               | one × P      | low    | Skip insert when active alert already exists |
 * |    9 | alerts                  | insert or update   | one × P      | low    | Insert alert when low; soft-delete when above threshold |
 * |   10 | logs                    | insert             | one × P      | low    | Stock alert audit when `alert_qty` > 0 |
 * |   11 | sales_return_item     | read               | many         | medium | `syncHeaderTotalsFromLineItems` — single aggregation over return lines |
 * |   12 | sales_return          | read               | one          | low    | `syncHeaderTotalsFromLineItems` — load discount/shipment |
 * |   13 | sales_return          | update             | one          | low    | `syncHeaderTotalsFromLineItems` — set `lines_subtotal`, `total_amount` |
 * |   14 | sales_return          | read               | one          | low    | `findById` for response payload |
 * |   15 | logs                    | insert             | one          | low    | `logRollbackFailure` — failure path only |
 *
 * Header-only create (no lines): steps 1–2 only; skips 3–18. L = line count; N = lines with valid `warehouse_id`; P = distinct `product_id` on lines.
 */
async function salesReturnCreate(req, res) {
  const originalRequestBody = req.body;
  const lineItemsFromClient = collectLineItems(originalRequestBody);
  let srStepTimer = null;

  try {
    // `handleGenericCreate` reads `req.body`; strip embedded line payloads and coerce numeric header fields.
    req.body = normalizeSalesReturnNumericFields(
      stripLineItemKeysFromBody(originalRequestBody),
    );
    delete req.body._id;
    // Unique per company (partial index). Model pre-save assigns next `PO-####` when absent.
    // Drop client `order_no` so double-submit / fixed defaults cannot collide.
    delete req.body.sales_return_no;
    ensureSalesReturnHeaderFields(req.body, req.user);
    // Mode-of-payment GL row needs `payment_method_accounts_id`; same fallback pattern as order / POS flows.
    resolveSrPaymentMethodAccount(req.body, req.user);

    req.body.lines_subtotal = salesReturnLinesSubtotalSum(lineItemsFromClient);

    const transaction_number = generateTransactionNumber();
    req.body.transaction_number = transaction_number;

    let mongooseClientSession = null;
    let salesReturnCreateResult = null;
    const persistedLineItems = [];
    const productStockUpdates = [];
    /** Set when `withTransaction` fails for a non–transaction-support reason, or when the non-session retry throws. */
    let createPipelineError = null;
    srStepTimer = startSrCreateStepTimer();

    /** Pass-through for `handleGenericCreate` / inventory helpers: include `session` only when a transaction is active. */
    const modelHelperOptions = (mongoSession) =>
      mongoSession ? { session: mongoSession } : {};

    /**
     * Runs inside one logical unit: sales return document, GL postings, each `sales_return_item`, optional outbound inventory ledger,
     * then header aggregate fields. Mutates outer `salesReturnCreateResult` and `persistedLineItems`.
     *
     * @param {object | null} mongoSession Mongoose client session when in a transaction; null on standalone mongod.
     */
    const runSalesReturnCreateBody = async (mongoSession) => {
      const srGlAccounts = await resolveSalesReturnGlAccounts(
        req,
        mongoSession,
      );
      if (
        !req.body.payment_method_accounts_id &&
        srGlAccounts.default_cash_account
      ) {
        req.body.payment_method_accounts_id = srGlAccounts.default_cash_account;
      }

      // step 1 start — purchase_order insert
      let step1Closed = false;
      let endStep1 = () => {};
      endStep1 = srStepTimer.start(1, "purchase_order insert");
      const closeStep1 = () => {
        if (!step1Closed) {
          step1Closed = true;
          endStep1();
        }
      };
      salesReturnCreateResult = await handleGenericCreate(req, "sales_return", {
        ...modelHelperOptions(mongoSession),
        afterCreate: async (record, orderReq, sess) => {
          closeStep1();
          // step 1 end
          // step 2 start — transaction insert ×5 (GL)
          const endStep2 = srStepTimer.start(2, "transaction insert ×5 (GL)");
          const { created, failed } = await transactionBulkCreate(
            orderReq,
            buildSalesReturnGlTransactionItems(
              record,
              transaction_number,
              req.body?.remaining_amount,
              srGlAccounts,
            ),
            { stopOnError: true, session: sess },
          );
          try {
            if (failed.length) {
              await throwSalesReturnGlBulkFailed(orderReq, failed);
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
      });
      if (!salesReturnCreateResult?.success || !salesReturnCreateResult.data) {
        closeStep1();
        throwWithGenericFailure(
          salesReturnCreateResult,
          "Sales return create failed",
        );
      }

      const newSalesReturnId = salesReturnCreateResult.data._id;
      // `req.user.company_id` may be populated `{ _id, ... }` from auth — normalize for line items / inventory.
      const companyId =
        coalesceObjectId(salesReturnCreateResult.data.company_id) ||
        coalesceObjectId(req.user?.company_id);

      // Header-only: steps 1–2 done; skip steps 3–19.
      if (lineItemsFromClient.length === 0) {
        return;
      }

      if (!companyId || !mongoose.Types.ObjectId.isValid(String(companyId))) {
        throw new Error(
          "company_id is required to create sales return line items",
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
            "Each sales return line needs a valid product_id and positive qty",
          );
        }
      }

      // step 5 start — sales_return_item insertMany
      const built = buildSalesReturnItemDocuments(
        newSalesReturnId,
        salesReturnCreateResult.data,
        lineItemsFromClient,
        req,
      );
      if (built.error) {
        throw new Error(built.error);
      }
      if (built.docs.length !== lineItemsFromClient.length) {
        throw new Error("Could not build sales return line documents");
      }

      const endStep5 = srStepTimer.start(5, "sales_return_item insertMany", {
        line_count: built.docs.length,
      });
      const insertedLineDocs = await SalesReturnItem.insertMany(
        built.docs,
        sessionOpts(mongoSession),
      );
      endStep5();
      persistedLineItems.push(...insertedLineDocs);
      // step 5 end

      // step 6–11 start — warehouse_inventory outbound + inventory_movements per line
      for (
        let lineIndex = 0;
        lineIndex < lineItemsFromClient.length;
        lineIndex++
      ) {
        const line = lineItemsFromClient[lineIndex];
        const endSteps611 = srStepTimer.start(
          6,
          "warehouse inbound + inventory_movements",
          { line_index: lineIndex },
        );
        try {
          const stockChanges = await applySalesReturnInboundForLine({
            line,
            referenceId: newSalesReturnId,
            referenceName: "Sales Return",
            companyId,
            req,
            mongoSession,
          });
          productStockUpdates.push(...stockChanges);
        } catch (inventoryMovementErr) {
          if (inventoryMovementErr.clientPayload) {
            throwWithGenericFailure(
              inventoryMovementErr.clientPayload,
              "Inventory movement for sales return failed",
            );
          }
          throw inventoryMovementErr;
        } finally {
          endSteps611();
        }
      }
      // step 6–11 end

      // step 3–4 start — product stock (ledger sync + non-warehouse bump)
      const stockReconcile = await reconcileProductStockAfterSrCreate({
        lines: lineItemsFromClient,
        companyId,
        mongoSession,
        req,
        srStepTimer,
      });
      productStockUpdates.push(...stockReconcile.productStockUpdates);
      // step 3–4 end

      // step 12–15 start — stock alerts per distinct product
      for (const [productIdStr, onHand] of stockReconcile.stockByProductId) {
        const endSteps1215 = srStepTimer.start(
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
            "/api/sales_return/sales_return_create",
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
      const endSteps1618 = srStepTimer.start(
        16,
        "syncHeaderTotalsFromLineItems (steps 16–18)",
      );
      await SalesReturn.syncHeaderTotalsFromLineItems(newSalesReturnId, {
        session: mongoSession,
      });
      endSteps1618();
      // step 16–18 end
    };

    // txn start — MongoDB transaction wrapper (or standalone retry)
    let endTxnWrap = () => {};
    endTxnWrap = srStepTimer.start("txn", "MongoDB transaction wrapper");
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
        await runSalesReturnCreateBody(mongooseClientSession);
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
          "[sales_return] MongoDB transactions unavailable (e.g. standalone mongod); continuing without transaction",
        );
        try {
          persistedLineItems.length = 0;
          productStockUpdates.length = 0;
          salesReturnCreateResult = null;
          srStepTimer.resetSteps();
          const endTxnRetry = srStepTimer.start(
            "txn",
            "pipeline retry (no Mongo transaction)",
          );
          await runSalesReturnCreateBody(null);
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
      const stepTimingsOnError = srStepTimer.log(
        "[sales_return_create] failed —",
      );
      console.error("Sales Return creation error:", createPipelineError);
      // Step 20 — logs insert (failure path)
      await logRollbackFailure(req, createPipelineError, {
        action: "SALES RETURN CREATE ROLLBACK",
        tags: ["api", "sales_return", "rollback", "create"],
        fallbackUrl: "/api/sales_return/sales_return_create",
      });
      // step 20 end
      if (createPipelineError.clientErrorPayload) {
        const p = createPipelineError.clientErrorPayload;
        return res.status(p.status || 400).json({
          ...p,
          success: false,
          message:
            p.message ||
            createPipelineError.message ||
            p.error ||
            "Sales return creation rolled back",
          step_timings_ms: stepTimingsOnError,
        });
      }
      const errorMessage = String(createPipelineError.message || "");
      const isGeneralLedgerRelatedError =
        errorMessage.includes("Post-sales_return") ||
        errorMessage.includes("company_id is required") ||
        errorMessage.includes("Configure company default GL accounts");
      const httpStatus =
        (
          createPipelineError.statusCode >= 400 &&
          createPipelineError.statusCode < 600
        ) ?
          createPipelineError.statusCode
        : isGeneralLedgerRelatedError ? 400
        : 500;
      return res.status(httpStatus).json({
        success: false,
        status: httpStatus,
        error:
          isGeneralLedgerRelatedError ?
            "Sales return creation rolled back"
          : "Failed to create sales return",
        message: errorMessage,
        details: createPipelineError.details ?? errorMessage,
        step_timings_ms: stepTimingsOnError,
      });
    }

    if (!salesReturnCreateResult?.success || !salesReturnCreateResult.data) {
      return res
        .status(salesReturnCreateResult?.status || 400)
        .json(salesReturnCreateResult);
    }

    const createdSalesReturnId = salesReturnCreateResult.data._id;

    if (lineItemsFromClient.length === 0) {
      const stepTimingsHeaderOnly = srStepTimer.log();
      return res.status(201).json({
        ...salesReturnCreateResult,
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
    const endStep19 = srStepTimer.start(
      19,
      "purchase_order read (response reload)",
    );
    const headerReloadedFromDb =
      await SalesReturn.findById(createdSalesReturnId).lean();
    endStep19();
    // step 19 end

    const stepTimingsMs = srStepTimer.log();

    return res.status(201).json({
      ...salesReturnCreateResult,
      status: 201,
      data: {
        ...salesReturnCreateResult.data,
        ...headerReloadedFromDb,
      },
      items: persistedLineItems,
      items_total,
      product_stock_updates: productStockUpdates,
      wholesale_updates: [],
      step_timings_ms: stepTimingsMs,
    });
  } catch (unexpectedError) {
    if (srStepTimer) {
      srStepTimer.log("[sales_return_create] unexpected —");
    }
    console.error("Sales Return creation error:", unexpectedError);
    // step 20 start — rollback log (outer catch)
    await logRollbackFailure(req, unexpectedError, {
      action: "SALES RETURN CREATE ROLLBACK",
      tags: ["api", "sales_return", "rollback", "create", "outer"],
      fallbackUrl: "/api/sales_return/sales_return_create",
    });
    // step 20 end
    return res.status(500).json({
      success: false,
      message: "Failed to create sales return",
      error: unexpectedError.message,
      ...(srStepTimer ? { step_timings_ms: srStepTimer.report() } : {}),
    });
  }
}

/**
 * PUT/PATCH sales return — header update, GL rebuild, optional full line replace + inventory replay.
 *
 * Flow: (1) parse `collectLineItems` from body, (2) normalize header on `req.body` (restore `originalBody`
 * before response), (3) `handleGenericUpdate` inside `session.withTransaction` when supported,
 * (4) in `afterUpdate`: soft-delete prior `transaction` rows for this return's `transaction_number`, soft-delete
 *     prior `inventory_movements` with `reference_type: purchase_order`, then insert five new GL lines
 *     (same order as `salesReturnCreate` / `SALES_RETURN_GL_LINE_META`),
 * (5) when client sends lines: replace all `sales_return_item` rows, post new `in` movements per line
 *     with `warehouse_id` via `insertInventoryMovementRecord`, then stock reconcile for
 *     every product on old or new lines (sets `product.stock` from ledger `available_qty`),
 * (6) `SalesReturn.syncHeaderTotalsFromLineItems`.
 *
 * Header-only update (no lines in body): keeps existing line items and does not touch inventory movements
 * in the post-update block (GL + movement soft-delete in `afterUpdate` still runs on every successful header save).
 *
 * Standalone `mongod`: retries `runSalesReturnUpdateBody` without a session (partial writes possible on failure).
 *
 * Collections (Mongo) — op = insert | update | delete | read; scope = one | many
 * Cost (relative): **low** = single cheap round-trip; **medium** = few docs or scales modestly;
 * **high** = bulk soft-delete, ledger replay, or per-line movement txn (see `salesReturnCreate` table).
 *
 * | Step | When                                          | Collection              | Op               | One or many  | Cost   | Notes |
 * |------|-----------------------------------------------|-------------------------|--------------------|--------------|--------|-------|
 * |    1 | Pre-txn (no lines in body)                    | sales_return_item     | read               | many         | medium | Sum subtotals → `lines_subtotal` on header |
 * |    2 | In txn — always                               | purchase_order          | update             | one          | low    | `handleGenericUpdate` (header fields) |
 * |    3 | In txn — always (`afterUpdate`)               | transaction             | update             | many         | medium | Soft-delete active rows for `transaction_number` |
 * |    4 | In txn — always (`afterUpdate`)               | transaction             | insert             | many (5)     | medium | `transactionBulkCreate` — new GL set |
 * |    5 | In txn — always (`afterUpdate`)               | inventory_movements     | update             | many         | high   | Soft-delete rows for this return `reference_id` |
 * |    6 | In txn — lines in body                        | sales_return_item     | read               | many         | low    | Snapshot before replace (`product_id`) |
 * |    7 | In txn — lines in body                        | sales_return_item     | delete             | many         | medium | `deleteMany` by `order_id` |
 * |    8 | In txn — lines in body                        | sales_return_item     | insert             | many         | medium | `insertMany` from `built.docs` |
 * |    9 | In txn — lines in body (per line w/ warehouse) | inventory_movements     | insert             | one × N      | low    | `insertInventoryMovementRecord` |
 * |   10 | In txn — lines in body (per line w/ warehouse) | product                 | update             | one × N      | medium | Optional `wholesale_price` on `in` (weighted avg) |
 * |   11 | In txn — lines in body (per line w/ warehouse) | logs                    | insert             | one × N      | low    | Movement + optional wholesale audit rows |
 * |   12 | In txn — lines in body                        | product                 | read / update      | one × P      | high   | `syncProductStockFromMovementLedger` (ledger + stock + log) |
 * |   13 | In txn — lines in body                        | logs                    | insert             | one × P      | low    | Stock-sync audit when stock changed (same session) |
 * |   14 | In txn — always                               | purchase_order          | update             | one          | medium | `syncHeaderTotalsFromLineItems` (`lines_subtotal`, `total_amount`) |
 * |   15 | Post-txn success                              | sales_return_item     | read               | many         | medium | Populate for response `data` |
 * |   16 | Post-txn success                              | purchase_order          | read               | one          | low    | Reload header for response |
 * |   17 | On failure                                    | logs                    | insert             | one          | low    | `logRollbackFailure` (`SALES RETURN UPDATE ROLLBACK`) |
 *
 * P = distinct product ids on old ∪ new lines. N = lines with valid `warehouse_id`. Does not call
 * `incrementProductStockForReturnLine` (create-only direct `product.stock` bump).
 */
async function sales_return_update(req, res) {
  const lines = collectLineItems(req.body);
  const originalBody = req.body;
  // `handleGenericUpdate` reads header fields only; strip embedded line keys from multipart / indexed payloads.
  req.body = normalizeSalesReturnNumericFields(
    stripLineItemKeysFromBody(originalBody),
  );
  delete req.body._id;
  // Mode-of-payment GL row needs `payment_method_accounts_id`; same fallback as create when client omits it.
  resolveSrPaymentMethodAccount(req.body, req.user);

  const recordId = String(req.params?.id || "").trim();
  if (lines.length > 0) {
    req.body.lines_subtotal = salesReturnLinesSubtotalSum(lines);
  } else if (recordId && mongoose.Types.ObjectId.isValid(recordId)) {
    // Header-only update: derive subtotal from persisted lines so GL purchase line amount stays correct.
    const existingItems = await SalesReturnItem.find({
      sales_return_id: recordId,
      status: "active",
      deletedAt: null,
    })
      .select("subtotal")
      .lean();
    req.body.lines_subtotal = salesReturnLinesSubtotalSum(existingItems);
  }

  let clientSession = null;
  let response = null;
  let txnError = null;
  /** Set when lines are replaced: product ids on old rows vs incoming `built.docs` + ledger stock sync. */
  let srLineReplaceSnapshot = null;

  /** @param {import("mongoose").ClientSession | null} mongoSession */
  const runSalesReturnUpdateBody = async (mongoSession) => {
    const srGlAccounts = await resolveSalesReturnGlAccounts(req, mongoSession);
    if (
      !req.body.payment_method_accounts_id &&
      srGlAccounts.default_cash_account
    ) {
      req.body.payment_method_accounts_id = srGlAccounts.default_cash_account;
    }

    response = await handleGenericUpdate(req, "sales_return", {
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
            reference_type: "sales_return",
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
          buildSalesReturnGlTransactionItems(
            record,
            transaction_number,
            req.body?.remaining_amount,
            srGlAccounts,
          ),
          { stopOnError: true, session: sess },
        );
        if (failed.length) {
          await throwSalesReturnGlBulkFailed(orderReq, failed);
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
      throwWithGenericFailure(response, "Sales return update failed");
    }

    const prId = response.data._id;

    if (lines.length > 0) {
      const built = buildSalesReturnItemDocuments(
        prId,
        response.data,
        lines,
        req,
      );
      if (built.error) {
        throw new Error(built.error);
      }

      // Snapshot existing lines before replace (for ledger stock sync and API metadata).
      let existingSrItemsQuery = SalesReturnItem.find({
        sales_return_id: prId,
        status: "active",
        deletedAt: null,
      }).select("product_id qty price subtotal");
      if (mongoSession) {
        existingSrItemsQuery = existingSrItemsQuery.session(mongoSession);
      }
      const existingSrItems = await existingSrItemsQuery.lean();

      const previous_product_ids =
        collectUniqueProductIdsFromLineRows(existingSrItems);
      const new_product_ids = collectUniqueProductIdsFromLineRows(built.docs);

      // Full line replace: delete all items for this return, then insert the new set from the request.
      await SalesReturnItem.deleteMany(
        { sales_return_id: prId },
        sessionOpts(mongoSession),
      );
      await SalesReturnItem.insertMany(built.docs, sessionOpts(mongoSession));

      // Outbound warehouse_inventory + ledger per line (split across warehouses when needed).
      const companyIdForMovement =
        coalesceObjectId(response.data.company_id) ||
        coalesceObjectId(req.user?.company_id);

      for (const line of lines) {
        try {
          await applySalesReturnInboundForLine({
            line,
            referenceId: prId,
            referenceName: "Sales Return",
            companyId: companyIdForMovement,
            req,
            mongoSession,
          });
        } catch (inventoryMovementErr) {
          if (inventoryMovementErr.clientPayload) {
            throwWithGenericFailure(
              inventoryMovementErr.clientPayload,
              "Inventory movement for sales return update failed",
            );
          }
          throw inventoryMovementErr;
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
            logUrl: req.originalUrl || "/api/sales_return/update",
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
          logUrl: req.originalUrl || req.path || "/api/sales_return/update",
        });
        if (!alertResult.success) {
          throw new Error(
            alertResult.message ||
              alertResult.error ||
              "Product stock alert check failed",
          );
        }
      }

      srLineReplaceSnapshot = {
        previous_product_ids,
        new_product_ids,
        stock_sync: stockSyncResults,
      };

      await SalesReturn.syncHeaderTotalsFromLineItems(prId, {
        session: mongoSession || undefined,
      });
    } else {
      // No new lines in payload: header totals still reconciled from existing `sales_return_item` rows.
      await SalesReturn.syncHeaderTotalsFromLineItems(prId, {
        session: mongoSession || undefined,
      });
    }
  };

  try {
    clientSession = await mongoose.startSession();
    await clientSession.withTransaction(async () => {
      await runSalesReturnUpdateBody(clientSession);
    });
  } catch (e) {
    // Same standalone retry pattern as `salesReturnCreate` / `order_save`.
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
        "[sales_return] MongoDB transactions unavailable (e.g. standalone mongod); continuing without transaction",
      );
      try {
        response = null;
        await runSalesReturnUpdateBody(null);
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

  // Failure path — `logs` row (`SALES RETURN UPDATE ROLLBACK`) + client JSON.
  if (txnError) {
    await logRollbackFailure(req, txnError, {
      action: "SALES RETURN UPDATE ROLLBACK",
      tags: ["api", "sales_return", "rollback", "update"],
      fallbackUrl: "/api/sales_return/update",
    });
    if (txnError.clientErrorPayload) {
      const p = txnError.clientErrorPayload;
      return res.status(p.status || 400).json({
        ...p,
        success: false,
        message:
          p.message ||
          txnError.message ||
          p.error ||
          "Sales return update rolled back",
      });
    }
    const msg = String(txnError.message || "");
    const is400 =
      msg.includes("Post-sales_return") ||
      msg.includes("company_id is required") ||
      msg.includes("Validation failed") ||
      msg.includes("Missing required fields");
    return res.status(is400 ? 400 : 500).json({
      success: false,
      status: is400 ? 400 : 500,
      error: "Sales return update rolled back",
      message: msg,
      details: msg,
    });
  }

  if (!response || !response.success || !response.data) {
    return res
      .status(response && response.status ? response.status : 400)
      .json(response);
  }

  const prId = response.data._id;

  // Success: reload lines + header for shaped `data` (post-txn read; not inside the session).
  const items = await SalesReturnItem.find({
    sales_return_id: prId,
    status: "active",
    deletedAt: null,
  })
    .populate("product_id")
    .sort({ createdAt: 1 })
    .lean();

  const prFresh = await SalesReturn.findById(prId).lean();
  const data = shapeSalesReturnWithItems(prFresh || response.data, items);

  return res.status(200).json({
    success: true,
    status: 200,
    data,
    wholesale_updates: [], // reserved; create may populate wholesale side-effects in future
    ...(srLineReplaceSnapshot ? { line_replace: srLineReplaceSnapshot } : {}),
  });
}

async function sales_return_delete(req, res) {
  let srDeleteStepTimer = null;

  try {
    const srId = String(req.params?.id || "").trim();
    if (!srId || !mongoose.Types.ObjectId.isValid(srId)) {
      return res.status(400).json({
        success: false,
        status: 400,
        error: "Invalid id",
        details: "id must be a valid sales_return ObjectId",
        type: "invalid_id",
      });
    }

    const companyId = coalesceObjectId(req.user?.company_id);
    if (!companyId || !mongoose.Types.ObjectId.isValid(String(companyId))) {
      return res.status(400).json({
        success: false,
        status: 400,
        error: "company_id is required",
        details:
          "Authenticated user must have company_id to delete a sales return",
        type: "validation",
      });
    }

    // step 0 — pre-txn read (return header + line items + inbound movement snapshot)
    const existingSr = await SalesReturn.findOne({
      _id: srId,
      company_id: companyId,
      status: "active",
      deletedAt: null,
    }).lean();

    if (!existingSr) {
      return res.status(404).json({
        success: false,
        status: 404,
        error: "Record not found",
        details: `sales_return with id "${srId}" not found or already deleted`,
        type: "not_found",
      });
    }

    const transactionNumber = String(
      existingSr.transaction_number ?? "",
    ).trim();

    const existingSrItems = await SalesReturnItem.find({
      sales_return_id: srId,
      company_id: companyId,
      status: "active",
      deletedAt: null,
    })
      .sort({ createdAt: 1 })
      .lean();

    const oldInMovementsPreTxn = await InventoryMovements.find({
      reference_type: "sales_return",
      reference_id: srId,
      movement_type: "in",
      status: "active",
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    })
      .select("product_id warehouse_id quantity")
      .lean();

    srDeleteStepTimer = startSrCreateStepTimer();

    let clientSession = null;
    let txnError = null;
    /** @type {"mongodb_transaction"|"standalone_no_transaction"|null} */
    let txnMode = null;
    let softDeletedSr = null;
    const productStockUpdates = [];
    const deletedAt = new Date();
    const userId = req.user?._id;
    const deleteSnapshot = {
      gl_rows_soft_deleted: 0,
      movements_soft_deleted: 0,
      items_soft_deleted: 0,
      reversal_movements_inserted: 0,
    };

    /** @param {import("mongoose").ClientSession | null} mongoSession */
    const runSalesReturnDeleteBody = async (mongoSession) => {
      const srSoftDeleteFilter = {
        _id: srId,
        company_id: companyId,
        status: "active",
        deletedAt: null,
      };
      const srSoftDeleteSet = {
        deletedAt,
        status: "inactive",
      };
      if (userId) {
        srSoftDeleteSet.updated_by = userId;
      }

      // step 1 start — soft-delete sales_return header
      const endStep1 = srDeleteStepTimer.start(1, "sales_return soft-delete");
      softDeletedSr = await SalesReturn.findOneAndUpdate(
        srSoftDeleteFilter,
        { $set: srSoftDeleteSet },
        { new: true, ...sessionOpts(mongoSession) },
      ).lean();
      endStep1();
      if (!softDeletedSr) {
        throw new Error("Sales return not found or already deleted");
      }

      // step 2 start — soft-delete GL rows for this return transaction_number
      const endStep2 = srDeleteStepTimer.start(
        2,
        "transaction soft-delete by transaction_number",
      );
      const glSoftDelete = await softDeleteActiveGlByTransactionNumber({
        transactionNumber,
        mongoSession,
        userId,
      });
      deleteSnapshot.gl_rows_soft_deleted = glSoftDelete.modifiedCount || 0;
      endStep2({ modified_count: deleteSnapshot.gl_rows_soft_deleted });
      if (deleteSnapshot.gl_rows_soft_deleted > 0) {
        console.log(
          "✅ Transaction rows soft-deleted:",
          deleteSnapshot.gl_rows_soft_deleted,
        );
      }

      // step 3 start — snapshot inbound movements then soft-delete movement rows
      const endStep3 = srDeleteStepTimer.start(
        3,
        "inventory_movements soft-delete by reference",
      );
      let movQuery = InventoryMovements.find({
        reference_type: "sales_return",
        reference_id: srId,
        movement_type: "in",
        status: "active",
        $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
      }).select("product_id warehouse_id quantity");
      if (mongoSession) movQuery = movQuery.session(mongoSession);
      const oldInMovementsInTxn = await movQuery.lean();
      const oldInMovements =
        oldInMovementsInTxn.length > 0 ?
          oldInMovementsInTxn
        : oldInMovementsPreTxn;

      const movementSoftDelete =
        await InventoryMovements.softDeleteActiveByReference({
          referenceType: "sales_return",
          referenceId: srId,
          companyId,
          session: mongoSession,
          userId,
        });
      deleteSnapshot.movements_soft_deleted =
        movementSoftDelete.modifiedCount || 0;
      endStep3({ modified_count: deleteSnapshot.movements_soft_deleted });
      if (deleteSnapshot.movements_soft_deleted > 0) {
        console.log(
          "✅ Inventory movement rows soft-deleted:",
          deleteSnapshot.movements_soft_deleted,
        );
      }

      // step 4 start — soft-delete sales_return_item rows
      const endStep4 = srDeleteStepTimer.start(
        4,
        "sales_return_item soft-delete",
      );
      const itemSoftDeleteSet = {
        deletedAt,
        status: "inactive",
      };
      if (userId) {
        itemSoftDeleteSet.updated_by = userId;
      }
      const itemSoftDelete = await SalesReturnItem.updateMany(
        {
          sales_return_id: srId,
          company_id: companyId,
          status: "active",
          deletedAt: null,
        },
        { $set: itemSoftDeleteSet },
        sessionOpts(mongoSession),
      );
      deleteSnapshot.items_soft_deleted = itemSoftDelete.modifiedCount || 0;
      endStep4({ modified_count: deleteSnapshot.items_soft_deleted });
      if (deleteSnapshot.items_soft_deleted > 0) {
        console.log(
          "✅ Sales return line items soft-deleted:",
          deleteSnapshot.items_soft_deleted,
        );
      }

      // step 5 start — reverse warehouse_inventory + insert reversal `out` movements
      const endStep5 = srDeleteStepTimer.start(
        5,
        "warehouse_inventory reverse + inventory_movements insert (out reversal)",
        { line_count: existingSrItems.length },
      );
      const restoreResult = await applySalesReturnDeleteInventoryRestore({
        oldInMovements,
        existingReturnItems: existingSrItems,
        salesReturnId: srId,
        companyId,
        req,
        mongoSession,
        logUrl:
          req.originalUrl ||
          req.path ||
          "/api/sales_return/sales_return_delete",
      });
      productStockUpdates.push(...restoreResult.productStockUpdates);
      deleteSnapshot.reversal_movements_inserted =
        restoreResult.reversalMovementsInserted;
      endStep5({
        warehouse_updates: productStockUpdates.length,
        reversal_movements_inserted: deleteSnapshot.reversal_movements_inserted,
      });
    };

    // txn start — MongoDB transaction wrapper (or standalone retry)
    let endTxnWrap = () => {};
    endTxnWrap = srDeleteStepTimer.start("txn", "MongoDB transaction wrapper");
    let txnWrapEnded = false;
    const finishTxnWrap = (extra) => {
      if (!txnWrapEnded) {
        txnWrapEnded = true;
        endTxnWrap(extra);
      }
    };

    try {
      clientSession = await mongoose.startSession();
      await clientSession.withTransaction(async () => {
        await runSalesReturnDeleteBody(clientSession);
      });
      txnMode = "mongodb_transaction";
      finishTxnWrap({ mode: txnMode });
    } catch (e) {
      if (isMongoTransactionUnsupportedError(e)) {
        finishTxnWrap({ mode: "txn_unavailable_retry" });
        if (clientSession) {
          try {
            clientSession.endSession();
          } catch (_) {
            /* ignore */
          }
          clientSession = null;
        }
        console.warn(
          "[sales_return] MongoDB transactions unavailable (e.g. standalone mongod); continuing without transaction",
        );
        try {
          softDeletedSr = null;
          productStockUpdates.length = 0;
          deleteSnapshot.gl_rows_soft_deleted = 0;
          deleteSnapshot.movements_soft_deleted = 0;
          deleteSnapshot.items_soft_deleted = 0;
          deleteSnapshot.reversal_movements_inserted = 0;
          srDeleteStepTimer.resetSteps();
          const endTxnRetry = srDeleteStepTimer.start(
            "txn",
            "pipeline retry (no Mongo transaction)",
          );
          await runSalesReturnDeleteBody(null);
          endTxnRetry({ mode: "standalone_no_transaction" });
          txnMode = "standalone_no_transaction";
        } catch (e2) {
          txnError = e2;
        }
      } else {
        finishTxnWrap({ mode: "mongodb_transaction_failed" });
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

    if (txnError) {
      const stepTimingsOnError = srDeleteStepTimer.log(
        "[sales_return_delete] failed —",
      );
      console.error("Sales return delete error:", txnError);
      await logRollbackFailure(req, txnError, {
        action: "SALES RETURN DELETE ROLLBACK",
        tags: ["api", "sales_return", "rollback", "delete"],
        fallbackUrl: "/api/sales_return/sales_return_delete",
        context: {
          sales_return_id: srId,
          sales_return_no: existingSr.sales_return_no ?? null,
          transaction_number: transactionNumber,
          line_count: existingSrItems.length,
          txn_mode: txnMode,
          in_transaction: txnMode === "mongodb_transaction",
          delete_snapshot: deleteSnapshot,
          step_timings_ms: stepTimingsOnError,
        },
      });
      if (txnError.clientErrorPayload) {
        const p = txnError.clientErrorPayload;
        return res.status(p.status || 400).json({
          success: false,
          message: "Sales return delete rolled back",
          ...p,
          step_timings_ms: stepTimingsOnError,
          txn_mode: txnMode,
        });
      }
      const msg = String(txnError.message || "");
      const is400 =
        msg.includes("Insufficient") ||
        msg.includes("Validation failed") ||
        msg.includes("company_id is required") ||
        msg.includes("Sales return not found") ||
        msg.includes("Product stock sync");
      return res.status(is400 ? 400 : 500).json({
        success: false,
        status: is400 ? 400 : 500,
        error: "Sales return delete rolled back",
        message: msg,
        details: msg,
        step_timings_ms: stepTimingsOnError,
        txn_mode: txnMode,
      });
    }

    const stepTimingsMs = srDeleteStepTimer.log("[sales_return_delete]");

    await createApplicationLog(
      req,
      {
        action: "Sales return deleted",
        url:
          req.originalUrl ||
          req.path ||
          "/api/sales_return/sales_return_delete",
        tags: ["sales_return", "delete", "soft_delete", "inventory"],
        description: {
          sales_return_id: srId,
          sales_return_no: softDeletedSr?.sales_return_no ?? null,
          transaction_number: transactionNumber,
          line_count: existingSrItems.length,
          txn_mode: txnMode,
          delete_snapshot: deleteSnapshot,
          warehouse_inventory_updates: productStockUpdates.length,
          message: `Sales return ${softDeletedSr?.sales_return_no || srId} soft-deleted; inventory and GL reversed.`,
        },
        reference_id: srId,
        reference_type: "sales_return",
        company_id: companyId,
      },
      { silent: true },
    );

    return res.status(200).json({
      success: true,
      status: 200,
      message: "Sales return deleted successfully",
      data: {
        ...softDeletedSr,
        sales_return_items: existingSrItems,
        transaction_number: transactionNumber,
      },
      product_stock_updates: productStockUpdates,
      delete_snapshot: deleteSnapshot,
      step_timings_ms: stepTimingsMs,
      txn_mode: txnMode,
    });
  } catch (unexpectedError) {
    if (srDeleteStepTimer) {
      srDeleteStepTimer.log("[sales_return_delete] unexpected —");
    }
    console.error("Sales return delete unexpected error:", unexpectedError);
    await logRollbackFailure(req, unexpectedError, {
      action: "SALES RETURN DELETE ROLLBACK",
      tags: ["api", "sales_return", "rollback", "delete", "unexpected"],
      fallbackUrl: "/api/sales_return/sales_return_delete",
      context: {
        sales_return_id: req.params?.id ?? null,
        stage: "unexpected",
      },
    });
    return res.status(500).json({
      success: false,
      status: 500,
      error: "Sales return delete failed",
      details: unexpectedError.message,
      ...(srDeleteStepTimer ?
        { step_timings_ms: srDeleteStepTimer.report() }
      : {}),
    });
  }
}

/** Default reporting window when GET /sales_return/profit-by-sales-return-item omits `from` and `to`. */
const FIND_PROFIT_DEFAULT_RANGE_DAYS = 90;

/**
 * GET `SUM(profit)` from `sales_return_item` for the authenticated user's `company_id` only.
 * Uses denormalized line `profit` ((wholesale_price − price) × qty).
 * Query: `sales_return_id`, `order_id` (via parent return), `product_id`, optional `from` / `to` on line `createdAt`.
 * If both dates are omitted, only the last {@link FIND_PROFIT_DEFAULT_RANGE_DAYS} days are included.
 */
async function findProfitBySalesReturnItem(req, res) {
  try {
    const rawCompany = req.user?.company_id;
    const companyId =
      rawCompany && typeof rawCompany === "object" && rawCompany._id ?
        rawCompany._id
      : rawCompany;
    if (!companyId) {
      return res.status(400).json({
        success: false,
        status: 400,
        error: "company_id is required",
        message: "Authentication with company context is required",
      });
    }

    const companyObjectId = coalesceObjectId(companyId);
    if (
      !companyObjectId ||
      !mongoose.Types.ObjectId.isValid(String(companyObjectId))
    ) {
      return res.status(400).json({
        success: false,
        status: 400,
        error: "company_id is required",
        message: "Invalid company context",
      });
    }

    const cid = new mongoose.Types.ObjectId(String(companyObjectId));
    const match = {
      company_id: cid,
      status: "active",
      deletedAt: null,
    };

    const rawSalesReturnId =
      req.query?.sales_return_id ?? req.params?.sales_return_id;
    if (rawSalesReturnId != null && String(rawSalesReturnId).trim() !== "") {
      const salesReturnIdStr = String(rawSalesReturnId).trim();
      if (!mongoose.Types.ObjectId.isValid(salesReturnIdStr)) {
        return res.status(400).json({
          success: false,
          status: 400,
          error: "Invalid sales_return_id",
        });
      }
      match.sales_return_id = new mongoose.Types.ObjectId(salesReturnIdStr);
    } else {
      const rawOrderId = req.query?.order_id ?? req.params?.order_id;
      if (rawOrderId != null && String(rawOrderId).trim() !== "") {
        const orderIdStr = String(rawOrderId).trim();
        if (!mongoose.Types.ObjectId.isValid(orderIdStr)) {
          return res.status(400).json({
            success: false,
            status: 400,
            error: "Invalid order_id",
          });
        }
        const linkedReturns = await SalesReturn.find({
          company_id: cid,
          order_id: new mongoose.Types.ObjectId(orderIdStr),
          deletedAt: null,
        })
          .select("_id")
          .lean();
        const returnIds = linkedReturns.map((row) => row._id);
        if (returnIds.length === 0) {
          return res.status(200).json({
            success: true,
            status: 200,
            company_id: String(cid),
            profit: 0,
            line_count: 0,
          });
        }
        match.sales_return_id = { $in: returnIds };
      }
    }

    const rawProductId = req.query?.product_id;
    if (rawProductId != null && String(rawProductId).trim() !== "") {
      const productIdStr = String(rawProductId).trim();
      if (!mongoose.Types.ObjectId.isValid(productIdStr)) {
        return res.status(400).json({
          success: false,
          status: 400,
          error: "Invalid product_id",
        });
      }
      match.product_id = new mongoose.Types.ObjectId(productIdStr);
    }

    const hasFrom =
      req.query?.from != null && String(req.query.from).trim() !== "";
    const hasTo = req.query?.to != null && String(req.query.to).trim() !== "";

    if (!hasFrom && !hasTo) {
      const toDate = new Date();
      const fromDate = new Date(toDate);
      fromDate.setDate(fromDate.getDate() - FIND_PROFIT_DEFAULT_RANGE_DAYS);
      match.createdAt = { $gte: fromDate, $lte: toDate };
    } else {
      match.createdAt = {};
      if (hasFrom) {
        const fromDate = new Date(String(req.query.from).trim());
        if (Number.isNaN(fromDate.getTime())) {
          return res.status(400).json({
            success: false,
            status: 400,
            error: "Invalid from date",
          });
        }
        match.createdAt.$gte = fromDate;
      }
      if (hasTo) {
        const toDate = new Date(String(req.query.to).trim());
        if (Number.isNaN(toDate.getTime())) {
          return res.status(400).json({
            success: false,
            status: 400,
            error: "Invalid to date",
          });
        }
        match.createdAt.$lte = toDate;
      }
    }

    const rows = await SalesReturnItem.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          profit: { $sum: { $ifNull: ["$profit", 0] } },
          line_count: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          profit: { $round: ["$profit", 2] },
          line_count: 1,
        },
      },
    ]);

    const profit = rows[0]?.profit ?? 0;
    const line_count = rows[0]?.line_count ?? 0;

    return res.status(200).json({
      success: true,
      status: 200,
      company_id: String(cid),
      profit,
      line_count,
    });
  } catch (error) {
    console.error("❌ findProfitBySalesReturnItem:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      error: error.message || "Internal server error",
    });
  }
}

module.exports = {
  salesReturnCreate,
  sales_return_update,
  sales_return_delete,
  getSalesReturnByReturnItem,
  getSalesReturnByReturnNo,
  findProfitBySalesReturnItem,
  // purchase_orderUpdate,
  // purchase_orderById,
  // getAllpurchase_order,
  // getallpurchase_orderactive,
  // purchase_orderdelete,
  // findActiveBlogByTitle,
  // findBlogByParams,
};
