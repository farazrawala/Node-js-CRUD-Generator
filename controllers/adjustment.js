const mongoose = require("mongoose");
const Adjustment = require("../models/adjustment");
const Account = require("../models/account");
const Company = require("../models/company");
const Warehouse = require("../models/warehouse");
const { performAccountCreate } = require("./account");
const Product = require("../models/product");
const Transaction = require("../models/transaction");
const InventoryMovements = require("../models/inventory_movements");
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
const { runInventoryMovementTxnBody } = require("./inventory_movements");

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

/** GL accounts must be readable inside the same Mongo session as transaction inserts. */
async function verifyGlAccountIds(
  companyId,
  adjustmentAccountId,
  equityAccountId,
  session = null,
) {
  const tenantId = toMongoObjectId(companyId);
  const checks = [
    { id: adjustmentAccountId, label: "adjustment" },
    { id: equityAccountId, label: "equity" },
  ];

  for (const { id, label } of checks) {
    const accountId = toMongoObjectId(id);
    if (!accountId) {
      const err = new Error(`Invalid ${label} account id for GL posting`);
      err.statusCode = 400;
      throw err;
    }
    let q = Account.findById(accountId).select("company_id status deletedAt");
    if (session) q = q.session(session);
    const acc = await q.lean();
    if (!acc) {
      const err = new Error(
        `${label} account not found for GL posting (id=${accountId}). ` +
          "If this account was just created, retry inside the same transaction.",
      );
      err.statusCode = 400;
      throw err;
    }
    if (String(acc.company_id) !== String(tenantId)) {
      const err = new Error(`${label} account does not belong to this company`);
      err.statusCode = 400;
      throw err;
    }
    if (acc.status !== "active" || acc.deletedAt) {
      const err = new Error(`${label} account is not active`);
      err.statusCode = 400;
      throw err;
    }
  }
}

function companyObjFromReq(adjustmentReq) {
  return (
      adjustmentReq?.user?.company_id &&
        typeof adjustmentReq.user.company_id === "object"
    ) ?
      adjustmentReq.user.company_id
    : {};
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

function tagAdjustmentFailure(err, step) {
  if (err && typeof err === "object" && !err.adjustmentFailureStep) {
    err.adjustmentFailureStep = step;
  }
  return err;
}

function adjustmentLogContext(req, extra = {}) {
  return {
    adjustment_id: req.params?.id ?? null,
    product_id: pickObjectId(req.body?.product_id) ?? req.body?.product_id,
    quantity: req.body?.quantity,
    type: req.body?.type,
    warehouse_id:
      pickObjectId(req.body?.warehouse_id) ?? req.body?.warehouse_id,
    transaction_number: req.body?.transaction_number,
    company_id:
      pickObjectId(req.body?.company_id) ?? pickObjectId(req?.user?.company_id),
    user_id: pickObjectId(req.user?._id),
    ...extra,
  };
}

function adjustmentTransactionNumber(record, req = null) {
  const existing = record?.transaction_number ?? req?.body?.transaction_number;
  if (existing != null && String(existing).trim() !== "") {
    return String(existing).trim();
  }
  return generateTransactionNumber({
    includeDate: true,
    includeTime: true,
  });
}

async function throwAdjustmentGlBulkFailed(failed) {
  const err = new Error(
    `Post-adjustment transaction bulk insert failed: ${JSON.stringify(failed)}`,
  );
  err.statusCode = 400;
  err.details = failed;
  err.responseType = "transaction_bulk";
  throw err;
}

async function runAdjustmentWithOptionalTransaction(runFlow) {
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

function activeAccountFilter(companyId) {
  return {
    company_id: companyId,
    status: "active",
    ...activeNotDeletedCriteria(),
  };
}

async function resolveAccountIdIfValid(companyId, accountId, session = null) {
  const oid = toMongoObjectId(accountId);
  const tenantId = toMongoObjectId(companyId);
  if (!oid || !tenantId) return null;

  let q = Account.findById(oid).select("company_id status deletedAt");
  if (session) q = q.session(session);
  const acc = await q.lean();
  if (
    !acc ||
    String(acc.company_id) !== String(tenantId) ||
    acc.status !== "active" ||
    acc.deletedAt
  ) {
    return null;
  }
  return oid;
}

async function findCompanyAccountByName(
  companyId,
  namePattern,
  session = null,
) {
  let q = Account.findOne({
    ...activeAccountFilter(companyId),
    name: namePattern,
  })
    .select("_id name")
    .sort({ createdAt: 1 });
  if (session) q = q.session(session);
  return q.lean();
}

/** COA fallback when `company.default_adjustment_account` was never set (legacy tenants). */
async function resolveAdjustmentAccountId(companyId, session = null) {
  const byName = await findCompanyAccountByName(
    companyId,
    /^adjustment$/i,
    session,
  );
  return pickObjectId(byName?._id);
}

/** COA fallback — same pattern as `controllers/account.js` `resolveDefaultEquityAccountId`. */
async function resolveEquityAccountId(companyId, session = null) {
  const byName = await findCompanyAccountByName(
    companyId,
    /^equity$/i,
    session,
  );
  if (byName?._id) return pickObjectId(byName._id);

  let q = Account.findOne({
    ...activeAccountFilter(companyId),
    account_type: "equity",
  })
    .select("_id name")
    .sort({ createdAt: 1 });
  if (session) q = q.session(session);
  const eq = await q.lean();
  return pickObjectId(eq?._id);
}

async function resolveDefaultWarehouseId(companyId, session = null) {
  let q = Warehouse.findOne({
    company_id: companyId,
    status: "active",
    ...activeNotDeletedCriteria(),
  })
    .select("_id name")
    .sort({ createdAt: 1 });
  if (session) q = q.session(session);
  const wh = await q.lean();
  return pickObjectId(wh?._id);
}

/** Legacy tenants: signup may have created warehouse but never set `company.warehouse_id`. */
async function maybeHealCompanyDefaults(
  companyId,
  { adjustmentAccountId, equityAccountId, warehouseId },
  companyDoc,
  session = null,
) {
  if (!companyId) return;

  const patch = {};
  if (
    adjustmentAccountId &&
    !pickObjectId(companyDoc?.default_adjustment_account)
  ) {
    patch.default_adjustment_account = adjustmentAccountId;
  }
  if (equityAccountId && !pickObjectId(companyDoc?.default_equity_account_id)) {
    patch.default_equity_account_id = equityAccountId;
  }
  if (warehouseId && !pickObjectId(companyDoc?.warehouse_id)) {
    patch.warehouse_id = warehouseId;
  }
  if (!Object.keys(patch).length) return;

  const opts = session ? { session } : {};
  await Company.updateOne({ _id: companyId }, { $set: patch }, opts);
}

/**
 * Signup bug skipped `account_type: "equity"` rows other than "Equity" — create Adjustment if missing.
 */
async function ensureAdjustmentAccount(
  adjustmentReq,
  companyId,
  session = null,
) {
  const savedBody = adjustmentReq.body;
  adjustmentReq.body = {
    name: "Adjustment",
    account_type: "equity",
    company_id: toMongoObjectId(companyId) ?? companyId,
    status: "active",
    initial_balance: 0,
  };
  let createdId = null;
  try {
    const result = await performAccountCreate(adjustmentReq, true, { session });
    if (result?.success && result?.data?._id) {
      createdId = pickObjectId(result.data._id);
    }
  } finally {
    adjustmentReq.body = savedBody;
  }
  return createdId;
}

function throwMissingCompanyDefaultsError(missing, companyId) {
  const err = new Error(
    `Company GL defaults missing: ${missing.join(", ")}. ` +
      `Update the company record (PATCH /api/company/update_record/${companyId || ":id"}) ` +
      `or ensure chart accounts named "Adjustment" and "Equity" exist.`,
  );
  err.statusCode = 400;
  err.responseType = "validation";
  err.details = { missing, company_id: companyId ?? null };
  throw err;
}

async function loadCompanyDefaults(adjustmentReq, session = null) {
  const populated = companyObjFromReq(adjustmentReq);
  let adjustmentAccountId = pickObjectId(populated?.default_adjustment_account);
  let equityAccountId = pickObjectId(populated?.default_equity_account_id);
  let warehouseId =
    pickObjectId(adjustmentReq.body?.warehouse_id) ??
    pickObjectId(populated?.warehouse_id);

  const companyId =
    pickObjectId(adjustmentReq.body?.company_id) ??
    coalesceObjectId(adjustmentReq.user?.company_id);

  let companyDoc = null;

  if (!companyId) {
    const err = new Error("company_id is required for adjustment posting");
    err.statusCode = 400;
    throw err;
  }

  if (!adjustmentAccountId || !equityAccountId || !warehouseId) {
    let companyQuery = Company.findById(companyId).select(
      "default_adjustment_account default_equity_account_id warehouse_id",
    );
    if (session) companyQuery = companyQuery.session(session);
    companyDoc = await companyQuery.lean();
    if (!adjustmentAccountId) {
      adjustmentAccountId = pickObjectId(
        companyDoc?.default_adjustment_account,
      );
    }
    if (!equityAccountId) {
      equityAccountId = pickObjectId(companyDoc?.default_equity_account_id);
    }
    if (!warehouseId) {
      warehouseId = pickObjectId(companyDoc?.warehouse_id);
    }
  }

  if (adjustmentAccountId) {
    adjustmentAccountId = await resolveAccountIdIfValid(
      companyId,
      adjustmentAccountId,
      session,
    );
  }
  if (equityAccountId) {
    equityAccountId = await resolveAccountIdIfValid(
      companyId,
      equityAccountId,
      session,
    );
  }

  if (!equityAccountId) {
    equityAccountId = await resolveEquityAccountId(companyId, session);
  }
  if (!adjustmentAccountId) {
    adjustmentAccountId = await resolveAdjustmentAccountId(companyId, session);
  }
  if (!adjustmentAccountId && equityAccountId) {
    adjustmentAccountId = await ensureAdjustmentAccount(
      adjustmentReq,
      companyId,
      session,
    );
  }
  if (!warehouseId) {
    warehouseId = await resolveDefaultWarehouseId(companyId, session);
  }

  if (adjustmentAccountId || equityAccountId || warehouseId) {
    if (!companyDoc) {
      let companyQuery = Company.findById(companyId).select(
        "default_adjustment_account default_equity_account_id warehouse_id",
      );
      if (session) companyQuery = companyQuery.session(session);
      companyDoc = await companyQuery.lean();
    }
    await maybeHealCompanyDefaults(
      companyId,
      { adjustmentAccountId, equityAccountId, warehouseId },
      companyDoc,
      session,
    );
  }

  const missing = [];
  if (!adjustmentAccountId) {
    missing.push(
      'default_adjustment_account (or an active account named "Adjustment")',
    );
  }
  if (!equityAccountId) {
    missing.push(
      'default_equity_account_id (or an active account named "Equity")',
    );
  }
  if (!warehouseId) {
    missing.push("warehouse_id (request body or company default warehouse)");
  }
  if (missing.length) {
    throwMissingCompanyDefaultsError(missing, companyId);
  }

  return {
    adjustmentAccountId: toMongoObjectId(adjustmentAccountId),
    equityAccountId: toMongoObjectId(equityAccountId),
    warehouseId: toMongoObjectId(warehouseId),
    companyId: toMongoObjectId(companyId),
  };
}

async function resolveAdjustmentLineAmount(record, session = null) {
  const qty = Number(record?.quantity ?? 0);
  if (!Number.isFinite(qty) || qty <= 0) {
    const err = new Error("Adjustment quantity must be greater than zero");
    err.statusCode = 400;
    throw err;
  }

  const productQuery = Product.findById(record.product_id).select(
    "wholesale_price product_name product_code",
  );
  if (session) productQuery.session(session);
  const product = await productQuery.lean();

  if (!product) {
    const err = new Error("Product not found for adjustment");
    err.statusCode = 400;
    throw err;
  }

  const productName = String(
    product.product_name ?? product.name ?? product.product_code ?? "",
  ).trim();

  const unitCost = Number(product.wholesale_price ?? 0);
  if (!Number.isFinite(unitCost) || unitCost < 0) {
    const err = new Error(
      "Product wholesale_price is required for adjustment costing",
    );
    err.statusCode = 400;
    throw err;
  }

  const amount = Math.round(qty * unitCost * 100) / 100;
  if (amount <= 0) {
    const err = new Error(
      "Adjustment amount must be greater than zero (quantity × wholesale price)",
    );
    err.statusCode = 400;
    throw err;
  }

  return { amount, unitCost, qty, productName };
}

function buildAdjustmentGlItems(
  record,
  transaction_number,
  { adjustmentAccountId, equityAccountId, amount, productName },
) {
  const companyId = toMongoObjectId(record?.company_id);
  const adjType = String(record?.type || "")
    .trim()
    .toLowerCase();
  const isAdd = adjType === "add";
  const isRemove = adjType === "remove";

  if (!isAdd && !isRemove) {
    const err = new Error('Adjustment type must be "add" or "remove"');
    err.statusCode = 400;
    throw err;
  }
  const name = productName ? String(productName).trim() : "";
  const description =
    name ?
      `Adjustment ${adjType} - Stock [${name}]`
    : `Adjustment ${adjType} - Stock`;
  const createdAt =
    record?.createdAt instanceof Date ? record.createdAt
    : record?.createdAt ? new Date(record.createdAt)
    : new Date();

  const base = {
    company_id: companyId,
    amount,
    reference_user_id:
      pickObjectId(record?.created_by) ?? pickObjectId(record?.user_id),
    transaction_number,
    description,
    createdAt,
    reference_id: {
      module: "adjustment",
      ref_id: record._id,
    },
  };

  const adjAcct = toMongoObjectId(adjustmentAccountId);
  const eqAcct = toMongoObjectId(equityAccountId);

  if (isAdd) {
    return [
      { ...base, account_id: adjAcct, type: "debit" },
      { ...base, account_id: eqAcct, type: "credit" },
    ];
  }

  return [
    { ...base, account_id: adjAcct, type: "credit" },
    { ...base, account_id: eqAcct, type: "debit" },
  ];
}

async function postAdjustmentInventoryMovement(
  record,
  adjustmentReq,
  { warehouseId, unitCost, qty, amount },
  session = null,
) {
  const adjType = String(record?.type || "")
    .trim()
    .toLowerCase();
  const movement_type = adjType === "add" ? "in" : "out";
  const companyId =
    pickObjectId(record?.company_id) ??
    coalesceObjectId(adjustmentReq.user?.company_id);

  const bodyBefore = adjustmentReq.body;
  const hadRouteParamId = Object.prototype.hasOwnProperty.call(
    adjustmentReq.params,
    "id",
  );
  const savedRouteParamId =
    hadRouteParamId ? adjustmentReq.params.id : undefined;

  adjustmentReq.body = {
    product_id: String(record.product_id).trim(),
    warehouse_id: String(warehouseId).trim(),
    quantity: qty,
    movement_type,
    unit_cost: unitCost,
    total_cost: amount,
    reference_type: "adjustment",
    reference_id: record._id,
    reference_name: "Adjustment",
    company_id: companyId,
    status: "active",
  };

  try {
    await runInventoryMovementTxnBody(adjustmentReq, session);
  } catch (inventoryMovementErr) {
    if (inventoryMovementErr.clientPayload) {
      throwWithGenericFailure(
        inventoryMovementErr.clientPayload,
        "Inventory movement for adjustment failed",
      );
    }
    throw inventoryMovementErr;
  } finally {
    adjustmentReq.body = bodyBefore;
    if (hadRouteParamId) {
      adjustmentReq.params.id = savedRouteParamId;
    } else if (adjustmentReq.params?.id !== undefined) {
      delete adjustmentReq.params.id;
    }
  }
}

async function postAdjustmentGlTransactions(
  record,
  adjustmentReq,
  transaction_number,
  companyDefaults,
  lineAmount,
  session = null,
) {
  const items = buildAdjustmentGlItems(record, transaction_number, {
    adjustmentAccountId: companyDefaults.adjustmentAccountId,
    equityAccountId: companyDefaults.equityAccountId,
    amount: lineAmount.amount,
    productName: lineAmount.productName,
  });
  const { failed } = await transactionBulkCreate(adjustmentReq, items, {
    stopOnError: true,
    session,
  });
  if (failed.length) {
    await throwAdjustmentGlBulkFailed(failed);
  }
}

function softDeleteSetForReq(adjustmentReq) {
  const softDeleteSet = { deletedAt: new Date(), status: "inactive" };
  const uid = pickObjectId(adjustmentReq?.user?._id ?? adjustmentReq?.user);
  if (uid) softDeleteSet.updated_by = uid;
  return softDeleteSet;
}

async function softDeleteAdjustmentGlRows(
  adjustmentReq,
  adjustmentId,
  session = null,
) {
  if (!adjustmentId) return { modifiedCount: 0 };

  return Transaction.updateMany(
    {
      "reference_id.module": "adjustment",
      "reference_id.ref_id": adjustmentId,
      ...activeNotDeletedCriteria(),
    },
    { $set: softDeleteSetForReq(adjustmentReq) },
    session ? { session } : {},
  );
}

async function softDeleteAdjustmentInventoryRows(
  adjustmentReq,
  adjustmentId,
  session = null,
) {
  if (!adjustmentId) return { modifiedCount: 0 };

  return InventoryMovements.updateMany(
    {
      reference_type: "adjustment",
      reference_id: adjustmentId,
      ...activeNotDeletedCriteria(),
    },
    { $set: softDeleteSetForReq(adjustmentReq) },
    session ? { session } : {},
  );
}

async function softDeleteAdjustmentLinkedRows(
  adjustmentReq,
  adjustmentId,
  session = null,
) {
  const gl = await softDeleteAdjustmentGlRows(
    adjustmentReq,
    adjustmentId,
    session,
  );
  const inv = await softDeleteAdjustmentInventoryRows(
    adjustmentReq,
    adjustmentId,
    session,
  );
  return { gl, inv };
}

/** Compensating rollback when Mongo multi-doc transactions are unavailable. */
async function rollbackAdjustmentSave(
  adjustmentId,
  adjustmentReq,
  session = null,
) {
  if (!adjustmentId) return;

  const sessionOpts = session ? { session } : {};
  const softDeleteSet = softDeleteSetForReq(adjustmentReq);

  await Adjustment.updateOne(
    { _id: adjustmentId },
    { $set: softDeleteSet },
    sessionOpts,
  );
  await softDeleteAdjustmentLinkedRows(adjustmentReq, adjustmentId, session);
}

async function postAdjustmentSideEffects(
  record,
  adjustmentReq,
  transaction_number,
  session = null,
) {
  let step = "company_defaults";
  try {
    const companyDefaults = await loadCompanyDefaults(adjustmentReq, session);
    if (!companyDefaults.warehouseId) {
      const err = new Error(
        "warehouse_id is required (request body or company default warehouse)",
      );
      err.statusCode = 400;
      throw tagAdjustmentFailure(err, step);
    }

    step = "line_amount";
    const lineAmount = await resolveAdjustmentLineAmount(record, session);

    step = "inventory_movement";
    await postAdjustmentInventoryMovement(
      record,
      adjustmentReq,
      {
        warehouseId: companyDefaults.warehouseId,
        unitCost: lineAmount.unitCost,
        qty: lineAmount.qty,
        amount: lineAmount.amount,
      },
      session,
    );

    step = "gl_accounts_verify";
    await verifyGlAccountIds(
      companyDefaults.companyId,
      companyDefaults.adjustmentAccountId,
      companyDefaults.equityAccountId,
      session,
    );

    step = "gl_posting";
    await postAdjustmentGlTransactions(
      record,
      adjustmentReq,
      transaction_number,
      companyDefaults,
      lineAmount,
      session,
    );
  } catch (err) {
    throw tagAdjustmentFailure(err, step);
  }
}

async function logAdjustmentFailure(req, err, options) {
  await logRollbackFailure(req, err, {
    action: options.action,
    tags: options.tags,
    fallbackUrl: options.fallbackUrl,
    context: {
      ...adjustmentLogContext(req, options.extra),
      failure_step: err?.adjustmentFailureStep ?? options.failureStep ?? null,
      gl_failed: err?.details ?? null,
    },
  });
}

async function adjustmentCreate(req, res) {
  const tenantCo = coalesceObjectId(req.user?.company_id);
  if (tenantCo) {
    req.body.company_id = tenantCo;
  }

  let response = null;
  const txnError = await runAdjustmentWithOptionalTransaction(
    async (mongoSession) => {
      response = await handleGenericCreate(req, "adjustment", {
        ...(mongoSession ? { session: mongoSession } : {}),
        afterCreate: async (record, adjustmentReq, sess) => {
          const transaction_number = adjustmentTransactionNumber(
            record,
            adjustmentReq,
          );
          try {
            await postAdjustmentSideEffects(
              record,
              adjustmentReq,
              transaction_number,
              sess,
            );
          } catch (sideEffectErr) {
            if (!sess && record?._id) {
              await rollbackAdjustmentSave(record._id, adjustmentReq, null);
            }
            throw sideEffectErr;
          }
        },
      });
      if (!response?.success || !response?.data) {
        throwWithGenericFailure(response, "Adjustment create failed");
      }
    },
  );

  if (txnError) {
    console.error(
      "❌ adjustmentCreate failed:\n",
      serializeErrorForLog(txnError),
    );
    await logAdjustmentFailure(req, txnError, {
      action: "ADJUSTMENT CREATE ROLLBACK",
      tags: ["adjustment", "create", "error"],
      fallbackUrl: "/api/adjustment/save",
      extra: {
        adjustment_id:
          txnError?.clientErrorPayload?.data?._id ??
          response?.data?._id ??
          null,
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
      error: txnError.message || "Adjustment create failed",
      message: txnError.message || "Adjustment create failed",
      details: txnError.details ?? txnError.message,
      type: txnError.responseType || "error",
    });
  }

  return res.status(response.status).json(response);
}

async function adjustmentUpdate(req, res) {
  const tenantCo = coalesceObjectId(req.user?.company_id);
  const updateFilter = { ...activeNotDeletedCriteria() };
  if (tenantCo) {
    updateFilter.company_id = tenantCo;
  }

  let response = null;
  const txnError = await runAdjustmentWithOptionalTransaction(
    async (mongoSession) => {
      response = await handleGenericUpdate(req, "adjustment", {
        ...(mongoSession ? { session: mongoSession } : {}),
        filter: updateFilter,
        beforeUpdate: async (_updateData, adjustmentReq, existingRecord) => {
          adjustmentReq._adjustmentPriorSnapshot =
            existingRecord ?
              {
                product_id: existingRecord.product_id,
                quantity: existingRecord.quantity,
                type: existingRecord.type,
                transaction_number: existingRecord.transaction_number,
              }
            : null;
        },
        afterUpdate: async (record, adjustmentReq, _existing, sess) => {
          const adjustmentId = record?._id;
          await softDeleteAdjustmentLinkedRows(
            adjustmentReq,
            adjustmentId,
            sess,
          );
          const transaction_number = adjustmentTransactionNumber(
            record,
            adjustmentReq,
          );
          try {
            await postAdjustmentSideEffects(
              record,
              adjustmentReq,
              transaction_number,
              sess,
            );
          } catch (sideEffectErr) {
            if (!sess && adjustmentId) {
              await rollbackAdjustmentSave(adjustmentId, adjustmentReq, null);
            }
            throw sideEffectErr;
          }
        },
      });
      if (!response?.success || !response?.data) {
        throwWithGenericFailure(response, "Adjustment update failed");
      }
    },
  );

  if (txnError) {
    console.error(
      "❌ adjustmentUpdate failed:\n",
      serializeErrorForLog(txnError),
    );
    await logAdjustmentFailure(req, txnError, {
      action: "ADJUSTMENT UPDATE ROLLBACK",
      tags: ["adjustment", "update", "error"],
      fallbackUrl: `/api/adjustment/update_record/${req.params?.id || ""}`,
      extra: {
        prior: req._adjustmentPriorSnapshot ?? null,
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
      error: txnError.message || "Adjustment update failed",
      message: txnError.message || "Adjustment update failed",
      details: txnError.details ?? txnError.message,
      type: txnError.responseType || "error",
    });
  }

  return res.status(response.status).json(response);
}

module.exports = {
  adjustmentCreate,
  adjustmentUpdate,
};
