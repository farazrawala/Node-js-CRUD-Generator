const {
    handleGenericCreate,
    handleGenericUpdate,
    handleGenericGetById,
    handleGenericGetAll,
  } = require("../utils/modelHelper");
  
  async function companyCreate(req, res) {
    const response = await handleGenericCreate(req, "company", {
      afterCreate: async (record, req) => {
        console.log("✅ Record created successfully:", record);
      },
    });
    return res.status(response.status).json(response);
  }
  
  // async function companyUpdate(req, res) {
  //   const response = await handleGenericUpdate(req, "", {
  //     afterUpdate: async (record, req, existingUser) => {
  //       console.log("✅ Record updated successfully:", record);
  //     },
  //   });
  //   return res.status(response.status).json(response);
  // }
  
  
  async function companyUpdate(req, res) {
    const response = await handleGenericUpdate(req, "company", {
      excludeFields: ["password"], // Don't return password in response
      // allowedFields: [] - Empty array means allow all fields except password (dynamic)
      beforeUpdate: async (updateData, req, existingUser) => {
        console.log("🔧 Processing user update...", {
          userId: existingUser._id,
          currentName: existingUser.name,
          newName: updateData.name,
          currentEmail: existingUser.email,
          newEmail: updateData.email,
          hasProfileImage: !!req.files?.profile_image,
          updateFields: Object.keys(updateData),
        });
      },
      afterUpdate: async (record, req, existingUser) => {
        console.log("✅ Record updated successfully:", record);
      },
    });
  
    return res.status(response.status).json(response);
  }
  
  
  async function companyById(req, res) {
    const response = await handleGenericGetById(req, "company", {
      excludeFields: [], // Don't exclude any fields
    });
    return res.status(response.status).json(response);
  }
  
  async function getAllcompany(req, res) {
    const response = await handleGenericGetAll(req, "company", {
      excludeFields: [], // Don't exclude any fields
      populate: [], // Company model doesn't have user_id field  
      sort: { createdAt: -1 }, // Sort by newest first
      limit: req.query.limit ? parseInt(req.query.limit) : null, // Support limit from query params
      skip: req.query.skip ? parseInt(req.query.skip) : 0, // Support skip from query params
    });
    return res.status(response.status).json(response);
  }
  
  async function getallcompanyactive(req, res) {
    const response = await handleGenericGetAll(req, "company", {
      filter: { status: "active" , deletedAt: null },
      excludeFields: [], // Don't exclude any fields
      populate: [], // Company model doesn't have user_id field  
      sort: { createdAt: -1 }, // Sort by newest first
      limit: req.query.limit ? parseInt(req.query.limit) : null, // Support limit from query params
      skip: req.query.skip ? parseInt(req.query.skip) : 0, // Support skip from query params
    });
    return res.status(response.status).json(response);
  }
  
  
  async function companydelete(req, res) {
    console.log("🔐 company delete attempt:", {
      id: req.params.id,
      time: new Date().toISOString(),
    });
    
    // Manually set the request body with deletedAt data
    req.body = { deletedAt: new Date().toISOString() };
    const response = await handleGenericUpdate(req, "company", {
      afterUpdate: async (record, req, existingRecord) => {
        console.log("✅ company soft deleted successfully. DeletedAt:", record.deletedAt);
      },
    });
    return res.status(response.status).json(response);
  }
  
  
  
  module.exports = {
    companyCreate,
    companyUpdate,
    companyById,
    getAllcompany,
    getallcompanyactive,
    companydelete,
  };
  