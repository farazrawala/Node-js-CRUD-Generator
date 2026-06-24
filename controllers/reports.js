const mongoose = require("mongoose");
const Order = require("../models/order");
const Expense = require("../models/expense");
const { coalesceObjectId } = require("../utils/modelHelper");
const {
  computeIncomeStatementReport,
  resolveIncomeStatementDateRange,
} = require("../utils/incomeStatementReport");
const {
  computeIncomeStatementDetailReport,
} = require("../utils/incomeStatementDetailReport");
const {
  resolveReportPeriodRange,
  periodResponse,
} = require("../utils/reportPeriodRange");
const { resolveTenantCompany } = require("../utils/receivablesReport");

function resolveReportCompanyId(req) {
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
 * GET /api/reports/income-statement
 * Query: startDate, endDate (YYYY-MM-DD). Aliases: from, to, start_date, end_date.
 * Optional: company_id (must match authenticated tenant if provided).
 */
async function getIncomeStatement(req, res) {
  try {
    const resolvedCompany = resolveReportCompanyId(req);
    if (resolvedCompany.error) {
      return res.status(resolvedCompany.error.status).json(resolvedCompany.error.body);
    }

    const resolvedDates = resolveIncomeStatementDateRange(req.query);
    if (resolvedDates.error) {
      return res.status(resolvedDates.error.status).json(resolvedDates.error.body);
    }

    const report = await computeIncomeStatementReport(
      resolvedCompany.companyId,
      resolvedDates.fromDate,
      resolvedDates.toDate,
    );

    if (!report.ok) {
      return res.status(report.status || 400).json({
        success: false,
        status: report.status || 400,
        error: report.error,
        message: report.message,
      });
    }

    return res.status(200).json({
      success: true,
      status: 200,
      data: report,
    });
  } catch (error) {
    console.error("❌ getIncomeStatement:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      error: error.message || "Failed to build income statement report",
    });
  }
}

/**
 * GET /api/reports/income-statement-detail
 * Combined P&L: operational totals (sales, returns, COGS) + period GL sections.
 * Query: startDate, endDate (YYYY-MM-DD). Aliases: from, to, start_date, end_date.
 */
async function getIncomeStatementDetail(req, res) {
  try {
    const resolvedCompany = resolveReportCompanyId(req);
    if (resolvedCompany.error) {
      return res.status(resolvedCompany.error.status).json(resolvedCompany.error.body);
    }

    const resolvedDates = resolveIncomeStatementDateRange(req.query);
    if (resolvedDates.error) {
      return res.status(resolvedDates.error.status).json(resolvedDates.error.body);
    }

    const report = await computeIncomeStatementDetailReport(
      resolvedCompany.companyId,
      resolvedDates.fromDate,
      resolvedDates.toDate,
    );

    if (!report.ok) {
      return res.status(report.status || 400).json({
        success: false,
        status: report.status || 400,
        error: report.error,
        message: report.message,
      });
    }

    return res.status(200).json({
      success: true,
      status: 200,
      data: report,
    });
  } catch (error) {
    console.error("❌ getIncomeStatementDetail:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      error: error.message || "Failed to build income statement detail report",
    });
  }
}

/**
 * GET expense vs revenue comparison for a period.
 * Revenue = sum of `order.total_amount`; expenses = sum of `expense.amount`.
 * Query: `period`, `from` / `to` (default: current_month); optional `order_status`.
 */
async function getExpenseVsRevenue(req, res) {
  try {
    const companyResolved = resolveTenantCompany(req);
    if (!companyResolved.ok) {
      return res
        .status(companyResolved.response.status)
        .json(companyResolved.response.body);
    }

    const hasPeriod =
      req.query?.period != null && String(req.query.period).trim() !== "";
    const hasFrom = req.query?.from != null && String(req.query.from).trim() !== "";
    const hasTo = req.query?.to != null && String(req.query.to).trim() !== "";
    if (!hasPeriod && !hasFrom && !hasTo) {
      req.query.period = "current_month";
    }

    const rangeResolved = resolveReportPeriodRange(req.query, {
      defaultPeriod: "current_month",
    });
    if (rangeResolved.error) {
      return res
        .status(rangeResolved.error.status)
        .json(rangeResolved.error.body);
    }

    const { fromDate, toDate, periodLabel } = rangeResolved;
    const { cid, companyId } = companyResolved;

    const orderMatch = {
      company_id: cid,
      status: "active",
      deletedAt: null,
      createdAt: { $gte: fromDate, $lte: toDate },
    };
    const rawOrderStatus = req.query?.order_status;
    if (rawOrderStatus != null && String(rawOrderStatus).trim() !== "") {
      orderMatch.order_status = String(rawOrderStatus).trim();
    }

    const expenseMatch = {
      company_id: cid,
      status: "active",
      deletedAt: null,
      createdAt: { $gte: fromDate, $lte: toDate },
    };

    const [revenueRows, expenseRows] = await Promise.all([
      Order.aggregate([
        { $match: orderMatch },
        {
          $group: {
            _id: null,
            total_revenue: { $sum: { $ifNull: ["$total_amount", 0] } },
            order_count: { $sum: 1 },
          },
        },
      ]),
      Expense.aggregate([
        { $match: expenseMatch },
        {
          $group: {
            _id: null,
            total_expense: { $sum: { $ifNull: ["$amount", 0] } },
            expense_count: { $sum: 1 },
          },
        },
      ]),
    ]);

    const revenueRow = revenueRows[0] || { total_revenue: 0, order_count: 0 };
    const expenseRow = expenseRows[0] || { total_expense: 0, expense_count: 0 };
    const total_revenue = Math.round((revenueRow.total_revenue || 0) * 100) / 100;
    const total_expense = Math.round((expenseRow.total_expense || 0) * 100) / 100;
    const net_profit = Math.round((total_revenue - total_expense) * 100) / 100;
    const expense_ratio_percent =
      total_revenue > 0 ?
        Math.round((total_expense / total_revenue) * 10000) / 100
      : 0;

    return res.status(200).json({
      success: true,
      status: 200,
      company_id: companyId,
      period: periodResponse(periodLabel, fromDate, toDate),
      data: {
        total_revenue,
        order_count: revenueRow.order_count ?? 0,
        total_expense,
        expense_count: expenseRow.expense_count ?? 0,
        net_profit,
        expense_ratio_percent,
      },
    });
  } catch (error) {
    console.error("getExpenseVsRevenue:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      error: error.message || "Failed to build expense vs revenue report",
    });
  }
}

module.exports = {
  getIncomeStatement,
  getIncomeStatementDetail,
  getExpenseVsRevenue,
};
