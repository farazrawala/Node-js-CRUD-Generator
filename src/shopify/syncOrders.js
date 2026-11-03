/**
 * Import Shopify orders through the existing POS order importer.
 * @module src/shopify/syncOrders
 */

const Order = require("../../models/order");
const { importShopifyOrderToPos } = require("../../controllers/shopifyProcess");
const { orderHistoryDays } = require("./constants");
const { mapGraphqlOrder, numericId } = require("./orderMapper");
const { ShopifyOrder } = require("./models");
const { adminClient } = require("./connectionService");
const { openSyncLog, finishSyncLog } = require("./syncLog");

const ORDER_FIELDS = `
  id
  legacyResourceId
  name
  email
  phone
  note
  displayFinancialStatus
  displayFulfillmentStatus
  cancelledAt
  currencyCode
  sourceName
  paymentGatewayNames
  totalPriceSet { shopMoney { amount } }
  totalDiscountsSet { shopMoney { amount } }
  totalTaxSet { shopMoney { amount } }
  totalShippingPriceSet { shopMoney { amount } }
  customer { firstName lastName email phone }
  billingAddress { firstName lastName address1 address2 city province zip country phone }
  shippingAddress { firstName lastName address1 address2 city province zip country phone }
  shippingLines(first: 5) { nodes { title originalPriceSet { shopMoney { amount } } } }
  lineItems(first: 100) {
    nodes {
      id
      name
      title
      sku
      quantity
      originalUnitPriceSet { shopMoney { amount } }
      product { legacyResourceId }
      variant { legacyResourceId sku barcode }
    }
  }
  fulfillments {
    id
    status
    displayStatus
    createdAt
    updatedAt
    trackingInfo { company number url }
  }
`;

function sinceDate(connection) {
  const days = orderHistoryDays(connection.granted_scopes);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return since.toISOString().slice(0, 10);
}

async function rememberOrder(connection, remote, posOrder) {
  await ShopifyOrder.findOneAndUpdate(
    {
      company_id: connection.company_id,
      shop_domain: connection.shop_domain,
      shopify_id: String(remote.id),
    },
    {
      $set: {
        pos_order_id: posOrder?._id || undefined,
        name: remote.name || "",
        financial_status: remote.financial_status || "",
        fulfillment_status: remote.fulfillment_status || "",
        currency: remote.currency || "",
        total_price: remote.total_price || "",
        total_discounts: remote.total_discounts || "",
        total_tax: remote.total_tax || "",
        total_shipping: remote.total_shipping_price_set?.shop_money?.amount || "",
        payment_gateways: remote.payment_gateway_names || [],
        channel: remote.source_name || "",
        cancelled_at: remote.cancelled_at ? new Date(remote.cancelled_at) : null,
      },
    },
    { upsert: true },
  );
}

async function importRemoteOrder(connection, node) {
  const remote = mapGraphqlOrder(node);
  if (!remote) return { skipped: true };
  const graphql = await adminClient(connection);
  const stats = {};
  const process = {
    integration_id: connection.integration_id,
    company_id: connection.company_id,
    created_by: connection.installed_by,
  };
  await importShopifyOrderToPos(remote, {
    companyId: connection.company_id,
    process,
    stats,
    req: null,
    client: null,
    graphql,
    allowRemoteProductCreate: connection.sync_settings?.product_sync_enabled !== false,
  });
  const posOrder = await Order.findOne({
    company_id: connection.company_id,
    integration_id: connection.integration_id,
    $or: [
      { integration_order_id: String(remote.order_number) },
      { integration_order_id: String(remote.name) },
      { description: new RegExp(`shopify:order:${remote.id}\\b`) },
    ],
  })
    .select("_id")
    .lean();
  await rememberOrder(connection, remote, posOrder);
  return { imported: true, pos_order_id: posOrder?._id || null };
}

async function importOrders(connection) {
  if (connection.sync_settings?.order_import_enabled === false) {
    return { skipped: true, reason: "order_import_disabled" };
  }
  const { log } = await openSyncLog({
    companyId: connection.company_id,
    shop: connection.shop_domain,
    shopifyId: connection.shopify_id,
    action: "import_orders",
    message: "Importing Shopify orders",
  });
  const stats = { pages: 0, imported: 0 };
  try {
    const client = await adminClient(connection);
    const queryText = `created_at:>=${sinceDate(connection)}`;
    let cursor = null;
    const maxPages = Number(process.env.SHOPIFY_MAX_PAGES || 200);
    do {
      const data = await client.query(
        `query ShopifyOrders($cursor: String, $query: String) {
          orders(first: 40, after: $cursor, query: $query, sortKey: CREATED_AT) {
            pageInfo { hasNextPage endCursor }
            nodes { ${ORDER_FIELDS} }
          }
        }`,
        { cursor, query: queryText },
      );
      for (const node of data?.orders?.nodes || []) {
        await importRemoteOrder(connection, node);
        stats.imported += 1;
      }
      stats.pages += 1;
      cursor = data?.orders?.pageInfo?.hasNextPage
        ? data.orders.pageInfo.endCursor
        : null;
    } while (cursor && stats.pages < maxPages);

    connection.order_count = await ShopifyOrder.countDocuments({
      company_id: connection.company_id,
      shop_domain: connection.shop_domain,
    });
    connection.last_order_sync_at = new Date();
    connection.last_sync_at = new Date();
    connection.last_error = "";
    await connection.save();
    await finishSyncLog(log._id, "success", `Imported ${stats.imported} Shopify orders.`, stats);
    return stats;
  } catch (error) {
    connection.last_error = error.message;
    await connection.save();
    await finishSyncLog(log._id, "failed", error.message);
    throw error;
  }
}

async function importOrderById(connection, orderGidOrId) {
  const id = String(orderGidOrId).startsWith("gid://")
    ? orderGidOrId
    : `gid://shopify/Order/${numericId(orderGidOrId)}`;
  const client = await adminClient(connection);
  const data = await client.query(
    `query OneOrder($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`,
    { id },
  );
  if (!data?.order) return { skipped: true, reason: "order_not_found" };
  return importRemoteOrder(connection, data.order);
}

module.exports = {
  importOrders,
  importOrderById,
  importRemoteOrder,
};
