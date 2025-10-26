const {
    handleGenericCreate,
    handleGenericUpdate,
    handleGenericGetById,
    handleGenericGetAll,
    handleGenericFindOne,
  } = require("../utils/modelHelper");
  
  // async function integrationCreate(req, res) {
  //   const response = await handleGenericCreate(req, "integration", {
  //     afterCreate: async (record, req) => {
  //       console.log("✅ Record created successfully:", record);
  //     },
  //   });
  //   return res.status(response.status).json(response);
  // }
  
  // async function integrationUpdate(req, res) {
  //   const response = await handleGenericUpdate(req, "integration", {
  //     excludeFields: ["password"], // Don't return password in response
  //     // allowedFields: [] - Empty array means allow all fields except password (dynamic)
  //     beforeUpdate: async (updateData, req, existingUser) => {
  //       console.log("🔧 Processing user update...", {
  //         userId: existingUser._id,
  //         currentName: existingUser.name,
  //         newName: updateData.name,
  //         currentEmail: existingUser.email,
  //         newEmail: updateData.email,
  //         hasProfileImage: !!req.files?.profile_image,
  //         updateFields: Object.keys(updateData),
  //       });
  //     },
  //     afterUpdate: async (record, req, existingUser) => {
  //       console.log("✅ Record updated successfully:", record);
  //     },
  //   });
  
  //   return res.status(response.status).json(response);
  // }
  
  
  // async function integrationById(req, res) {
  //   const response = await handleGenericGetById(req, "integration", {
  //     excludeFields: [], // Don't exclude any fields
  //   });
  //   return res.status(response.status).json(response);
  // }
  
  // async function getAllintegration(req, res) {
  //   const response = await handleGenericGetAll(req, "integration", {
  //     excludeFields: [], // Don't exclude any fields
  //     populate: ["user_id"],  
  //     sort: { createdAt: -1 }, // Sort by newest first
  //     limit: req.query.limit ? parseInt(req.query.limit) : null, // Support limit from query params
  //     skip: req.query.skip ? parseInt(req.query.skip) : 0, // Support skip from query params
  //   });
  //   return res.status(response.status).json(response);
  // }
  
  // async function getallintegrationactive(req, res) {
  //   const response = await handleGenericGetAll(req, "integration", {
  //     filter: { status: "active", deletedAt: null },
  //     excludeFields: [], // Don't exclude any fields
  //     populate: ["company_id"],  
  //     sort: { createdAt: -1 }, // Sort by newest first
  //     limit: req.query.limit ? parseInt(req.query.limit) : null, // Support limit from query params
  //     skip: req.query.skip ? parseInt(req.query.skip) : 0, // Support skip from query params
  //   });
  //   return res.status(response.status).json(response);
  // }
  
  
  // async function integrationdelete(req, res) {
  //   console.log("🔐 Blog delete attempt:", {
  //     id: req.params.id,
  //     time: new Date().toISOString(),
  //   });
    
  //   // Manually set the request body with deletedAt data
  //   req.body = { deletedAt: new Date().toISOString() };
  //   const response = await handleGenericUpdate(req, "integration", {
  //     afterUpdate: async (record, req, existingRecord) => {
  //       // console.log("✅ Blog soft deleted successfully. DeletedAt:", record.deletedAt);
  //     },
  //   });
  //   return res.status(response.status).json(response);
  // }
  
  
  // // Example: Find active integration by title
  // async function findActiveBlogByTitle(req, res) {
  //   const response = await handleGenericFindOne(req, "integration", {
  //     searchCriteria: { 
  //       title: req.body.title,
  //       active: true,
  //       status: "published"
  //     },
  //     excludeFields: ["password"],
  //     beforeFind: async (criteria, req) => {
  //       console.log("🔍 Searching for active integration with criteria:", criteria);
  //       return criteria;
  //     },
  //     afterFind: async (record, req) => {
  //       console.log("✅ Found active integration:", record.title);
  //     }
  //   });
  //   return res.status(response.status).json(response);
  // }
  
  // // Example: Find integration by custom parameters from request body
  // async function findBlogByParams(req, res) {
  //   const { category, author, tags, status } = req.body;
    
  //   // Build search criteria dynamically
  //   const searchCriteria = {};
  //   if (category) searchCriteria.category = category;
  //   if (author) searchCriteria.author = author;
  //   if (tags) searchCriteria.tags = { $in: tags }; // MongoDB operator for array contains
  //   if (status) searchCriteria.status = status;
    
  //   const response = await handleGenericFindOne(req, "integration", {
  //     searchCriteria,
  //     includeFields: ["title", "slug", "createdAt", "author"], // Only return specific fields
  //     populate: ["author", "category"],
  //     sort: { createdAt: -1 }, // Get the most recent one if multiple match
  //   });
  //   return res.status(response.status).json(response);
  // }
  
  
  
  module.exports = {
    // integrationCreate,
    // integrationUpdate,
    // integrationById,
    // getAllintegration,
    // getallintegrationactive,
    // integrationdelete,
    // findActiveBlogByTitle,
    // findBlogByParams,
  };
  