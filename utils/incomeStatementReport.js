const mongoose = require("mongoose");
const Account = require("../models/account");
const Transaction = require("../models/transaction");
const { coalesceObjectId } = require("./modelHelper");
const { roundMoney2 } = require("./balanceSheetReconcile");

const INCOME_STATEMENT_ACCOUNT_TYPES = [
  "revenue",
  "cost_of_goods_sold_account",
  "operating_expense",
  "other_expense",
];

function activeAccountFilter(companyId) {
  return {
    company_id: companyId,
    status: "active",
    deletedAt: null,
    account_type: { $in: INCOME_STATEMENT_ACCOUNT_TYPES },
  };
}

/** Period GL totals per account (debit/credit convention matches balance sheet). */
async function aggregatePeriodSumsByAccountIds(
  accountIds,
  companyId,
  fromDate,
  toDate,
) {
  if (!accountIds.length) return new Map();

  const match = {
    account_id: { $in: accountIds },
    deletedAt: null,
    status: "active",
    createdAt: { $gte: fromDate, $lte: toDate },
  };
  if (companyId) match.company_id = companyId;

  const rows = await Transaction.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$account_id",
        total_debit: {
          $sum: { $cond: [{ $eq: ["$type", "debit"] }, "$amount", 0] },
        },
        total_credit: {
          $sum: { $cond: [{ $eq: ["$type", "credit"] }, "$amount", 0] },
        },
        line_count: { $sum: 1 },
      },
    },
  ]);

  const map = new Map();
  for (const row of rows) {
    const totalDebit = roundMoney2(row.total_debit);
    const totalCredit = roundMoney2(row.total_credit);
    map.set(String(row._id), {
      total_debit: totalDebit,
      total_credit: totalCredit,
      line_count: row.line_count ?? 0,
      net_debit_minus_credit: roundMoney2(totalDebit - totalCredit),
      credit_minus_debit: roundMoney2(totalCredit - totalDebit),
    });
  }
  return map;
}

/** Signed P&L amount for one account type in a period. */
function periodAmountForAccountType(accountType, sums) {
  const s = sums || {
    net_debit_minus_credit: 0,
    credit_minus_debit: 0,
  };
  if (accountType === "revenue") {
    return roundMoney2(s.credit_minus_debit);
  }
  if (
    accountType === "cost_of_goods_sold_account" ||
    accountType === "operating_expense" ||
    accountType === "other_expense"
  ) {
    return roundMoney2(-s.net_debit_minus_credit);
  }
  return 0;
}

function buildAccountSectionRows(accounts, sumByAccount, accountTypes) {
  const typeSet = new Set(accountTypes);
  const rows = [];

  for (const acc of accounts) {
    if (!typeSet.has(acc.account_type)) continue;
    const sums = sumByAccount.get(String(acc._id));
    const amount = periodAmountForAccountType(acc.account_type, sums);
    if (Math.abs(amount) < 0.005 && (!sums || sums.line_count === 0)) {
      continue;
    }
    rows.push({
      account_id: acc._id,
      name: acc.name,
      account_number: acc.account_number ?? null,
      account_type: acc.account_type,
      amount,
      transactions_sum: sums || null,
    });
  }

  rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const total = roundMoney2(rows.reduce((t, r) => t + r.amount, 0));
  return { accounts: rows, total };
}

/**
 * Build income statement (P&L) for one tenant and date range.
 *
 * @param {import("mongoose").Types.ObjectId|string} companyId
 * @param {Date} fromDate inclusive start
 * @param {Date} toDate inclusive end
 */
async function computeIncomeStatementReport(companyId, fromDate, toDate) {
  const cid = coalesceObjectId(companyId);
  if (!cid || !mongoose.Types.ObjectId.isValid(String(cid))) {
    return { ok: false, status: 400, error: "Valid company_id is required" };
  }
  if (!(fromDate instanceof Date) || Number.isNaN(fromDate.getTime())) {
    return { ok: false, status: 400, error: "Valid start date is required" };
  }
  if (!(toDate instanceof Date) || Number.isNaN(toDate.getTime())) {
    return { ok: false, status: 400, error: "Valid end date is required" };
  }
  if (fromDate > toDate) {
    return {
      ok: false,
      status: 400,
      error: "Invalid date range",
      message: "startDate must be on or before endDate",
    };
  }

  const accounts = await Account.find(activeAccountFilter(cid))
    .select("_id name account_number account_type")
    .sort({ account_type: 1, name: 1 })
    .lean();

  const accountIds = accounts.map((a) => a._id);
  const sumByAccount = await aggregatePeriodSumsByAccountIds(
    accountIds,
    cid,
    fromDate,
    toDate,
  );

  const revenue = buildAccountSectionRows(accounts, sumByAccount, ["revenue"]);
  const cost_of_goods_sold = buildAccountSectionRows(accounts, sumByAccount, [
    "cost_of_goods_sold_account",
  ]);
  const operating_expenses = buildAccountSectionRows(accounts, sumByAccount, [
    "operating_expense",
  ]);
  const other_expenses = buildAccountSectionRows(accounts, sumByAccount, [
    "other_expense",
  ]);

  const gross_profit = roundMoney2(
    revenue.total - cost_of_goods_sold.total,
  );
  const operating_income = roundMoney2(
    gross_profit - operating_expenses.total,
  );
  const net_income = roundMoney2(
    operating_income - other_expenses.total,
  );

  return {
    ok: true,
    company_id: cid,
    period: {
      startDate: formatLocalDateKey(fromDate),
      endDate: formatLocalDateKey(toDate),
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
    },
    revenue,
    cost_of_goods_sold,
    gross_profit,
    operating_expenses,
    operating_income,
    other_expenses,
    net_income,
  };
}

function formatLocalDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseLocalDateOnly(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || "").trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  const d = new Date(year, month, day);
  if (
    d.getFullYear() !== year ||
    d.getMonth() !== month ||
    d.getDate() !== day
  ) {
    return null;
  }
  return d;
}

function endOfLocalDay(d) {
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    23,
    59,
    59,
    999,
  );
}

/**
 * Resolve report date range from query params.
 * Supports `startDate`/`endDate` (frontend) and `from`/`to` (API alias).
 */
function resolveIncomeStatementDateRange(query = {}) {
  const startRaw =
    query.startDate ?? query.start_date ?? query.from ?? null;
  const endRaw = query.endDate ?? query.end_date ?? query.to ?? null;

  if (startRaw == null || String(startRaw).trim() === "") {
    return {
      error: {
        status: 400,
        body: {
          success: false,
          status: 400,
          error: "startDate is required",
          message: "Provide startDate (YYYY-MM-DD)",
        },
      },
    };
  }
  if (endRaw == null || String(endRaw).trim() === "") {
    return {
      error: {
        status: 400,
        body: {
          success: false,
          status: 400,
          error: "endDate is required",
          message: "Provide endDate (YYYY-MM-DD)",
        },
      },
    };
  }

  const startDay = parseLocalDateOnly(startRaw);
  const endDay = parseLocalDateOnly(endRaw);

  if (!startDay) {
    return {
      error: {
        status: 400,
        body: {
          success: false,
          status: 400,
          error: "Invalid startDate",
          message: "Use YYYY-MM-DD format",
        },
      },
    };
  }
  if (!endDay) {
    return {
      error: {
        status: 400,
        body: {
          success: false,
          status: 400,
          error: "Invalid endDate",
          message: "Use YYYY-MM-DD format",
        },
      },
    };
  }

  const fromDate = startDay;
  const toDate = endOfLocalDay(endDay);

  if (fromDate > toDate) {
    return {
      error: {
        status: 400,
        body: {
          success: false,
          status: 400,
          error: "Invalid date range",
          message: "startDate must be on or before endDate",
        },
      },
    };
  }

  return { fromDate, toDate };
}

module.exports = {
  computeIncomeStatementReport,
  resolveIncomeStatementDateRange,
  aggregatePeriodSumsByAccountIds,
  periodAmountForAccountType,
  formatLocalDateKey,
};
