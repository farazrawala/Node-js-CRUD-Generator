const mongoose = require("mongoose");

/**
 * MongoDB multi-document transactions require a replica set or mongos.
 * Standalone `mongod` (typical local dev / some shared hosts) throws when starting a transaction.
 *
 * Errors may appear on `Error.message`, or nested in Mongoose/Mongo payloads
 * and in `clientErrorPayload.details` after handleGenericCreate maps them.
 */
function collectErrorTextBlobs(err, depth, seen) {
  if (!err || depth > 12) return [];
  if (typeof err === "string") return [err];
  if (typeof err !== "object") return [];

  if (typeof err === "object" && seen.has(err)) return [];
  try {
    seen.add(err);
  } catch {
    /* non-WeakSet-able */
  }

  const out = [];
  if (typeof err.message === "string") out.push(err.message);
  if (typeof err.errmsg === "string") out.push(err.errmsg);
  if (typeof err.error === "string") out.push(err.error);

  const d = err.details;
  if (typeof d === "string") out.push(d);
  if (Array.isArray(d)) {
    for (const x of d) {
      if (typeof x === "string") out.push(x);
    }
  }

  if (err.clientErrorPayload && typeof err.clientErrorPayload === "object") {
    out.push(...collectErrorTextBlobs(err.clientErrorPayload, depth + 1, seen));
  }
  if (err.errorResponse && typeof err.errorResponse === "object") {
    const er = err.errorResponse;
    if (typeof er.errmsg === "string") out.push(er.errmsg);
    if (typeof er.message === "string") out.push(er.message);
  }
  for (const key of ["cause", "reason", "originalError", "error"]) {
    const nested = err[key];
    if (nested && nested !== err) {
      out.push(...collectErrorTextBlobs(nested, depth + 1, seen));
    }
  }

  return out;
}

function combinedErrorText(err) {
  const seen = new WeakSet();
  return collectErrorTextBlobs(err, 0, seen).join(" ");
}

function isMongoTransactionUnsupportedError(err) {
  if (!err) return false;

  const combined = combinedErrorText(err);

  if (/Transaction numbers are only allowed/i.test(combined)) return true;
  if (/replica set member or mongos/i.test(combined)) return true;
  if (/transaction.*replica set/i.test(combined)) return true;
  if (/multi-document transactions require a replica set/i.test(combined)) {
    return true;
  }

  let e = err;
  for (let i = 0; e && i < 10; i++) {
    if (e.code === 20 && e.codeName === "IllegalOperation") return true;
    e = e.cause || e.reason || e.originalError;
  }

  return false;
}

/** Whether a controller pipeline should retry the same work without `session`. */
function shouldRetryWithoutMongoTransaction(err) {
  return isMongoTransactionUnsupportedError(err);
}

/**
 * Run `runBody(session)` inside `withTransaction` when supported; otherwise retry once with `null`.
 *
 * @param {(session: import("mongoose").ClientSession | null) => Promise<void>} runBody
 * @param {{ logLabel?: string, onBeforeRetry?: () => void | Promise<void> }} [options]
 * @returns {Promise<"mongodb_transaction" | "standalone_no_transaction">}
 */
async function runWithOptionalMongoTransaction(runBody, options = {}) {
  const { logLabel = "mongo_txn", onBeforeRetry = null } = options;
  let session = null;

  try {
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      await runBody(session);
    });
    return "mongodb_transaction";
  } catch (mongoTransactionError) {
    if (!shouldRetryWithoutMongoTransaction(mongoTransactionError)) {
      throw mongoTransactionError;
    }

    if (session) {
      try {
        session.endSession();
      } catch (_) {
        /* ignore */
      }
      session = null;
    }

    console.warn(
      `[${logLabel}] MongoDB transactions unavailable (standalone mongod / non-replica host); continuing without transaction`,
    );

    if (typeof onBeforeRetry === "function") {
      await onBeforeRetry();
    }

    await runBody(null);
    return "standalone_no_transaction";
  } finally {
    if (session) {
      try {
        session.endSession();
      } catch (_) {
        /* ignore */
      }
    }
  }
}

module.exports = {
  isMongoTransactionUnsupportedError,
  shouldRetryWithoutMongoTransaction,
  runWithOptionalMongoTransaction,
};
