const mongoose = require("mongoose");
const {
  handleGenericCreate,
  handleGenericUpdate,
  handleGenericGetAll,
  parseSearchFieldsFromQuery,
  applyIncludeExcludeIdQueryFilter,
  coalesceObjectId,
} = require("../utils/modelHelper");
const Transaction = require("../models/transaction");
const Company = require("../models/company");
const AccountModel = require("../models/account");
const {
  logControllerError,
  logRollbackFailure,
  serializeErrorForLog,
} = require("../utils/logControllerError");
const { isMongoTransactionUnsupportedError } = require("../utils/mongoTransactionSupport");
const { generateTransactionNumber } = require("../utils/transactionNumber");
const {
  createTransactionsFromItems: transactionBulkCreate,
} = require("./transaction");
const {
  computeBalanceSheetDifference,
  computeBalanceSheetReport,
} = require("../utils/balanceSheetReconcile");

const ACCOUNT_TRANSACTION_ERROR_LOG = {
  action: "POST ACCOUNT TRANSACTION ERROR",
  tags: [
    "api",
    "account",
    "transaction",
    "error",
    "insert",
    "update",
    "delete",
  ],
  fallbackUrl: "/api/account",
};

function throwWithGenericFailure(response, fallbackMessage) {
  const err = new Error(
    response?.error || response?.message || fallbackMessage || "Request failed",
  );
  err.statusCode = response?.status || 400;
  err.responseType = response?.type || "validation";
  err.details = response?.details ?? response?.missing ?? response;
  err.clientErrorPayload = response;
  throw err;
}

function throwAccountGlBulkFailed(failed) {
  const err = new Error(
    `Post-account opening balance GL failed: ${JSON.stringify(failed)}`,
  );
  err.statusCode = 400;
  err.details = failed;
  err.responseType = "transaction_bulk";
  throw err;
}

function accountCustomCreateLogContext(req, extra = {}) {
  return {
    account_name: req.body?.name,
    account_type: req.body?.account_type,
    initial_balance: req.body?.initial_balance,
    company_id: coalesceObjectId(req.user?.company_id) ?? req.body?.company_id,
    user_id: toObjectId(req.user?._id),
    ...extra,
  };
}

function accountCustomUpdateLogContext(req, extra = {}) {
  return {
    account_id: req.params?.id ?? null,
    account_name: req.body?.name,
    account_type: req.body?.account_type,
    initial_balance: req.body?.initial_balance,
    company_id: coalesceObjectId(req.user?.company_id) ?? req.body?.company_id,
    user_id: toObjectId(req.user?._id),
    ...extra,
  };
}

function glSoftDeleteSet(req) {
  const softDeleteSet = { deletedAt: new Date(), status: "inactive" };
  const uid = toObjectId(req.user?._id);
  if (uid) softDeleteSet.updated_by = uid;
  return softDeleteSet;
}

/** Opening-balance journal lines for asset / liability accounts (empty if not applicable or zero balance). */
function buildOpeningBalanceGlItems(record, transcReq, transaction_number) {
  const openingRaw = Number(record?.initial_balance ?? 0);
  if (Number.isNaN(openingRaw) || openingRaw === 0) {
    return { items: [], equityRequired: false, openingRaw: 0 };
  }

  const amount = makeNumberPositive(openingRaw);
  const posting = {
    company_id: record.company_id,
    user_id: transcReq.user._id,
    description: "Account Initial Balance",
    amount,
    transaction_number,
  };

  const items = [];
  if (
    record?.account_type == "current_asset" ||
    record?.account_type == "fixed_asset"
  ) {
    items.push({
      ...posting,
      account_id: record._id,
      type: record?.initial_balance >= 0 ? "debit" : "credit",
    });
    return { items, equityRequired: true, openingRaw };
  }
  if (
    record?.account_type === "current_liability" ||
    record?.account_type === "long_term_liability" ||
    record?.account_type === "short_term_liability"
  ) {
    items.push({
      ...posting,
      account_id: record._id,
      type: record?.initial_balance >= 0 ? "credit" : "debit",
    });
    return { items, equityRequired: true, openingRaw };
  }
  return { items: [], equityRequired: false, openingRaw };
}

async function postOpeningBalanceGl(
  record,
  transcReq,
  transaction_number,
  bulkSession,
  strictGl,
) {
  const built = buildOpeningBalanceGlItems(record, transcReq, transaction_number);
  if (!built.items.length) {
    return;
  }

  const equityAccountId = await resolveDefaultEquityAccountId(
    record,
    transcReq,
    bulkSession,
  );

  if (!equityAccountId) {
    const msg =
      "Opening balance journal requires a default equity account for this company";
    if (strictGl) {
      const err = new Error(msg);
      err.statusCode = 400;
      err.responseType = "equity_account_missing";
      throw err;
    }
    console.warn(`⚠️ Skipping opening balance journal: ${msg}`);
    return;
  }
  if (String(equityAccountId) === String(record._id)) {
    return;
  }

  if (!transcReq.user?._id) {
    const msg = "Opening balance journal requires an authenticated user (user_id)";
    if (strictGl) {
      const err = new Error(msg);
      err.statusCode = 400;
      err.responseType = "user_missing";
      throw err;
    }
    console.warn(`⚠️ Skipping opening balance journal: ${msg}`);
    return;
  }

  const openingRaw = built.openingRaw;
  const amount = makeNumberPositive(openingRaw);
  const posting = {
    company_id: record.company_id,
    user_id: transcReq.user._id,
    description: "Account Initial Balance",
    amount,
    transaction_number,
  };

  built.items.push({
    ...posting,
    account_id: equityAccountId,
    type:
      record?.account_type == "current_asset" ||
      record?.account_type == "fixed_asset" ?
        openingRaw >= 0 ?
          "credit"
        : "debit"
      : openingRaw >= 0 ?
        "debit"
      : "credit",
  });

  const { created, failed } = await transactionBulkCreate(
    transcReq,
    built.items,
    {
      stopOnError: true,
      ...(bulkSession ? { session: bulkSession } : {}),
    },
  );

  if (failed.length) {
    console.error("⚠️ Post-account transaction bulk insert failed:", failed);
    if (strictGl) {
      throwAccountGlBulkFailed(failed);
    }
    await logControllerError(
      transcReq,
      `Post-account transaction bulk insert failed: ${JSON.stringify(failed)}`,
      ACCOUNT_TRANSACTION_ERROR_LOG,
    );
    return;
  }

  if (created[0]?.data?._id) {
    console.log(
      "✅ Transaction(s) created:",
      created.map((c) => c.data._id),
    );
  }
}

async function softDeleteGlByTransactionNumber(
  transaction_number,
  companyId,
  req,
  session = null,
) {
  const txnNum = String(transaction_number || "").trim();
  if (!txnNum) return;

  const opts = session ? { session } : {};
  const filter = { transaction_number: txnNum, deletedAt: null };
  const coId = coalesceObjectId(companyId);
  if (coId) filter.company_id = coId;

  await Transaction.updateMany(filter, { $set: glSoftDeleteSet(req) }, opts);
}

async function rollbackAccountCustomCreate(
  accountId,
  transactionNumber,
  req,
  session = null,
) {
  const opts = session ? { session } : {};
  const softDeleteSet = { deletedAt: new Date(), status: "inactive" };
  const uid = toObjectId(req.user?._id);
  if (uid) softDeleteSet.updated_by = uid;
  const companyId = coalesceObjectId(req.user?.company_id);

  if (transactionNumber) {
    const txnFilter = {
      transaction_number: String(transactionNumber).trim(),
      deletedAt: null,
    };
    if (companyId) txnFilter.company_id = companyId;
    await Transaction.updateMany(txnFilter, { $set: softDeleteSet }, opts);
  }

  const accountOid = toObjectId(accountId);
  if (accountOid) {
    const acctFilter = { _id: accountOid, deletedAt: null };
    if (companyId) acctFilter.company_id = companyId;
    await AccountModel.updateOne(acctFilter, { $set: softDeleteSet }, opts);
  }

  console.warn(
    `⚠️ account custom-create compensating rollback: account=${accountId}, txn=${transactionNumber}`,
  );
}

async function captureAccountUpdateSnapshots(req, session, tracker) {
  const accountId = req.params?.id;
  const accountOid = toObjectId(accountId);
  if (!accountOid) {
    const err = new Error("Invalid account id");
    err.statusCode = 400;
    throw err;
  }

  tracker.accountId = accountOid;
  let acctQ = AccountModel.findOne({ _id: accountOid, deletedAt: null }).lean();
  if (session) acctQ = acctQ.session(session);
  tracker.accountBefore = await acctQ;
  if (!tracker.accountBefore) {
    const err = new Error("Account not found");
    err.statusCode = 404;
    throw err;
  }

  tracker.transaction_number = tracker.accountBefore.transaction_number;
  if (tracker.transaction_number) {
    const txnFilter = {
      transaction_number: String(tracker.transaction_number).trim(),
      deletedAt: null,
    };
    const companyId = coalesceObjectId(
      tracker.accountBefore.company_id || req.user?.company_id,
    );
    if (companyId) txnFilter.company_id = companyId;

    let txnQ = Transaction.find(txnFilter).lean();
    if (session) txnQ = txnQ.session(session);
    tracker.transactionsBefore = await txnQ;
  } else {
    tracker.transactionsBefore = [];
  }
}

async function rollbackAccountCustomUpdate(tracker, req, session = null) {
  const opts = session ? { session } : {};
  const companyId = coalesceObjectId(
    tracker.accountBefore?.company_id || req.user?.company_id,
  );

  const txnNum = tracker.transaction_number;
  if (txnNum) {
    await softDeleteGlByTransactionNumber(
      txnNum,
      companyId,
      req,
      session,
    );

    for (const row of tracker.transactionsBefore || []) {
      if (!row?._id) continue;
      const restoreDoc = {
        ...row,
        deletedAt: null,
        status: row.status || "active",
      };
      await Transaction.replaceOne({ _id: row._id }, restoreDoc, {
        upsert: true,
        ...opts,
      });
    }
  }

  if (tracker.accountBefore && tracker.accountId) {
    const { _id, __v, createdAt, updatedAt, ...rest } = tracker.accountBefore;
    const acctFilter = { _id: tracker.accountId };
    if (companyId) acctFilter.company_id = companyId;
    await AccountModel.updateOne(acctFilter, { $set: rest }, opts);
  }

  console.warn(
    `⚠️ account custom-update compensating rollback: account=${tracker.accountId}, txn=${txnNum}`,
  );
}

async function runAccountWithOptionalTransaction(runFlow) {
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

/** Must match `models/account.js` account_type enum */
const ACCOUNT_TYPES = new Set([
  "current_asset",
  "fixed_asset",
  "revenue",
  "cost_of_goods_sold_account",
  "operating_expense",
  "other_expense",
  "equity",
  "current_liability",
  "long_term_liability",
  "other",
]);

function makeNumberPositive(number) {
  return Math.abs(number);
}

function toObjectId(value) {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (typeof value === "object" && value._id) {
    return toObjectId(value._id);
  }
  const s = String(value);
  return mongoose.Types.ObjectId.isValid(s) ?
      new mongoose.Types.ObjectId(s)
    : null;
}

/** Per-account GL line totals (same debit/credit convention as transaction list summary). */
async function aggregateTransactionSumsByAccountIds(accountIds, companyId) {
  if (!accountIds.length) return new Map();

  const match = {
    account_id: { $in: accountIds },
    deletedAt: null,
  };
  const coId = toObjectId(companyId);
  if (coId) match.company_id = coId;

  const rows = await Transaction.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$account_id",
        total_debit: {
          $sum: {
            $cond: [{ $eq: ["$type", "debit"] }, "$amount", 0],
          },
        },
        total_credit: {
          $sum: {
            $cond: [{ $eq: ["$type", "credit"] }, "$amount", 0],
          },
        },
        line_count: { $sum: 1 },
      },
    },
  ]);

  const map = new Map();
  for (const row of rows) {
    const totalDebit = Number((row.total_debit ?? 0).toFixed(2));
    const totalCredit = Number((row.total_credit ?? 0).toFixed(2));
    map.set(String(row._id), {
      total_debit: totalDebit,
      total_credit: totalCredit,
      line_count: row.line_count ?? 0,
      net_debit_minus_credit: Number((totalDebit - totalCredit).toFixed(2)),
      credit_minus_debit: Number((totalCredit - totalDebit).toFixed(2)),
    });
  }
  return map;
}

/**
 * Equity leg for opening-balance journals: populated company, DB default, or first equity GL.
 */
async function resolveDefaultEquityAccountId(record, transcReq, session = null) {
  const populatedCompany = transcReq.user?.company_id;
  if (populatedCompany && typeof populatedCompany === "object") {
    const id = populatedCompany.default_equity_account_id;
    if (id) return id;
  }
  if (record.company_id) {
    let compQ = Company.findById(record.company_id)
      .select("default_equity_account_id")
      .lean();
    if (session) compQ = compQ.session(session);
    const comp = await compQ;
    if (comp?.default_equity_account_id) return comp.default_equity_account_id;
  }
  if (!record.company_id) return null;
  let eqQ = AccountModel.findOne({
    company_id: record.company_id,
    account_type: "equity",
    status: "active",
    deletedAt: null,
  })
    .sort({ createdAt: 1 })
    .lean();
  if (session) eqQ = eqQ.session(session);
  const eq = await eqQ;
  return eq?._id ?? null;
}

/**
 * Same behavior as HTTP `accountCreate` but returns the generic-create response
 * (for internal callers such as company signup that are not Express handlers).
 */
async function performAccountCreate(req, comp_create = false, options = {}) {
  const session = options.session || null;
  const strictGl = Boolean(session || options.strictGl);
  console.log("🔐 Processing account creation...", req.user);
  const transaction_number = generateTransactionNumber();

  req.body.transaction_number = transaction_number;
  req.body.is_editable = true;

  if (comp_create == true) {
    req.body.is_deletable = false;
    req.body.is_editable = req.body.name == "Cash" ? true : false;
  }

  return handleGenericCreate(req, "account", {
    ...(session ? { session } : {}),
    skipFailureLog: options.skipFailureLog,
    beforeCreate: async (record, transcReq) => {
      console.log("🔍 Before Create_account", record);
    },
    afterCreate: async (record, transcReq, sess) => {
      console.log("✅ Record created successfully:", record);
      if (options.tracker) {
        options.tracker.accountId = record._id;
        options.tracker.transaction_number = transaction_number;
      }

      await postOpeningBalanceGl(
        record,
        transcReq,
        transaction_number,
        sess || session,
        strictGl,
      );
    },
  });
}

/**
 * HTTP `POST /api/account/custom-create` — account + opening GL in one atomic unit.
 */
async function runAccountCustomCreateBody(req, session, tracker) {
  const txnOpts = {
    strictGl: true,
    tracker,
    ...(session ? { session } : {}),
  };
  tracker.create_step = "account";

  const response = await performAccountCreate(req, false, txnOpts);

  if (!response?.success || !response?.data?._id) {
    throwWithGenericFailure(response, "Account create failed");
  }

  tracker.accountId = response.data._id;
  tracker.transaction_number =
    response.data.transaction_number || req.body.transaction_number;
  tracker.create_step = "complete";
  return response;
}

async function accountCreate(req, res, comp_create = false) {
  if (comp_create) {
    const response = await performAccountCreate(req, true);
    return res.status(response.status).json(response);
  }

  const tracker = {
    create_step: "init",
    accountId: null,
    transaction_number: req.body?.transaction_number ?? null,
  };
  let response = null;

  const txnError = await runAccountWithOptionalTransaction(async (session) => {
      try {
        response = await runAccountCustomCreateBody(req, session, tracker);
      } catch (stepError) {
        if (
          !session &&
          (tracker.accountId || tracker.transaction_number)
        ) {
          await rollbackAccountCustomCreate(
            tracker.accountId,
            tracker.transaction_number,
            req,
            null,
          );
        }
        throw stepError;
      }
    },
  );

  if (txnError) {
    console.error(
      "❌ accountCreate failed:\n",
      serializeErrorForLog(txnError),
    );
    await logRollbackFailure(req, txnError, {
      action: "ACCOUNT CUSTOM CREATE ROLLBACK",
      tags: ["account", "custom-create", "error"],
      fallbackUrl: req.originalUrl || "/api/account/custom-create",
      context: accountCustomCreateLogContext(req, {
        create_step: tracker.create_step,
        account_id: tracker.accountId,
        transaction_number: tracker.transaction_number,
        execution_mode:
          isMongoTransactionUnsupportedError(txnError) ?
            "no_mongodb_transaction_compensating_rollback"
          : "mongodb_transaction_aborted",
        api_client_error: txnError.clientErrorPayload ?? null,
        gl_failed: txnError.details ?? null,
      }),
      fallbackCompanyId: req.user?.company_id,
    });

    if (txnError.clientErrorPayload) {
      return res
        .status(txnError.clientErrorPayload.status || txnError.statusCode || 400)
        .json(txnError.clientErrorPayload);
    }
    return res.status(txnError.statusCode || 500).json({
      success: false,
      message: txnError.message || "Account create failed",
      details: txnError.details ?? undefined,
      type: txnError.responseType || "internal",
    });
  }

  return res.status(response?.status || 201).json(response);
}

/**
 * Account update + replace opening-balance GL (shared by HTTP custom-update).
 */
async function performAccountUpdate(req, options = {}) {
  const session = options.session || null;
  const strictGl = Boolean(session || options.strictGl);

  return handleGenericUpdate(req, "account", {
    ...(session ? { session } : {}),
    excludeFields: ["password"],
    beforeUpdate: async (updateData, transcReq, existingRecord) => {
      console.log("🔧 Processing account update...", {
        accountId: existingRecord._id,
        updateFields: Object.keys(updateData),
      });
    },
    afterUpdate: async (record, transcReq, existingRecord, sess) => {
      console.log("✅ Record updated successfully:", record);
      const bulkSession = sess || session;

      if (options.tracker) {
        options.tracker.accountId = record._id;
        options.tracker.transaction_number = record?.transaction_number;
      }

      const transaction_number = record?.transaction_number;
      if (!transaction_number) {
        const openingRaw = Number(record?.initial_balance ?? 0);
        if (strictGl && openingRaw !== 0) {
          const err = new Error(
            "Account update with non-zero initial_balance requires transaction_number for GL",
          );
          err.statusCode = 400;
          err.responseType = "transaction_number_missing";
          throw err;
        }
        return;
      }

      await softDeleteGlByTransactionNumber(
        transaction_number,
        record.company_id,
        transcReq,
        bulkSession,
      );

      await postOpeningBalanceGl(
        record,
        transcReq,
        transaction_number,
        bulkSession,
        strictGl,
      );
    },
  });
}

async function runAccountCustomUpdateBody(req, session, tracker) {
  tracker.update_step = "snapshot";
  await captureAccountUpdateSnapshots(req, session, tracker);

  tracker.update_step = "account_and_gl";
  const txnOpts = {
    strictGl: true,
    tracker,
    ...(session ? { session } : {}),
  };

  const response = await performAccountUpdate(req, txnOpts);

  if (!response?.success) {
    throwWithGenericFailure(response, "Account update failed");
  }

  tracker.update_step = "complete";
  return response;
}

async function accountUpdate(req, res) {
  const tracker = {
    update_step: "init",
    accountId: null,
    accountBefore: null,
    transactionsBefore: [],
    transaction_number: null,
  };
  let response = null;

  const txnError = await runAccountWithOptionalTransaction(async (session) => {
    try {
      response = await runAccountCustomUpdateBody(req, session, tracker);
    } catch (stepError) {
      if (
        !session &&
        (tracker.accountBefore || tracker.transactionsBefore?.length)
      ) {
        await rollbackAccountCustomUpdate(tracker, req, null);
      }
      throw stepError;
    }
  });

  if (txnError) {
    console.error(
      "❌ accountUpdate failed:\n",
      serializeErrorForLog(txnError),
    );
    await logRollbackFailure(req, txnError, {
      action: "ACCOUNT CUSTOM UPDATE ROLLBACK",
      tags: ["account", "custom-update", "error"],
      fallbackUrl: req.originalUrl || "/api/account/custom-update",
      context: accountCustomUpdateLogContext(req, {
        update_step: tracker.update_step,
        account_id: tracker.accountId,
        transaction_number: tracker.transaction_number,
        prior_gl_line_count: tracker.transactionsBefore?.length ?? 0,
        execution_mode:
          isMongoTransactionUnsupportedError(txnError) ?
            "no_mongodb_transaction_compensating_rollback"
          : "mongodb_transaction_aborted",
        api_client_error: txnError.clientErrorPayload ?? null,
        gl_failed: txnError.details ?? null,
      }),
      fallbackCompanyId: req.user?.company_id,
    });

    if (txnError.clientErrorPayload) {
      return res
        .status(txnError.clientErrorPayload.status || txnError.statusCode || 400)
        .json(txnError.clientErrorPayload);
    }
    return res.status(txnError.statusCode || 500).json({
      success: false,
      message: txnError.message || "Account update failed",
      details: txnError.details ?? undefined,
      type: txnError.responseType || "internal",
    });
  }

  return res.status(response?.status || 200).json(response);
}

function truthyQuery(v) {
  if (v === true || v === 1) return true;
  const s = String(v ?? "")
    .trim()
    .toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

/** Comma-separated or repeated query values → valid ObjectIds. */
function parseObjectIdList(raw) {
  if (raw == null || raw === "") return [];
  const parts = Array.isArray(raw) ? raw : String(raw).split(",");
  return parts.map((p) => toObjectId(String(p).trim())).filter(Boolean);
}

async function resolveCompanyDefaultReceivableId(user) {
  const coRaw = user?.company_id;
  if (!coRaw) return null;
  if (
    typeof coRaw === "object" &&
    coRaw.default_account_receivable_account != null
  ) {
    return toObjectId(coRaw.default_account_receivable_account);
  }
  const companyId = toObjectId(coRaw);
  if (!companyId) return null;
  const row = await Company.findById(companyId)
    .select("default_account_receivable_account")
    .lean();
  return toObjectId(row?.default_account_receivable_account);
}

async function resolveCompanyDefaultDiscountAccountIds(user, companyId) {
  const coRaw = user?.company_id;
  let salesDiscountId = null;
  let purchaseDiscountId = null;

  if (coRaw && typeof coRaw === "object") {
    salesDiscountId = toObjectId(coRaw.default_sales_discount_account);
    purchaseDiscountId = toObjectId(coRaw.default_purchase_discount_account);
  }

  const cid = toObjectId(companyId) || toObjectId(coRaw);
  if (cid && (!salesDiscountId || !purchaseDiscountId)) {
    const row = await Company.findById(cid)
      .select(
        "default_sales_discount_account default_purchase_discount_account",
      )
      .lean();
    if (!salesDiscountId) {
      salesDiscountId = toObjectId(row?.default_sales_discount_account);
    }
    if (!purchaseDiscountId) {
      purchaseDiscountId = toObjectId(row?.default_purchase_discount_account);
    }
  }

  return {
    companyId: cid,
    salesDiscountId,
    purchaseDiscountId,
  };
}

const EMPTY_TRANSACTIONS_SUM = {
  total_debit: 0,
  total_credit: 0,
  line_count: 0,
  net_debit_minus_credit: 0,
  credit_minus_debit: 0,
};

/** Sales discount posts as debit; purchase discount posts as credit. */
function discountAmountFromGlSums(transactionsSum, role) {
  if (!transactionsSum) return 0;
  if (role === "sales_discount") {
    return transactionsSum.net_debit_minus_credit;
  }
  return transactionsSum.credit_minus_debit;
}

function buildDiscountAccountPayload(
  accountId,
  accountMeta,
  transactionsSum,
  role,
) {
  const sums = transactionsSum ?? { ...EMPTY_TRANSACTIONS_SUM };
  return {
    account_id: accountId ? String(accountId) : null,
    account_name: accountMeta?.name ?? null,
    account_number: accountMeta?.account_number ?? null,
    amount: discountAmountFromGlSums(sums, role),
    transactions_sum: sums,
  };
}

/**
 * GET ?account_type=current_asset
 * Optional: limit, skip, search, searchFields (via handleGenericGetAll).
 * Exclude company default A/R from the list:
 *   ?exclude_default_account_receivable=true
 *   (alias) ?neq_default_account_receivable=true
 * Each account includes `transactions_sum`: debit/credit totals, line_count,
 * `net_debit_minus_credit`, and `credit_minus_debit` for that GL.
 */
async function fetchAccountsByType(req, res) {
  const accountType = String(
    req.query.account_type ?? req.query.type ?? "",
  ).trim();

  if (!accountType) {
    return res.status(400).json({
      success: false,
      message:
        "Query parameter account_type is required (e.g. account_type=current_asset)",
    });
  }

  if (!ACCOUNT_TYPES.has(accountType)) {
    return res.status(400).json({
      success: false,
      message: `Invalid account_type. Allowed values: ${[...ACCOUNT_TYPES].join(", ")}`,
    });
  }

  const filter = {
    account_type: accountType,
    status: "active",
    deletedAt: null,
  };

  const tenantCompanyId = coalesceObjectId(req.user?.company_id);
  if (tenantCompanyId) {
    filter.company_id = tenantCompanyId;
  }

  const excludeDefReceivable =
    truthyQuery(req.query.exclude_default_account_receivable) ||
    truthyQuery(req.query.neq_default_account_receivable);
  if (excludeDefReceivable) {
    const arId = await resolveCompanyDefaultReceivableId(req.user);
    if (arId) {
      const existing = String(req.query.exclude_id ?? "").trim();
      req.query.exclude_id = existing ? `${existing},${arId}` : String(arId);
    }
  }

  const scopedFilter = applyIncludeExcludeIdQueryFilter(filter, req.query);

  const response = await handleGenericGetAll(req, "account", {
    filter: scopedFilter,
    sort: { name: 1 },
    limit: req.query.limit ? parseInt(req.query.limit, 10) : null,
    skip: req.query.skip ? parseInt(req.query.skip, 10) || 0 : 0,
    search: req.query.search,
    searchFields: parseSearchFieldsFromQuery(req.query.searchFields),
  });

  if (!response.success || !Array.isArray(response.data)) {
    return res.status(response.status || 200).json(response);
  }

  const accountObjectIds = response.data
    .map((a) => toObjectId(a._id))
    .filter(Boolean);

  const sumByAccount = await aggregateTransactionSumsByAccountIds(
    accountObjectIds,
    req.user?.company_id,
  );

  const emptySum = {
    total_debit: 0,
    total_credit: 0,
    line_count: 0,
    net_debit_minus_credit: 0,
    credit_minus_debit: 0,
  };

  response.data = response.data.map((acc) => ({
    ...acc,
    transactions_sum: sumByAccount.get(String(acc._id)) ?? { ...emptySum },
  }));

  return res.status(response.status || 200).json(response);
}

function resolveBalanceSheetCompanyId(req) {
  const tenantCo = coalesceObjectId(req.user?.company_id);
  const queryCo = coalesceObjectId(req.query?.company_id);
  const companyId = queryCo || tenantCo;

  if (!companyId || !mongoose.Types.ObjectId.isValid(String(companyId))) {
    return {
      error: {
        status: 400,
        body: {
          success: false,
          status: 400,
          error: "company_id is required",
          message:
            "Provide company_id query param or authenticate with a user that has company_id",
        },
      },
    };
  }

  if (tenantCo && queryCo && String(tenantCo) !== String(queryCo)) {
    return {
      error: {
        status: 403,
        body: {
          success: false,
          status: 403,
          error: "Forbidden",
          message: "company_id does not match authenticated tenant",
        },
      },
    };
  }

  return { companyId };
}

/**
 * GET /api/account/balance-sheet
 * Optional query: company_id (must match authenticated tenant if provided).
 * Returns all balance-sheet sections and totals for UI display.
 */
async function getBalanceSheet(req, res) {
  try {
    const resolved = resolveBalanceSheetCompanyId(req);
    if (resolved.error) {
      return res.status(resolved.error.status).json(resolved.error.body);
    }

    const report = await computeBalanceSheetReport(resolved.companyId);
    if (!report.ok) {
      return res.status(report.status || 400).json({
        success: false,
        status: report.status || 400,
        error: report.error,
      });
    }

    return res.status(200).json({
      success: true,
      status: 200,
      data: report,
    });
  } catch (error) {
    console.error("❌ getBalanceSheet:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      error: error.message || "Failed to build balance sheet report",
    });
  }
}

/**
 * GET /api/account/balance-sheet-difference
 * Optional query: company_id (must match authenticated tenant if provided).
 * Returns assets vs liabilities+equity and the equation difference.
 */
async function getBalanceSheetDifference(req, res) {
  try {
    const resolved = resolveBalanceSheetCompanyId(req);
    if (resolved.error) {
      return res.status(resolved.error.status).json(resolved.error.body);
    }

    const report = await computeBalanceSheetDifference(resolved.companyId);
    if (!report.ok) {
      return res.status(report.status || 400).json({
        success: false,
        status: report.status || 400,
        error: report.error,
      });
    }

    return res.status(200).json({
      success: true,
      status: 200,
      data: report,
    });
  } catch (error) {
    console.error("❌ getBalanceSheetDifference:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      error: error.message || "Failed to compute balance sheet difference",
    });
  }
}

/**
 * GET /api/account/default-discount-sums
 * Sums GL activity on company default sales_discount and purchase_discount accounts.
 * Optional query: company_id (must match authenticated tenant if provided).
 */
async function getCompanyDefaultDiscountSums(req, res) {
  try {
    const resolved = resolveBalanceSheetCompanyId(req);
    if (resolved.error) {
      return res.status(resolved.error.status).json(resolved.error.body);
    }

    const { companyId } = resolved;
    const { salesDiscountId, purchaseDiscountId } =
      await resolveCompanyDefaultDiscountAccountIds(req.user, companyId);

    const accountIds = [salesDiscountId, purchaseDiscountId].filter(Boolean);
    const sumByAccount = await aggregateTransactionSumsByAccountIds(
      accountIds,
      companyId,
    );

    const accountMetaById = new Map();
    if (accountIds.length) {
      const accounts = await AccountModel.find({
        _id: { $in: accountIds },
        company_id: companyId,
        deletedAt: null,
      })
        .select("name account_number")
        .lean();
      for (const acc of accounts) {
        accountMetaById.set(String(acc._id), acc);
      }
    }

    const sales_discount = buildDiscountAccountPayload(
      salesDiscountId,
      salesDiscountId ?
        accountMetaById.get(String(salesDiscountId))
      : null,
      salesDiscountId ?
        sumByAccount.get(String(salesDiscountId))
      : null,
      "sales_discount",
    );
    const purchase_discount = buildDiscountAccountPayload(
      purchaseDiscountId,
      purchaseDiscountId ?
        accountMetaById.get(String(purchaseDiscountId))
      : null,
      purchaseDiscountId ?
        sumByAccount.get(String(purchaseDiscountId))
      : null,
      "purchase_discount",
    );

    const total_discount_amount = Number(
      (sales_discount.amount + purchase_discount.amount).toFixed(2),
    );

    return res.status(200).json({
      success: true,
      status: 200,
      data: {
        company_id: String(companyId),
        sales_discount,
        purchase_discount,
        total_discount_amount,
      },
    });
  } catch (error) {
    console.error("❌ getCompanyDefaultDiscountSums:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      error: error.message || "Failed to compute default discount sums",
    });
  }
}

module.exports = {
  accountCreate,
  performAccountCreate,
  accountUpdate,
  fetchAccountsByType,
  getBalanceSheet,
  getBalanceSheetDifference,
  getCompanyDefaultDiscountSums,
};
