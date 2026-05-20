const mongoose = require("mongoose");
const Assets = require("../models/assets");
const Transaction = require("../models/transaction");
const {
  handleGenericCreate,
  handleGenericUpdate,
  coalesceObjectId,
  activeNotDeletedCriteria,
} = require("../utils/modelHelper");
const {
  createTransactionsFromItems: transactionBulkCreate,
} = require("./transaction");
const {
  logRollbackFailure,
  serializeErrorForLog,
} = require("../utils/logControllerError");
const { generateTransactionNumber } = require("../utils/transactionNumber");
const {
  isMongoTransactionUnsupportedError,
} = require("../utils/mongoTransactionSupport");

function pickObjectId(value) {
  if (value && typeof value === "object" && value._id) return value._id;
  return value;
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

async function throwAssetsGlBulkFailed(_req, failed) {
  const msg = `Post-assets transaction bulk insert failed: ${JSON.stringify(
    failed,
  )}`;
  const err = new Error(msg);
  err.statusCode = 400;
  err.details = failed;
  err.responseType = "transaction_bulk";
  throw err;
}

function assetLogContext(req, extra = {}) {
  return {
    asset_id: req.params?.id,
    name: req.body?.name,
    amount: req.body?.amount,
    asset_type: req.body?.asset_type,
    account_id: pickObjectId(req.body?.account_id) ?? req.body?.account_id,
    user_id: pickObjectId(req.body?.user_id) ?? req.body?.user_id,
    company_id:
      pickObjectId(req.body?.company_id) ?? pickObjectId(req?.user?.company_id),
    transaction_number: req.body?.transaction_number,
    ...extra,
  };
}

function resolveAssetTransactionNumber(record, assetReq = null) {
  const existing =
    record?.transaction_number ?? assetReq?.body?.transaction_number;
  if (existing != null && String(existing).trim() !== "") {
    return String(existing).trim();
  }
  return generateTransactionNumber({
    includeDate: true,
    includeTime: true,
  });
}

function companyObjFromReq(assetReq) {
  return (
      assetReq?.user?.company_id &&
      typeof assetReq.user.company_id === "object"
    ) ?
      assetReq.user.company_id
    : {};
}

async function softDeleteAssetGlRows(assetReq, assetId, session = null) {
  if (!assetId) return { modifiedCount: 0 };

  const softDeleteSet = { deletedAt: new Date(), status: "inactive" };
  const uid = pickObjectId(assetReq?.user?._id);
  if (uid) softDeleteSet.updated_by = uid;

  return Transaction.updateMany(
    {
      "reference_id.module": "assets",
      "reference_id.ref_id": assetId,
      ...activeNotDeletedCriteria(),
    },
    { $set: softDeleteSet },
    session ? { session } : {},
  );
}

async function postAssetGlTransactions(
  record,
  assetReq,
  transaction_number,
  sess,
) {
  const companyObj = companyObjFromReq(assetReq);
  const items = buildAssetsGlItems(record, transaction_number, companyObj);
  if (record?.createdAt) {
    items.forEach((row) => {
      row.createdAt = record.createdAt;
    });
  }

  const { created, failed } = await transactionBulkCreate(assetReq, items, {
    stopOnError: true,
    session: sess,
  });

  if (failed.length) {
    await throwAssetsGlBulkFailed(assetReq, failed);
  }
  if (created.length) {
    console.log(
      "✅ Asset transaction(s) created:",
      created.map((c) => c.data?._id),
    );
  }
}

/** Soft-delete asset + any GL rows when Mongo txn is unavailable (compensating rollback). */
async function rollbackAssetSave(assetId, assetReq, session = null) {
  if (!assetId) return;

  const softDeleteSet = { deletedAt: new Date(), status: "inactive" };
  const uid = pickObjectId(assetReq?.user?._id);
  if (uid) softDeleteSet.updated_by = uid;

  const sessionOpts = session ? { session } : {};

  await Assets.updateOne(
    { _id: assetId },
    { $set: softDeleteSet },
    sessionOpts,
  );

  const glResult = await Transaction.updateMany(
    {
      "reference_id.module": "assets",
      "reference_id.ref_id": assetId,
      ...activeNotDeletedCriteria(),
    },
    { $set: softDeleteSet },
    sessionOpts,
  );

  console.warn(
    `⚠️ Assets save compensating rollback: asset ${assetId}, GL rows soft-deleted: ${glResult.modifiedCount}`,
  );
}

/**
 * Buy: debit purchase (asset cost), credit cash/bank (`account_id`).
 * Sell: debit cash/bank (`account_id`), credit sales.
 */
function buildAssetsGlItems(record, transaction_number, companyObj) {
  const companyId = pickObjectId(record?.company_id);
  const amount = Number(record?.amount ?? 0);
  const cashAccountId = pickObjectId(record?.account_id);
  const assetType = String(record?.asset_type || "")
    .trim()
    .toLowerCase();
  const isBuy = assetType === "buy";
  const isSell = assetType === "sell";

  if (!Number.isFinite(amount) || amount <= 0) {
    const err = new Error("Asset amount must be greater than zero");
    err.statusCode = 400;
    throw err;
  }
  if (!cashAccountId) {
    const err = new Error("account_id is required for GL posting");
    err.statusCode = 400;
    throw err;
  }
  if (!isBuy && !isSell) {
    const err = new Error('asset_type must be "buy" or "sell"');
    err.statusCode = 400;
    throw err;
  }

  const fixedAssetAccountId = pickObjectId(companyObj?.default_fixed_asset_account);

  const label = record?.name ? String(record.name).trim() : "Asset";
  const description = `Asset ${assetType} - ${label}`;

  const base = {
    company_id: companyId,
    amount,
    reference_user_id: pickObjectId(record?.user_id),
    transaction_number,
    description,
    reference_id: {
      module: "assets",
      ref_id: record._id,
    },
  };

  if (!fixedAssetAccountId) {
    const err = new Error(
      "Company default_fixed_asset_account is required to post asset transactions",
    );
    err.statusCode = 400;
    throw err;
  }

  if (isBuy) {
    return [
      { ...base, account_id: fixedAssetAccountId, type: "debit" },
      { ...base, account_id: cashAccountId, type: "credit" },
    ];
  }

  return [
    { ...base, account_id: cashAccountId, type: "debit" },
    { ...base, account_id: fixedAssetAccountId, type: "credit" },
  ];
}

async function assetsSave(req, res) {
  if (!req.body || typeof req.body !== "object") {
    return res.status(400).json({
      success: false,
      status: 400,
      error: "Request body is required",
    });
  }

  if (req.user?._id && !req.body.user_id) {
    req.body.user_id = req.user._id;
  }

  const tenantCo = coalesceObjectId(req.user?.company_id);
  if (tenantCo) {
    req.body.company_id = tenantCo;
  }

  const transaction_number = generateTransactionNumber({
    includeDate: true,
    includeTime: true,
  });
  req.body.transaction_number = transaction_number;

  let response = null;
  let txnError = null;
  let session = null;

  const runCreateFlow = async (mongoSession) => {
    response = await handleGenericCreate(req, "assets", {
      ...(mongoSession ? { session: mongoSession } : {}),
      afterCreate: async (record, assetReq, sess) => {
        try {
          await postAssetGlTransactions(
            record,
            assetReq,
            transaction_number,
            sess,
          );
        } catch (glErr) {
          if (!sess && record?._id) {
            await rollbackAssetSave(record._id, assetReq, null);
          }
          throw glErr;
        }
      },
    });

    if (!response?.success || !response?.data) {
      throwWithGenericFailure(response, "Asset create failed");
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
    console.error("❌ assetsSave failed:\n", serializeErrorForLog(txnError));

    await logRollbackFailure(req, txnError, {
      action: "ASSETS SAVE ROLLBACK",
      tags: ["assets", "save", "error"],
      fallbackUrl: "/api/assets/save",
      context: {
        transaction_number: req.body?.transaction_number,
        asset_type: req.body?.asset_type,
        account_id: pickObjectId(req.body?.account_id) ?? req.body?.account_id,
        amount: req.body?.amount,
        user_id: pickObjectId(req.body?.user_id) ?? req.body?.user_id,
        company_id: pickObjectId(req.body?.company_id) ?? req.body?.company_id,
        asset_id:
          txnError?.clientErrorPayload?.data?._id ??
          response?.data?._id ??
          null,
        gl_failed: txnError?.details ?? null,
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
      error: txnError.message || "Asset save failed",
      message: txnError.message || "Asset save failed",
      details: txnError.details ?? txnError.message,
      type: txnError.responseType || "internal",
    });
  }

  return res.status(response.status).json(response);
}

async function assetsUpdate(req, res) {
  if (!req.body || typeof req.body !== "object") {
    return res.status(400).json({
      success: false,
      status: 400,
      error: "Request body is required",
    });
  }

  const tenantCo = coalesceObjectId(req.user?.company_id);
  const updateFilter = { deletedAt: null, status: "active" };
  if (tenantCo) {
    updateFilter.company_id = tenantCo;
  }

  let response = null;
  let txnError = null;
  let session = null;

  const runUpdateFlow = async (mongoSession) => {
    response = await handleGenericUpdate(req, "assets", {
      ...(mongoSession ? { session: mongoSession } : {}),
      filter: updateFilter,
      excludeFields: ["password"],
      beforeUpdate: async (_updateData, updateReq, existingRecord) => {
        updateReq._assetPriorSnapshot = existingRecord ?
          {
            transaction_number: existingRecord.transaction_number,
            amount: existingRecord.amount,
            asset_type: existingRecord.asset_type,
            account_id: existingRecord.account_id,
          }
        : null;
      },
      afterUpdate: async (record, assetReq, _existing, sess) => {
        const assetId = record?._id;
        const glDelete = await softDeleteAssetGlRows(assetReq, assetId, sess);
        if (glDelete.modifiedCount > 0) {
          console.log(
            "✅ Asset GL rows soft-deleted:",
            glDelete.modifiedCount,
          );
        }

        const transaction_number = resolveAssetTransactionNumber(
          record,
          assetReq,
        );
        if (!record.transaction_number) {
          record.transaction_number = transaction_number;
          await Assets.updateOne(
            { _id: assetId },
            { $set: { transaction_number } },
            sess ? { session: sess } : {},
          );
        }

        await postAssetGlTransactions(
          record,
          assetReq,
          transaction_number,
          sess,
        );
      },
    });

    if (!response?.success || !response?.data) {
      throwWithGenericFailure(response, "Asset update failed");
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
    console.error("❌ assetsUpdate failed:\n", serializeErrorForLog(txnError));

    await logRollbackFailure(req, txnError, {
      action: "ASSETS UPDATE ROLLBACK",
      tags: ["assets", "update", "error"],
      fallbackUrl: `/api/assets/update/${req.params?.id || ""}`,
      context: assetLogContext(req, {
        prior: req._assetPriorSnapshot ?? null,
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
      error: txnError.message || "Asset update failed",
      message: txnError.message || "Asset update failed",
      details: txnError.details ?? txnError.message,
      type: txnError.responseType || "internal",
    });
  }

  return res.status(response.status).json(response);
}

module.exports = {
  assetsSave,
  assetsUpdate,
};
