/**
 * ShopifyQL sales reports when read_reports is granted.
 * OrdersHub totals are always calculated separately and labeled as such.
 * @module src/shopify/analytics
 */

const Order = require("../../models/order");
const { adminClient } = require("./connectionService");

function rowsOf(table) {
  const columns = table?.columns || [];
  return (table?.rows || []).map((row) => {
    if (row && typeof row === "object" && !Array.isArray(row)) return row;
    const record = {};
    columns.forEach((column, index) => {
      record[column.name || column.displayName || `col_${index}`] = row?.[index];
    });
    return record;
  });
}

function numberFrom(row, names) {
  for (const name of names) {
    const value = Number(row?.[name]);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

async function shopifyql(client, query) {
  const data = await client.query(
    `query Report($query: String!) {
      shopifyqlQuery(query: $query) {
        tableData { columns { name dataType displayName } rows }
        parseErrors
      }
    }`,
    { query },
  );
  const report = data?.shopifyqlQuery;
  if (!report || (report.parseErrors && report.parseErrors.length)) {
    const error = new Error(
      (report?.parseErrors || ["ShopifyQL is not available for this store."]).join("; "),
    );
    error.status = 403;
    throw error;
  }
  return rowsOf(report.tableData);
}

async function ordersHubTotals(companyId, match, from, to) {
  const createdAt = {};
  if (from) createdAt.$gte = new Date(from);
  if (to) createdAt.$lte = new Date(to);
  const filter = {
    company_id: companyId,
    deletedAt: null,
    ...match,
  };
  if (Object.keys(createdAt).length) filter.createdAt = createdAt;
  const [summary] = await Order.aggregate([
    { $match: filter },
    {
      $group: {
        _id: null,
        total_sales: { $sum: "$total_amount" },
        total_orders: { $sum: 1 },
        discounts: { $sum: "$discount" },
      },
    },
  ]);
  const totalSales = Number(summary?.total_sales) || 0;
  const totalOrders = Number(summary?.total_orders) || 0;
  const discounts = Number(summary?.discounts) || 0;
  return {
    source: "ordershub_calculated",
    total_sales: totalSales,
    net_sales: Math.round((totalSales - discounts) * 100) / 100,
    total_orders: totalOrders,
    average_order_value: totalOrders
      ? Math.round((totalSales / totalOrders) * 100) / 100
      : 0,
  };
}

async function analytics(connection, { from, to } = {}) {
  const since = from ? String(from).slice(0, 10) : "-30d";
  const until = to ? String(to).slice(0, 10) : "today";
  const range = from ? `SINCE ${since} UNTIL ${until}` : "SINCE -30d UNTIL today";
  const hasReports = (connection.granted_scopes || []).includes("read_reports");
  let shopify = null;
  let shopifyError = "";
  if (hasReports) {
    try {
      const client = await adminClient(connection);
      const summaryRows = await shopifyql(
        client,
        `FROM sales SHOW total_sales, net_sales, orders, average_order_value ${range}`,
      );
      const summary = summaryRows[0] || {};
      const byProduct = await shopifyql(
        client,
        `FROM sales SHOW total_sales, net_sales, orders GROUP BY product_title ${range} ORDER BY total_sales DESC LIMIT 25`,
      );
      const byDate = await shopifyql(
        client,
        `FROM sales SHOW total_sales, orders GROUP BY day ${range} ORDER BY day`,
      );
      let byChannel = [];
      try {
        byChannel = await shopifyql(
          client,
          `FROM sales SHOW total_sales, orders GROUP BY sales_channel ${range}`,
        );
      } catch (error) {
        byChannel = [];
        shopifyError = error.message;
      }
      shopify = {
        source: "shopify_reports",
        total_sales: numberFrom(summary, ["total_sales"]),
        net_sales: numberFrom(summary, ["net_sales"]),
        total_orders: numberFrom(summary, ["orders"]),
        average_order_value: numberFrom(summary, ["average_order_value"]),
        sales_by_product: byProduct,
        sales_by_date: byDate,
        sales_by_channel: byChannel,
      };
    } catch (error) {
      shopify = null;
      shopifyError = error.message;
    }
  } else {
    shopifyError =
      "read_reports is not granted. Shopify-reported metrics are unavailable. OrdersHub totals below are calculated from imported orders.";
  }

  const ordershubShopify = await ordersHubTotals(
    connection.company_id,
    { integration_id: connection.integration_id },
    from,
    to,
  );
  const ordershubPos = await ordersHubTotals(
    connection.company_id,
    {
      $or: [
        { integration_id: null },
        { integration_id: { $exists: false } },
        { integration_id: { $ne: connection.integration_id } },
      ],
    },
    from,
    to,
  );

  return {
    shopify_reported: shopify,
    shopify_reported_error: shopifyError,
    ordershub_shopify_orders: ordershubShopify,
    ordershub_pos_sales: {
      ...ordershubPos,
      note: "OrdersHub orders that did not come from this Shopify store.",
    },
  };
}

module.exports = {
  analytics,
};
