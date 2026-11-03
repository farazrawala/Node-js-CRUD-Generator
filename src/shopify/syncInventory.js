/**
 * Location mapping and inventory sync.
 * pos_to_shopify keeps OrdersHub warehouse quantity as the source of truth.
 * @module src/shopify/syncInventory
 */

const Warehouse = require("../../models/warehouse");
const WarehouseInventory = require("../../models/warehouse_inventory");
const { numericId } = require("./orderMapper");
const { shouldApplyRemoteInventory } = require("./inventoryGuard");
const { ShopifyLocation, ShopifyInventory, ShopifyProduct } = require("./models");
const { adminClient } = require("./connectionService");
const { appUrl } = require("./client");
const { openSyncLog, finishSyncLog } = require("./syncLog");

const LOCATIONS_QUERY = `
  query ShopifyLocations($cursor: String) {
    locations(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        legacyResourceId
        name
        isActive
      }
    }
  }
`;

async function ensureWarehouse(connection, location) {
  const name = location.name || `Shopify ${location.shopify_id}`;
  if (location.warehouse_id) {
    const existing = await Warehouse.findOne({
      _id: location.warehouse_id,
      company_id: connection.company_id,
      deletedAt: null,
    })
      .select("_id")
      .lean();
    if (existing) return existing._id;
  }
  const byName = await Warehouse.findOne({
    company_id: connection.company_id,
    name,
    deletedAt: null,
  })
    .select("_id")
    .lean();
  if (byName) return byName._id;
  const created = await Warehouse.create({
    name,
    company_id: connection.company_id,
    status: "active",
    created_by: connection.installed_by || undefined,
  });
  return created._id;
}

async function importLocations(connection) {
  const client = await adminClient(connection);
  let cursor = null;
  const saved = [];
  do {
    const data = await client.query(LOCATIONS_QUERY, { cursor });
    const page = data?.locations;
    for (const node of page?.nodes || []) {
      const shopifyId = String(node.legacyResourceId || numericId(node.id));
      const row = await ShopifyLocation.findOneAndUpdate(
        {
          company_id: connection.company_id,
          shop_domain: connection.shop_domain,
          shopify_id: shopifyId,
        },
        {
          $set: {
            name: node.name || shopifyId,
            active: node.isActive !== false,
          },
        },
        { upsert: true, new: true },
      );
      if (!row.warehouse_id) {
        row.warehouse_id = await ensureWarehouse(connection, row);
        await row.save();
      }
      saved.push(row);
    }
    cursor = page?.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return saved;
}

async function mapLocationWarehouse(connection, locationId, warehouseId) {
  const warehouse = await Warehouse.findOne({
    _id: warehouseId,
    company_id: connection.company_id,
    deletedAt: null,
  })
    .select("_id")
    .lean();
  if (!warehouse) {
    const error = new Error("Warehouse was not found for this company.");
    error.status = 404;
    throw error;
  }
  const location = await ShopifyLocation.findOneAndUpdate(
    {
      company_id: connection.company_id,
      shop_domain: connection.shop_domain,
      shopify_id: String(locationId),
    },
    { $set: { warehouse_id: warehouse._id } },
    { new: true },
  );
  if (!location) {
    const error = new Error("Shopify location was not found. Sync locations first.");
    error.status = 404;
    throw error;
  }
  return location;
}

async function setPosQuantity({ companyId, productId, warehouseId, targetQty, userId }) {
  const filter = WarehouseInventory.activeRowFilter(productId, warehouseId, companyId);
  if (!filter) return { skipped: true };
  const row = await WarehouseInventory.findOne(filter).select("quantity").lean();
  const current = Number(row?.quantity) || 0;
  const target = Math.max(0, Math.round(Number(targetQty) * 100) / 100);
  const delta = Math.round((target - current) * 100) / 100;
  if (!delta) return { skipped: true, quantity: current };
  await WarehouseInventory.applyQuantityDelta({
    productId,
    warehouseId,
    companyId,
    qtyDelta: delta,
    userId,
    allowNegative: false,
  });
  return { skipped: false, quantity: target, previous: current };
}

async function applyRemoteLevel(connection, { inventoryItemId, locationId, available }) {
  const direction = connection.sync_settings?.inventory_sync_direction || "pos_to_shopify";
  const level = await ShopifyInventory.findOne({
    company_id: connection.company_id,
    shop_domain: connection.shop_domain,
    inventory_item_id: String(inventoryItemId),
    location_id: String(locationId),
  });
  const decision = shouldApplyRemoteInventory({
    direction,
    incomingQty: available,
    lastPushedQty: level?.last_pushed_qty,
    lastPushedAt: level?.last_pushed_at,
  });
  const { log } = await openSyncLog({
    companyId: connection.company_id,
    shop: connection.shop_domain,
    shopifyId: `${inventoryItemId}:${locationId}`,
    action: "inventory_remote",
    message: decision.reason,
  });
  if (!decision.apply) {
    if (level) {
      level.last_remote_qty = Number(available);
      level.last_remote_at = new Date();
      await level.save();
    }
    await finishSyncLog(log._id, "success", decision.reason, { available });
    return { applied: false, reason: decision.reason };
  }
  const mapping = await ShopifyProduct.findOne({
    company_id: connection.company_id,
    shop_domain: connection.shop_domain,
    inventory_item_id: String(inventoryItemId),
    pos_product_id: { $ne: null },
  }).lean();
  const location = await ShopifyLocation.findOne({
    company_id: connection.company_id,
    shop_domain: connection.shop_domain,
    shopify_id: String(locationId),
  }).lean();
  if (!mapping?.pos_product_id || !location?.warehouse_id) {
    await finishSyncLog(log._id, "failed", "Product or warehouse mapping is missing.");
    return { applied: false, reason: "unmapped" };
  }
  const result = await setPosQuantity({
    companyId: connection.company_id,
    productId: mapping.pos_product_id,
    warehouseId: location.warehouse_id,
    targetQty: available,
    userId: connection.installed_by,
  });
  await ShopifyInventory.findOneAndUpdate(
    {
      company_id: connection.company_id,
      shop_domain: connection.shop_domain,
      inventory_item_id: String(inventoryItemId),
      location_id: String(locationId),
    },
    {
      $set: {
        shopify_id: `${inventoryItemId}:${locationId}`,
        pos_product_id: mapping.pos_product_id,
        warehouse_id: location.warehouse_id,
        available: Number(available) || 0,
        last_remote_qty: Number(available) || 0,
        last_remote_at: new Date(),
      },
    },
    { upsert: true },
  );
  await finishSyncLog(log._id, "success", "Inventory imported from Shopify.", result);
  return { applied: true, ...result };
}

async function pushInventory(connection) {
  const direction = connection.sync_settings?.inventory_sync_direction || "pos_to_shopify";
  if (direction === "shopify_to_pos") {
    return { skipped: true, reason: "direction_is_shopify_to_pos" };
  }
  const { log } = await openSyncLog({
    companyId: connection.company_id,
    shop: connection.shop_domain,
    shopifyId: connection.shopify_id,
    action: "push_inventory",
    message: "Pushing OrdersHub inventory to Shopify",
  });
  const stats = { pushed: 0, skipped: 0, failed: 0 };
  try {
    const client = await adminClient(connection);
    const mappings = await ShopifyProduct.find({
      company_id: connection.company_id,
      shop_domain: connection.shop_domain,
      inventory_item_id: { $nin: ["", null] },
      pos_product_id: { $ne: null },
      status: { $ne: "deleted" },
    }).lean();
    const locations = await ShopifyLocation.find({
      company_id: connection.company_id,
      shop_domain: connection.shop_domain,
      active: true,
      warehouse_id: { $ne: null },
    }).lean();
    for (const mapping of mappings) {
      for (const location of locations) {
        const stock = await WarehouseInventory.findOne(
          WarehouseInventory.activeRowFilter(
            mapping.pos_product_id,
            location.warehouse_id,
            connection.company_id,
          ),
        )
          .select("quantity")
          .lean();
        const quantity = Math.max(0, Math.round(Number(stock?.quantity) || 0));
        const levelKey = {
          company_id: connection.company_id,
          shop_domain: connection.shop_domain,
          inventory_item_id: mapping.inventory_item_id,
          location_id: location.shopify_id,
        };
        const previous = await ShopifyInventory.findOne(levelKey).lean();
        if (previous && Number(previous.last_pushed_qty) === quantity) {
          stats.skipped += 1;
          continue;
        }
        const result = await client.query(
          `mutation SetInventory($input: InventorySetQuantitiesInput!) {
            inventorySetQuantities(input: $input) {
              userErrors { field message }
            }
          }`,
          {
            input: {
              name: "available",
              reason: "correction",
              ignoreCompareQuantity: true,
              referenceDocumentUri: `${appUrl().origin}/shopify-sync/${connection.company_id}/${mapping.inventory_item_id}/${location.shopify_id}`,
              quantities: [
                {
                  inventoryItemId: `gid://shopify/InventoryItem/${mapping.inventory_item_id}`,
                  locationId: `gid://shopify/Location/${location.shopify_id}`,
                  quantity,
                },
              ],
            },
          },
        );
        const errors = result?.inventorySetQuantities?.userErrors || [];
        if (errors.length) {
          stats.failed += 1;
          await openSyncLog({
            companyId: connection.company_id,
            shop: connection.shop_domain,
            shopifyId: `${mapping.inventory_item_id}:${location.shopify_id}`,
            action: "push_inventory_item",
            message: errors.map((row) => row.message).join("; "),
          }).then(({ log: itemLog }) =>
            finishSyncLog(itemLog._id, "failed", errors.map((row) => row.message).join("; ")),
          );
          continue;
        }
        await ShopifyInventory.findOneAndUpdate(
          levelKey,
          {
            $set: {
              shopify_id: `${mapping.inventory_item_id}:${location.shopify_id}`,
              pos_product_id: mapping.pos_product_id,
              warehouse_id: location.warehouse_id,
              available: quantity,
              last_pushed_qty: quantity,
              last_pushed_at: new Date(),
            },
          },
          { upsert: true },
        );
        stats.pushed += 1;
      }
    }
    connection.last_inventory_sync_at = new Date();
    connection.last_sync_at = new Date();
    connection.inventory_sync_status = stats.failed ? "error" : "ok";
    await connection.save();
    await finishSyncLog(log._id, stats.failed ? "failed" : "success", "Inventory push finished.", stats);
    return stats;
  } catch (error) {
    connection.inventory_sync_status = "error";
    connection.last_error = error.message;
    await connection.save();
    await finishSyncLog(log._id, "failed", error.message);
    throw error;
  }
}

async function importInventory(connection) {
  const direction = connection.sync_settings?.inventory_sync_direction || "pos_to_shopify";
  await importLocations(connection);
  if (direction === "pos_to_shopify") {
    return pushInventory(connection);
  }
  const client = await adminClient(connection);
  const mappings = await ShopifyProduct.find({
    company_id: connection.company_id,
    shop_domain: connection.shop_domain,
    inventory_item_id: { $nin: ["", null] },
  }).lean();
  const stats = { applied: 0, skipped: 0 };
  for (const mapping of mappings) {
    const data = await client.query(
      `query ItemLevels($id: ID!) {
        inventoryItem(id: $id) {
          inventoryLevels(first: 20) {
            nodes {
              location { legacyResourceId }
              quantities(names: ["available"]) { quantity }
            }
          }
        }
      }`,
      { id: `gid://shopify/InventoryItem/${mapping.inventory_item_id}` },
    );
    const nodes = data?.inventoryItem?.inventoryLevels?.nodes || [];
    for (const node of nodes) {
      const available = Number(node.quantities?.[0]?.quantity) || 0;
      const result = await applyRemoteLevel(connection, {
        inventoryItemId: mapping.inventory_item_id,
        locationId: node.location?.legacyResourceId,
        available,
      });
      if (result.applied) stats.applied += 1;
      else stats.skipped += 1;
    }
  }
  if (direction === "bidirectional") {
    const pushed = await pushInventory(connection);
    stats.pushed = pushed;
  }
  connection.last_inventory_sync_at = new Date();
  connection.inventory_sync_status = "ok";
  connection.last_sync_at = new Date();
  await connection.save();
  return stats;
}

module.exports = {
  importLocations,
  mapLocationWarehouse,
  importInventory,
  pushInventory,
  applyRemoteLevel,
};
