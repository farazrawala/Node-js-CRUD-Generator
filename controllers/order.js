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

function orderItemGroupKey(order_id) {
  if (order_id == null) {
    return null;
  }
  if (typeof order_id === "object" && order_id._id != null) {
    return String(order_id._id);
  }
  return String(order_id);
}

async function getOrderByorderItem(req, res) {
  const filter = { status: "active", deletedAt: null };
  const response = await handleGenericGetAll(req, "order_item", {
    filter,
    excludeFields: [],
    sort: { createdAt: -1 },
    limit: req.query.limit ? parseInt(req.query.limit) : null,
    skip: req.query.skip ? parseInt(req.query.skip) : 0,
    // group: {
    //   _id: "$order_id",
    //   order_items: { $push: "$$ROOT" },
    // },
    // populate: [
    //   {
    //     path: "product_id",
    //     select: "product_name",
    //   },
    //   {
    //     path: "order_id",
    //     select: "order_no",
    //   },
    // ],
  });

  return res.status(response.status).json({
    ...response,
    // data,
    pagination: {
      ...response.pagination,
      // groupCount: data.length,
    },
  });
}

// async function getOrderByorderItem(req, res) {
//   const filter = { status: "active", deletedAt: null };
//   const response = await handleGenericGetAll(req, "order", {
//     filter,
//     excludeFields: [],
//     populate: [],
//     sort: { createdAt: -1 },
//     limit: req.query.limit ? parseInt(req.query.limit) : null,
//     skip: req.query.skip ? parseInt(req.query.skip) : 0,
//   });

//   if (!response.success || !Array.isArray(response.data)) {
//     return res.status(response.status).json(response);
//   }

//   const orderIds = response.data.map((o) => o._id).filter(Boolean);
//   if (orderIds.length === 0) {
//     return res.status(response.status).json(response);
//   }

//   const items = await OrderItem.find({ order_id: { $in: orderIds } })
//     .populate("product_id")
//     .sort({ createdAt: 1 })
//     .lean();

//   const itemsByOrderId = new Map();
//   for (const id of orderIds) {
//     itemsByOrderId.set(String(id), []);
//   }
//   for (const item of items) {
//     const key = String(item.order_id);
//     if (!itemsByOrderId.has(key)) {
//       itemsByOrderId.set(key, []);
//     }
//     itemsByOrderId.get(key).push(item);
//   }

//   const data = response.data.map((order) => ({
//     ...order,
//     order_items: itemsByOrderId.get(String(order._id)) || [],
//   }));

//   return res.status(response.status).json({
//     ...response,
//     data,
//   });
// }

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

module.exports = {
  // orderCreate,
  // orderUpdate,
  // orderById,
  // getAllorder,
  order_save,
  getOrderByorderItem,
};
