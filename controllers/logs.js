const {
  handleGenericGetAll,
  coalesceObjectId,
} = require("../utils/modelHelper");
const { applyLogsTagQueryFilter } = require("../utils/logsListFilter");

async function getAllLogsByUser(req, res) {
  let filter = { status: "active", deletedAt: null };

  const tenantCo = coalesceObjectId(req.user?.company_id);
  if (tenantCo) {
    filter.company_id = tenantCo;
  }

  filter = applyLogsTagQueryFilter(filter, req.query);

  const response = await handleGenericGetAll(req, "logs", {
    filter,
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
