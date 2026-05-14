const mongoose = require("mongoose");
const Logs = require("../models/logs");
const { coalesceObjectId } = require("./modelHelper");

const MAX_TAGS = 30;

function normalizeTags(tags) {
  if (tags == null || tags === "") return [];
  const arr = Array.isArray(tags) ? tags : [tags];
  return arr
    .map((t) => String(t).trim())
    .filter(Boolean)
    .slice(0, MAX_TAGS);
}

function serializeDescription(description) {
  if (description == null) return "";
  if (typeof description === "object") {
    try {
      return JSON.stringify(description);
    } catch (_) {
      return String(description);
    }
  }
  return String(description);
}

function defaultRequestUrl(req, overrideUrl) {
  if (overrideUrl != null && String(overrideUrl).trim() !== "") {
    return String(overrideUrl).trim();
  }
  const u = req?.originalUrl || req?.path || req?.url;
  return u != null && String(u).trim() !== "" ? String(u).trim() : "/api";
}

/**
 * Insert one row into `logs` (operational / audit trail).
 * Failures are swallowed by default so business flows are not blocked.
 *
 * @param {import("express").Request | null} req
 * @param {{
 *   action: string,
 *   url?: string,
 *   tags?: string[] | string,
 *   description?: string | Record<string, unknown>,
 *   company_id?: unknown,
 *   created_by?: unknown,
 *   status?: string,
 * }} entry
 * @param {{ silent?: boolean, session?: import("mongoose").ClientSession | null }} [options] silent=false rethrows after console.error; session participates in the same Mongo transaction when set.
 * @returns {Promise<{ ok: true, _id?: import("mongoose").Types.ObjectId } | { ok: false, skipped?: string, error?: unknown }>}
 */
async function createApplicationLog(req, entry, options = {}) {
  const { silent = true, session = null } = options;
  try {
    if (!entry || typeof entry.action !== "string" || !entry.action.trim()) {
      throw new Error("createApplicationLog: action is required");
    }

    const company_id = coalesceObjectId(
      entry.company_id ?? req?.user?.company_id,
    );
    if (
      !company_id ||
      !mongoose.Types.ObjectId.isValid(String(company_id))
    ) {
      const msg = "[applicationLogs] skip: valid company_id is required";
      if (silent) {
        console.warn(msg);
        return { ok: false, skipped: "no_company" };
      }
      throw new Error(msg);
    }

    const created_by = coalesceObjectId(
      entry.created_by ?? req?.user?._id,
    );
    const doc = {
      action: entry.action.trim(),
      url: defaultRequestUrl(req, entry.url),
      tags: normalizeTags(entry.tags),
      description: serializeDescription(entry.description),
      company_id,
      status: entry.status || "active",
      deletedAt: null,
    };

    if (
      created_by != null &&
      mongoose.Types.ObjectId.isValid(String(created_by))
    ) {
      doc.created_by = created_by;
    }

    const createOptions =
      session != null && typeof session === "object" ? { session } : {};
    const row = await Logs.create(
      Logs.sanitizeLogPlainObject(doc),
      createOptions,
    );
    return { ok: true, _id: row?._id };
  } catch (err) {
    console.error(
      "[applicationLogs] createApplicationLog failed:",
      err?.message || err,
    );
    if (!silent) throw err;
    return { ok: false, error: err };
  }
}

/**
 * Log a single field change on an entity (previous → updated), with structured `description` JSON.
 * Adds `fieldName` and `entityType` to `tags` when missing.
 *
 * @param {import("express").Request | null} req
 * @param {{
 *   action?: string,
 *   url?: string,
 *   tags?: string[] | string,
 *   entityType: string,
 *   entityId: string | import("mongoose").Types.ObjectId,
 *   fieldName: string,
 *   previousValue: unknown,
 *   newValue: unknown,
 *   metadata?: Record<string, unknown>,
 * }} params
 * @param {{ silent?: boolean }} [options]
 */
async function logEntityFieldChange(req, params, options = {}) {
  const {
    action,
    url,
    tags = [],
    entityType,
    entityId,
    fieldName,
    previousValue,
    newValue,
    metadata = {},
  } = params;

  const tagList = normalizeTags(tags);
  const merged = new Set(
    [fieldName, entityType, ...tagList].filter(
      (t) => t != null && String(t).trim() !== "",
    ),
  );

  const description = {
    entity_type: entityType,
    entity_id: entityId != null ? String(entityId) : undefined,
    field: fieldName,
    previous: previousValue,
    updated: newValue,
    ...metadata,
  };

  const defaultAction =
    `${String(entityType)} ${String(fieldName)} updated`.trim();

  return createApplicationLog(
    req,
    {
      action: action && String(action).trim() ? String(action).trim() : defaultAction,
      url,
      tags: [...merged],
      description,
    },
    options,
  );
}

module.exports = {
  createApplicationLog,
  logEntityFieldChange,
  normalizeTags,
};
