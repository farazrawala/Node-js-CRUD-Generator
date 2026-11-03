/**
 * Background job handlers. Safe to run more than once.
 * @module src/shopify/jobs
 */

const { ShopifyConnection, ShopifyWebhookEvent } = require("./models");
const {
  importProducts,
  importProductById,
  markRemoteProductDeleted,
} = require("./syncProducts");
const { importInventory, importLocations, applyRemoteLevel } = require("./syncInventory");
const { importOrders, importOrderById } = require("./syncOrders");
const { syncFulfillments } = require("./syncFulfillment");

const LOCK_MS = 15 * 60 * 1000;

async function loadConnection(id) {
  const connection = await ShopifyConnection.findById(id).select(
    "+access_token_enc +refresh_token_enc",
  );
  if (!connection || connection.status !== "connected") return null;
  return connection;
}

async function withLock(connection, key, work) {
  const locks = connection.sync_locks || {};
  const current = locks[key] ? new Date(locks[key]).getTime() : 0;
  if (current && Date.now() - current < LOCK_MS) {
    return { skipped: true, reason: "already_running" };
  }
  connection.sync_locks = { ...locks, [key]: new Date() };
  if (key === "inventory") connection.inventory_sync_status = "running";
  if (key === "fulfillments") connection.fulfillment_status = "running";
  await connection.save();
  try {
    return await work(connection);
  } finally {
    connection.sync_locks[key] = null;
    await connection.save();
  }
}

async function processWebhook({ connectionId, topic, webhookId }) {
  const connection = await loadConnection(connectionId);
  if (!connection) return { skipped: true };
  const event = await ShopifyWebhookEvent.findOne({
    company_id: connection.company_id,
    shopify_id: webhookId,
  });
  const payload = event?.payload || {};
  try {
    if (topic === "products/delete") {
      await markRemoteProductDeleted(connection, payload.id);
    } else if (topic === "products/create" || topic === "products/update") {
      if (connection.sync_settings?.product_sync_enabled !== false && payload?.id) {
        await importProductById(connection, payload.id, connection.installed_by);
      }
    } else if (
      topic === "orders/create" ||
      topic === "orders/updated" ||
      topic === "orders/cancelled"
    ) {
      if (connection.sync_settings?.order_import_enabled !== false && payload?.id) {
        await importOrderById(connection, payload.id);
      }
    } else if (topic === "inventory_levels/update") {
      await applyRemoteLevel(connection, {
        inventoryItemId: payload.inventory_item_id,
        locationId: payload.location_id,
        available: payload.available,
      });
    } else if (topic === "locations/create" || topic === "locations/update") {
      await importLocations(connection);
    }
    if (event) {
      event.status = "processed";
      event.payload = undefined;
      await event.save();
    }
    return { ok: true, topic };
  } catch (error) {
    if (event) {
      event.status = "failed";
      event.error = error.message;
      await event.save();
    }
    throw error;
  }
}

async function runJob(name, data) {
  if (name === "process_webhook") return processWebhook(data);
  const connection = await loadConnection(data.connectionId);
  if (!connection) return { skipped: true, reason: "disconnected" };
  if (name === "import_products") {
    return withLock(connection, "products", (row) => importProducts(row, data));
  }
  if (name === "import_orders") {
    return withLock(connection, "orders", (row) => importOrders(row));
  }
  if (name === "sync_inventory") {
    return withLock(connection, "inventory", (row) => importInventory(row));
  }
  if (name === "sync_fulfillments") {
    return withLock(connection, "fulfillments", (row) => syncFulfillments(row));
  }
  if (name === "reconcile") {
    const tasks = [];
    if (data.products !== false && connection.sync_settings?.product_sync_enabled !== false) {
      tasks.push(withLock(connection, "products", (row) => importProducts(row, data)));
    }
    if (data.orders !== false && connection.sync_settings?.order_import_enabled !== false) {
      tasks.push(withLock(connection, "orders", (row) => importOrders(row)));
    }
    if (data.inventory !== false) {
      tasks.push(withLock(connection, "inventory", (row) => importInventory(row)));
    }
    if (data.fulfillments !== false && connection.sync_settings?.fulfillment_sync_enabled !== false) {
      tasks.push(withLock(connection, "fulfillments", (row) => syncFulfillments(row)));
    }
    return Promise.all(tasks);
  }
  throw new Error(`Unknown Shopify job: ${name}`);
}

module.exports = {
  runJob,
};
