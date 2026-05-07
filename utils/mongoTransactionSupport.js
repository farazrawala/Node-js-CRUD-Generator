/**
 * MongoDB multi-document transactions require a replica set or mongos.
 * Standalone `mongod` (typical local dev) throws when starting a transaction.
 *
 * Errors may appear on `Error.message`, or nested in Mongoose/Mongo payloads
 * and in `clientErrorPayload.details` after handleGenericCreate maps them.
 */
function collectErrorTextBlobs(err, depth, seen) {
  if (!err || depth > 8) return [];
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
  }
  if (err.cause) {
    out.push(...collectErrorTextBlobs(err.cause, depth + 1, seen));
  }
  if (err.reason) {
    out.push(...collectErrorTextBlobs(err.reason, depth + 1, seen));
  }

  return out;
}

function isMongoTransactionUnsupportedError(err) {
  if (!err) return false;

  const seen = new WeakSet();
  const blobs = collectErrorTextBlobs(err, 0, seen);
  const combined = blobs.join(" ");

  if (/Transaction numbers are only allowed/i.test(combined)) return true;
  if (/replica set member or mongos/i.test(combined)) return true;
  if (/transaction.*replica set/i.test(combined)) return true;

  let e = err;
  for (let i = 0; e && i < 6; i++) {
    if (e.code === 20 && e.codeName === "IllegalOperation") return true;
    e = e.cause || e.reason;
  }

  return false;
}

module.exports = { isMongoTransactionUnsupportedError };
