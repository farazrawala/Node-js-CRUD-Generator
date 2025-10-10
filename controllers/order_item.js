const {
  handleGenericCreate,
  handleGenericUpdate,
  handleGenericGetById,
  handleGenericGetAll,
} = require("../utils/modelHelper");

async function order_itemCreate(req, res) {
  const response = await handleGenericCreate(req, "order_item", {
    afterCreate: async (record, req) => {
      console.log("✅ Record created successfully:", record);
    },
  });
  return res.status(response.status).json(response);
}

async function order_itemUpdate(req, res) {
  const response = await handleGenericUpdate(req, "order_item", {
    afterUpdate: async (record, req, existingUser) => {
      console.log("✅ Record updated successfully:", record);
    },
  });
  return res.status(response.status).json(response);
}

async function order_itemById(req, res) {
  const response = await handleGenericGetById(req, "order_item", {
    excludeFields: [], // Don't exclude any fields
    populate: [
      {
        path: "order_id",
        populate: {
          path: "user_id",
          select: "name email role", // Optional: select only specific user fields
        },
      },
    ],
  });
  return res.status(response.status).json(response);
}

async function getAllorder_item(req, res) {
  const response = await handleGenericGetAll(req, "order_item", {
    excludeFields: [], // Don't exclude any fields
    populate: [
      {
        path: "order_id",
        populate: {
          path: "user_id",
          // select: "name email role", // Optional: select only specific user fields
        },
      },
    ],
    sort: { createdAt: -1 }, // Sort by newest first
    limit: req.query.limit ? parseInt(req.query.limit) : null, // Support limit from query params
    skip: req.query.skip ? parseInt(req.query.skip) : 0, // Support skip from query params
  });
  return res.status(response.status).json(response);
}

module.exports = {
  order_itemCreate,
  order_itemUpdate,
  order_itemById,
  getAllorder_item,
};
