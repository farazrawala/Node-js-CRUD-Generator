const mongoose = require("mongoose");
const Account = require("../models/account");
const AmountTransfer = require("../models/amount_transfer");
const Transaction = require("../models/transaction");
const { generateTransactionNumber } = require("../utils/transactionNumber");
const {
  logRollbackFailure,
  serializeErrorForLog,
} = require("../utils/logControllerError");
const {
  isMongoTransactionUnsupportedError,
} = require("../utils/mongoTransactionSupport");
const {
  handleGenericCreate,
  handleGenericUpdate,
  coalesceObjectId,
  activeNotDeletedCriteria,
} = require("../utils/modelHelper");
const {
  createTransactionsFromItems: transactionBulkCreate,
} = require("./transaction");

function pickObjectId(value) {
  if (value && typeof value === "object" && value._id) return value._id;
  return value;
}

function toMongoObjectId(value) {
  const raw = pickObjectId(value);
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();
  if (!mongoose.Types.ObjectId.isValid(s)) return null;
  return raw instanceof mongoose.Types.ObjectId ?
      raw
    : new mongoose.Types.ObjectId(s);
}

function throwWithGenericFailure(response, fallbackError) {
  const err = new Error(
    response?.error || response?.message || fallbackError || "Request failed",
  );
  err.statusCode = response?.status || 400;
  err.responseType = response?.type || "validation";
  err.details = response?.details ?? response?.missing ?? response;
  err.clientErrorPayload = response;
  throw err;
}

function amountTransferLogContext(req, extra = {}) {
  return {
    amount_transfer_id: req.params?.id ?? null,
    from_account_id:
      pickObjectId(req.body?.from_account_id) ?? req.body?.from_account_id,
    to_account_id:
      pickObjectId(req.body?.to_account_id) ?? req.body?.to_account_id,
    amount: req.body?.amount,
    transaction_number: req.body?.transaction_number,
    description: req.body?.description,
    company_id:
      pickObjectId(req.body?.company_id) ?? pickObjectId(req?.user?.company_id),
    user_id: pickObjectId(req.user?._id),
    ...extra,
  };
}

function resolveAmountTransferTransactionNumber(record, req = null) {
  const existing = record?.transaction_number ?? req?.body?.transaction_number;
  if (existing != null && String(existing).trim() !== "") {
    return String(existing).trim();
  }
  return generateTransactionNumber({
    includeDate: true,
    includeTime: true,
  });
}

async function throwAmountTransferGlBulkFailed(failed) {
  const err = new Error(
    `Post-amount_transfer transaction bulk insert failed: ${JSON.stringify(failed)}`,
  );
  err.statusCode = 400;
  err.details = failed;
  err.responseType = "transaction_bulk";
  throw err;
}

async function runAmountTransferWithOptionalTransaction(runFlow) {
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

async function resolveTransferAccountNames(record, session = null) {
  const fromId = toMongoObjectId(record?.from_account_id);
  const toId = toMongoObjectId(record?.to_account_id);

  const fromPop =
    (
      record?.from_account_id &&
      typeof record.from_account_id === "object" &&
      record.from_account_id.name
    ) ?
      String(record.from_account_id.name).trim()
    : "";
  const toPop =
    (
      record?.to_account_id &&
      typeof record.to_account_id === "object" &&
      record.to_account_id.name
    ) ?
      String(record.to_account_id.name).trim()
    : "";

  if (fromPop && toPop) {
    return { fromName: fromPop, toName: toPop };
  }

  const ids = [fromId, toId].filter(Boolean);
  if (!ids.length) {
    return { fromName: "Account", toName: "Account" };
  }

  let q = Account.find({ _id: { $in: ids } }).select("name");
  if (session) q = q.session(session);
  const rows = await q.lean();
  const byId = new Map(
    rows.map((r) => [String(r._id), String(r.name || "").trim()]),
  );

  return {
    fromName: byId.get(String(fromId)) || "Account",
    toName: byId.get(String(toId)) || "Account",
  };
}

function amountTransferTransactionDescription(fromName, toName, record) {
  const base = `Amount transfer from ${fromName} to ${toName}`;
  const extra = record?.description ? String(record.description).trim() : "";
  return extra ? `${base} — ${extra}` : base;
}

async function buildAmountTransferGlItems(
  record,
  transaction_number,
  session = null,
) {
  const companyId = toMongoObjectId(record?.company_id);
  const fromAccountId = toMongoObjectId(record?.from_account_id);
  const toAccountId = toMongoObjectId(record?.to_account_id);
  const amount = Number(record?.amount ?? 0);
  const userId =
    toMongoObjectId(record?.created_by) ?? toMongoObjectId(record?.user_id);

  if (!fromAccountId || !toAccountId) {
    const err = new Error(
      "Amount transfer requires from_account_id and to_account_id",
    );
    err.statusCode = 400;
    throw err;
  }
  if (String(fromAccountId) === String(toAccountId)) {
    const err = new Error("From and to accounts must be different");
    err.statusCode = 400;
    throw err;
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    const err = new Error("Amount must be greater than zero");
    err.statusCode = 400;
    throw err;
  }

  const { fromName, toName } = await resolveTransferAccountNames(
    record,
    session,
  );
  const description = amountTransferTransactionDescription(
    fromName,
    toName,
    record,
  );

  const createdAt =
    record?.createdAt instanceof Date ? record.createdAt
    : record?.createdAt ? new Date(record.createdAt)
    : new Date();

  const base = {
    company_id: companyId,
    amount,
    user_id: userId,
    reference_user_id: userId,
    transaction_number,
    description,
    createdAt,
    reference_id: {
      module: "amount_transfer",
      ref_id: record._id,
    },
  };

  return [
    { ...base, account_id: fromAccountId, type: "credit" },
    { ...base, account_id: toAccountId, type: "debit" },
  ];
}

async function softDeleteAmountTransferGlRows(
  transferReq,
  transferId,
  session = null,
) {
  if (!transferId) return { modifiedCount: 0 };

  const softDeleteSet = { deletedAt: new Date(), status: "inactive" };
  const uid = pickObjectId(transferReq?.user?._id ?? transferReq?.user);
  if (uid) softDeleteSet.updated_by = uid;

  return Transaction.updateMany(
    {
      "reference_id.module": "amount_transfer",
      "reference_id.ref_id": transferId,
      ...activeNotDeletedCriteria(),
    },
    { $set: softDeleteSet },
    session ? { session } : {},
  );
}

async function rollbackAmountTransferSave(
  transferId,
  transferReq,
  session = null,
) {
  if (!transferId) return;

  const sessionOpts = session ? { session } : {};
  const softDeleteSet = { deletedAt: new Date(), status: "inactive" };
  const uid = pickObjectId(transferReq?.user?._id ?? transferReq?.user);
  if (uid) softDeleteSet.updated_by = uid;

  await AmountTransfer.updateOne(
    { _id: transferId },
    { $set: softDeleteSet },
    sessionOpts,
  );
  await softDeleteAmountTransferGlRows(transferReq, transferId, session);
}

async function postAmountTransferGlTransactions(
  record,
  transferReq,
  transaction_number,
  session = null,
) {
  const items = await buildAmountTransferGlItems(
    record,
    transaction_number,
    session,
  );
  const { failed } = await transactionBulkCreate(transferReq, items, {
    stopOnError: true,
    session,
  });
  if (failed.length) {
    await throwAmountTransferGlBulkFailed(failed);
  }
}

async function amountTransferCreate(req, res) {
  const tenantCo = coalesceObjectId(req.user?.company_id);
  if (tenantCo) {
    req.body.company_id = tenantCo;
  }

  const transaction_number = resolveAmountTransferTransactionNumber(
    req.body,
    req,
  );
  req.body.transaction_number = transaction_number;

  let response = null;
  const txnError = await runAmountTransferWithOptionalTransaction(
    async (mongoSession) => {
      response = await handleGenericCreate(req, "amount_transfer", {
        ...(mongoSession ? { session: mongoSession } : {}),
        afterCreate: async (record, transferReq, sess) => {
          try {
            await postAmountTransferGlTransactions(
              record,
              transferReq,
              transaction_number,
              sess,
            );
          } catch (glErr) {
            if (!sess && record?._id) {
              await rollbackAmountTransferSave(record._id, transferReq, null);
            }
            throw glErr;
          }
        },
      });
      if (!response?.success || !response?.data) {
        throwWithGenericFailure(response, "Amount transfer create failed");
      }
    },
  );

  if (txnError) {
    console.error(
      "❌ amountTransferCreate failed:\n",
      serializeErrorForLog(txnError),
    );
    await logRollbackFailure(req, txnError, {
      action: "AMOUNT TRANSFER CREATE ROLLBACK",
      tags: ["amount_transfer", "create", "error"],
      fallbackUrl: "/api/amount_transfer/save",
      context: amountTransferLogContext(req, {
        amount_transfer_id:
          txnError?.clientErrorPayload?.data?._id ??
          response?.data?._id ??
          null,
        gl_failed: txnError?.details ?? null,
      }),
    });
    if (txnError.clientErrorPayload) {
      return res
        .status(txnError.clientErrorPayload.status || 400)
        .json(txnError.clientErrorPayload);
    }
    return res.status(txnError.statusCode || 500).json({
      success: false,
      status: txnError.statusCode || 500,
      error: txnError.message || "Amount transfer create failed",
      message: txnError.message || "Amount transfer create failed",
      details: txnError.details ?? txnError.message,
      type: txnError.responseType || "error",
    });
  }

  return res.status(response.status).json(response);
}

async function amountTransferUpdate(req, res) {
  const tenantCo = coalesceObjectId(req.user?.company_id);
  const updateFilter = { ...activeNotDeletedCriteria() };
  if (tenantCo) {
    updateFilter.company_id = tenantCo;
  }

  let response = null;
  const txnError = await runAmountTransferWithOptionalTransaction(
    async (mongoSession) => {
      response = await handleGenericUpdate(req, "amount_transfer", {
        ...(mongoSession ? { session: mongoSession } : {}),
        filter: updateFilter,
        beforeUpdate: async (_updateData, transferReq, existingRecord) => {
          transferReq._amountTransferPriorSnapshot =
            existingRecord ?
              {
                from_account_id: existingRecord.from_account_id,
                to_account_id: existingRecord.to_account_id,
                amount: existingRecord.amount,
                transaction_number: existingRecord.transaction_number,
                description: existingRecord.description,
              }
            : null;
        },
        afterUpdate: async (record, transferReq, _existing, sess) => {
          const transferId = record?._id;
          await softDeleteAmountTransferGlRows(transferReq, transferId, sess);

          let transaction_number = resolveAmountTransferTransactionNumber(
            record,
            transferReq,
          );
          if (!record.transaction_number) {
            const sessionOpts = sess ? { session: sess } : {};
            await AmountTransfer.updateOne(
              { _id: transferId },
              { $set: { transaction_number } },
              sessionOpts,
            );
            record.transaction_number = transaction_number;
          }

          try {
            await postAmountTransferGlTransactions(
              record,
              transferReq,
              transaction_number,
              sess,
            );
          } catch (glErr) {
            if (!sess && transferId) {
              await rollbackAmountTransferSave(transferId, transferReq, null);
            }
            throw glErr;
          }
        },
      });
      if (!response?.success || !response?.data) {
        throwWithGenericFailure(response, "Amount transfer update failed");
      }
    },
  );

  if (txnError) {
    console.error(
      "❌ amountTransferUpdate failed:\n",
      serializeErrorForLog(txnError),
    );
    await logRollbackFailure(req, txnError, {
      action: "AMOUNT TRANSFER UPDATE ROLLBACK",
      tags: ["amount_transfer", "update", "error"],
      fallbackUrl: `/api/amount_transfer/update_record/${req.params?.id || ""}`,
      context: amountTransferLogContext(req, {
        prior: req._amountTransferPriorSnapshot ?? null,
        gl_failed: txnError?.details ?? null,
      }),
    });
    if (txnError.clientErrorPayload) {
      return res
        .status(txnError.clientErrorPayload.status || 400)
        .json(txnError.clientErrorPayload);
    }
    return res.status(txnError.statusCode || 500).json({
      success: false,
      status: txnError.statusCode || 500,
      error: txnError.message || "Amount transfer update failed",
      message: txnError.message || "Amount transfer update failed",
      details: txnError.details ?? txnError.message,
      type: txnError.responseType || "error",
    });
  }

  return res.status(response.status).json(response);
}

module.exports = {
  amountTransferCreate,
  amountTransferUpdate,
};
