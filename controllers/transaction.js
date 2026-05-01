const mongoose = require("mongoose");
const { handleGenericCreate } = require("../utils/modelHelper");
const Transaction = require("../models/transaction");

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

/**
 * Build filter for list + aggregation (same rules for totals and rows).
 */
function buildTransactionListFilter(req) {
  const filter = {
    status: "active",
    $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }],
  };

  if (
    req.query.include_inactive === "true" ||
    req.query.include_inactive === "1"
  ) {
    delete filter.status;
  }

  if (req.user?.company_id) {
    filter.company_id = req.user.company_id;
  }

  if (req.query.transaction_number) {
    filter.transaction_number = String(req.query.transaction_number).trim();
  }

  if (
    req.query.account_id &&
    mongoose.Types.ObjectId.isValid(String(req.query.account_id).trim())
  ) {
    filter.account_id = new mongoose.Types.ObjectId(
      String(req.query.account_id).trim(),
    );
  }

  if (
    req.query.branch_id &&
    mongoose.Types.ObjectId.isValid(String(req.query.branch_id).trim())
  ) {
    filter.branch_id = new mongoose.Types.ObjectId(
      String(req.query.branch_id).trim(),
    );
  }

  return filter;
}

/**
 * GET /api/transaction/list-with-summary
 *
 * Returns matching transactions (paginated) plus totals over **all** matching rows:
 * - total_debit: sum(amount) where type === "debit"
 * - total_credit: sum(amount) where type === "credit"
 * - net_debit_minus_credit: total_debit - total_credit
 *
 * Query: skip, limit (default 200, max 2000), transaction_number, account_id, branch_id, include_inactive
 */
async function getTransactionsListWithDebitCreditSummary(req, res) {
  try {
    const filter = buildTransactionListFilter(req);

    const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);
    const rawLimit =
      req.query.limit != null && String(req.query.limit).trim() !== "" ?
        parseInt(req.query.limit, 10)
      : 200;
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 200, 1), 2000);

    const [agg] = await Transaction.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          total_debit: {
            $sum: {
              $cond: [
                { $eq: ["$type", "debit"] },
                {
                  $convert: {
                    input: "$amount",
                    to: "double",
                    onError: 0,
                    onNull: 0,
                  },
                },
                0,
              ],
            },
          },
          total_credit: {
            $sum: {
              $cond: [
                { $eq: ["$type", "credit"] },
                {
                  $convert: {
                    input: "$amount",
                    to: "double",
                    onError: 0,
                    onNull: 0,
                  },
                },
                0,
              ],
            },
          },
          matched_count: { $sum: 1 },
        },
      },
    ]);

    const total_debit = agg?.total_debit ?? 0;
    const total_credit = agg?.total_credit ?? 0;
    const matched_count = agg?.matched_count ?? 0;

    const net_debit_minus_credit = Number(
      (total_debit - total_credit).toFixed(2),
    );

    let query = Transaction.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const pop = req.query.populate;
    if (pop != null && String(pop).includes("account_id")) {
      query = query.populate("account_id", "name account_type account_number");
    }

    const data = await query.lean().exec();

    return res.status(200).json({
      success: true,
      summary: {
        total_debit: Number(total_debit.toFixed(2)),
        total_credit: Number(total_credit.toFixed(2)),
        net_debit_minus_credit,
        matched_count,
      },
      data,
      pagination: {
        total: matched_count,
        skip,
        limit,
        returned: data.length,
      },
    });
  } catch (error) {
    console.error("❌ getTransactionsListWithDebitCreditSummary:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error",
    });
  }
}

module.exports = {
  transactionBulkCreate,
  createTransactionsFromItems,
  getTransactionsListWithDebitCreditSummary,
};
