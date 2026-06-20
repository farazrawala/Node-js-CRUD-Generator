const mongoose = require("mongoose");
const Order = require("../models/order");
const OrderItem = require("../models/order_item");
const SalesReturn = require("../models/sales_return");
const SalesReturnItem = require("../models/sales_return_item");
const Company = require("../models/company");
const Account = require("../models/account");
const { coalesceObjectId } = require("./modelHelper");
const { roundMoney2 } = require("./balanceSheetReconcile");
const {
  computeIncomeStatementReport,
  aggregatePeriodSumsByAccountIds,
} = require("./incomeStatementReport");

function baseCompanyMatch(companyId, fromDate, toDate) {
  return {
    company_id: new mongoose.Types.ObjectId(String(companyId)),
    status: "active",
    deletedAt: null,
    createdAt: { $gte: fromDate, $lte: toDate },
  };
}

const qtyToDouble = {
  $convert: { input: "$qty", to: "double", onError: 0, onNull: 0 },
};

const orderLineOutMovementLookup = {
  $lookup: {
    from: "inventory_movements",
    let: {
      orderId: "$order_id",
      productId: "$product_id",
      companyId: "$company_id",
    },
    pipeline: [
      {
        $match: {
          status: "active",
          $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
        },
      },
      {
        $match: {
          $expr: {
            $and: [
              { $eq: ["$company_id", "$$companyId"] },
              { $eq: ["$product_id", "$$productId"] },
              { $eq: ["$reference_id", "$$orderId"] },
              { $eq: ["$reference_type", "order"] },
              {
                $eq: [
                  { $toLower: { $ifNull: ["$movement_type", ""] } },
                  "out",
                ],
              },
            ],
          },
        },
      },
      { $limit: 1 },
    ],
    as: "out_movements",
  },
};

async function sumDocumentTotalAmount(companyId, Model, fromDate, toDate, statusField) {
  const match = baseCompanyMatch(companyId, fromDate, toDate);
  const rows = await Model.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        total_amount: { $sum: { $ifNull: ["$total_amount", 0] } },
        document_count: { $sum: 1 },
      },
    },
    {
      $project: {
        _id: 0,
        total_amount: { $round: ["$total_amount", 2] },
        document_count: 1,
      },
    },
  ]);
  return {
    total_amount: rows[0]?.total_amount ?? 0,
    document_count: rows[0]?.document_count ?? 0,
    status_field: statusField,
  };
}

async function sumOrderProfit(companyId, fromDate, toDate) {
  const match = baseCompanyMatch(companyId, fromDate, toDate);
  const rows = await OrderItem.aggregate([
    { $match: match },
    orderLineOutMovementLookup,
    { $match: { "out_movements.0": { $exists: true } } },
    {
      $group: {
        _id: null,
        profit: { $sum: { $ifNull: ["$profit", 0] } },
        line_count: { $sum: 1 },
      },
    },
    {
      $project: {
        _id: 0,
        profit: { $round: ["$profit", 2] },
        line_count: 1,
      },
    },
  ]);
  return {
    profit: rows[0]?.profit ?? 0,
    line_count: rows[0]?.line_count ?? 0,
  };
}

async function sumCogsSold(companyId, fromDate, toDate) {
  const match = baseCompanyMatch(companyId, fromDate, toDate);
  const lineCostExpr = {
    $multiply: [{ $ifNull: ["$cost_price_at_sale", 0] }, qtyToDouble],
  };
  const rows = await OrderItem.aggregate([
    { $match: match },
    orderLineOutMovementLookup,
    { $match: { "out_movements.0": { $exists: true } } },
    {
      $group: {
        _id: null,
        cost_of_goods_sold: { $sum: lineCostExpr },
        line_count: { $sum: 1 },
      },
    },
    {
      $project: {
        _id: 0,
        cost_of_goods_sold: { $round: ["$cost_of_goods_sold", 2] },
        line_count: 1,
      },
    },
  ]);
  return {
    cost_of_goods_sold: rows[0]?.cost_of_goods_sold ?? 0,
    line_count: rows[0]?.line_count ?? 0,
  };
}

async function sumCogsOnSalesReturns(companyId, fromDate, toDate) {
  const match = baseCompanyMatch(companyId, fromDate, toDate);
  const lineCostExpr = {
    $multiply: [{ $ifNull: ["$cost_price_at_return", 0] }, qtyToDouble],
  };
  const rows = await SalesReturnItem.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        cost_of_goods_on_returns: { $sum: lineCostExpr },
        line_count: { $sum: 1 },
      },
    },
    {
      $project: {
        _id: 0,
        cost_of_goods_on_returns: { $round: ["$cost_of_goods_on_returns", 2] },
        line_count: 1,
      },
    },
  ]);
  return {
    cost_of_goods_on_returns: rows[0]?.cost_of_goods_on_returns ?? 0,
    line_count: rows[0]?.line_count ?? 0,
  };
}

async function sumSalesReturnProfit(companyId, fromDate, toDate) {
  const match = baseCompanyMatch(companyId, fromDate, toDate);
  const rows = await SalesReturnItem.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        profit: { $sum: { $ifNull: ["$profit", 0] } },
        line_count: { $sum: 1 },
      },
    },
    {
      $project: {
        _id: 0,
        profit: { $round: ["$profit", 2] },
        line_count: 1,
      },
    },
  ]);
  return {
    profit: rows[0]?.profit ?? 0,
    line_count: rows[0]?.line_count ?? 0,
  };
}

async function resolveCompanyDiscountAccountIds(companyId) {
  const cid = coalesceObjectId(companyId);
  const row = await Company.findById(cid)
    .select("default_sales_discount_account default_purchase_discount_account")
    .lean();
  return {
    salesDiscountId: coalesceObjectId(row?.default_sales_discount_account),
    purchaseDiscountId: coalesceObjectId(row?.default_purchase_discount_account),
  };
}

function discountAmountFromGlSums(transactionsSum, role) {
  if (!transactionsSum) return 0;
  if (role === "sales_discount") {
    return roundMoney2(transactionsSum.net_debit_minus_credit);
  }
  return roundMoney2(transactionsSum.credit_minus_debit);
}

async function sumPeriodDiscounts(companyId, fromDate, toDate) {
  const { salesDiscountId, purchaseDiscountId } =
    await resolveCompanyDiscountAccountIds(companyId);
  const accountIds = [salesDiscountId, purchaseDiscountId].filter(Boolean);
  if (!accountIds.length) {
    return {
      sales_discount: { amount: 0, account_id: null },
      purchase_discount: { amount: 0, account_id: null },
    };
  }

  const sumByAccount = await aggregatePeriodSumsByAccountIds(
    accountIds,
    coalesceObjectId(companyId),
    fromDate,
    toDate,
  );

  const accounts = await Account.find({ _id: { $in: accountIds } })
    .select("_id name account_number")
    .lean();
  const metaById = new Map(accounts.map((a) => [String(a._id), a]));

  const salesSums =
    salesDiscountId ?
      sumByAccount.get(String(salesDiscountId)) || null
    : null;
  const purchaseSums =
    purchaseDiscountId ?
      sumByAccount.get(String(purchaseDiscountId)) || null
    : null;

  const salesMeta = salesDiscountId ? metaById.get(String(salesDiscountId)) : null;
  const purchaseMeta =
    purchaseDiscountId ? metaById.get(String(purchaseDiscountId)) : null;

  return {
    sales_discount: {
      account_id: salesDiscountId ? String(salesDiscountId) : null,
      account_name: salesMeta?.name ?? null,
      amount: discountAmountFromGlSums(salesSums, "sales_discount"),
      transactions_sum: salesSums,
    },
    purchase_discount: {
      account_id: purchaseDiscountId ? String(purchaseDiscountId) : null,
      account_name: purchaseMeta?.name ?? null,
      amount: discountAmountFromGlSums(purchaseSums, "purchase_discount"),
      transactions_sum: purchaseSums,
    },
  };
}

/**
 * Combined income statement: operational document totals + period GL P&L.
 */
async function computeIncomeStatementDetailReport(companyId, fromDate, toDate) {
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

  const [
    glReport,
    grossSales,
    salesReturns,
    cogsSold,
    cogsOnReturns,
    orderProfit,
    salesReturnProfit,
    discounts,
  ] = await Promise.all([
    computeIncomeStatementReport(cid, fromDate, toDate),
    sumDocumentTotalAmount(cid, Order, fromDate, toDate, "order_status"),
    sumDocumentTotalAmount(cid, SalesReturn, fromDate, toDate, "return_status"),
    sumCogsSold(cid, fromDate, toDate),
    sumCogsOnSalesReturns(cid, fromDate, toDate),
    sumOrderProfit(cid, fromDate, toDate),
    sumSalesReturnProfit(cid, fromDate, toDate),
    sumPeriodDiscounts(cid, fromDate, toDate),
  ]);

  if (!glReport.ok) {
    return glReport;
  }

  const salesDiscountAmount = discounts.sales_discount.amount;
  const net_sales = roundMoney2(
    grossSales.total_amount - salesReturns.total_amount - salesDiscountAmount,
  );
  const net_cogs = roundMoney2(
    cogsSold.cost_of_goods_sold - cogsOnReturns.cost_of_goods_on_returns,
  );
  const gross_profit = roundMoney2(net_sales - net_cogs);
  const operating_expenses_total = glReport.operating_expenses.total;
  const other_expenses_total = glReport.other_expenses.total;
  const operating_income = roundMoney2(gross_profit - operating_expenses_total);
  const net_income = roundMoney2(operating_income - other_expenses_total);

  const combined_line_profit = roundMoney2(
    orderProfit.profit + salesReturnProfit.profit,
  );

  return {
    ok: true,
    company_id: cid,
    period: glReport.period,
    summary: {
      net_sales,
      net_cogs,
      gross_profit,
      operating_expenses: operating_expenses_total,
      operating_income,
      other_expenses: other_expenses_total,
      net_income,
      combined_line_profit,
    },
    operational: {
      revenue: {
        gross_sales: {
          total_amount: grossSales.total_amount,
          order_count: grossSales.document_count,
          source: "GET /api/order/sales",
        },
        sales_returns: {
          total_amount: salesReturns.total_amount,
          return_count: salesReturns.document_count,
          source: "GET /api/sales_return/sales",
        },
        sales_discounts: {
          amount: salesDiscountAmount,
          account_id: discounts.sales_discount.account_id,
          account_name: discounts.sales_discount.account_name,
          source: "GL default sales discount account (period)",
        },
        net_sales,
      },
      cost_of_goods_sold: {
        cogs_sold: {
          amount: cogsSold.cost_of_goods_sold,
          line_count: cogsSold.line_count,
          source: "GET /api/order_item/cost-of-goods-sold-by-order-item",
        },
        cogs_on_returns: {
          amount: cogsOnReturns.cost_of_goods_on_returns,
          line_count: cogsOnReturns.line_count,
          source: "sales_return_item cost_price_at_return × qty",
        },
        net_cogs,
      },
      gross_profit,
      profit_reconciliation: {
        order_profit: {
          profit: orderProfit.profit,
          line_count: orderProfit.line_count,
          source: "GET /api/order/profit-by-order-item",
        },
        sales_return_profit: {
          profit: salesReturnProfit.profit,
          line_count: salesReturnProfit.line_count,
          source: "GET /api/sales_return/profit-by-sales-return-item",
        },
        combined_line_profit,
        note:
          "combined_line_profit ≈ gross_profit when line pricing matches header totals",
      },
      operating_expenses: glReport.operating_expenses,
      operating_income,
      other_expenses: glReport.other_expenses,
      purchase_discounts: {
        amount: discounts.purchase_discount.amount,
        account_id: discounts.purchase_discount.account_id,
        account_name: discounts.purchase_discount.account_name,
        note: "Purchase discounts affect inventory cost, not net sales",
      },
      net_income,
    },
    general_ledger: {
      revenue: glReport.revenue,
      cost_of_goods_sold: glReport.cost_of_goods_sold,
      gross_profit: glReport.gross_profit,
      operating_expenses: glReport.operating_expenses,
      operating_income: glReport.operating_income,
      other_expenses: glReport.other_expenses,
      net_income: glReport.net_income,
      note: "Period GL totals from chart-of-accounts transactions",
    },
  };
}

module.exports = {
  computeIncomeStatementDetailReport,
};
