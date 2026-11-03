/**
 * Every Shopify API call is bound to the authenticated company.
 * @module src/shopify/tenancy
 */

const { coalesceObjectId } = require("../../utils/modelHelper");

function companyIdFromRequest(req) {
  const companyId = coalesceObjectId(req?.user?.company_id);
  if (!companyId) {
    const error = new Error("Authenticated company_id is required");
    error.status = 401;
    throw error;
  }
  return companyId;
}

function assertSameCompany(record, companyId) {
  const expected = coalesceObjectId(companyId);
  const actual = coalesceObjectId(record?.company_id);
  if (!expected || !actual || String(expected) !== String(actual)) {
    const error = new Error("Shopify connection is not available for this company");
    error.status = 403;
    throw error;
  }
  return expected;
}

module.exports = {
  companyIdFromRequest,
  assertSameCompany,
};
