/**
 * Map a Shopify Admin GraphQL order into the REST shape already imported
 * by importShopifyOrderToPos.
 * @module src/shopify/orderMapper
 */

function numericId(gid) {
  const text = String(gid || "");
  const match = text.match(/(\d+)\s*$/);
  return match ? match[1] : "";
}

function money(set) {
  const amount =
    set?.shopMoney?.amount ??
    set?.shop_money?.amount ??
    set?.presentmentMoney?.amount ??
    null;
  if (amount == null || amount === "") return "0.00";
  return String(amount);
}

function address(node) {
  if (!node) return null;
  return {
    first_name: node.firstName || "",
    last_name: node.lastName || "",
    name: [node.firstName, node.lastName].filter(Boolean).join(" "),
    address1: node.address1 || "",
    address2: node.address2 || "",
    city: node.city || "",
    province: node.province || node.provinceCode || "",
    zip: node.zip || "",
    country: node.country || node.countryCodeV2 || "",
    phone: node.phone || "",
  };
}

function fulfillmentStatus(display) {
  const value = String(display || "").toLowerCase();
  if (value === "fulfilled") return "fulfilled";
  if (value === "partial" || value === "partially_fulfilled") return "partial";
  return null;
}

function mapGraphqlOrder(node) {
  if (!node) return null;
  const id = String(node.legacyResourceId || numericId(node.id) || "");
  if (!id) return null;
  const name = String(node.name || "").trim();
  const orderNumber = name.replace(/^#/, "") || id;
  const cancelledAt = node.cancelledAt || null;
  const lines = (node.lineItems?.nodes || []).map((line) => ({
    id: numericId(line.id),
    name: line.name || line.title || "",
    title: line.title || line.name || "",
    sku: line.sku || line.variant?.sku || "",
    quantity: Number(line.quantity) || 0,
    price: money(line.originalUnitPriceSet),
    product_id: numericId(line.product?.legacyResourceId || line.product?.id),
    variant_id: numericId(line.variant?.legacyResourceId || line.variant?.id),
    barcode: line.variant?.barcode || "",
  }));
  const fulfillments = (node.fulfillments || []).map((row) => ({
    id: numericId(row.id),
    status: String(row.status || "success").toLowerCase(),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    tracking_info: Array.isArray(row.trackingInfo) ? row.trackingInfo : [],
    shipment_status: String(row.displayStatus || "")
      .trim()
      .toLowerCase(),
  }));

  return {
    id,
    admin_graphql_api_id: node.id || `gid://shopify/Order/${id}`,
    name,
    order_number: orderNumber,
    email: node.email || node.customer?.email || "",
    phone: node.phone || node.customer?.phone || "",
    note: node.note || "",
    financial_status: cancelledAt
      ? "voided"
      : String(node.displayFinancialStatus || "pending").toLowerCase(),
    fulfillment_status: fulfillmentStatus(node.displayFulfillmentStatus),
    cancelled_at: cancelledAt,
    currency: node.currencyCode || "",
    total_price: money(node.totalPriceSet),
    total_discounts: money(node.totalDiscountsSet),
    total_tax: money(node.totalTaxSet),
    total_shipping_price_set: {
      shop_money: { amount: money(node.totalShippingPriceSet) },
    },
    payment_gateway_names: Array.isArray(node.paymentGatewayNames)
      ? node.paymentGatewayNames
      : [],
    source_name: node.sourceName || "",
    customer: node.customer
      ? {
          first_name: node.customer.firstName || "",
          last_name: node.customer.lastName || "",
          email: node.customer.email || "",
          phone: node.customer.phone || "",
        }
      : null,
    billing_address: address(node.billingAddress),
    shipping_address: address(node.shippingAddress),
    line_items: lines,
    fulfillments,
    shipping_lines: (node.shippingLines?.nodes || []).map((line) => ({
      title: line.title || "",
      price: money(line.originalPriceSet),
    })),
  };
}

module.exports = {
  numericId,
  mapGraphqlOrder,
};
