const {
  handleGenericCreate,
  handleGenericUpdate,
} = require("../utils/modelHelper");
const Transaction = require("../models/transaction");
const { logControllerError } = require("../utils/logControllerError");
const {
  createTransactionsFromItems: transactionBulkCreate,
} = require("./transaction");

const ACCOUNT_TRANSACTION_ERROR_LOG = {
  action: "POST ACCOUNT TRANSACTION ERROR",
  tags: ["api", "account", "transaction", "error"],
  fallbackUrl: "/api/account",
};

function makeNumberPositive(number) {
  return Math.abs(number);
}

async function accountCreate(req, res) {
  console.log("🔐 Processing account creation...", req.user);
  //   orderReq.user.company_id;
  //   return;
  const transaction_number = `TXN-${Date.now()}-${Math.floor(
    Math.random() * 1000000,
  )
    .toString()
    .padStart(6, "0")}`;

  req.body.transaction_number = transaction_number;

  const response = await handleGenericCreate(req, "account", {
    // Always persist server-generated number (covers /account/create vs body-only edge cases)
    afterCreate: async (record, transcReq) => {
      console.log("✅ Record created successfully:", record);

      try {
        const { created, failed } = await transactionBulkCreate(
          transcReq,
          [
            {
              //initial_balance
              account_id: record._id,
              type: record?.initial_balance > 0 ? "debit" : "credit",
              amount: makeNumberPositive(record?.initial_balance),
              //   reference_user_id: record?.customer_id,
              transaction_number,
              description: "Account Initial Balance",
              //   reference_id: {
              //     module: "order",
              //     ref_id: record._id,
              //   },
            },
            {
              //initial_balance
              account_id: transcReq.user.company_id.default_equity_account_id,
              type: record?.initial_balance > 0 ? "credit" : "debit",
              amount: makeNumberPositive(record?.initial_balance),
              //   reference_user_id: record?.customer_id,
              transaction_number,
              description: "Account Initial Balance",
              //   reference_id: {
              //     module: "order",
              //     ref_id: record._id,
              //   },
            },
          ],
          { stopOnError: true },
        );
        if (failed.length) {
          console.error(
            "⚠️ Post-order transaction bulk insert failed:",
            failed,
          );
          await logControllerError(
            req,
            `Post-account transaction bulk insert failed: ${JSON.stringify(failed)}`,
            ACCOUNT_TRANSACTION_ERROR_LOG,
          );
        } else if (created[0]?.data?._id) {
          console.log(
            "✅ Transaction(s) created:",
            created.map((c) => c.data._id),
          );
        }
      } catch (e) {
        console.error("⚠️ Post-order transaction error:", e.message);
        await logControllerError(
          req,
          `Post-account transaction error: ${e.message}`,
          ACCOUNT_TRANSACTION_ERROR_LOG,
        );
      }
    },
  });

  return res.status(response.status).json(response);
}

async function accountUpdate(req, res) {
  const response = await handleGenericUpdate(req, "account", {
    excludeFields: ["password"], // Don't return password in response
    // allowedFields: [] - Empty array means allow all fields except password (dynamic)
    beforeUpdate: async (updateData, req, existingUser) => {
      console.log("🔧 Processing user update...", {
        userId: existingUser._id,
        currentName: existingUser.name,
        newName: updateData.name,
        currentEmail: existingUser.email,
        newEmail: updateData.email,
        hasProfileImage: !!req.files?.profile_image,
        updateFields: Object.keys(updateData),
      });
    },
    afterUpdate: async (record, transcReq, existingUser) => {
      console.log("✅ Record updated successfully:", record);

      try {
        const transaction_number = record?.transaction_number;
        const deleteTransc =
          transaction_number ?
            await Transaction.deleteMany({ transaction_number })
          : { deletedCount: 0 };
        if (deleteTransc.deletedCount > 0) {
          console.log("✅ Transaction deleted:", deleteTransc.deletedCount);
        }
        const { created, failed } = await transactionBulkCreate(
          transcReq,
          [
            {
              //initial_balance
              account_id: record._id,
              type: record?.initial_balance > 0 ? "debit" : "credit",
              amount: makeNumberPositive(record?.initial_balance),
              transaction_number,
              description: "Account Initial Balance",
            },
            {
              //initial_balance
              account_id: transcReq.user.company_id.default_equity_account_id,
              type: record?.initial_balance > 0 ? "credit" : "debit",
              amount: makeNumberPositive(record?.initial_balance),
              transaction_number,
              description: "Account Initial Balance",
            },
          ],
          { stopOnError: true },
        );
        if (failed.length) {
          console.error(
            "⚠️ Post-order transaction bulk insert failed:",
            failed,
          );
          await logControllerError(
            req,
            `Post-account transaction bulk insert failed: ${JSON.stringify(failed)}`,
            ACCOUNT_TRANSACTION_ERROR_LOG,
          );
        } else if (created[0]?.data?._id) {
          console.log(
            "✅ Transaction(s) created:",
            created.map((c) => c.data._id),
          );
        }
      } catch (e) {
        console.error("⚠️ Post-order transaction error:", e.message);
        await logControllerError(
          req,
          `Post-account transaction error: ${e.message}`,
          ACCOUNT_TRANSACTION_ERROR_LOG,
        );
      }
    },
  });

  return res.status(response.status).json(response);
}

module.exports = {
  accountCreate,
  accountUpdate,
};
