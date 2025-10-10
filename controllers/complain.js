const User = require("../models/user");
const Complain = require("../models/complain");


const {
    handleGenericCreate,
    handleGenericUpdate,
    handleGenericGetById,
    handleGenericGetAll,
  } = require("../utils/modelHelper");
  
  async function complainCreate(req, res) {
    const response = await handleGenericCreate(req, "complain", {
      afterCreate: async (record, req) => {
        console.log("✅ Record created successfully:", record);
      },
    });
    return res.status(response.status).json(response);
  }
  
  async function complainUpdate(req, res) {
    const response = await handleGenericUpdate(req, "", {
      afterUpdate: async (record, req, existingUser) => {
        console.log("✅ Record updated successfully:", record);
      },
    });
    return res.status(response.status).json(response);
  }
  
  async function complainById(req, res) {
    const response = await handleGenericGetById(req, "complain", {
      excludeFields: [], // Don't exclude any fields
    });
    return res.status(response.status).json(response);
  }
  
  async function getAllcomplain(req, res) {
    const response = await handleGenericGetAll(req, "complain", {
      excludeFields: [], // Don't exclude any fields
      populate: ["user_id"],  
      sort: { createdAt: -1 }, // Sort by newest first
      limit: req.query.limit ? parseInt(req.query.limit) : null, // Support limit from query params
      skip: req.query.skip ? parseInt(req.query.skip) : 0, // Support skip from query params
    });
    return res.status(response.status).json(response);
  }
  
  module.exports = {
    complainCreate,
    complainUpdate,
    complainById,
    getAllcomplain,
  };
  