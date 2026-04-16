const mongoose = require("mongoose");
const Order = require("../models/order");
const OrderItem = require("../models/order_item");
const {
  handleGenericCreate,
  handleGenericUpdate,
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

async function getOrderByorderItem(req, res) {
  const filter = { status: "active", deletedAt: null };
  const response = await handleGenericGetAll(req, "order", {
    filter,
    excludeFields: [],
    sort: { createdAt: -1 },
    limit: req.query.limit ? parseInt(req.query.limit, 10) : null,
    skip: req.query.skip ? parseInt(req.query.skip, 10) : 0,
  });

  if (!response.success || !Array.isArray(response.data)) {
    return res.status(response.status).json(response);
  }

  const orderIds = response.data.map((o) => o._id).filter(Boolean);
  if (orderIds.length === 0) {
    return res.status(response.status).json(response);
  }

  const itemFilter = {
    order_id: { $in: orderIds },
    status: "active",
    deletedAt: null,
  };
  const items = await OrderItem.find(itemFilter)
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

  const data = response.data.map((order) => {
    const order_items = itemsByOrderId.get(String(order._id)) || [];
    return {
      ...order,
      order_items,
      no_of_items: order_items.length,
    };
  });

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
  let orderItemRes = [];
  products.forEach(async (product, index) => {
    req.body.order_id = orderId;
    req.body.product_id = product.product_id;
    req.body.qty = product.qty;
    req.body.price = product.price;
    orderItemRes[index] = await handleGenericCreate(req, "order_item", {
      afterCreate: async (record, req) => {
        console.log("✅ Record created successfully:", record);
      },
    })
      .then((response) => {
        console.log("✅ Record created successfully:", response);
      })
      .catch((error) => {
        console.error("❌ Failed to create record:", error);
        return res.status(error.status).json(error);
      });
  });
  console.log("🔍 orderItemRes1", orderItemRes);
  return res.status(response.status).json(response);
}

async function getOrderByOrderNo(req, res) {
  const param = String(req.params.id || "").trim();
  if (!param) {
    return res.status(400).json({
      success: false,
      status: 400,
      error: "Record ID is required",
      details: "Please provide id in the URL parameters",
      type: "missing_id",
    });
  }

  const filter = { status: "active", deletedAt: null };

  let order = await Order.findOne({ order_no: param, ...filter });
  if (!order && mongoose.Types.ObjectId.isValid(param)) {
    order = await Order.findOne({ _id: param, ...filter });
  }

  if (!order) {
    return res.status(404).json({
      success: false,
      status: 404,
      error: "Record not found",
      details: `order with order_no or id "${param}" not found`,
      type: "not_found",
    });
  }

  const items = await OrderItem.find({
    order_id: order._id,
    status: "active",
    deletedAt: null,
  })
    .populate("product_id")
    .sort({ createdAt: 1 })
    .lean();

  const data = {
    ...order.toObject({ flattenMaps: true }),
    order_items: items,
    no_of_items: items.length,
  };

  return res.status(200).json({
    success: true,
    status: 200,
    data,
  });
}

async function invoiceUpdate(req, res) {
  const response = await handleGenericUpdate(req, "order", {
    afterUpdate: async (record, req, existingUser) => {
      console.log("✅ Record updated successfully:", record);
    },
  });
  return res.status(response.status).json(response);
}

module.exports = {
  // orderCreate,
  // orderUpdate,
  invoiceUpdate,
  getOrderByOrderNo,
  order_save,
  getOrderByorderItem,
};
