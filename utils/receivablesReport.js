const mongoose = require("mongoose");
const Company = require("../models/company");
const Transaction = require("../models/transaction");
const User = require("../models/user");
const { coalesceObjectId } = require("./modelHelper");
const { roundMoney2 } = require("./balanceSheetReconcile");

function roundMoney(n) {
  return roundMoney2(Number(n) || 0);
}

async function resolveCompanyArAccountId(companyId, userCompany = null) {
  if (
    userCompany &&
    typeof userCompany === "object" &&
    userCompany.default_account_receivable_account != null
  ) {
    return coalesceObjectId(userCompany.default_account_receivable_account);
  }
  const row = await Company.findById(companyId)
    .select("default_account_receivable_account")
    .lean();
  return coalesceObjectId(row?.default_account_receivable_account);
}

function arBaseMatch(companyId, arAccountId) {
  return {
    company_id: companyId,
    account_id: arAccountId,
    status: "active",
    deletedAt: null,
    reference_user_id: { $ne: null },
  };
}

/** Lifetime AR balance on the company default receivable account. */
async function aggregateArGlBalance(companyId, arAccountId, beforeDate = null) {
  const match = {
    company_id: companyId,
    account_id: arAccountId,
    status: "active",
    deletedAt: null,
  };
  if (beforeDate) {
    match.createdAt = { $lt: beforeDate };
  }

  const rows = await Transaction.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        total_debit: {
          $sum: { $cond: [{ $eq: ["$type", "debit"] }, "$amount", 0] },
        },
        total_credit: {
          $sum: { $cond: [{ $eq: ["$type", "credit"] }, "$amount", 0] },
        },
      },
    },
  ]);

  const row = rows[0] || { total_debit: 0, total_credit: 0 };
  const total_debit = roundMoney(row.total_debit);
  const total_credit = roundMoney(row.total_credit);
  return {
    total_debit,
    total_credit,
    balance: roundMoney(total_debit - total_credit),
  };
}

/** Period movement on AR (charges = debits, collections = credits). */
async function aggregateArPeriodMovement(
  companyId,
  arAccountId,
  fromDate,
  toDate,
) {
  const rows = await Transaction.aggregate([
    {
      $match: {
        ...arBaseMatch(companyId, arAccountId),
        createdAt: { $gte: fromDate, $lte: toDate },
      },
    },
    {
      $group: {
        _id: null,
        new_charges: {
          $sum: { $cond: [{ $eq: ["$type", "debit"] }, "$amount", 0] },
        },
        collections: {
          $sum: { $cond: [{ $eq: ["$type", "credit"] }, "$amount", 0] },
        },
        transaction_count: { $sum: 1 },
      },
    },
  ]);

  const row = rows[0] || {
    new_charges: 0,
    collections: 0,
    transaction_count: 0,
  };
  return {
    new_charges: roundMoney(row.new_charges),
    collections: roundMoney(row.collections),
    transaction_count: row.transaction_count ?? 0,
    net_change: roundMoney(row.new_charges - row.collections),
  };
}

/** Per-customer AR balance from GL (`debit − credit`). */
async function aggregateCustomerReceivableBalances(
  companyId,
  arAccountId,
  { minBalance = 0.01, limit = null } = {},
) {
  const pipeline = [
    { $match: arBaseMatch(companyId, arAccountId) },
    {
      $group: {
        _id: "$reference_user_id",
        total_debit: {
          $sum: { $cond: [{ $eq: ["$type", "debit"] }, "$amount", 0] },
        },
        total_credit: {
          $sum: { $cond: [{ $eq: ["$type", "credit"] }, "$amount", 0] },
        },
        last_activity_at: { $max: "$createdAt" },
        transaction_count: { $sum: 1 },
      },
    },
    {
      $project: {
        _id: 0,
        customer_id: "$_id",
        total_debit: { $round: ["$total_debit", 2] },
        total_credit: { $round: ["$total_credit", 2] },
        balance: {
          $round: [{ $subtract: ["$total_debit", "$total_credit"] }, 2],
        },
        last_activity_at: 1,
        transaction_count: 1,
      },
    },
    { $match: { balance: { $gte: minBalance } } },
    { $sort: { balance: -1 } },
  ];

  if (limit != null && limit > 0) {
    pipeline.push({ $limit: limit });
  }

  const rows = await Transaction.aggregate(pipeline);

  const customerIds = rows.map((r) => r.customer_id).filter(Boolean);
  const users =
    customerIds.length ?
      await User.find({ _id: { $in: customerIds } })
        .select("name email phone role")
        .lean()
    : [];
  const userById = new Map(users.map((u) => [String(u._id), u]));

  return rows.map((row) => {
    const user = userById.get(String(row.customer_id));
    return {
      customer_id: row.customer_id,
      customer_name: user?.name ?? "Unknown",
      customer_email: user?.email ?? null,
      customer_phone: user?.phone ?? null,
      balance: row.balance,
      total_debit: row.total_debit,
      total_credit: row.total_credit,
      last_activity_at: row.last_activity_at,
      transaction_count: row.transaction_count,
    };
  });
}

const AGING_BUCKET_KEYS = ["current", "days_31_60", "days_61_90", "over_90"];

function emptyAgingBuckets() {
  return {
    current: 0,
    days_31_60: 0,
    days_61_90: 0,
    over_90: 0,
  };
}

function bucketKeyForAgeDays(days) {
  if (days <= 30) return "current";
  if (days <= 60) return "days_31_60";
  if (days <= 90) return "days_61_90";
  return "over_90";
}

/** FIFO: apply credits against oldest debits, then age remaining debit amounts. */
function fifoAgingBuckets(debitRows, creditTotal, asOfDate = new Date()) {
  const buckets = emptyAgingBuckets();
  const debits = [...debitRows].sort(
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
  );
  let remainingCredit = roundMoney(creditTotal);
  const asOfMs = asOfDate.getTime();

  for (const row of debits) {
    let amount = roundMoney(row.amount);
    if (remainingCredit > 0) {
      const applied = Math.min(amount, remainingCredit);
      amount = roundMoney(amount - applied);
      remainingCredit = roundMoney(remainingCredit - applied);
    }
    if (amount <= 0.009) continue;

    const days = Math.max(
      0,
      Math.floor((asOfMs - new Date(row.createdAt).getTime()) / 86400000),
    );
    const key = bucketKeyForAgeDays(days);
    buckets[key] = roundMoney(buckets[key] + amount);
  }

  return buckets;
}

async function computeReceivablesAging(companyId, arAccountId, asOfDate = new Date()) {
  const customerRows = await Transaction.aggregate([
    { $match: arBaseMatch(companyId, arAccountId) },
    {
      $group: {
        _id: "$reference_user_id",
        total_debit: {
          $sum: { $cond: [{ $eq: ["$type", "debit"] }, "$amount", 0] },
        },
        total_credit: {
          $sum: { $cond: [{ $eq: ["$type", "credit"] }, "$amount", 0] },
        },
      },
    },
    {
      $project: {
        balance: { $subtract: ["$total_debit", "$total_credit"] },
      },
    },
    { $match: { balance: { $gt: 0.009 } } },
  ]);

  const customerIds = customerRows.map((r) => r._id).filter(Boolean);
  if (!customerIds.length) {
    return {
      buckets: emptyAgingBuckets(),
      total_outstanding: 0,
      customer_count: 0,
    };
  }

  const txnRows = await Transaction.find({
    ...arBaseMatch(companyId, arAccountId),
    reference_user_id: { $in: customerIds },
  })
    .select("reference_user_id type amount createdAt")
    .sort({ createdAt: 1 })
    .lean();

  const byCustomer = new Map();
  for (const id of customerIds) {
    byCustomer.set(String(id), { debits: [], creditTotal: 0 });
  }
  for (const row of txnRows) {
    const key = String(row.reference_user_id);
    const bucket = byCustomer.get(key);
    if (!bucket) continue;
    if (row.type === "debit") {
      bucket.debits.push(row);
    } else {
      bucket.creditTotal += Number(row.amount) || 0;
    }
  }

  const buckets = emptyAgingBuckets();
  let total_outstanding = 0;
  for (const [, data] of byCustomer) {
    const customerBuckets = fifoAgingBuckets(
      data.debits,
      data.creditTotal,
      asOfDate,
    );
    for (const key of AGING_BUCKET_KEYS) {
      buckets[key] = roundMoney(buckets[key] + customerBuckets[key]);
    }
    total_outstanding = roundMoney(
      total_outstanding +
        AGING_BUCKET_KEYS.reduce((s, k) => s + customerBuckets[k], 0),
    );
  }

  return {
    buckets,
    total_outstanding,
    customer_count: customerIds.length,
  };
}

function resolveTenantCompany(req) {
  const rawCompany = req.user?.company_id;
  const companyId =
    rawCompany && typeof rawCompany === "object" && rawCompany._id ?
      rawCompany._id
    : rawCompany;
  if (!companyId) {
    return {
      ok: false,
      response: {
        status: 400,
        body: {
          success: false,
          status: 400,
          error: "company_id is required",
          message: "Authentication with company context is required",
        },
      },
    };
  }

  const companyObjectId = coalesceObjectId(companyId);
  if (
    !companyObjectId ||
    !mongoose.Types.ObjectId.isValid(String(companyObjectId))
  ) {
    return {
      ok: false,
      response: {
        status: 400,
        body: {
          success: false,
          status: 400,
          error: "company_id is required",
          message: "Invalid company context",
        },
      },
    };
  }

  return {
    ok: true,
    cid: new mongoose.Types.ObjectId(String(companyObjectId)),
    companyId: String(companyObjectId),
    userCompany: typeof rawCompany === "object" ? rawCompany : null,
  };
}

async function requireArAccount(companyResolved) {
  const arAccountId = await resolveCompanyArAccountId(
    companyResolved.cid,
    companyResolved.userCompany,
  );
  if (!arAccountId) {
    return {
      ok: false,
      response: {
        status: 400,
        body: {
          success: false,
          status: 400,
          error: "default_account_receivable_account is not configured",
          message:
            "Set the company default Accounts Receivable account before running receivables reports",
        },
      },
    };
  }
  return { ok: true, arAccountId };
}

module.exports = {
  resolveTenantCompany,
  requireArAccount,
  aggregateArGlBalance,
  aggregateArPeriodMovement,
  aggregateCustomerReceivableBalances,
  computeReceivablesAging,
  AGING_BUCKET_KEYS,
};
