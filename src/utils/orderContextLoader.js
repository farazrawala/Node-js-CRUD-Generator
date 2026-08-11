/**
 * Loads everything a courier needs from the DB given only an orderId.
 * @module src/utils/orderContextLoader
 */

const mongoose = require("mongoose");
const { orderNotFound } = require("../couriers/errors");

/**
 * @typedef {object} OrderContext
 * @property {*} _id
 * @property {string} [order_no]
 * @property {string} [name]
 * @property {string} [email]
 * @property {string} [phone]
 * @property {string} [address]
 * @property {string} [description]
 * @property {string} [city]
 * @property {string} [province]
 * @property {string} [country]
 * @property {string} [countryCode]
 * @property {number} codAmount
 * @property {number} weightKg
 * @property {number} pieces
 * @property {object} company
 * @property {object|null} customer
 * @property {object} shippingAddress
 * @property {object} billingAddress
 * @property {object|null} warehouse
 * @property {object[]} items
 * @property {number} [declaredValue]
 * @property {string} [contentDesc]
 * @property {string} [remarks]
 */

/**
 * @param {string|import('mongoose').Types.ObjectId} orderId
 * @param {object} [opts]
 * @param {string|import('mongoose').Types.ObjectId} [opts.companyId] tenant guard
 * @returns {Promise<OrderContext>}
 */
async function loadOrderContext(orderId, opts = {}) {
  if (!orderId || !mongoose.Types.ObjectId.isValid(String(orderId))) {
    throw orderNotFound(orderId);
  }

  const Order = mongoose.model("order");
  const OrderItem = mongoose.model("order_item");
  const Company = mongoose.model("company");

  const filter = { _id: orderId, deletedAt: null };
  if (opts.companyId) filter.company_id = opts.companyId;

  const order = await Order.findOne(filter).lean();
  if (!order) throw orderNotFound(orderId);

  const [company, items, customer] = await Promise.all([
    Company.findById(order.company_id).lean(),
    OrderItem.find({
      order_id: order._id,
      deletedAt: null,
      status: { $ne: "inactive" },
    })
      .populate("product_id", "name weight price")
      .lean(),
    order.customer_id ?
      mongoose.model("user").findById(order.customer_id).lean()
    : Promise.resolve(null),
  ]);

  let warehouse = null;
  if (company?.warehouse_id) {
    try {
      warehouse = await mongoose
        .model("warehouse")
        .findById(company.warehouse_id)
        .lean();
    } catch {
      warehouse = null;
    }
  }

  const enrichedItems = (items || []).map((line) => {
    const product = line.product_id && typeof line.product_id === "object" ?
        line.product_id
      : null;
    return {
      _id: line._id,
      name: line.name || product?.name || "Item",
      qty: Number(line.qty) || 1,
      price: Number(line.price) || 0,
      subtotal: Number(line.subtotal) || 0,
      // Product weight is stored in grams when synced to Shopify (weight_unit: "g").
      weight: productWeightToKg(product?.weight),
      product_id: product?._id || line.product_id,
    };
  });

  const totalWeightFromItems = enrichedItems.reduce((sum, it) => {
    const w = Number(it.weight) || 0;
    return sum + w * (Number(it.qty) || 1);
  }, 0);
  const weightKg = Math.max(0.5, totalWeightFromItems || 0.5);
  // Courier "pieces" = physical packages in the consignment, not retail SKU qty.
  // (Summing line qty breaks providers like PostEx that require items in 1..99.)
  const explicitPackages = Number(
    order.no_of_pieces ?? order.package_count ?? order.packages ?? order.pieces,
  );
  const pieces =
    Number.isFinite(explicitPackages) && explicitPackages > 0
      ? Math.max(1, Math.round(explicitPackages))
      : 1;

  const totalAmount = Number(order.total_amount) || 0;
  const amountReceived = Number(order.amount_received) || 0;
  // Remaining balance treated as COD when not fully paid.
  const codAmount = Math.max(0, round2(totalAmount - amountReceived));

  const shippingAddress = {
    name: order.name || customer?.name || "",
    phone: order.phone || customer?.phone || "",
    email: order.email || customer?.email || "",
    address: order.address || customer?.address || "",
    address2: "",
    city: order.city || customer?.city || warehouse?.city || "",
    province: order.province || order.state || customer?.state || warehouse?.state || "",
    country: order.country || "Pakistan",
    country_code: order.country_code || "PK",
    zip: order.zip || order.postal_code || warehouse?.zip_code || "",
    city_id: order.city_id || null,
    area: order.area || "",
    landmark: order.landmark || "",
    lat: order.lat || "",
    lng: order.lng || "",
  };

  const billingAddress = { ...shippingAddress };

  /** @type {OrderContext} */
  const ctx = {
    ...order,
    company: company || {},
    customer: customer || null,
    warehouse,
    items: enrichedItems,
    shippingAddress,
    billingAddress,
    city: shippingAddress.city,
    province: shippingAddress.province,
    country: shippingAddress.country,
    countryCode: shippingAddress.country_code,
    codAmount,
    weightKg,
    pieces,
    declaredValue: totalAmount,
    contentDesc: enrichedItems
      .map((i) => i.name)
      .filter(Boolean)
      .slice(0, 3)
      .join(", ")
      .slice(0, 50) || "Goods",
    remarks: order.description || "",
  };

  return ctx;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Normalize product weight to kilograms.
 * Values above 50 are treated as grams (common for Shopify-synced catalog data).
 * @param {*} raw
 * @returns {number}
 */
function productWeightToKg(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // Unrealistic as kg for a single retail line → assume grams.
  if (n > 50) return n / 1000;
  return n;
}

module.exports = { loadOrderContext, productWeightToKg };
