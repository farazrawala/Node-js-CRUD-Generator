const mongoose = require("mongoose");
const { EJSON } = require("bson");
const { resolveCompanyIdFromReq } = require("../utils/redisCache");
const { logListAccess } = require("../utils/applicationLogs");

/** Collection names we will list or download. Blocks system and injection-like names. */
const TABLE_NAME_RE = /^[a-zA-Z0-9_-]{1,80}$/;

/** The tenant row lives in this collection by `_id`, not only `company_id`. */
const COMPANY_COLLECTIONS = new Set(["companies", "company"]);

const COUNT_CONCURRENCY = 6;

function requireCompanyId(req, res) {
  const companyId = resolveCompanyIdFromReq(req);
  if (!companyId) {
    res.status(400).json({
      success: false,
      status: 400,
      message:
        "company_id is required (authenticate with a user linked to a company)",
    });
    return null;
  }
  return companyId;
}

function companyIdValues(companyId) {
  const hex = String(companyId).trim().toLowerCase();
  const values = [hex];
  if (mongoose.Types.ObjectId.isValid(hex)) {
    values.push(new mongoose.Types.ObjectId(hex));
  }
  return values;
}

/**
 * Rows that belong to the signed-in company.
 * Other collections match `company_id` stored as a string or ObjectId.
 * The company collection also includes the tenant document itself (`_id`).
 */
function scopeFilter(collectionName, companyId) {
  const values = companyIdValues(companyId);
  const byCompanyId = { company_id: { $in: values } };
  if (!COMPANY_COLLECTIONS.has(collectionName)) return byCompanyId;

  const oid = values.find((value) => value instanceof mongoose.Types.ObjectId);
  const ors = [byCompanyId];
  if (oid) ors.unshift({ _id: oid });
  return { $or: ors };
}

function getDb() {
  const db = mongoose.connection && mongoose.connection.db;
  if (!db) {
    const error = new Error("Database is not connected");
    error.statusCode = 503;
    throw error;
  }
  return db;
}

async function listCollectionNames(db) {
  const listed = await db.listCollections({}, { nameOnly: true }).toArray();
  return listed
    .map((entry) => (entry && entry.name ? String(entry.name) : ""))
    .filter(
      (name) =>
        TABLE_NAME_RE.test(name) &&
        !name.startsWith("system.") &&
        !name.startsWith("system_"),
    )
    .sort((a, b) => a.localeCompare(b));
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        out[index] = await fn(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

function sendError(res, error, fallback) {
  const status = error.statusCode || 500;
  return res.status(status).json({
    success: false,
    status,
    error: error.message || fallback,
  });
}

/**
 * GET `/api/company/table-backup`
 * Every collection, with a row count limited to the signed-in company.
 */
async function listCompanyTables(req, res) {
  try {
    const companyId = requireCompanyId(req, res);
    if (!companyId) return undefined;

    const db = getDb();
    const names = await listCollectionNames(db);
    const counted = await mapPool(names, COUNT_CONCURRENCY, async (name) => {
      const rows = await db.collection(name).countDocuments(scopeFilter(name, companyId));
      return { name, rows };
    });

    counted.sort(
      (a, b) => b.rows - a.rows || a.name.localeCompare(b.name),
    );
    const totalRows = counted.reduce((sum, row) => sum + row.rows, 0);

    void logListAccess(req, {
      source: "api",
      module: "company",
      action: "table-backup",
      description: { tables: counted.length, total_rows: totalRows },
    });

    return res.status(200).json({
      success: true,
      status: 200,
      message:
        counted.length > 0
          ? `Found ${counted.length} table(s) for this company`
          : "No tables found",
      company_id: companyId,
      count: counted.length,
      total_rows: totalRows,
      tables: counted,
    });
  } catch (error) {
    console.error("❌ listCompanyTables:", error?.message || error);
    return sendError(res, error, "Failed to list tables");
  }
}

/**
 * GET `/api/company/table-backup/:table/download`
 * One collection, JSON array of that company's documents.
 * Password hashes are omitted.
 */
async function downloadCompanyTable(req, res) {
  let cursor = null;
  try {
    const companyId = requireCompanyId(req, res);
    if (!companyId) return undefined;

    const table = String(req.params.table || "").trim();
    if (!TABLE_NAME_RE.test(table)) {
      return res.status(400).json({
        success: false,
        status: 400,
        message: "Invalid table name",
      });
    }

    const db = getDb();
    const names = await listCollectionNames(db);
    if (!names.includes(table)) {
      return res.status(404).json({
        success: false,
        status: 404,
        message: "Table not found",
      });
    }

    void logListAccess(req, {
      source: "api",
      module: "company",
      action: "table-backup-download",
      description: { table },
    });

    const filename = `${table}-${companyId}.json`;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`,
    );
    res.setHeader("Cache-Control", "no-store");

    cursor = db.collection(table).find(scopeFilter(table, companyId), {
      projection: { password: 0 },
    });

    res.write("[");
    let first = true;
    for await (const doc of cursor) {
      if (!first) res.write(",");
      first = false;
      res.write(EJSON.stringify(doc, { relaxed: true }));
    }
    res.write("]");
    return res.end();
  } catch (error) {
    console.error("❌ downloadCompanyTable:", error?.message || error);
    if (cursor) {
      try {
        await cursor.close();
      } catch {
        /* ignore */
      }
    }
    if (res.headersSent) {
      return res.end();
    }
    return sendError(res, error, "Failed to download table");
  }
}

module.exports = {
  listCompanyTables,
  downloadCompanyTable,
  scopeFilter,
  TABLE_NAME_RE,
};
