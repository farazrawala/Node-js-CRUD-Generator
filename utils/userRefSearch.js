const User = require("../models/user");
const { coalesceObjectId } = require("./modelHelper");

const USER_REF_SEARCH_LIMIT = 500;

/**
 * `$or` clauses matching documents whose user ref (e.g. order `customer_id`, purchase order
 * `vendor_id`) points at a user in the company whose name, phone or email contains `search`.
 * Pass to handleGenericGetAll as `searchExtraOrClauses`.
 */
async function findUserRefSearchClauses(search, companyId, refField) {
  const term = String(search ?? "").trim();
  if (term.length < 2 || !refField) return [];
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = { $regex: escaped, $options: "i" };
  const users = await User.find({
    ...(companyId ? { company_id: coalesceObjectId(companyId) } : {}),
    $or: [{ name: regex }, { phone: regex }, { email: regex }],
  })
    .select("_id")
    .limit(USER_REF_SEARCH_LIMIT)
    .lean();
  if (users.length === 0) return [];
  return [{ [refField]: { $in: users.map((u) => u._id) } }];
}

module.exports = { findUserRefSearchClauses };
