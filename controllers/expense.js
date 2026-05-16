const { generateTransactionNumber } = require("../utils/transactionNumber");
const { handleGenericCreate } = require("../utils/modelHelper");
const {
  createTransactionsFromItems: transactionBulkCreate,
} = require("./transaction");

function pickObjectId(value) {
  if (value && typeof value === "object" && value._id) return value._id;
  return value;
}

async function throwExpenseGlBulkFailed(failed) {
  const err = new Error(
    `Post-expense transaction bulk insert failed: ${JSON.stringify(failed)}`,
  );
  err.statusCode = 400;
  err.details = failed;
  throw err;
}

async function expenseCreate(req, res) {
  const transaction_number = generateTransactionNumber({
    includeDate: true,
    includeTime: true,
  });

  try {
    const response = await handleGenericCreate(req, "expense", {
      afterCreate: async (record, expenseReq, session) => {
        const companyId =
          pickObjectId(record?.company_id) ||
          pickObjectId(expenseReq?.user?.company_id);
        const amount = Number(record?.amount ?? 0);
        const expenseAccountId = pickObjectId(record?.account_id);
        const paymentAccountId = pickObjectId(
          record?.payment_method_accounts_id,
        );

        if (!expenseAccountId || !paymentAccountId) {
          const err = new Error(
            "Expense requires account_id and payment_method_accounts_id for GL posting",
          );
          err.statusCode = 400;
          throw err;
        }

        const description =
          record?.name ? `Expense: ${record.name}` : "Expense";

        const { failed } = await transactionBulkCreate(
          expenseReq,
          [
            {
              account_id: expenseAccountId,
              type: "debit",
              company_id: companyId,
              amount,
              reference_user_id: pickObjectId(record?.user_id),
              transaction_number,
              description,
              reference_id: {
                module: "expense",
                ref_id: record._id,
              },
            },
            {
              account_id: paymentAccountId,
              type: "credit",
              company_id: companyId,
              amount,
              reference_user_id: pickObjectId(record?.user_id),
              transaction_number,
              description,
              reference_id: {
                module: "expense",
                ref_id: record._id,
              },
            },
          ],
          { stopOnError: true, session },
        );

        if (failed.length) {
          await throwExpenseGlBulkFailed(failed);
        }
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

module.exports = {
  expenseCreate,
};
