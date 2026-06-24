const mongoose = require("mongoose");
const Transaction = require("../models/transaction");
const Expense = require("../models/expense");
const { generateTransactionNumber } = require("../utils/transactionNumber");
const { logRollbackFailure } = require("../utils/logControllerError");
const {
  isMongoTransactionUnsupportedError,
} = require("../utils/mongoTransactionSupport");
const {
  handleGenericCreate,
  handleGenericUpdate,
  activeNotDeletedCriteria,
} = require("../utils/modelHelper");
const {
  createTransactionsFromItems: transactionBulkCreate,
} = require("./transaction");
const {
  resolveReportPeriodRange,
  periodResponse,
} = require("../utils/reportPeriodRange");
const { resolveTenantCompany } = require("../utils/receivablesReport");

function pickObjectId(value) {
  if (value && typeof value === "object" && value._id) return value._id;
  return value;
}

/** Expense `createdAt` / `created_at` from the saved row or create body. */
function expenseCreatedAt(record, req = null) {
  const raw =
    record?.createdAt ??
    record?.created_at ??
    req?.body?.createdAt ??
    req?.body?.created_at;
  if (raw == null || raw === "") return new Date();
  const d = raw instanceof Date ? raw : new Date(raw);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function expenseTransactionNumber(record, req = null) {
  return generateTransactionNumber({
    includeDate: true,
    includeTime: true,
    now: expenseCreatedAt(record, req),
  });
}

async function throwExpenseGlBulkFailed(failed) {
  const err = new Error(
    `Post-expense transaction bulk insert failed: ${JSON.stringify(failed)}`,
  );
  err.statusCode = 400;
  err.details = failed;
  err.responseType = "transaction_bulk";
  throw err;
}

function throwWithGenericFailure(response, fallbackError) {
  const err = new Error(
    response?.error || response?.message || fallbackError || "Request failed",
  );
  err.statusCode = response?.status || 400;
  err.responseType = response?.type || "validation";
  err.details = response?.details || response?.missing || response;
  err.clientErrorPayload = response;
  throw err;
}

function expenseLogContext(req, extra = {}) {
  return {
    expense_id: req.params?.id,
    name: req.body?.name,
    amount: req.body?.amount,
    account_id: pickObjectId(req.body?.account_id) ?? req.body?.account_id,
    payment_method_accounts_id:
      pickObjectId(req.body?.payment_method_accounts_id) ??
      req.body?.payment_method_accounts_id,
    user_id: pickObjectId(req.body?.user_id) ?? req.body?.user_id,
    company_id:
      pickObjectId(req.body?.company_id) ?? pickObjectId(req?.user?.company_id),
    ...extra,
  };
}

/** Mongo session when supported; otherwise retry once without a session. */
async function runExpenseWithOptionalTransaction(runFlow) {
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
      session.endSession();
    }
  }
  return txnError;
}

function buildExpenseGlItems(record, transaction_number, req = null) {
  const companyId = pickObjectId(record?.company_id);
  const amount = Number(record?.amount ?? 0);
  const expenseAccountId = pickObjectId(record?.account_id);
  const paymentAccountId = pickObjectId(record?.payment_method_accounts_id);
  const description = record?.name ? `Expense: ${record.name}` : "Expense";
  const createdAt = expenseCreatedAt(record, req);

  if (!expenseAccountId || !paymentAccountId) {
    const err = new Error(
      "Expense requires account_id and payment_method_accounts_id for GL posting",
    );
    err.statusCode = 400;
    throw err;
  }

  const base = {
    company_id: companyId,
    amount,
    reference_user_id: pickObjectId(record?.user_id),
    transaction_number,
    description,
    createdAt,
    reference_id: {
      module: "expense",
      ref_id: record._id,
    },
  };

  return [
    { ...base, account_id: expenseAccountId, type: "debit" },
    { ...base, account_id: paymentAccountId, type: "credit" },
  ];
}

async function softDeleteExpenseGlRows(expenseReq, expenseId, session = null) {
  const softDeleteSet = { deletedAt: new Date(), status: "inactive" };
  const uid = pickObjectId(expenseReq?.user?._id ?? expenseReq?.user);
  if (uid) softDeleteSet.updated_by = uid;

  const filter = {
    "reference_id.module": "expense",
    "reference_id.ref_id": expenseId,
    ...activeNotDeletedCriteria(),
  };

  const result = await Transaction.updateMany(
    filter,
    { $set: softDeleteSet },
    session ? { session } : {},
  );

  if (result.modifiedCount > 0) {
    console.log("✅ Expense GL rows soft-deleted:", result.modifiedCount);
  }
}

async function postExpenseGlTransactions(
  record,
  expenseReq,
  transaction_number,
  session = null,
) {
  const items = buildExpenseGlItems(record, transaction_number, expenseReq);
  const { failed } = await transactionBulkCreate(expenseReq, items, {
    stopOnError: true,
    session,
  });
  if (failed.length) {
    await throwExpenseGlBulkFailed(failed);
  }
}

async function expenseCreate(req, res) {
  let response = null;
  const txnError = await runExpenseWithOptionalTransaction(async (mongoSession) => {
    response = await handleGenericCreate(req, "expense", {
      ...(mongoSession ? { session: mongoSession } : {}),
      afterCreate: async (record, expenseReq, sess) => {
        const transaction_number = expenseTransactionNumber(record, expenseReq);
        await postExpenseGlTransactions(
          record,
          expenseReq,
          transaction_number,
          sess,
        );
      },
    });
    if (!response?.success || !response?.data) {
      throwWithGenericFailure(response, "Expense create failed");
    }
  });

  if (txnError) {
    await logRollbackFailure(req, txnError, {
      action: "EXPENSE CREATE ROLLBACK",
      tags: ["expense", "create"],
      fallbackUrl: "/api/expense/save",
      context: expenseLogContext(req),
    });
    if (txnError.clientErrorPayload) {
      return res
        .status(txnError.clientErrorPayload.status || 400)
        .json(txnError.clientErrorPayload);
    }
    return res.status(txnError.statusCode || 500).json({
      success: false,
      status: txnError.statusCode || 500,
      error: txnError.message || "Expense create failed",
      message: txnError.message || "Expense create failed",
      details: txnError.details || txnError.message,
      type: txnError.responseType || "internal",
    });
  }

  return res.status(response.status).json(response);
}

async function expenseUpdate(req, res) {
  let response = null;
  const txnError = await runExpenseWithOptionalTransaction(async (mongoSession) => {
    response = await handleGenericUpdate(req, "expense", {
      ...(mongoSession ? { session: mongoSession } : {}),
      filter: activeNotDeletedCriteria(),
      afterUpdate: async (record, expenseReq, _existing, sess) => {
        await softDeleteExpenseGlRows(expenseReq, record._id, sess);
        const transaction_number = expenseTransactionNumber(record, expenseReq);
        await postExpenseGlTransactions(
          record,
          expenseReq,
          transaction_number,
          sess,
        );
      },
    });
    if (!response?.success || !response?.data) {
      throwWithGenericFailure(response, "Expense update failed");
    }
  });

  if (txnError) {
    await logRollbackFailure(req, txnError, {
      action: "EXPENSE UPDATE ROLLBACK",
      tags: ["expense", "update"],
      fallbackUrl: `/api/expense/update/${req.params?.id || ""}`,
      context: expenseLogContext(req, { expense_id: req.params?.id }),
    });
    if (txnError.clientErrorPayload) {
      return res
        .status(txnError.clientErrorPayload.status || 400)
        .json(txnError.clientErrorPayload);
    }
    return res.status(txnError.statusCode || 500).json({
      success: false,
      status: txnError.statusCode || 500,
      error: txnError.message || "Expense update failed",
      message: txnError.message || "Expense update failed",
      details: txnError.details || txnError.message,
      type: txnError.responseType || "internal",
    });
  }

  return res.status(response.status).json(response);
}

/**
 * GET expense totals for a period.
 * Query: `period`, `from` / `to` (default: current_month).
 */
async function findExpenseSummary(req, res) {
  try {
    const companyResolved = resolveTenantCompany(req);
    if (!companyResolved.ok) {
      return res
        .status(companyResolved.response.status)
        .json(companyResolved.response.body);
    }

    const hasPeriod =
      req.query?.period != null && String(req.query.period).trim() !== "";
    const hasFrom = req.query?.from != null && String(req.query.from).trim() !== "";
    const hasTo = req.query?.to != null && String(req.query.to).trim() !== "";
    if (!hasPeriod && !hasFrom && !hasTo) {
      req.query.period = "current_month";
    }

    const rangeResolved = resolveReportPeriodRange(req.query, {
      defaultPeriod: "current_month",
    });
    if (rangeResolved.error) {
      return res
        .status(rangeResolved.error.status)
        .json(rangeResolved.error.body);
    }

    const { fromDate, toDate, periodLabel } = rangeResolved;
    const { cid, companyId } = companyResolved;

    const rows = await Expense.aggregate([
      {
        $match: {
          company_id: cid,
          status: "active",
          deletedAt: null,
          createdAt: { $gte: fromDate, $lte: toDate },
        },
      },
      {
        $group: {
          _id: null,
          total_amount: { $sum: { $ifNull: ["$amount", 0] } },
          expense_count: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          total_amount: { $round: ["$total_amount", 2] },
          expense_count: 1,
          average_expense: {
            $round: [
              {
                $cond: [
                  { $gt: ["$expense_count", 0] },
                  { $divide: ["$total_amount", "$expense_count"] },
                  0,
                ],
              },
              2,
            ],
          },
        },
      },
    ]);

    const summary = rows[0] || {
      total_amount: 0,
      expense_count: 0,
      average_expense: 0,
    };

    return res.status(200).json({
      success: true,
      status: 200,
      company_id: companyId,
      period: periodResponse(periodLabel, fromDate, toDate),
      data: summary,
    });
  } catch (error) {
    console.error("findExpenseSummary:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      error: error.message || "Internal server error",
    });
  }
}

/**
 * GET expenses grouped by expense GL account.
 * Query: `period`, `from` / `to`, `limit` (default 10, max 100).
 */
async function findExpenseByAccount(req, res) {
  try {
    const companyResolved = resolveTenantCompany(req);
    if (!companyResolved.ok) {
      return res
        .status(companyResolved.response.status)
        .json(companyResolved.response.body);
    }

    const hasPeriod =
      req.query?.period != null && String(req.query.period).trim() !== "";
    const hasFrom = req.query?.from != null && String(req.query.from).trim() !== "";
    const hasTo = req.query?.to != null && String(req.query.to).trim() !== "";
    if (!hasPeriod && !hasFrom && !hasTo) {
      req.query.period = "last_30_days";
    }

    const rangeResolved = resolveReportPeriodRange(req.query, {
      defaultPeriod: "last_30_days",
    });
    if (rangeResolved.error) {
      return res
        .status(rangeResolved.error.status)
        .json(rangeResolved.error.body);
    }

    const { fromDate, toDate, periodLabel } = rangeResolved;
    const { cid, companyId } = companyResolved;
    const limitRaw = parseInt(req.query?.limit, 10);
    const limit = limitRaw > 0 ? Math.min(limitRaw, 100) : 10;

    const rows = await Expense.aggregate([
      {
        $match: {
          company_id: cid,
          status: "active",
          deletedAt: null,
          createdAt: { $gte: fromDate, $lte: toDate },
        },
      },
      {
        $group: {
          _id: "$account_id",
          total_amount: { $sum: { $ifNull: ["$amount", 0] } },
          expense_count: { $sum: 1 },
        },
      },
      {
        $lookup: {
          from: "accounts",
          localField: "_id",
          foreignField: "_id",
          pipeline: [
            {
              $match: {
                company_id: cid,
                deletedAt: null,
              },
            },
            { $project: { name: 1, account_type: 1, account_number: 1 } },
          ],
          as: "account",
        },
      },
      {
        $project: {
          _id: 0,
          account_id: "$_id",
          account_name: {
            $ifNull: [{ $arrayElemAt: ["$account.name", 0] }, "Unknown account"],
          },
          account_type: { $arrayElemAt: ["$account.account_type", 0] },
          account_number: { $arrayElemAt: ["$account.account_number", 0] },
          total_amount: { $round: ["$total_amount", 2] },
          expense_count: 1,
        },
      },
      { $sort: { total_amount: -1 } },
      { $limit: limit },
    ]);

    const summary = rows.reduce(
      (acc, row) => {
        acc.total_amount += Number(row.total_amount) || 0;
        acc.expense_count += Number(row.expense_count) || 0;
        return acc;
      },
      { total_amount: 0, expense_count: 0, account_count: rows.length },
    );
    summary.total_amount = Math.round(summary.total_amount * 100) / 100;

    return res.status(200).json({
      success: true,
      status: 200,
      company_id: companyId,
      period: periodResponse(periodLabel, fromDate, toDate),
      summary,
      data: rows,
    });
  } catch (error) {
    console.error("findExpenseByAccount:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      error: error.message || "Internal server error",
    });
  }
}

module.exports = {
  expenseCreate,
  expenseUpdate,
  findExpenseSummary,
  findExpenseByAccount,
};
