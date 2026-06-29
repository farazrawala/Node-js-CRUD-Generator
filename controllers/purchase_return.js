const mongoose = require("mongoose");
const PurchaseReturn = require("../models/purchase_return");
const PurchaseReturnItem = require("../models/purchase_return_item");
require("../models/purchase_order");
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
const { sumHeaderTotalAmount } = require("../utils/reportHeaderTotals");
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
 * Purchase return HTTP handlers: header + line items, inventory movement ledger (`inventory_movements` only),
 * and five GL postings per return (reversed vs PO — see transactionBulkCreate payloads).
 *
 * Standalone MongoDB: tries `withTransaction` first; on replica-set–only errors, retries without a session.
 */

/** Merged into every `logs` row written from purchase return create / update / delete flows. */
const PURCHASE_RETURN_LOG_TAGS = ["purchase_return"];

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

/** Inventory movement `reference_name` with PR number when available (e.g. `Purchase Return (PR-0042)`). */
function purchaseReturnReferenceName(label, purchaseReturnNo) {
  const no = String(purchaseReturnNo ?? "").trim();
  return no ? `${label} (${no})` : label;
}

/** Legacy tenants: resolve GL ids by signup COA name when `company.default_*` was never set. */
const PR_GL_ACCOUNT_NAME_FALLBACKS = {
  default_purchase_account: /^purchase$/i,
  default_shipping_account: /^shipping$/i,
  default_purchase_discount_account: /^purchase discount$/i,
  default_cash_account: /^cash$/i,
  default_account_payable_account: /^accounts payable$/i,
};

const PR_GL_ACCOUNT_TYPE_FALLBACKS = {
  default_purchase_account: "cost_of_goods_sold_account",
  default_shipping_account: "operating_expense",
  default_purchase_discount_account: "other",
  default_cash_account: "current_asset",
  default_account_payable_account: "current_liability",
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

  const namePattern = PR_GL_ACCOUNT_NAME_FALLBACKS[field];
  if (namePattern) {
    const byName = await findCompanyAccountByName(
      companyId,
      namePattern,
      session,
    );
    if (byName?._id) return pickObjectId(byName._id);
  }

  const accountType = PR_GL_ACCOUNT_TYPE_FALLBACKS[field];
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
 * Resolve five company GL account ids for PR postings. Heals missing `company.default_*`
 * from signup COA names/types when found (same pattern as adjustment create).
 */
async function resolvePurchaseReturnGlAccounts(orderReq, session = null) {
  const companyDoc = orderReq?.user?.company_id;
  const companyId = pickObjectId(companyDoc);
  if (!companyId) {
    const err = new Error(
      "company_id is required for purchase return GL postings",
    );
    err.statusCode = 400;
    throw err;
  }

  const resolved = {};
  const patch = {};
  for (const meta of PURCHASE_RETURN_GL_LINE_META) {
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

  const missing = PURCHASE_RETURN_GL_LINE_META.filter(
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

/** Five GL rows for create/update — order must match PURCHASE_RETURN_GL_LINE_META. */
function buildPurchaseReturnGlTransactionItems(
  record,
  transaction_number,
  remainingAmount,
  glAccounts,
) {
  return [
    {
      account_id: glAccounts.default_purchase_account,
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
      account_id: glAccounts.default_shipping_account,
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
      account_id: glAccounts.default_purchase_discount_account,
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
      account_id: glAccounts.default_account_payable_account,
      type: "debit",
      amount: remainingAmount || 0,
      reference_user_id: record?.vendor_id,
      transaction_number,
      description: "A/c Payable",
      reference_id: {
        module: "purchase_return",
        ref_id: record._id,
      },
    },
  ];
}

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
      message: f.message,
      error: f.error,
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
    const reason =
      e.message && e.message !== e.error ? ` — ${e.message}`
      : e.error && !String(e.error).startsWith("Post-purchase_return") ?
        ` — ${e.error}`
      : "";
    return `index ${e.gl_line_index} «${e.gl_line_description}»${miss}${reason}. ${e.where_to_fix}`;
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

function buildOutboundQtyMapFromMovements(movements) {
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
 * Delete / void purchase return: restore warehouse qty and insert reversal `in` movements
 * from prior `out` snapshot (mirrors order delete — PR create posts outbound stock).
 */
async function applyPurchaseReturnDeleteInventoryRestore({
  oldOutMovements,
  existingReturnItems,
  purchaseReturnId,
  purchaseReturnNo = null,
  companyId,
  req,
  mongoSession = null,
  logUrl = "/api/purchase_return/purchase_return_delete",
}) {
  const inventoryLogContext = {
    reference_type: "purchase_return",
    reference_id: purchaseReturnId,
    reference_no: purchaseReturnNo,
  };
  const oldMap = buildOutboundQtyMapFromMovements(oldOutMovements);

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
        qtyDelta: lineQtyNum,
        userId: req.user?._id,
        session: mongoSession,
        req,
        logContext: inventoryLogContext,
      });
      if (whChange) {
        productStockUpdates.push({
          ...whChange,
          source: "warehouse_inventory",
          qty_delta_reason: "purchase_return_delete_restore",
        });
      }
    } catch (whErr) {
      const whMsg = String(
        whErr?.message || "Warehouse inventory restore failed",
      );
      const mapped = new Error(whMsg);
      mapped.clientErrorPayload = {
        success: false,
        status: 400,
        error: "Warehouse inventory restore failed",
        message: whMsg,
        details: whMsg,
        type: "validation",
        product_id: productIdStr,
        warehouse_id: warehouseIdStr,
        qty_restore: lineQtyNum,
      };
      throw mapped;
    }

    await insertPurchaseReturnOutboundMovement(req, {
      productId: productIdStr,
      warehouseId: warehouseIdStr,
      quantity: lineQtyNum,
      unitCost,
      referenceId: purchaseReturnId,
      referenceName: "Purchase Return Delete",
      referenceNo: purchaseReturnNo,
      companyId,
      mongoSession,
      movementType: "in",
    });
    reversalMovementsInserted += 1;
  }

  const summary = summarizeLineStockByProduct(existingReturnItems || []);
  for (const [productIdStr, info] of summary) {
    if (info.hasWarehouseLine) {
      const syncResult = await syncProductStockFromMovementLedger(
        productIdStr,
        companyId,
        { req, mongoSession, logUrl, logTags: PURCHASE_RETURN_LOG_TAGS },
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
      const bump = await incrementProductStockForReturnLineDelete({
        productId: productIdStr,
        lineQty: info.qtyWithoutWarehouse,
        companyId,
        mongoSession,
      });
      productStockUpdates.push({ ...bump, source: "product_stock_restore" });
    }
  }

  return { productStockUpdates, reversalMovementsInserted };
}

async function insertPurchaseReturnOutboundMovement(
  req,
  {
    productId,
    warehouseId,
    quantity,
    unitCost,
    referenceId,
    referenceName,
    referenceNo = null,
    companyId,
    mongoSession,
    movementType = "out",
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
    reference_type: "purchase_return",
    reference_id: referenceId,
    reference_name: purchaseReturnReferenceName(referenceName, referenceNo),
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
 * Outbound return line: subtract across warehouses (preferred line warehouse first),
 * then one inventory_movements `out` row per warehouse chunk.
 */
async function applyPurchaseReturnOutboundForLine({
  line,
  referenceId,
  referenceName = "Purchase Return",
  referenceNo = null,
  companyId,
  req,
  mongoSession = null,
}) {
  const inventoryLogContext = {
    reference_type: "purchase_return",
    reference_id: referenceId,
    reference_no: referenceNo,
  };
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
      "Each purchase return line needs a valid product_id and positive qty",
    );
  }
  if (!Number.isFinite(unitCost) || unitCost < 0) {
    throw new Error(
      "Each return line needs a finite unit price (price) and positive quantity for inventory movement",
    );
  }

  const preferredRaw =
    line.warehouse_id != null ? String(line.warehouse_id).trim() : "";
  const preferredWarehouseId =
    preferredRaw && mongoose.Types.ObjectId.isValid(preferredRaw) ?
      preferredRaw
    : null;

  let allocations;
  let stockChanges;
  try {
    ({ allocations, stockChanges } =
      await WarehouseInventory.applySplitWarehouseOutbound({
        productId: productIdStr,
        companyId,
        qtyNeeded: lineQtyNum,
        preferredWarehouseId,
        userId: req.user?._id,
        session: mongoSession,
        req,
        logContext: inventoryLogContext,
      }));
  } catch (err) {
    if (err.clientPayload) {
      throwWithGenericFailure(
        err.clientPayload,
        "Insufficient stock for purchase return line",
      );
    }
    throw err;
  }

  for (const alloc of allocations) {
    await insertPurchaseReturnOutboundMovement(req, {
      productId: productIdStr,
      warehouseId: alloc.warehouse_id,
      quantity: alloc.quantity,
      unitCost,
      referenceId,
      referenceName,
      referenceNo,
      companyId,
      mongoSession,
    });
  }

  return stockChanges;
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
        { req, mongoSession, logUrl, logTags: PURCHASE_RETURN_LOG_TAGS },
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

/** Inverse of `decrementProductStockForReturnLine` — restore qty when voiding a return. */
async function incrementProductStockForReturnLineDelete({
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
      "Each purchase return line needs a positive quantity to restore product stock",
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
    qty_restored: qtyToAdd,
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
 * |  6b | product, logs           | read / update      | one × P      | medium | `applyWholesalePriceRemoveForPoLines` — reverse weighted `wholesale_price` after outbound |
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
    const wholesaleUpdates = [];
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
      const prGlAccounts = await resolvePurchaseReturnGlAccounts(
        req,
        mongoSession,
      );
      if (
        !req.body.payment_method_accounts_id &&
        prGlAccounts.default_cash_account
      ) {
        req.body.payment_method_accounts_id = prGlAccounts.default_cash_account;
      }

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
              buildPurchaseReturnGlTransactionItems(
                record,
                transaction_number,
                req.body?.remaining_amount,
                prGlAccounts,
              ),
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

      // step 6–11 start — warehouse_inventory outbound + inventory_movements per line
      for (
        let lineIndex = 0;
        lineIndex < lineItemsFromClient.length;
        lineIndex++
      ) {
        const line = lineItemsFromClient[lineIndex];
        const endSteps611 = prStepTimer.start(
          6,
          "warehouse outbound + inventory_movements",
          { line_index: lineIndex },
        );
        try {
          const stockChanges = await applyPurchaseReturnOutboundForLine({
            line,
            referenceId: newPurchaseReturnId,
            referenceName: "Purchase Return",
            referenceNo: purchaseReturnCreateResult.data?.purchase_return_no,
            companyId,
            req,
            mongoSession,
          });
          productStockUpdates.push(...stockChanges);
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
        }
      }
      // step 6–11 end

      // A purchase return is an OUTBOUND on already-blended inventory, so it is
      // WAC-neutral (like a sale): stock is removed at the current weighted
      // average and `product.wholesale_price` is left unchanged. (Reversing at
      // the line/purchase cost here previously skewed WAC, e.g. 240 → 280.)

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
          logTags: PURCHASE_RETURN_LOG_TAGS,
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
          wholesaleUpdates.length = 0;
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
        action: "PURCHASE RETURN CREATE ROLLBACK",
        tags: ["api", "purchase_return", "rollback", "create"],
        fallbackUrl: "/api/purchase_return/purchase_return_create",
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
            "Purchase return creation rolled back",
          step_timings_ms: stepTimingsOnError,
        });
      }
      const errorMessage = String(createPipelineError.message || "");
      const isGeneralLedgerRelatedError =
        errorMessage.includes("Post-purchase_return") ||
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
            "Purchase return creation rolled back"
          : "Failed to create purchase return",
        message: errorMessage,
        details: createPipelineError.details ?? errorMessage,
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
      wholesale_updates: wholesaleUpdates,
      step_timings_ms: stepTimingsMs,
    });
  } catch (unexpectedError) {
    if (prStepTimer) {
      prStepTimer.log("[purchase_return_create] unexpected —");
    }
    console.error("Purchase Return creation error:", unexpectedError);
    // step 20 start — rollback log (outer catch)
    await logRollbackFailure(req, unexpectedError, {
      action: "PURCHASE RETURN CREATE ROLLBACK",
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
    const prGlAccounts = await resolvePurchaseReturnGlAccounts(
      req,
      mongoSession,
    );
    if (
      !req.body.payment_method_accounts_id &&
      prGlAccounts.default_cash_account
    ) {
      req.body.payment_method_accounts_id = prGlAccounts.default_cash_account;
    }

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
          buildPurchaseReturnGlTransactionItems(
            record,
            transaction_number,
            req.body?.remaining_amount,
            prGlAccounts,
          ),
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

      // Outbound warehouse_inventory + ledger per line (split across warehouses when needed).
      const companyIdForMovement =
        coalesceObjectId(response.data.company_id) ||
        coalesceObjectId(req.user?.company_id);

      for (const line of lines) {
        try {
          await applyPurchaseReturnOutboundForLine({
            line,
            referenceId: prId,
            referenceName: "Purchase Return",
            referenceNo: response.data?.purchase_return_no,
            companyId: companyIdForMovement,
            req,
            mongoSession,
          });
        } catch (inventoryMovementErr) {
          if (inventoryMovementErr.clientPayload) {
            throwWithGenericFailure(
              inventoryMovementErr.clientPayload,
              "Inventory movement for purchase return update failed",
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
            logUrl: req.originalUrl || "/api/purchase_return/update",
            logTags: PURCHASE_RETURN_LOG_TAGS,
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
          logTags: PURCHASE_RETURN_LOG_TAGS,
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
        ...p,
        success: false,
        message:
          p.message ||
          txnError.message ||
          p.error ||
          "Purchase return update rolled back",
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

/**
 * Soft-delete a purchase return and reverse inventory / GL effects.
 *
 * URL: `DELETE /api/purchase_return/purchase_return_delete/:id` — `:id` is `purchase_return._id`.
 *
 * **Session:** Tries `mongoose.startSession` + `withTransaction` first. On standalone mongod
 * (replica-set–only errors), retries the same pipeline without a session — see `isMongoTransactionUnsupportedError`.
 * All writes inside `runPurchaseReturnDeleteBody` pass `sessionOpts(mongoSession)` when a session is active.
 *
 * Collections (Mongo) — op = insert | update | delete | read; scope = one | many
 *
 * | Step | Collection              | Op                 | One or many  | Cost   | Notes |
 * |------|-------------------------|--------------------|--------------|--------|-------|
 * |    0 | purchase_return, purchase_return_item, inventory_movements | read | one + many | low | Pre-txn validation (404 if missing); snapshot active `out` movements for this return |
 * |    1 | purchase_return         | update (soft)      | one          | low    | `status: inactive`, `deletedAt` |
 * |    2 | transaction             | update (soft)      | many         | medium | By return header `transaction_number` |
 * |    3 | purchase_return_item    | update (soft)      | many         | medium | All active lines for this return |
 * |  3b | product, logs           | read / update      | one × P      | medium | `applyWholesalePriceWeightedAverageForPoLines` — restore weighted `wholesale_price` before warehouse restore |
 * |    4 | warehouse_inventory, inventory_movements, product | read / update / insert | one × N | medium | `applyPurchaseReturnDeleteInventoryRestore`: add warehouse qty back, insert `in` reversal rows, ledger `product.stock` sync |
 * |    5 | logs                    | insert             | one          | low    | `createApplicationLog` — success path only (post-commit; no session) |
 * |    6 | logs                    | insert             | one          | low    | `logRollbackFailure` — failure path (`PURCHASE RETURN DELETE ROLLBACK`) |
 *
 * N = distinct product/warehouse pairs from prior outbound movements (or line items when movement snapshot is empty).
 */
async function purchase_return_delete(req, res) {
  let prDeleteStepTimer = null;

  try {
    const prId = String(req.params?.id || "").trim();
    if (!prId || !mongoose.Types.ObjectId.isValid(prId)) {
      return res.status(400).json({
        success: false,
        status: 400,
        error: "Invalid id",
        details: "id must be a valid purchase_return ObjectId",
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
          "Authenticated user must have company_id to delete a purchase return",
        type: "validation",
      });
    }

    // step 0 — pre-txn read (return header + line items + outbound movement snapshot)
    const existingPr = await PurchaseReturn.findOne({
      _id: prId,
      company_id: companyId,
      status: "active",
      deletedAt: null,
    }).lean();

    if (!existingPr) {
      return res.status(404).json({
        success: false,
        status: 404,
        error: "Record not found",
        details: `purchase_return with id "${prId}" not found or already deleted`,
        type: "not_found",
      });
    }

    const transactionNumber = String(
      existingPr.transaction_number ?? "",
    ).trim();

    const existingPrItems = await PurchaseReturnItem.find({
      purchase_return_id: prId,
      company_id: companyId,
      status: "active",
      deletedAt: null,
    })
      .sort({ createdAt: 1 })
      .lean();

    const oldOutMovementsPreTxn = await InventoryMovements.find({
      reference_type: "purchase_return",
      reference_id: prId,
      movement_type: "out",
      status: "active",
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    })
      .select("product_id warehouse_id quantity")
      .lean();

    prDeleteStepTimer = startPrCreateStepTimer();

    let clientSession = null;
    let txnError = null;
    /** @type {"mongodb_transaction"|"standalone_no_transaction"|null} */
    let txnMode = null;
    let softDeletedPr = null;
    const productStockUpdates = [];
    const wholesaleUpdates = [];
    const deletedAt = new Date();
    const userId = req.user?._id;
    const deleteSnapshot = {
      gl_rows_soft_deleted: 0,
      items_soft_deleted: 0,
      reversal_movements_inserted: 0,
    };

    /** @param {import("mongoose").ClientSession | null} mongoSession */
    const runPurchaseReturnDeleteBody = async (mongoSession) => {
      const prSoftDeleteFilter = {
        _id: prId,
        company_id: companyId,
        status: "active",
        deletedAt: null,
      };
      const prSoftDeleteSet = {
        deletedAt,
        status: "inactive",
      };
      if (userId) {
        prSoftDeleteSet.updated_by = userId;
      }

      // step 1 start — soft-delete purchase_return header
      const endStep1 = prDeleteStepTimer.start(
        1,
        "purchase_return soft-delete",
      );
      softDeletedPr = await PurchaseReturn.findOneAndUpdate(
        prSoftDeleteFilter,
        { $set: prSoftDeleteSet },
        { new: true, ...sessionOpts(mongoSession) },
      ).lean();
      endStep1();
      // step 1 end
      if (!softDeletedPr) {
        throw new Error("Purchase return not found or already deleted");
      }

      // step 2 start — soft-delete GL rows for this return transaction_number
      const endStep2 = prDeleteStepTimer.start(
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
      // step 2 end

      // step 3 start — soft-delete purchase_return_item rows
      const endStep3 = prDeleteStepTimer.start(
        3,
        "purchase_return_item soft-delete",
      );
      const itemSoftDeleteSet = {
        deletedAt,
        status: "inactive",
      };
      if (userId) {
        itemSoftDeleteSet.updated_by = userId;
      }
      const itemSoftDelete = await PurchaseReturnItem.updateMany(
        {
          purchase_return_id: prId,
          company_id: companyId,
          status: "active",
          deletedAt: null,
        },
        { $set: itemSoftDeleteSet },
        sessionOpts(mongoSession),
      );
      deleteSnapshot.items_soft_deleted = itemSoftDelete.modifiedCount || 0;
      endStep3({ modified_count: deleteSnapshot.items_soft_deleted });
      if (deleteSnapshot.items_soft_deleted > 0) {
        console.log(
          "✅ Purchase return line items soft-deleted:",
          deleteSnapshot.items_soft_deleted,
        );
      }
      // step 3 end

      // Deleting a purchase return adds the returned stock back. Because the
      // original purchase return was WAC-neutral (outbound at the running
      // average), restoring it is WAC-neutral too — `wholesale_price` is left
      // unchanged here.

      // step 4 start — restore warehouse_inventory + insert reversal `in` movements
      const endStep4 = prDeleteStepTimer.start(
        4,
        "warehouse_inventory restore + inventory_movements insert (in reversal)",
        { line_count: existingPrItems.length },
      );
      const restoreResult = await applyPurchaseReturnDeleteInventoryRestore({
        oldOutMovements: oldOutMovementsPreTxn,
        existingReturnItems: existingPrItems,
        purchaseReturnId: prId,
        purchaseReturnNo: existingPr.purchase_return_no,
        companyId,
        req,
        mongoSession,
        logUrl:
          req.originalUrl ||
          req.path ||
          "/api/purchase_return/purchase_return_delete",
      });
      productStockUpdates.push(...restoreResult.productStockUpdates);
      deleteSnapshot.reversal_movements_inserted =
        restoreResult.reversalMovementsInserted;
      endStep4({
        warehouse_updates: productStockUpdates.length,
        reversal_movements_inserted: deleteSnapshot.reversal_movements_inserted,
      });
      // step 4 end
    };

    // txn start — MongoDB transaction wrapper (or standalone retry)
    let endTxnWrap = () => {};
    endTxnWrap = prDeleteStepTimer.start("txn", "MongoDB transaction wrapper");
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
        await runPurchaseReturnDeleteBody(clientSession);
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
          "[purchase_return] MongoDB transactions unavailable (e.g. standalone mongod); continuing without transaction",
        );
        try {
          softDeletedPr = null;
          productStockUpdates.length = 0;
          wholesaleUpdates.length = 0;
          deleteSnapshot.gl_rows_soft_deleted = 0;
          deleteSnapshot.items_soft_deleted = 0;
          deleteSnapshot.reversal_movements_inserted = 0;
          prDeleteStepTimer.resetSteps();
          const endTxnRetry = prDeleteStepTimer.start(
            "txn",
            "pipeline retry (no Mongo transaction)",
          );
          await runPurchaseReturnDeleteBody(null);
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
    // txn end

    // step 6 start — failure path (`logRollbackFailure` + client JSON)
    if (txnError) {
      const stepTimingsOnError = prDeleteStepTimer.log(
        "[purchase_return_delete] failed —",
      );
      console.error("Purchase return delete error:", txnError);
      await logRollbackFailure(req, txnError, {
        action: "PURCHASE RETURN DELETE ROLLBACK",
        tags: ["api", "purchase_return", "rollback", "delete"],
        fallbackUrl: "/api/purchase_return/purchase_return_delete",
        context: {
          purchase_return_id: prId,
          purchase_return_no: existingPr.purchase_return_no ?? null,
          transaction_number: transactionNumber,
          line_count: existingPrItems.length,
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
          message: "Purchase return delete rolled back",
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
        msg.includes("Purchase return not found") ||
        msg.includes("Product stock sync");
      return res.status(is400 ? 400 : 500).json({
        success: false,
        status: is400 ? 400 : 500,
        error: "Purchase return delete rolled back",
        message: msg,
        details: msg,
        step_timings_ms: stepTimingsOnError,
        txn_mode: txnMode,
      });
    }
    // step 6 end

    const stepTimingsMs = prDeleteStepTimer.log("[purchase_return_delete]");

    // step 5 start — success audit log (post-commit; no session)
    await createApplicationLog(
      req,
      {
        action: "Purchase return deleted",
        url:
          req.originalUrl ||
          req.path ||
          "/api/purchase_return/purchase_return_delete",
        tags: ["purchase_return", "delete", "soft_delete", "inventory"],
        description: {
          purchase_return_id: prId,
          purchase_return_no: softDeletedPr?.purchase_return_no ?? null,
          transaction_number: transactionNumber,
          line_count: existingPrItems.length,
          txn_mode: txnMode,
          delete_snapshot: deleteSnapshot,
          warehouse_inventory_updates: productStockUpdates.length,
          message: `Purchase return ${softDeletedPr?.purchase_return_no || prId} soft-deleted; inventory and GL reversed.`,
        },
        reference_id: prId,
        reference_type: "purchase_return",
        company_id: companyId,
      },
      { silent: true },
    );
    // step 5 end

    return res.status(200).json({
      success: true,
      status: 200,
      message: "Purchase return deleted successfully",
      data: {
        ...softDeletedPr,
        purchase_return_items: existingPrItems,
        transaction_number: transactionNumber,
      },
      product_stock_updates: productStockUpdates,
      wholesale_updates: wholesaleUpdates,
      delete_snapshot: deleteSnapshot,
      step_timings_ms: stepTimingsMs,
      txn_mode: txnMode,
    });
  } catch (unexpectedError) {
    if (prDeleteStepTimer) {
      prDeleteStepTimer.log("[purchase_return_delete] unexpected —");
    }
    console.error("Purchase return delete unexpected error:", unexpectedError);
    await logRollbackFailure(req, unexpectedError, {
      action: "PURCHASE RETURN DELETE ROLLBACK",
      tags: ["api", "purchase_return", "rollback", "delete", "unexpected"],
      fallbackUrl: "/api/purchase_return/purchase_return_delete",
      context: {
        purchase_return_id: req.params?.id ?? null,
        stage: "unexpected",
      },
    });
    return res.status(500).json({
      success: false,
      status: 500,
      error: "Purchase return delete failed",
      details: unexpectedError.message,
      ...(prDeleteStepTimer ?
        { step_timings_ms: prDeleteStepTimer.report() }
      : {}),
    });
  }
}

/** GET sum of `total_amount` from `purchase_return` for income statement / reporting. */
async function findPurchaseReturnPurchases(req, res) {
  return sumHeaderTotalAmount(req, res, PurchaseReturn, {
    statusQueryField: "return_status",
  });
}

module.exports = {
  purchaseReturnCreate,
  purchase_return_update,
  purchase_return_delete,
  getPurchaseReturnByReturnItem,
  getPurchaseReturnByReturnNo,
  findPurchaseReturnPurchases,
  // purchase_orderUpdate,
  // purchase_orderById,
  // getAllpurchase_order,
  // getallpurchase_orderactive,
  // purchase_orderdelete,
  // findActiveBlogByTitle,
  // findBlogByParams,
};
