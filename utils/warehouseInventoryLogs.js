const mongoose = require("mongoose");
const Product = require("../models/product");
const { createApplicationLog } = require("./applicationLogs");
const { coalesceObjectId } = require("./modelHelper");

function mapReferenceType(raw) {
  const value = String(raw || "")
    .trim()
    .toLowerCase();
  if (!value) return "warehouse_inventory";
  if (value === "order" || value === "sale") return "sales";
  if (value === "purchase_order" || value === "po") return "purchase";
  return value;
}

/**
 * @param {object} [input]
 * @returns {{
 *   reference_type: string,
 *   reference_id?: import("mongoose").Types.ObjectId | null,
 *   reference_no: string,
 *   product_code: string,
 *   product_name: string,
 * }}
 */
function normalizeWarehouseInventoryLogContext(input = {}) {
  const reference_no = String(
    input.reference_no ??
      input.order_no ??
      input.purchase_order_no ??
      input.sales_return_no ??
      input.purchase_return_no ??
      "",
  ).trim();

  return {
    reference_type: mapReferenceType(input.reference_type),
    reference_id: coalesceObjectId(input.reference_id),
    reference_no,
    product_code: String(input.product_code ?? "").trim(),
    product_name: String(input.product_name ?? "").trim(),
  };
}

function formatProductCodeLabel(code, productId) {
  const trimmed = String(code ?? "").trim();
  if (trimmed) return trimmed;
  const pid = productId != null ? String(productId).trim() : "";
  return pid ? `product:${pid}` : "product";
}

function buildWarehouseInventoryLogAction(ctx, productCode, productId) {
  const refType = ctx.reference_type || "warehouse_inventory";
  const refNo = ctx.reference_no || "";
  const codeLabel = formatProductCodeLabel(productCode || ctx.product_code, productId);
  const suffix =
    refNo ? `${refNo} / ${codeLabel}` : codeLabel;
  return `Warehouse inventory updated :: ${refType} ${suffix}`;
}

async function resolveProductLabels(productId, session, ctx) {
  if (ctx.product_code || ctx.product_name) {
    return {
      product_code: ctx.product_code || "",
      product_name: ctx.product_name || "",
    };
  }

  const pid = coalesceObjectId(productId);
  if (!pid) {
    return { product_code: "", product_name: "" };
  }

  try {
    let q = Product.findById(pid).select("product_code product_name").lean();
    if (session) q = q.session(session);
    const row = await q;
    return {
      product_code: row?.product_code ? String(row.product_code).trim() : "",
      product_name: row?.product_name ? String(row.product_name).trim() : "",
    };
  } catch (err) {
    console.warn(
      "[warehouseInventoryLogs] product lookup failed:",
      err?.message || err,
    );
    return { product_code: "", product_name: "" };
  }
}

/**
 * Insert application log when `warehouse_inventory.quantity` changes.
 *
 * @param {import("express").Request | null} req
 * @param {object} change Audit from `applyQuantityDelta`
 * @param {*} companyId
 * @param {object} [logContext]
 * @param {import("mongoose").ClientSession | null} [session]
 */
async function logWarehouseInventoryChange(
  req,
  change,
  companyId,
  logContext = {},
  session = null,
) {
  if (!change || !Number.isFinite(Number(change.qty_delta))) return;

  const ctx = normalizeWarehouseInventoryLogContext(logContext);
  const cid = coalesceObjectId(companyId ?? logContext.company_id);
  if (!cid) return;

  const productLabels = await resolveProductLabels(
    change.product_id,
    session,
    ctx,
  );
  const qtyDelta = Number(change.qty_delta);
  const direction = qtyDelta >= 0 ? "in" : "out";
  const action = buildWarehouseInventoryLogAction(
    ctx,
    productLabels.product_code,
    change.product_id,
  );

  const description = {
    warehouse_inventory_id:
      change.warehouse_inventory_id != null ?
        String(change.warehouse_inventory_id)
      : null,
    product_id: change.product_id != null ? String(change.product_id) : null,
    product_code: productLabels.product_code || null,
    product_name: productLabels.product_name || null,
    warehouse_id:
      change.warehouse_id != null ? String(change.warehouse_id) : null,
    previous_quantity: change.previous_quantity,
    quantity: change.quantity,
    qty_delta: qtyDelta,
    direction,
    reference_type: ctx.reference_type,
    reference_no: ctx.reference_no || null,
    reference_id:
      ctx.reference_id != null ? String(ctx.reference_id) : null,
  };

  await createApplicationLog(
    req,
    {
      action,
      url: req?.originalUrl || req?.path || "/api/warehouse_inventory",
      tags: ["stock", "Inventory_movement", ctx.reference_type, direction],
      description,
      reference_id: ctx.reference_id ?? change.warehouse_inventory_id ?? change.product_id,
      reference_type: ctx.reference_type,
      company_id: cid,
    },
    { session, silent: true },
  );
}

module.exports = {
  logWarehouseInventoryChange,
  normalizeWarehouseInventoryLogContext,
  mapReferenceType,
};
