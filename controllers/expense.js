const Transaction = require("../models/transaction");
const { generateTransactionNumber } = require("../utils/transactionNumber");
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
  throw err;
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
  try {
    const response = await handleGenericCreate(req, "expense", {
      afterCreate: async (record, expenseReq, session) => {
        const transaction_number = expenseTransactionNumber(record);
        await postExpenseGlTransactions(
          record,
          expenseReq,
          transaction_number,
          session,
        );
      },
    });
    return res.status(response.status).json(response);
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Expense create failed",
      details: error.details,
    });
  }
}

async function expenseUpdate(req, res) {
  try {
    const response = await handleGenericUpdate(req, "expense", {
      filter: activeNotDeletedCriteria(),
      afterUpdate: async (record, expenseReq, _existing, session) => {
        await softDeleteExpenseGlRows(expenseReq, record._id, session);
        const transaction_number = expenseTransactionNumber(record, expenseReq);
        await postExpenseGlTransactions(
          record,
          expenseReq,
          transaction_number,
          session,
        );
      },
    });
    return res.status(response.status).json(response);
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Expense update failed",
      details: error.details,
    });
  }
}

module.exports = {
  expenseCreate,
  expenseUpdate,
};
