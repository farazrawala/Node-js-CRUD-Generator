const { handleGenericCreate } = require("./modelHelper");

/**
 * Best-effort write of a controller/API failure to the `logs` model via handleGenericCreate.
 * Safe to await from any controller; swallows logging failures.
 *
 * @param {import("express").Request} req
 * @param {string} description
 * @param {object} [options]
 * @param {string} [options.action] - Stored log action label
 * @param {string[]} [options.tags] - Tags for filtering in admin/logs
 * @param {string} [options.fallbackUrl] - When req.originalUrl and req.path are empty
 */
async function logControllerError(req, description, options = {}) {
  try {
    const {
      action = "CONTROLLER ERROR",
      tags = ["api", "error"],
      fallbackUrl = "/api",
    } = options;

    const companyId =
      req.user?.company_id?._id || req.user?.company_id || undefined;
    const createdBy = req.user?._id || undefined;
    const logReq = Object.create(Object.getPrototypeOf(req));
    Object.assign(logReq, req, {
      body: {
        action,
        url: req.originalUrl || req.path || fallbackUrl,
        tags,
        description,
        company_id: companyId,
        created_by: createdBy,
      },
    });
    await handleGenericCreate(logReq, "logs", {});
  } catch (logErr) {
    console.error("⚠️ Failed to write controller error log:", logErr.message);
  }
}

module.exports = { logControllerError };
