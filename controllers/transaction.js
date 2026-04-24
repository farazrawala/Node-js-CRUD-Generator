const { handleGenericCreate } = require("../utils/modelHelper");

const MAX_BULK_ITEMS = 500;

/**
 * Create many transactions using the same rules as the bulk HTTP API (cloned req + handleGenericCreate).
 * @param {import("express").Request} req - Original request (for user / headers)
 * @param {object[]} items - Plain objects, same shape as each `items[]` entry in POST /transaction/bulk-create
 * @param {{ stopOnError?: boolean }} [options]
 * @returns {Promise<{ created: { index: number, data: object }[], failed: object[], summary: { total: number, inserted: number, failed: number } }>}
 */
async function createTransactionsFromItems(req, items, options = {}) {
  const raw = items;
  const stopOnError = options.stopOnError === true;

  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      created: [],
      failed: [
        {
          index: -1,
          status: 400,
          error: "Invalid items",
          message: "Expected a non-empty array of transaction objects.",
        },
      ],
      summary: { total: 0, inserted: 0, failed: 1 },
    };
  }

  if (raw.length > MAX_BULK_ITEMS) {
    return {
      created: [],
      failed: [
        {
          index: -1,
          status: 400,
          error: "Too many items",
          message: `At most ${MAX_BULK_ITEMS} items per call.`,
        },
      ],
      summary: { total: raw.length, inserted: 0, failed: 1 },
    };
  }

  const created = [];
  const failed = [];

  for (let i = 0; i < raw.length; i++) {
    const row = raw[i];
    if (row == null || typeof row !== "object" || Array.isArray(row)) {
      failed.push({
        index: i,
        status: 400,
        error: "Invalid item",
        message: "Each item must be a plain object",
      });
      if (stopOnError) break;
      continue;
    }

    const itemReq = Object.assign(
      Object.create(Object.getPrototypeOf(req)),
      req,
      { body: { ...row } },
    );

    if (req.user && req.user.company_id) {
      itemReq.body.company_id = req.user.company_id;
    }

    const response = await handleGenericCreate(itemReq, "transaction", {});
    if (response.success) {
      created.push({ index: i, data: response.data });
    } else {
      failed.push({
        index: i,
        status: response.status || 400,
        error: response.error,
        message: response.message,
        details: response.details,
        missing: response.missing,
      });
      if (stopOnError) {
        break;
      }
    }
  }

  return {
    created,
    failed,
    summary: {
      total: raw.length,
      inserted: created.length,
      failed: failed.length,
    },
  };
}

/**
 * POST /api/transaction/bulk-create
 * Body: { "items": [ { ...transaction fields }, ... ] }  (alias: `transactions`)
 */
async function transactionBulkCreate(req, res) {
  const raw = req.body.items ?? req.body.transactions;
  if (!Array.isArray(raw) || raw.length === 0) {
    return res.status(400).json({
      success: false,
      message: "Send a non-empty array in `items` or `transactions`.",
    });
  }

  const stopOnError =
    req.body.stopOnError === true ||
    req.body.stopOnError === "true" ||
    req.query.stopOnError === "true";

  const { created, failed, summary } = await createTransactionsFromItems(
    req,
    raw,
    { stopOnError },
  );

  const allOk = failed.length === 0;
  const noneOk = created.length === 0;

  const payload = {
    success: allOk,
    summary,
    inserted: created,
    errors: failed,
  };

  if (allOk) {
    return res.status(201).json(payload);
  }
  if (noneOk) {
    return res.status(400).json(payload);
  }
  return res.status(207).json(payload);
}

module.exports = {
  transactionBulkCreate,
  createTransactionsFromItems,
};
