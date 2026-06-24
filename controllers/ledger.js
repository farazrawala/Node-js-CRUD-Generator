const {
  resolveReportPeriodRange,
  periodResponse,
} = require("../utils/reportPeriodRange");
const {
  resolveTenantCompany,
  requireArAccount,
  aggregateCustomerReceivableBalances,
  computeReceivablesAging,
  AGING_BUCKET_KEYS,
} = require("../utils/receivablesReport");

/**
 * GET top customers by outstanding A/R balance (GL on default receivable account).
 * Query: `limit` (default 10, max 100), optional `min_balance` (default 0.01).
 */
async function getReceivablesSummary(req, res) {
  try {
    const companyResolved = resolveTenantCompany(req);
    if (!companyResolved.ok) {
      return res
        .status(companyResolved.response.status)
        .json(companyResolved.response.body);
    }

    const arResolved = await requireArAccount(companyResolved);
    if (!arResolved.ok) {
      return res.status(arResolved.response.status).json(arResolved.response.body);
    }

    const limitRaw = parseInt(req.query?.limit, 10);
    const limit = limitRaw > 0 ? Math.min(limitRaw, 100) : 10;
    const minBalanceRaw = parseFloat(req.query?.min_balance);
    const minBalance =
      Number.isFinite(minBalanceRaw) && minBalanceRaw >= 0 ? minBalanceRaw : 0.01;

    const data = await aggregateCustomerReceivableBalances(
      companyResolved.cid,
      arResolved.arAccountId,
      { minBalance, limit },
    );

    const summary = data.reduce(
      (acc, row) => {
        acc.total_outstanding += Number(row.balance) || 0;
        acc.customer_count += 1;
        return acc;
      },
      { total_outstanding: 0, customer_count: data.length },
    );
    summary.total_outstanding =
      Math.round(summary.total_outstanding * 100) / 100;

    return res.status(200).json({
      success: true,
      status: 200,
      company_id: companyResolved.companyId,
      account_receivable_account_id: String(arResolved.arAccountId),
      summary,
      data,
    });
  } catch (error) {
    console.error("getReceivablesSummary:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      error: error.message || "Internal server error",
    });
  }
}

/**
 * GET A/R aging buckets (FIFO on GL receivable lines per customer).
 * Query: optional `as_of` (ISO date; default now).
 */
async function getReceivablesAging(req, res) {
  try {
    const companyResolved = resolveTenantCompany(req);
    if (!companyResolved.ok) {
      return res
        .status(companyResolved.response.status)
        .json(companyResolved.response.body);
    }

    const arResolved = await requireArAccount(companyResolved);
    if (!arResolved.ok) {
      return res.status(arResolved.response.status).json(arResolved.response.body);
    }

    const asOfRaw = req.query?.as_of;
    const asOfDate =
      asOfRaw != null && String(asOfRaw).trim() !== "" ?
        new Date(String(asOfRaw).trim())
      : new Date();
    if (Number.isNaN(asOfDate.getTime())) {
      return res.status(400).json({
        success: false,
        status: 400,
        error: "Invalid as_of date",
      });
    }

    const aging = await computeReceivablesAging(
      companyResolved.cid,
      arResolved.arAccountId,
      asOfDate,
    );

    const buckets = AGING_BUCKET_KEYS.map((key) => ({
      bucket: key,
      label:
        key === "current" ? "0–30 days"
        : key === "days_31_60" ? "31–60 days"
        : key === "days_61_90" ? "61–90 days"
        : "90+ days",
      amount: aging.buckets[key] ?? 0,
    }));

    return res.status(200).json({
      success: true,
      status: 200,
      company_id: companyResolved.companyId,
      account_receivable_account_id: String(arResolved.arAccountId),
      as_of: asOfDate.toISOString(),
      summary: {
        total_outstanding: aging.total_outstanding,
        customer_count: aging.customer_count,
      },
      buckets,
    });
  } catch (error) {
    console.error("getReceivablesAging:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      error: error.message || "Internal server error",
    });
  }
}

module.exports = {
  getReceivablesSummary,
  getReceivablesAging,
};
