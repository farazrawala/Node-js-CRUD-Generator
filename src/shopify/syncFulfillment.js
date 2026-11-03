/**
 * Fulfillment orders, tracking, and the OrdersHub courier shipment.
 * Fulfillment is created only when Shopify says this app may fulfill the order.
 * @module src/shopify/syncFulfillment
 */

const mongoose = require("mongoose");
const Order = require("../../models/order");
const Courier = require("../../models/courier");
const { numericId } = require("./orderMapper");
const { ShopifyFulfillment, ShopifyOrder } = require("./models");
const { adminClient } = require("./connectionService");
const { openSyncLog, finishSyncLog } = require("./syncLog");

function actionNames(fulfillmentOrder) {
  return (fulfillmentOrder?.supportedActions || [])
    .map((action) => (typeof action === "string" ? action : action?.action))
    .filter(Boolean);
}

function trackingFromNode(node) {
  const info = Array.isArray(node?.trackingInfo) ? node.trackingInfo[0] : null;
  return {
    tracking_number: info?.number || "",
    tracking_company: info?.company || "",
    tracking_url: info?.url || "",
  };
}

async function listFulfillmentOrders(client, orderGid) {
  const data = await client.query(
    `query FulfillmentOrders($id: ID!) {
      order(id: $id) {
        fulfillmentOrders(first: 20) {
          nodes {
            id
            status
            requestStatus
            supportedActions { action }
            lineItems(first: 50) {
              nodes { id remainingQuantity }
            }
          }
        }
        fulfillments {
          id
          status
          displayStatus
          trackingInfo { company number url }
        }
      }
    }`,
    { id: orderGid },
  );
  return data?.order || null;
}

async function saveFulfillment(connection, orderShopifyId, node, posOrderId) {
  const tracking = trackingFromNode(node);
  const shopifyId = numericId(node.id) || String(node.id);
  return ShopifyFulfillment.findOneAndUpdate(
    {
      company_id: connection.company_id,
      shop_domain: connection.shop_domain,
      shopify_id: shopifyId,
    },
    {
      $set: {
        order_shopify_id: String(orderShopifyId || ""),
        pos_order_id: posOrderId || undefined,
        status: String(node.status || "").toLowerCase(),
        shipment_status: String(node.displayStatus || "").toLowerCase(),
        ...tracking,
      },
    },
    { upsert: true, new: true },
  );
}

async function createFulfillment(connection, {
  orderShopifyId,
  trackingNumber,
  trackingCompany,
  trackingUrl,
  lineItems,
  notifyCustomer = false,
}) {
  const client = await adminClient(connection);
  const orderGid = `gid://shopify/Order/${numericId(orderShopifyId)}`;
  const remote = await listFulfillmentOrders(client, orderGid);
  if (!remote) {
    const error = new Error("Shopify order was not found.");
    error.status = 404;
    throw error;
  }
  const openOrders = (remote.fulfillmentOrders?.nodes || []).filter((row) => {
    const status = String(row.status || "").toUpperCase();
    return status !== "CLOSED" && status !== "CANCELLED";
  });
  const manageable = openOrders.find((row) =>
    actionNames(row).includes("CREATE_FULFILLMENT"),
  );
  if (!manageable) {
    const error = new Error(
      "Shopify has not assigned this fulfillment order to the app. Tracking was not created.",
    );
    error.status = 403;
    throw error;
  }
  const requested = new Map(
    (lineItems || []).map((line) => [String(line.id), Number(line.quantity)]),
  );
  const fulfillmentOrderLineItems = (manageable.lineItems?.nodes || [])
    .map((line) => {
      const remaining = Number(line.remainingQuantity) || 0;
      if (!remaining) return null;
      const quantity = requested.size
        ? Math.min(remaining, requested.get(numericId(line.id)) || requested.get(line.id) || 0)
        : remaining;
      if (!quantity) return null;
      return { id: line.id, quantity };
    })
    .filter(Boolean);
  if (!fulfillmentOrderLineItems.length) {
    const error = new Error("Nothing left to fulfill on this Shopify order.");
    error.status = 409;
    throw error;
  }
  const result = await client.query(
    `mutation CreateFulfillment($fulfillment: FulfillmentInput!) {
      fulfillmentCreate(fulfillment: $fulfillment) {
        fulfillment { id status displayStatus trackingInfo { company number url } }
        userErrors { field message }
      }
    }`,
    {
      fulfillment: {
        notifyCustomer: Boolean(notifyCustomer),
        trackingInfo: trackingNumber
          ? {
              company: trackingCompany || undefined,
              number: trackingNumber,
              url: trackingUrl || undefined,
            }
          : undefined,
        lineItemsByFulfillmentOrder: [
          {
            fulfillmentOrderId: manageable.id,
            fulfillmentOrderLineItems,
          },
        ],
      },
    },
  );
  const errors = result?.fulfillmentCreate?.userErrors || [];
  if (errors.length) {
    const error = new Error(errors.map((row) => row.message).join("; "));
    error.status = 422;
    throw error;
  }
  const created = result?.fulfillmentCreate?.fulfillment;
  const posLink = await ShopifyOrder.findOne({
    company_id: connection.company_id,
    shop_domain: connection.shop_domain,
    shopify_id: String(numericId(orderShopifyId)),
  })
    .select("pos_order_id")
    .lean();
  return saveFulfillment(
    connection,
    numericId(orderShopifyId),
    created,
    posLink?.pos_order_id,
  );
}

async function updateTracking(connection, fulfillmentId, tracking) {
  const client = await adminClient(connection);
  const result = await client.query(
    `mutation UpdateTracking($id: ID!, $tracking: FulfillmentTrackingInput!, $notify: Boolean) {
      fulfillmentTrackingInfoUpdate(fulfillmentId: $id, trackingInfoInput: $tracking, notifyCustomer: $notify) {
        fulfillment { id status displayStatus trackingInfo { company number url } }
        userErrors { field message }
      }
    }`,
    {
      id: String(fulfillmentId).startsWith("gid://")
        ? fulfillmentId
        : `gid://shopify/Fulfillment/${fulfillmentId}`,
      notify: false,
      tracking: {
        company: tracking.trackingCompany || undefined,
        number: tracking.trackingNumber,
        url: tracking.trackingUrl || undefined,
      },
    },
  );
  const errors = result?.fulfillmentTrackingInfoUpdate?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((row) => row.message).join("; "));
  }
  return result.fulfillmentTrackingInfoUpdate.fulfillment;
}

async function cancelFulfillment(connection, fulfillmentId) {
  const client = await adminClient(connection);
  const result = await client.query(
    `mutation CancelFulfillment($id: ID!) {
      fulfillmentCancel(id: $id) {
        fulfillment { id status }
        userErrors { field message }
      }
    }`,
    {
      id: String(fulfillmentId).startsWith("gid://")
        ? fulfillmentId
        : `gid://shopify/Fulfillment/${fulfillmentId}`,
    },
  );
  const errors = result?.fulfillmentCancel?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((row) => row.message).join("; "));
  }
  return result.fulfillmentCancel.fulfillment;
}

async function courierTracking(order) {
  let shipment = null;
  try {
    const CourierShipment = mongoose.model("courier_shipment");
    shipment = await CourierShipment.findOne({
      company_id: order.company_id,
      order_id: order._id,
    })
      .sort({ updated_at: -1, updatedAt: -1 })
      .lean();
  } catch {
    shipment = null;
  }
  let courierName = "";
  if (order.courier_id) {
    const courier = await Courier.findOne({
      _id: order.courier_id,
      company_id: order.company_id,
    })
      .select("name")
      .lean();
    courierName = courier?.name || "";
  }
  return {
    trackingNumber: shipment?.tracking_number || order.courier_tracking_number || "",
    trackingCompany: courierName,
    trackingUrl: shipment?.tracking_url || "",
  };
}

async function pushOrderTracking(connection, posOrderId) {
  const order = await Order.findOne({
    _id: posOrderId,
    company_id: connection.company_id,
    deletedAt: null,
  }).lean();
  if (!order) return { skipped: true, reason: "order_not_found" };
  const link = await ShopifyOrder.findOne({
    company_id: connection.company_id,
    shop_domain: connection.shop_domain,
    pos_order_id: order._id,
  }).lean();
  if (!link) return { skipped: true, reason: "not_a_shopify_order" };
  const tracking = await courierTracking(order);
  if (!tracking.trackingNumber) return { skipped: true, reason: "no_tracking_number" };
  const existing = await ShopifyFulfillment.findOne({
    company_id: connection.company_id,
    shop_domain: connection.shop_domain,
    order_shopify_id: link.shopify_id,
    tracking_number: tracking.trackingNumber,
  }).lean();
  if (existing) return { skipped: true, reason: "tracking_already_synced" };
  const open = await ShopifyFulfillment.findOne({
    company_id: connection.company_id,
    shop_domain: connection.shop_domain,
    order_shopify_id: link.shopify_id,
    status: { $nin: ["cancelled", "canceled", "error"] },
    tracking_number: "",
  }).lean();
  if (open) {
    const updated = await updateTracking(connection, open.shopify_id, tracking);
    return saveFulfillment(connection, link.shopify_id, updated, order._id);
  }
  return createFulfillment(connection, {
    orderShopifyId: link.shopify_id,
    trackingNumber: tracking.trackingNumber,
    trackingCompany: tracking.trackingCompany,
    trackingUrl: tracking.trackingUrl,
  });
}

async function syncFulfillments(connection) {
  if (connection.sync_settings?.fulfillment_sync_enabled === false) {
    return { skipped: true, reason: "fulfillment_sync_disabled" };
  }
  const { log } = await openSyncLog({
    companyId: connection.company_id,
    shop: connection.shop_domain,
    shopifyId: connection.shopify_id,
    action: "sync_fulfillments",
    message: "Synchronizing fulfillments",
  });
  const stats = { pulled: 0, pushed: 0, failed: 0 };
  try {
    const client = await adminClient(connection);
    const links = await ShopifyOrder.find({
      company_id: connection.company_id,
      shop_domain: connection.shop_domain,
      cancelled_at: null,
    })
      .sort({ updated_at: -1 })
      .limit(100)
      .lean();
    for (const link of links) {
      try {
        const remote = await listFulfillmentOrders(
          client,
          `gid://shopify/Order/${link.shopify_id}`,
        );
        for (const node of remote?.fulfillments || []) {
          const saved = await saveFulfillment(
            connection,
            link.shopify_id,
            node,
            link.pos_order_id,
          );
          stats.pulled += 1;
          if (saved.tracking_number && link.pos_order_id) {
            const order = await Order.findOne({
              _id: link.pos_order_id,
              company_id: connection.company_id,
            });
            if (order && !String(order.courier_tracking_number || "").trim()) {
              order.courier_tracking_number = saved.tracking_number;
              await order.save();
            }
          }
        }
        if (link.pos_order_id) {
          const pushed = await pushOrderTracking(connection, link.pos_order_id);
          if (pushed && !pushed.skipped) stats.pushed += 1;
        }
      } catch (error) {
        stats.failed += 1;
        console.warn(
          `[shopify] fulfillment sync ${link.shopify_id}:`,
          error?.message || error,
        );
      }
    }
    connection.last_fulfillment_sync_at = new Date();
    connection.fulfillment_status = stats.failed ? "error" : "ok";
    connection.last_sync_at = new Date();
    await connection.save();
    await finishSyncLog(log._id, "success", "Fulfillment sync finished.", stats);
    return stats;
  } catch (error) {
    connection.fulfillment_status = "error";
    connection.last_error = error.message;
    await connection.save();
    await finishSyncLog(log._id, "failed", error.message);
    throw error;
  }
}

module.exports = {
  createFulfillment,
  updateTracking,
  cancelFulfillment,
  pushOrderTracking,
  syncFulfillments,
};
