const OrderStatusUpdates = require("../models/order_status_updates");
const { coalesceObjectId } = require("./modelHelper");
const { invalidateModuleListCaches } = require("./redisCache");

/**
 * Insert one `order_status_updates` row and invalidate list caches for the tenant.
 * @param {{
 *   orderId: string|import("mongoose").Types.ObjectId,
 *   orderStatus: string,
 *   companyId: string|import("mongoose").Types.ObjectId,
 *   userId?: string|import("mongoose").Types.ObjectId|null,
 *   mongoSession?: import("mongoose").ClientSession|null,
 * }} params
 */
async function recordOrderStatusUpdate({
  orderId,
  orderStatus,
  companyId,
  userId = null,
  mongoSession = null,
}) {
  const oid = coalesceObjectId(orderId);
  const cid = coalesceObjectId(companyId);
  const status = String(orderStatus ?? "").trim();
  if (!oid || !cid || !status) {
    throw new Error(
      "recordOrderStatusUpdate requires orderId, companyId, and orderStatus",
    );
  }

  const actor = coalesceObjectId(userId) || undefined;
  const sessOpts = mongoSession ? { session: mongoSession } : {};

  const [created] = await OrderStatusUpdates.create(
    [
      {
        order_id: oid,
        order_status: status,
        company_id: cid,
        created_by: actor,
        updated_by: actor,
        status: "active",
      },
    ],
    sessOpts,
  );

  try {
    await invalidateModuleListCaches(cid, "order_status_updates");
  } catch (err) {
    console.warn(
      "[order_status_updates] list cache invalidate failed:",
      err?.message || err,
    );
  }

  return created?.toObject?.() || created || null;
}

/**
 * Insert many history rows (e.g. merge sources → duplicate).
 * @param {Array<{
 *   orderId: string|import("mongoose").Types.ObjectId,
 *   orderStatus: string,
 *   companyId: string|import("mongoose").Types.ObjectId,
 *   userId?: string|import("mongoose").Types.ObjectId|null,
 * }>} rows
 * @param {import("mongoose").ClientSession|null} [mongoSession]
 */
async function recordOrderStatusUpdates(rows = [], mongoSession = null) {
  const docs = [];
  let companyIdForCache = null;
  for (const row of rows) {
    const oid = coalesceObjectId(row.orderId ?? row.order_id);
    const cid = coalesceObjectId(row.companyId ?? row.company_id);
    const status = String(row.orderStatus ?? row.order_status ?? "").trim();
    if (!oid || !cid || !status) continue;
    companyIdForCache = cid;
    const actor = coalesceObjectId(row.userId ?? row.created_by) || undefined;
    docs.push({
      order_id: oid,
      order_status: status,
      company_id: cid,
      created_by: actor,
      updated_by: actor,
      status: "active",
    });
  }
  if (!docs.length) return [];

  const sessOpts = mongoSession ? { session: mongoSession } : {};
  const created = await OrderStatusUpdates.create(docs, sessOpts);

  if (companyIdForCache) {
    try {
      await invalidateModuleListCaches(companyIdForCache, "order_status_updates");
    } catch (err) {
      console.warn(
        "[order_status_updates] list cache invalidate failed:",
        err?.message || err,
      );
    }
  }

  return created;
}

module.exports = {
  recordOrderStatusUpdate,
  recordOrderStatusUpdates,
};
