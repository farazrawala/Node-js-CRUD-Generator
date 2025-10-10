const {
  handleGenericCreate,
  handleGenericUpdate,
  handleGenericGetById,
  handleGenericGetAll,
} = require("../utils/modelHelper");

async function orderCreate(req, res) {
  const response = await handleGenericCreate(req, "order", {
    afterCreate: async (record, req) => {
      console.log("✅ Record created successfully:", record);
    },
  });
  return res.status(response.status).json(response);
}

async function orderUpdate(req, res) {
  const response = await handleGenericUpdate(req, "", {
    afterUpdate: async (record, req, existingUser) => {
      console.log("✅ Record updated successfully:", record);
    },
  });
  return res.status(response.status).json(response);
}

async function orderById(req, res) {
  const response = await handleGenericGetById(req, "order", {
    excludeFields: [], // Don't exclude any fields
  });
  return res.status(response.status).json(response);
}

async function getAllorder(req, res) {
  const response = await handleGenericGetAll(req, "order", {
    excludeFields: [], // Don't exclude any fields
    populate: ["user_id"],
    sort: { createdAt: -1 }, // Sort by newest first
    limit: req.query.limit ? parseInt(req.query.limit) : null, // Support limit from query params
    skip: req.query.skip ? parseInt(req.query.skip) : 0, // Support skip from query params
  });
  return res.status(response.status).json(response);
}

module.exports = {
  orderCreate,
  orderUpdate,
  orderById,
  getAllorder,
};
