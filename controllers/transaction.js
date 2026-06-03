const mongoose = require("mongoose");
const {
  handleGenericCreate,
  handleGenericGetAll,
  buildPopulateFromQuery,
  coalesceObjectId,
} = require("../utils/modelHelper");
const Transaction = require("../models/transaction");
const {
  logRollbackFailure,
  serializeErrorForLog,
} = require("../utils/logControllerError");
const { isMongoTransactionUnsupportedError } = require("../utils/mongoTransactionSupport");

const MAX_BULK_ITEMS = 500;

/**
 * Create many transactions using the same rules as the bulk HTTP API.
 * Temporarily sets `req.body` per row (then restores) so `handleGenericCreate` always receives the real
 * Express `req` (`req.get`, `req.protocol`, etc.). A prototype-cloned fake `req` can lose `.get` in some stacks.
 * @param {import("express").Request} req - Original request (for user / headers)
 * @param {object[]} items - Plain objects, same shape as each `items[]` entry in POST /transaction/bulk-create
 * @param {{ stopOnError?: boolean, session?: import("mongoose").ClientSession | null }} [options]
 * @returns {Promise<{ created: { index: number, data: object }[], failed: object[], summary: { total: number, inserted: number, failed: number } }>}
 */
async function createTransactionsFromItems(req, items, options = {}) {
  const raw = items;
  const stopOnError = options.stopOnError === true;
  const session = options.session || null;

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

    const savedBody = req.body;
    req.body = { ...row };
    const rowCompanyId = coalesceObjectId(row.company_id);
    const userCompanyId = coalesceObjectId(req.user?.company_id);
    if (rowCompanyId || userCompanyId) {
      req.body.company_id = rowCompanyId ?? userCompanyId;
    }

    let response;
    try {
      response = await handleGenericCreate(req, "transaction", {
        ...(session ? { session } : {}),
      });
    } finally {
      req.body = savedBody;
    }

    if (response?.success) {
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

function parseAtomicBulkFlag(req) {
  const v = req.body?.atomic ?? req.query?.atomic;
  if (v === false || v === "false" || v === "0") return false;
  if (v === true || v === "true" || v === "1") return true;
  return true;
}

function parseStopOnErrorFlag(req) {
  return (
    req.body.stopOnError === true ||
    req.body.stopOnError === "true" ||
    req.query.stopOnError === "true"
  );
}

function transactionBulkLogContext(req, extra = {}) {
  const raw = req.body?.items ?? req.body?.transactions;
  return {
    company_id: req.user?.company_id,
    user_id: req.user?._id,
    item_count: Array.isArray(raw) ? raw.length : 0,
    atomic: parseAtomicBulkFlag(req),
    ...extra,
  };
}

function throwOnBulkTransactionFailures(result) {
  if (!result?.failed?.length) return;
  const first = result.failed[0];
  const err = new Error(
    first.message || first.error || "Bulk transaction create failed",
  );
  err.statusCode = first.status || 400;
  err.responseType = "validation";
  err.details = first.details ?? first.missing ?? result.failed;
  err.clientErrorPayload = {
    success: false,
    summary: result.summary,
    inserted: result.created,
    errors: result.failed,
  };
  throw err;
}

/** Soft-delete rows inserted during a failed non-transactional atomic bulk. */
async function rollbackBulkTransactions(created, req, session = null) {
  const ids = [];
  for (const row of created || []) {
    const id = row?.data?._id ?? row?.data?.id;
    const oid = coalesceObjectId(id);
    if (oid) ids.push(oid);
  }
  if (!ids.length) return;

  const opts = session ? { session } : {};
  const filter = { _id: { $in: ids }, deletedAt: null };
  const companyId = coalesceObjectId(req.user?.company_id);
  if (companyId) filter.company_id = companyId;

  const softDeleteSet = { deletedAt: new Date(), status: "inactive" };
  const uid = coalesceObjectId(req.user?._id);
  if (uid) softDeleteSet.updated_by = uid;

  await Transaction.updateMany(filter, { $set: softDeleteSet }, opts);
  console.warn(
    `⚠️ transaction bulk-create compensating rollback: ${ids.length} row(s)`,
  );
}

async function runTransactionBulkWithOptionalTransaction(runFlow) {
  let session = null;
  let txnError = null;
  try {
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      await runFlow(session);
    });
  } catch (error) {
    if (isMongoTransactionUnsupportedError(error)) {
      if (session) {
        try {
          session.endSession();
        } catch (_) {
          /* ignore */
        }
        session = null;
      }
      try {
        await runFlow(null);
      } catch (retryError) {
        txnError = retryError;
      }
    } else {
      txnError = error;
    }
  } finally {
    if (session) {
      try {
        session.endSession();
      } catch (_) {
        /* ignore */
      }
    }
  }
  return txnError;
}

/**
 * All items succeed or none persist (Mongo txn when supported; else compensating rollback).
 */
async function runAtomicTransactionBulkCreateBody(req, session) {
  const raw = req.body.items ?? req.body.transactions;
  let result = await createTransactionsFromItems(req, raw, {
    session,
    stopOnError: true,
  });

  if (result.failed.length > 0) {
    if (!session) {
      await rollbackBulkTransactions(result.created, req, null);
    }
    throwOnBulkTransactionFailures(result);
  }

  return result;
}

function buildBulkCreateHttpPayload(created, failed, summary) {
  return {
    success: failed.length === 0,
    summary,
    inserted: created,
    errors: failed,
  };
}

function sendLegacyBulkCreateResponse(res, created, failed, summary) {
  const payload = buildBulkCreateHttpPayload(created, failed, summary);
  if (failed.length === 0) {
    return res.status(201).json(payload);
  }
  if (created.length === 0) {
    return res.status(400).json(payload);
  }
  return res.status(207).json(payload);
}

async function getMyLedgerTransactions(req, res) {
  const referenceUserId =
    req.query?.reference_user_id && String(req.query.reference_user_id).trim()
      ? String(req.query.reference_user_id).trim()
      : req.user?._id;

  const companyDoc =
    req.user?.company_id && typeof req.user.company_id === "object" ?
      req.user.company_id
    : null;
  const companyId = companyDoc?._id || req.user?.company_id;
  const accountIds = [
    companyDoc?.default_account_receivable_account,
    companyDoc?.default_account_payable_account,
  ].filter(Boolean);

  const filter = {
    status: "active",
    deletedAt: null,
    company_id: companyId,
    reference_user_id: referenceUserId,
  };

  if (accountIds.length > 0) {
    filter.account_id = { $in: accountIds };
  }

  const response = await handleGenericGetAll(req, "transaction", {
    filter,
    excludeFields: [], // Don't exclude any fields
    populate: buildPopulateFromQuery(req.query, "transaction"),
    sort: { createdAt: -1 }, // Sort by newest first
    limit: req.query.limit ? parseInt(req.query.limit) : null, // Support limit from query params
    skip: req.query.skip ? parseInt(req.query.skip) : 0, // Support skip from query params
  });
  return res.status(response.status).json(response);
}

/**
 * POST /api/transaction/bulk-create  (alias: POST /api/transactions/bulk-create)
 * Body: { "items": [ { ...transaction fields }, ... ] }  (alias: `transactions`)
 *
 * Default (`atomic` true): all rows commit together (Mongo txn when supported) or none persist.
 * Legacy partial mode: `atomic: false` — may return 207 with per-row `errors` (no session).
 */
async function transactionBulkCreate(req, res) {
  const raw = req.body.items ?? req.body.transactions;
  if (!Array.isArray(raw) || raw.length === 0) {
    return res.status(400).json({
      success: false,
      message: "Send a non-empty array in `items` or `transactions`.",
    });
  }

  const atomic = parseAtomicBulkFlag(req);

  if (!atomic) {
    const { created, failed, summary } = await createTransactionsFromItems(
      req,
      raw,
      { stopOnError: parseStopOnErrorFlag(req) },
    );
    return sendLegacyBulkCreateResponse(res, created, failed, summary);
  }

  const tracker = { bulk_step: "items", inserted_count: 0 };
  let result = null;

  const txnError = await runTransactionBulkWithOptionalTransaction(
    async (session) => {
      try {
        tracker.bulk_step = "create_rows";
        result = await runAtomicTransactionBulkCreateBody(req, session);
        tracker.inserted_count = result.created.length;
      } catch (stepError) {
        if (!session && result?.created?.length) {
          await rollbackBulkTransactions(result.created, req, null);
        }
        throw stepError;
      }
    },
  );

  if (txnError) {
    console.error(
      "❌ transactionBulkCreate failed:\n",
      serializeErrorForLog(txnError),
    );
    await logRollbackFailure(req, txnError, {
      action: "TRANSACTION BULK CREATE ROLLBACK",
      tags: ["transaction", "bulk-create", "error"],
      fallbackUrl:
        req.originalUrl || req.path || "/api/transaction/bulk-create",
      context: transactionBulkLogContext(req, {
        bulk_step: tracker.bulk_step,
        inserted_count: tracker.inserted_count,
        execution_mode:
          isMongoTransactionUnsupportedError(txnError) ?
            "no_mongodb_transaction_compensating_rollback"
          : "mongodb_transaction_aborted",
        api_client_error: txnError.clientErrorPayload ?? null,
      }),
      fallbackCompanyId: req.user?.company_id,
    });

    if (txnError.clientErrorPayload) {
      const status = txnError.statusCode || 400;
      return res.status(status).json(txnError.clientErrorPayload);
    }
    return res.status(txnError.statusCode || 500).json({
      success: false,
      message: txnError.message || "Bulk transaction create failed",
      details: txnError.details ?? undefined,
      type: txnError.responseType || "internal",
    });
  }

  return res
    .status(201)
    .json(buildBulkCreateHttpPayload(result.created, [], result.summary));
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
    const limit = Math.min(
      Math.max(Number.isFinite(rawLimit) ? rawLimit : 200, 1),
      2000,
    );

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
  getMyLedgerTransactions,
};
