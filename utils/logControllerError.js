const mongoose = require("mongoose");
const { handleGenericCreate, coalesceObjectId } = require("./modelHelper");
const Logs = require("../models/logs");

function normalizeObjectIdMaybe(value) {
  if (value == null || value === "") return null;
  try {
    const id = coalesceObjectId(value);
    if (!id) return null;
    const s = String(id);
    return mongoose.Types.ObjectId.isValid(s) ? id : null;
  } catch {
    return null;
  }
}

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
 * @param {import("mongoose").Types.ObjectId|string} [options.fallbackCompanyId] - When `req.user.company_id` is missing (`logs.company_id` is required)
 */
function safeJsonForLog(value, maxLen = 6000) {
  try {
    const s = JSON.stringify(value);
    if (s.length <= maxLen) return s;
    return `${s.slice(0, maxLen - 25)}…[truncated]`;
  } catch {
    return "[unserializable]";
  }
}

function truncateForLog(str, max) {
  const s = String(str);
  if (s.length <= max) return s;
  return `${s.slice(0, max - 20)}…[truncated]`;
}

async function logControllerError(req, description, options = {}) {
  try {
    const {
      action = "CONTROLLER ERROR",
      tags = ["api", "error"],
      fallbackUrl = "/api",
      fallbackCompanyId,
    } = options;

    const companyId =
      normalizeObjectIdMaybe(fallbackCompanyId) ||
      normalizeObjectIdMaybe(req.user?.company_id?._id) ||
      normalizeObjectIdMaybe(req.user?.company_id);
    const createdBy = normalizeObjectIdMaybe(req.user?._id);

    if (!companyId) {
      console.error(
        "[logControllerError] logs row not inserted: missing company_id. Pass options.fallbackCompanyId or ensure req.user.company_id is set.",
        {
          action,
          url: req.originalUrl || req.path || fallbackUrl,
          descriptionPreview: String(description).slice(0, 400),
        },
      );
      return;
    }

    const body = Logs.sanitizeLogPlainObject({
      action,
      url: req.originalUrl || req.path || fallbackUrl,
      tags,
      description,
      company_id: companyId,
      created_by: createdBy,
      status: "active",
    });
    const logReq = Object.create(Object.getPrototypeOf(req));
    Object.assign(logReq, req, { body });
    logReq._skipGenericCrudFailureLog = true;
    const createResult = await handleGenericCreate(logReq, "logs", {
      skipFailureLog: true,
    });
    if (!createResult?.success) {
      console.error(
        "[logControllerError] handleGenericCreate(logs) returned failure:",
        safeJsonForLog(createResult, 2500),
        "\nOriginal description (first 600 chars):\n",
        String(description).slice(0, 600),
      );
      try {
        await Logs.create({
          action: body.action,
          url: body.url,
          tags: body.tags,
          description: body.description,
          company_id: companyId,
          created_by: createdBy || undefined,
          status: "active",
        });
      } catch (directErr) {
        console.error(
          "[logControllerError] Direct Logs.create fallback failed:",
          directErr.message,
        );
      }
    }
  } catch (logErr) {
    console.error(
      "⚠️ Failed to write controller error log:",
      logErr.message,
      "\nOriginal description (first 800 chars):\n",
      String(description).slice(0, 800),
    );
  }
}

/**
 * Build a multi-line description for `logs.description` from thrown errors / txn failures.
 * Includes Mongo/Mongoose fields and stack (truncated) so production logs stay diagnosable.
 */
function serializeErrorForLog(err) {
  if (err == null) return "Unknown error (null)";
  if (typeof err === "string") return err;
  const parts = [];
  if (err.name) parts.push(`name: ${err.name}`);
  if (err.message) parts.push(`message: ${err.message}`);
  if (err.statusCode != null) parts.push(`statusCode: ${err.statusCode}`);
  if (err.responseType) parts.push(`responseType: ${err.responseType}`);
  if (err.code != null) parts.push(`code: ${err.code}`);
  if (err.codeName) parts.push(`codeName: ${err.codeName}`);
  if (err.details != null) {
    parts.push(
      typeof err.details === "string" ?
        `details: ${err.details}`
      : `details: ${safeJsonForLog(err.details)}`,
    );
  }
  if (err.errors && typeof err.errors === "object") {
    parts.push(`mongoose_validation: ${safeJsonForLog(err.errors, 4000)}`);
  }
  if (err.writeErrors) {
    parts.push(`writeErrors: ${safeJsonForLog(err.writeErrors, 4000)}`);
  }
  if (err.result) {
    parts.push(`result: ${safeJsonForLog(err.result, 3000)}`);
  }
  if (err.clientErrorPayload) {
    try {
      parts.push(`api_response: ${safeJsonForLog(err.clientErrorPayload, 5000)}`);
    } catch {
      parts.push(`api_response: [unserializable]`);
    }
  }
  let depth = 0;
  let c = err.cause;
  while (c && depth < 4) {
    const msg = c?.message || String(c);
    parts.push(`cause[${depth}]: ${msg}`);
    c = c.cause;
    depth += 1;
  }
  if (err.stack) {
    parts.push(`stack:\n${truncateForLog(err.stack, 4000)}`);
  }
  return parts.length ? parts.join("\n") : String(err);
}

/**
 * Persist rollback / txn failure to `logs` (best-effort).
 * Tags always include `api`, `error`, and `rollback`, plus any `options.tags`.
 * @param {import("express").Request} req
 * @param {unknown} err
 * @param {{ action?: string, tags?: string[], fallbackUrl?: string, context?: Record<string, unknown>, fallbackCompanyId?: import("mongoose").Types.ObjectId|string }} [options]
 */
const GENERIC_CRUD_REDACT_KEYS = new Set([
  "password",
  "confirm_password",
  "current_password",
  "new_password",
  "token",
  "access_token",
  "refresh_token",
]);

function redactBodyForGenericCrudLog(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return body;
  }
  const copy = { ...body };
  for (const key of Object.keys(copy)) {
    if (GENERIC_CRUD_REDACT_KEYS.has(key)) {
      copy[key] = "[REDACTED]";
    }
  }
  return copy;
}

function buildGenericCrudFailureDescription(
  modelName,
  operation,
  failureResult,
  context = {},
) {
  const lines = [];
  lines.push(`model: ${modelName}`);
  lines.push(`operation: ${operation}`);
  if (context.recordId != null && String(context.recordId).trim() !== "") {
    lines.push(`record_id: ${context.recordId}`);
  }
  lines.push(`http_status: ${failureResult?.status ?? "n/a"}`);
  if (failureResult?.type) lines.push(`failure_type: ${failureResult.type}`);
  if (failureResult?.error) lines.push(`error: ${failureResult.error}`);
  if (failureResult?.message) lines.push(`message: ${failureResult.message}`);
  if (failureResult?.details != null) {
    lines.push(`details: ${safeJsonForLog(failureResult.details, 4500)}`);
  }
  if (failureResult?.missing != null) {
    lines.push(`missing: ${safeJsonForLog(failureResult.missing, 2000)}`);
  }
  if (failureResult?.required != null) {
    lines.push(`required: ${safeJsonForLog(failureResult.required, 2000)}`);
  }
  if (failureResult?.received != null) {
    lines.push(`received_fields: ${safeJsonForLog(failureResult.received, 1500)}`);
  }
  if (failureResult?.contentType) {
    lines.push(`content_type: ${failureResult.contentType}`);
  }
  if (context.bodyKeys?.length) {
    lines.push(`body_keys: ${context.bodyKeys.join(", ")}`);
  }
  if (context.bodySample != null) {
    lines.push(`body_sample: ${safeJsonForLog(context.bodySample, 3500)}`);
  }
  if (context.inTransaction) {
    lines.push("in_transaction: true");
  }
  return lines.join("\n");
}

/**
 * Persist handleGenericCreate / handleGenericUpdate failures to `logs` (direct insert; avoids circular import).
 * @param {import("express").Request} req
 * @param {string} modelName
 * @param {"create"|"update"} operation
 * @param {{ success?: boolean, status?: number, error?: string, message?: string, details?: unknown, type?: string, missing?: unknown, required?: unknown, received?: unknown, contentType?: string }} failureResult
 * @param {{ recordId?: string, fallbackUrl?: string, fallbackCompanyId?: import("mongoose").Types.ObjectId|string, inTransaction?: boolean }} [extraContext]
 */
async function logGenericCrudFailure(
  req,
  modelName,
  operation,
  failureResult,
  extraContext = {},
) {
  if (!failureResult || failureResult.success !== false) return;

  const resolvedModel = String(modelName || "unknown").trim() || "unknown";
  if (resolvedModel === "logs") return;

  const companyId =
    normalizeObjectIdMaybe(extraContext.fallbackCompanyId) ||
    normalizeObjectIdMaybe(req.user?.company_id?._id) ||
    normalizeObjectIdMaybe(req.user?.company_id);

  if (!companyId) {
    console.error(
      "[logGenericCrudFailure] logs row not inserted: missing company_id",
      {
        model: resolvedModel,
        operation,
        error: failureResult.error,
        message: failureResult.message,
      },
    );
    return;
  }

  const bodyKeys =
    req.body && typeof req.body === "object" && !Array.isArray(req.body) ?
      Object.keys(req.body)
    : [];

  const description = buildGenericCrudFailureDescription(
    resolvedModel,
    operation,
    failureResult,
    {
      recordId: extraContext.recordId,
      bodyKeys,
      bodySample: redactBodyForGenericCrudLog(req.body),
      inTransaction: extraContext.inTransaction === true,
    },
  );

  const action =
    operation === "update" ? "GENERIC UPDATE FAILED" : "GENERIC CREATE FAILED";
  const opTag = operation === "update" ? "generic_update" : "generic_create";

  const logRow = Logs.sanitizeLogPlainObject({
    action,
    url:
      req.originalUrl ||
      req.path ||
      extraContext.fallbackUrl ||
      "/api",
    tags: ["api", "error", opTag, resolvedModel],
    description,
    company_id: companyId,
    created_by: normalizeObjectIdMaybe(req.user?._id),
    status: "active",
  });

  try {
    await Logs.create(logRow);
  } catch (logErr) {
    console.error(
      "[logGenericCrudFailure] Logs.create failed:",
      logErr.message,
      "\n",
      truncateForLog(description, 800),
    );
  }
}

async function logRollbackFailure(req, err, options = {}) {
  const {
    action = "TRANSACTION ROLLBACK",
    tags = [],
    fallbackUrl = "/api",
    context = null,
    fallbackCompanyId: explicitFallbackCompanyId,
  } = options;
  const tagsWithError = [...new Set(["api", "error", "rollback", ...tags])];
  let description = serializeErrorForLog(err);
  if (context != null && typeof context === "object") {
    description += `\n\ncontext:\n${safeJsonForLog(context, 2500)}`;
  }
  const fallbackCompanyId =
    explicitFallbackCompanyId ??
    (context?.company_id != null ?
      normalizeObjectIdMaybe(context.company_id)
    : undefined);
  await logControllerError(req, description, {
    action,
    tags: tagsWithError,
    fallbackUrl,
    fallbackCompanyId,
  });
}

module.exports = {
  logControllerError,
  logRollbackFailure,
  logGenericCrudFailure,
  serializeErrorForLog,
};
