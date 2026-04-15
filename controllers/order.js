const mongoose = require("mongoose");
const Order = require("../models/order");
const OrderItem = require("../models/order_item");
const {
  handleGenericCreate,
  handleGenericUpdate,
  handleGenericGetById,
  handleGenericGetAll,
} = require("../utils/modelHelper");

// async function orderCreate(req, res) {
//   const response = await handleGenericCreate(req, "order", {
//     afterCreate: async (record, req) => {
//       console.log("✅ Record created successfully:", record);
//     },
//   });
//   return res.status(response.status).json(response);
// }

// async function orderUpdate(req, res) {
//   const response = await handleGenericUpdate(req, "", {
//     afterUpdate: async (record, req, existingUser) => {
//       console.log("✅ Record updated successfully:", record);
//     },
//   });
//   return res.status(response.status).json(response);
// }

// async function orderById(req, res) {
//   const response = await handleGenericGetById(req, "order", {
//     excludeFields: [], // Don't exclude any fields
//   });
//   return res.status(response.status).json(response);
// }

async function getOrderByorderItem(req, res) {
  const filter = { status: "active", deletedAt: null };
  const response = await handleGenericGetAll(req, "order", {
    filter,
    excludeFields: [],
    populate: [],
    sort: { createdAt: -1 },
    limit: req.query.limit ? parseInt(req.query.limit) : null,
    skip: req.query.skip ? parseInt(req.query.skip) : 0,
  });

  if (!response.success || !Array.isArray(response.data)) {
    return res.status(response.status).json(response);
  }

  const orderIds = response.data.map((o) => o._id).filter(Boolean);
  if (orderIds.length === 0) {
    return res.status(response.status).json(response);
  }

  const items = await OrderItem.find({ order_id: { $in: orderIds } })
    .populate("product_id")
    .sort({ createdAt: 1 })
    .lean();

  const itemsByOrderId = new Map();
  for (const id of orderIds) {
    itemsByOrderId.set(String(id), []);
  }
  for (const item of items) {
    const key = String(item.order_id);
    if (!itemsByOrderId.has(key)) {
      itemsByOrderId.set(key, []);
    }
    itemsByOrderId.get(key).push(item);
  }

  const data = response.data.map((order) => ({
    ...order,
    order_items: itemsByOrderId.get(String(order._id)) || [],
  }));

  return res.status(response.status).json({
    ...response,
    data,
  });
}

async function order_save(req, res) {
  console.log("🔍 Incoming request body:", JSON.stringify(req.body, null, 2));

  const response = await handleGenericCreate(req, "order", {
    afterCreate: async (record, req) => {
      console.log("✅ Record created successfully:", record);
    },
  });
  const orderId = response.data._id;

  const products = [];
  Object.keys(req.body).forEach((key) => {
    const match = key.match(/\[(\d+)\]/);
    if (!match) return;
    const index = match[1];
    if (!products[index]) {
      products[index] = {};
    }
    if (key.startsWith("product_id")) {
      products[index].product_id = req.body[key];
    }
    if (key.startsWith("qty")) {
      products[index].qty = req.body[key];
    }
    if (key.startsWith("price")) {
      products[index].price = req.body[key];
    }
  });
  console.log("🔍 products", products);
  products.forEach(async (product) => {
    req.body.order_id = orderId;
    req.body.product_id = product.product_id;
    req.body.qty = product.qty;
    req.body.price = product.price;
    const orderItemResponse = await handleGenericCreate(req, "order_item", {
      afterCreate: async (record, req) => {
        console.log("✅ Record created successfully:", record);
      },
    });
  });
  return res.status(orderItemResponse.status).json(orderItemResponse);
}

module.exports = {
  // orderCreate,
  // orderUpdate,
  // orderById,
  // getAllorder,
  order_save,
  getOrderByorderItem,
};
