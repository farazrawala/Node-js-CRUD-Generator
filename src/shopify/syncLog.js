/**
 * Append-only synchronization history.
 * @module src/shopify/syncLog
 */

const { ShopifySyncLog } = require("./models");

async function openSyncLog({
  companyId,
  shop,
  shopifyId,
  action,
  message = "",
  idempotencyKey = "",
  meta = null,
}) {
  if (idempotencyKey) {
    const existing = await ShopifySyncLog.findOne({
      idempotency_key: idempotencyKey,
    }).lean();
    if (existing) return { log: existing, duplicate: true };
  }
  const log = await ShopifySyncLog.create({
    company_id: companyId,
    shop_domain: shop,
    shopify_id: shopifyId || action,
    action,
    status: "pending",
    message,
    idempotency_key: idempotencyKey,
    meta,
  });
  return { log, duplicate: false };
}

async function finishSyncLog(logId, status, message, meta) {
  if (!logId) return;
  const set = { status, message: String(message || "").slice(0, 2000) };
  if (meta !== undefined) set.meta = meta;
  await ShopifySyncLog.updateOne({ _id: logId }, { $set: set });
}

module.exports = {
  openSyncLog,
  finishSyncLog,
};
