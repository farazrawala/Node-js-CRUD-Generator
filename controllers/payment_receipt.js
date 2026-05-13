const mongoose = require("mongoose");
const Transaction = require("../models/transaction");
const {
  handleGenericCreate,
  handleGenericUpdate,
  handleGenericGetById,
  handleGenericGetAll,
  handleGenericFindOne,
} = require("../utils/modelHelper");
const {
  createTransactionsFromItems: transactionBulkCreate,
} = require("./transaction");
const { logRollbackFailure } = require("../utils/logControllerError");
const { generateTransactionNumber } = require("../utils/transactionNumber");
const {
  isMongoTransactionUnsupportedError,
} = require("../utils/mongoTransactionSupport");

function pickObjectId(value) {
  if (value && typeof value === "object" && value._id) return value._id;
  return value;
}

async function throwPaymentReceiptGlBulkFailed(_req, failed) {
  const msg = `Post-payment_receipt transaction bulk insert failed: ${JSON.stringify(
    failed,
  )}`;
  const err = new Error(msg);
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

async function paymentReceiptCreate(req, res) {
  const transaction_number = generateTransactionNumber({
    includeDate: true,
    includeTime: true,
  });

  req.body.transaction_number = transaction_number;
  let response = null;
  let txnError = null;
  let session = null;
  const runCreateFlow = async (mongoSession) => {
    response = await handleGenericCreate(req, "payment_receipt", {
      ...(mongoSession ? { session: mongoSession } : {}),
      afterCreate: async (record, orderReq, sess) => {
        const companyId =
          pickObjectId(record?.company_id) ||
          pickObjectId(orderReq?.user?.company_id);
        const companyObj =
          (
            orderReq?.user?.company_id &&
            typeof orderReq.user.company_id === "object"
          ) ?
            orderReq.user.company_id
          : {};

        const { created, failed } = await transactionBulkCreate(
          orderReq,
          [
            {
              account_id:
                record?.payment_type === "Send" ?
                  record?.payment_mode
                : companyObj.default_account_receivable_account,
              type: "credit",
              company_id: companyId,
              amount: record?.amount,
              reference_user_id: record?.user_id,
              transaction_number,
              description: `Payment Receipt (${record?.payment_type || ""})`,
              reference_id: {
                module: "payment_receipt",
                ref_id: record?._id,
              },
            },
            // send: a/c payable / cash(mode)
            // receive: cash(mode) / a/c receivable
            {
              account_id:
                record?.payment_type === "Send" ?
                  companyObj.default_account_payable_account
                : record?.payment_mode,
              type: "debit",
              company_id: companyId,
              amount: record?.amount,
              reference_user_id: record?.user_id,
              transaction_number,
              description: `Payment Receipt (${record?.payment_type || ""})`,
              reference_id: {
                module: "payment_receipt",
                ref_id: record._id,
              },
            },
          ],
          { stopOnError: true, session: sess },
        );
        if (failed.length) {
          await throwPaymentReceiptGlBulkFailed(orderReq, failed);
        }
        if (created[0]?.data?._id) {
          console.log(
            "✅ Transaction(s) created:",
            created.map((c) => c.data._id),
          );
        }
      },
    });

    if (!response?.success || !response?.data) {
      throwWithGenericFailure(response, "Payment receipt create failed");
    }
  };

  try {
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      await runCreateFlow(session);
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
        await runCreateFlow(null);
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

  if (txnError) {
    await logRollbackFailure(req, txnError, {
      action: "PAYMENT RECEIPT CREATE ROLLBACK",
      tags: ["payment_receipt", "create"],
      fallbackUrl: "/api/payment_receipt/create",
      context: {
        transaction_number: req.body?.transaction_number,
        payment_type: req.body?.payment_type,
        payment_mode:
          pickObjectId(req.body?.payment_mode) ?? req.body?.payment_mode,
        amount: req.body?.amount,
        user_id: pickObjectId(req.body?.user_id) ?? req.body?.user_id,
        company_id: pickObjectId(req.body?.company_id) ?? req.body?.company_id,
      },
    });
    if (txnError.clientErrorPayload) {
      return res
        .status(txnError.clientErrorPayload.status || 400)
        .json(txnError.clientErrorPayload);
    }
    return res.status(txnError.statusCode || 500).json({
      success: false,
      status: txnError.statusCode || 500,
      error: txnError.message || "Payment receipt create failed",
      details: txnError.details || txnError.message,
      type: txnError.responseType || "internal",
    });
  }

  return res.status(response.status).json(response);
}

async function paymentReceiptUpdate(req, res) {
  let response = null;
  let txnError = null;
  let session = null;
  const runUpdateFlow = async (mongoSession) => {
    response = await handleGenericUpdate(req, "payment_receipt", {
      ...(mongoSession ? { session: mongoSession } : {}),
      filter: { status: "active", deletedAt: null },
      beforeUpdate: async (_updateData, updateReq, existingRecord) => {
        updateReq._paymentReceiptPriorTransactionNumber =
          existingRecord?.transaction_number;
      },
      afterUpdate: async (record, orderReq, existingRecord, sess) => {
        const priorTxnNumber = existingRecord?.transaction_number;
        if (priorTxnNumber) {
          const softDeleteSet = {
            deletedAt: new Date(),
            status: "inactive",
          };
          const uid = pickObjectId(orderReq?.user?._id ?? orderReq?.user);
          if (uid) softDeleteSet.updated_by = uid;

          const softDeleteResult = await Transaction.updateMany(
            { transaction_number: priorTxnNumber, deletedAt: null },
            { $set: softDeleteSet },
            { session: sess },
          );
          if (softDeleteResult.modifiedCount > 0) {
            console.log(
              "✅ Payment receipt GL rows soft-deleted:",
              softDeleteResult.modifiedCount,
            );
          }
        }

        const transaction_number = record?.transaction_number;
        const companyId =
          pickObjectId(record?.company_id) ||
          pickObjectId(orderReq?.user?.company_id);
        const companyObj =
          (
            orderReq?.user?.company_id &&
            typeof orderReq.user.company_id === "object"
          ) ?
            orderReq.user.company_id
          : {};

        const { created, failed } = await transactionBulkCreate(
          orderReq,
          [
            {
              account_id:
                record?.payment_type === "Send" ?
                  record?.payment_mode
                : companyObj.default_account_receivable_account,
              type: "credit",
              company_id: companyId,
              amount: record?.amount,
              reference_user_id: record?.user_id,
              transaction_number,
              description: `Payment Receipt (${record?.payment_type || ""})`,
              reference_id: {
                module: "payment_receipt",
                ref_id: record?._id,
              },
              createdAt: record?.createdAt,
            },
            {
              account_id:
                record?.payment_type === "Send" ?
                  companyObj.default_account_payable_account
                : record?.payment_mode,
              type: "debit",
              company_id: companyId,
              amount: record?.amount,
              reference_user_id: record?.user_id,
              transaction_number,
              description: `Payment Receipt (${record?.payment_type || ""})`,
              reference_id: {
                module: "payment_receipt",
                ref_id: record._id,
              },
              createdAt: record?.createdAt,
            },
          ],
          { stopOnError: true, session: sess },
        );
        if (failed.length) {
          await throwPaymentReceiptGlBulkFailed(orderReq, failed);
        }
        if (created[0]?.data?._id) {
          console.log(
            "✅ Transaction(s) created:",
            created.map((c) => c.data._id),
          );
        }
      },
    });

    if (!response?.success || !response?.data) {
      throwWithGenericFailure(response, "Payment receipt update failed");
    }
  };

  try {
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      await runUpdateFlow(session);
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
        await runUpdateFlow(null);
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

  if (txnError) {
    await logRollbackFailure(req, txnError, {
      action: "PAYMENT RECEIPT UPDATE ROLLBACK",
      tags: ["payment_receipt", "update"],
      fallbackUrl: "/api/payment_receipt/update_receipt/:id",
      context: {
        payment_receipt_id: req.params?.id,
        prior_transaction_number: req._paymentReceiptPriorTransactionNumber,
        transaction_number: req.body?.transaction_number,
        payment_type: req.body?.payment_type,
        payment_mode:
          pickObjectId(req.body?.payment_mode) ?? req.body?.payment_mode,
        amount: req.body?.amount,
        user_id: pickObjectId(req.body?.user_id) ?? req.body?.user_id,
        company_id: pickObjectId(req.body?.company_id) ?? req.body?.company_id,
      },
    });
    if (txnError.clientErrorPayload) {
      return res
        .status(txnError.clientErrorPayload.status || 400)
        .json(txnError.clientErrorPayload);
    }
    return res.status(txnError.statusCode || 500).json({
      success: false,
      status: txnError.statusCode || 500,
      error: txnError.message || "Payment receipt update failed",
      details: txnError.details || txnError.message,
      type: txnError.responseType || "internal",
    });
  }

  return res.status(response.status).json(response);
}

module.exports = {
  paymentReceiptCreate,
  paymentReceiptUpdate,
};
