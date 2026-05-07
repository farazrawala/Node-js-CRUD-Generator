const { handleGenericCreate } = require("./modelHelper");
const Logs = require("../models/logs");

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
    const body = Logs.sanitizeLogPlainObject({
      action,
      url: req.originalUrl || req.path || fallbackUrl,
      tags,
      description,
      company_id: companyId,
      created_by: createdBy,
    });
    const logReq = Object.create(Object.getPrototypeOf(req));
    Object.assign(logReq, req, { body });
    await handleGenericCreate(logReq, "logs", {});
  } catch (logErr) {
    console.error("⚠️ Failed to write controller error log:", logErr.message);
  }
}

/**
 * Build a multi-line description for `logs.description` from thrown errors / txn failures.
 */
function serializeErrorForLog(err) {
  if (err == null) return "Unknown error (null)";
  if (typeof err === "string") return err;
  const parts = [];
  if (err.message) parts.push(`message: ${err.message}`);
  if (err.clientErrorPayload) {
    try {
      parts.push(`api_response: ${JSON.stringify(err.clientErrorPayload)}`);
    } catch {
      parts.push(`api_response: [unserializable]`);
    }
  }
  if (err.statusCode != null) parts.push(`statusCode: ${err.statusCode}`);
  if (err.responseType) parts.push(`responseType: ${err.responseType}`);
  if (err.details != null && err.clientErrorPayload == null) {
    parts.push(
      typeof err.details === "string" ?
        `details: ${err.details}`
      : `details: ${JSON.stringify(err.details)}`,
    );
  }
  if (process.env.NODE_ENV === "development" && err.stack) {
    parts.push(`stack:\n${err.stack}`);
  }
  return parts.length ? parts.join("\n") : String(err);
}

/**
 * Persist rollback / txn failure to `logs` (best-effort).
 * Tags always include `api`, `error`, and `rollback`, plus any `options.tags`.
 * @param {import("express").Request} req
 * @param {unknown} err
 * @param {{ action?: string, tags?: string[], fallbackUrl?: string }} [options]
 */
async function logRollbackFailure(req, err, options = {}) {
  const {
    action = "TRANSACTION ROLLBACK",
    tags = [],
    fallbackUrl = "/api",
  } = options;
  const tagsWithError = [...new Set(["api", "error", "rollback", ...tags])];
  await logControllerError(req, serializeErrorForLog(err), {
    action,
    tags: tagsWithError,
    fallbackUrl,
  });
}

module.exports = {
  logControllerError,
  logRollbackFailure,
  serializeErrorForLog,
};
