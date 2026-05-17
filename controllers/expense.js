const mongoose = require("mongoose");
const Transaction = require("../models/transaction");
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

module.exports = {
  expenseCreate,
  expenseUpdate,
};
