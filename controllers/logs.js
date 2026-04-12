const { handleGenericGetAll } = require("../utils/modelHelper");

async function getAllLogsByUser(req, res) {
  const response = await handleGenericGetAll(req, "logs", {
    filter: { status: "active", deletedAt: null },
    excludeFields: [], // Don't exclude any fields
    populate: ["user_id"],
    sort: { createdAt: -1 }, // Sort by newest first
    limit: req.query.limit ? parseInt(req.query.limit) : null, // Support limit from query params
    skip: req.query.skip ? parseInt(req.query.skip) : 0, // Support skip from query params
  });
  return res.status(response.status).json(response);
}

module.exports = {
  getAllLogsByUser,
};
