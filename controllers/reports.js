const mongoose = require("mongoose");
const { coalesceObjectId } = require("../utils/modelHelper");
const {
  computeIncomeStatementReport,
  resolveIncomeStatementDateRange,
} = require("../utils/incomeStatementReport");
const {
  computeIncomeStatementDetailReport,
} = require("../utils/incomeStatementDetailReport");

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

module.exports = {
  getIncomeStatement,
  getIncomeStatementDetail,
};
