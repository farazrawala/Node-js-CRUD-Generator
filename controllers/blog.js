const {
  handleGenericCreate,
  handleGenericUpdate,
  handleGenericGetById,
  handleGenericGetAll,
  handleGenericFindOne,
} = require("../utils/modelHelper");

async function blogCreate(req, res) {
  const response = await handleGenericCreate(req, "blog", {
    afterCreate: async (record, req) => {
      console.log("✅ Record created successfully:", record);
    },
  });
  return res.status(response.status).json(response);
}

// async function blogUpdate(req, res) {
//   const response = await handleGenericUpdate(req, "", {
//     afterUpdate: async (record, req, existingUser) => {
//       console.log("✅ Record updated successfully:", record);
//     },
//   });
//   return res.status(response.status).json(response);
// }


async function blogUpdate(req, res) {
  const response = await handleGenericUpdate(req, "blog", {
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


async function blogById(req, res) {
  const response = await handleGenericGetById(req, "blog", {
    excludeFields: [], // Don't exclude any fields
  });
  return res.status(response.status).json(response);
}

async function getAllBlog(req, res) {
  const response = await handleGenericGetAll(req, "blog", {
    excludeFields: [], // Don't exclude any fields
    populate: ["user_id"],  
    sort: { createdAt: -1 }, // Sort by newest first
    limit: req.query.limit ? parseInt(req.query.limit) : null, // Support limit from query params
    skip: req.query.skip ? parseInt(req.query.skip) : 0, // Support skip from query params
  });
  return res.status(response.status).json(response);
}

async function getallblogactive(req, res) {
  const response = await handleGenericGetAll(req, "blog", {
    filter: { status: "active" , deletedAt: null },
    excludeFields: [], // Don't exclude any fields
    populate: ["user_id"],  
    sort: { createdAt: -1 }, // Sort by newest first
    limit: req.query.limit ? parseInt(req.query.limit) : null, // Support limit from query params
    skip: req.query.skip ? parseInt(req.query.skip) : 0, // Support skip from query params
  });
  return res.status(response.status).json(response);
}


async function blogdelete(req, res) {
  console.log("🔐 Blog delete attempt:", {
    id: req.params.id,
    time: new Date().toISOString(),
  });
  
  // Manually set the request body with deletedAt data
  req.body = { deletedAt: new Date().toISOString() };
  const response = await handleGenericUpdate(req, "blog", {
    afterUpdate: async (record, req, existingRecord) => {
      // console.log("✅ Blog soft deleted successfully. DeletedAt:", record.deletedAt);
    },
  });
  return res.status(response.status).json(response);
}



async function findOneblog(req, res) {
  const response = await handleGenericFindOne(req, "blog", {
    searchCriteria: { slug: req.params.slug },
    excludeFields: ["internal_notes"], // Exclude sensitive fields
    populate: ["author"], // Populate author information
  });
  return res.status(response.status).json(response);
}

// Example: Find blog by slug instead of ID
// async function findBlogBySlug(req, res) {
//   const response = await handleGenericFindOne(req, "blog", {
//     searchCriteria: { slug: req.params.slug },
//     excludeFields: ["internal_notes"], // Exclude sensitive fields
//     populate: ["author"], // Populate author information
//   });
//   return res.status(response.status).json(response);
// }

// Example: Find active blog by title
async function findActiveBlogByTitle(req, res) {
  const response = await handleGenericFindOne(req, "blog", {
    searchCriteria: { 
      title: req.body.title,
      active: true,
      status: "published"
    },
    excludeFields: ["password"],
    beforeFind: async (criteria, req) => {
      console.log("🔍 Searching for active blog with criteria:", criteria);
      return criteria;
    },
    afterFind: async (record, req) => {
      console.log("✅ Found active blog:", record.title);
    }
  });
  return res.status(response.status).json(response);
}

// Example: Find blog by custom parameters from request body
async function findBlogByParams(req, res) {
  const { category, author, tags, status } = req.body;
  
  // Build search criteria dynamically
  const searchCriteria = {};
  if (category) searchCriteria.category = category;
  if (author) searchCriteria.author = author;
  if (tags) searchCriteria.tags = { $in: tags }; // MongoDB operator for array contains
  if (status) searchCriteria.status = status;
  
  const response = await handleGenericFindOne(req, "blog", {
    searchCriteria,
    includeFields: ["title", "slug", "createdAt", "author"], // Only return specific fields
    populate: ["author", "category"],
    sort: { createdAt: -1 }, // Get the most recent one if multiple match
  });
  return res.status(response.status).json(response);
}



module.exports = {
  blogCreate,
  blogUpdate,
  blogById,
  getAllBlog,
  getallblogactive,
  blogdelete,
  // findBlogBySlug,
  findActiveBlogByTitle,
  findBlogByParams,
};
