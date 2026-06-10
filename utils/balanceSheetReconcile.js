const mongoose = require("mongoose");
const Account = require("../models/account");
const Transaction = require("../models/transaction");
const Product = require("../models/product");
const WarehouseInventory = require("../models/warehouse_inventory");
const PurchaseOrderItem = require("../models/purchase_order_item");
const OrderItem = require("../models/order_item");
const SalesReturnItem = require("../models/sales_return_item");
const { coalesceObjectId } = require("./modelHelper");

const GL_POOL_ACCOUNT_TYPES = new Set([
  "revenue",
  "cost_of_goods_sold_account",
]);

const ASSET_ACCOUNT_TYPES = new Set(["current_asset", "fixed_asset"]);
const LIABILITY_ACCOUNT_TYPES = new Set([
  "current_liability",
  "long_term_liability",
]);
const EQUITY_SECTION_ACCOUNT_TYPES = new Set([
  "equity",
  "revenue",
  "operating_expense",
  "other_expense",
  "cost_of_goods_sold_account",
  "other",
]);

function roundMoney2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function activeAccountFilter(companyId) {
  return {
    company_id: companyId,
    status: "active",
    deletedAt: null,
  };
}

/** Per-account GL totals (debit/credit convention matches `fetchAccountsByType`). */
async function aggregateTransactionSumsByAccountIds(accountIds, companyId) {
  if (!accountIds.length) return new Map();

  const match = {
    account_id: { $in: accountIds },
    deletedAt: null,
    status: "active",
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

/** Signed balance for balance-sheet presentation. */
function signedBalanceForAccountType(accountType, sums) {
  const s = sums || {
    net_debit_minus_credit: 0,
    credit_minus_debit: 0,
  };
  if (ASSET_ACCOUNT_TYPES.has(accountType)) {
    return roundMoney2(s.net_debit_minus_credit);
  }
  if (LIABILITY_ACCOUNT_TYPES.has(accountType)) {
    return roundMoney2(s.credit_minus_debit);
  }
  if (accountType === "revenue" || accountType === "equity") {
    return roundMoney2(s.credit_minus_debit);
  }
  if (
    accountType === "operating_expense" ||
    accountType === "other_expense" ||
    accountType === "cost_of_goods_sold_account" ||
    accountType === "other"
  ) {
    return roundMoney2(-s.net_debit_minus_credit);
  }
  return roundMoney2(s.credit_minus_debit);
}

async function computeInventoryValuation(companyId) {
  const invRows = await WarehouseInventory.aggregate([
    {
      $match: {
        company_id: companyId,
        quantity: { $gt: 0 },
        $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
      },
    },
    {
      $group: {
        _id: "$product_id",
        total_qty: { $sum: "$quantity" },
      },
    },
    { $sort: { total_qty: -1 } },
  ]);

  if (!invRows.length) {
    return { lines: [], total: 0 };
  }

  const productIds = invRows.map((r) => r._id);
  const products = await Product.find({
    _id: { $in: productIds },
    company_id: companyId,
    status: "active",
    deletedAt: null,
  })
    .select("product_name product_code sku wholesale_price")
    .lean();

  const productById = new Map(products.map((p) => [String(p._id), p]));
  const lines = [];
  let total = 0;

  for (const row of invRows) {
    const productDoc = productById.get(String(row._id));
    if (!productDoc) continue;
    const qty = Math.max(0, Number(row.total_qty) || 0);
    const wholesaleUnit = Number(productDoc.wholesale_price);
    const wholesale_price =
      Number.isFinite(wholesaleUnit) ? wholesaleUnit : 0;
    const cost_of_goods_available = roundMoney2(qty * wholesale_price);
    total = roundMoney2(total + cost_of_goods_available);
    lines.push({
      product_id: row._id,
      product_name: productDoc.product_name,
      product_code: productDoc.product_code,
      sku: productDoc.sku,
      total_qty: qty,
      wholesale_price,
      inventory_value: cost_of_goods_available,
    });
  }

  return { lines, total: roundMoney2(total) };
}

async function findLineSubtotalMismatches(companyId, limit = 20) {
  const items = await PurchaseOrderItem.find({
    company_id: companyId,
    deletedAt: null,
  })
    .select("purchase_order_id product_id qty price subtotal")
    .limit(500)
    .lean();

  return items
    .map((it) => {
      const qty_x_price = roundMoney2(it.qty * it.price);
      const diff = roundMoney2(it.subtotal - qty_x_price);
      return {
        purchase_order_id: it.purchase_order_id,
        product_id: it.product_id,
        qty: it.qty,
        price: it.price,
        subtotal: it.subtotal,
        qty_x_price,
        diff,
      };
    })
    .filter((x) => Math.abs(x.diff) > 0.001)
    .slice(0, limit);
}

async function aggregateLineProfitSums(companyId) {
  const lineMatch = {
    company_id: companyId,
    status: "active",
    deletedAt: null,
  };

  const [orderRows, srRows] = await Promise.all([
    OrderItem.aggregate([
      { $match: lineMatch },
      {
        $group: {
          _id: null,
          profit: { $sum: { $ifNull: ["$profit", 0] } },
          line_count: { $sum: 1 },
        },
      },
    ]),
    SalesReturnItem.aggregate([
      { $match: lineMatch },
      {
        $group: {
          _id: null,
          profit: { $sum: { $ifNull: ["$profit", 0] } },
          line_count: { $sum: 1 },
        },
      },
    ]),
  ]);

  const profitFromOrders = roundMoney2(orderRows[0]?.profit || 0);
  const profitFromSalesReturns = roundMoney2(srRows[0]?.profit || 0);

  return {
    profit_from_orders: profitFromOrders,
    profit_from_sales_returns: profitFromSalesReturns,
    line_profit_total: roundMoney2(profitFromOrders + profitFromSalesReturns),
    order_line_count: orderRows[0]?.line_count || 0,
    sales_return_line_count: srRows[0]?.line_count || 0,
  };
}

function computeGlBridgedEquity(accounts, sumByAccount, inventoryValue) {
  let salesRevenueBalance = 0;
  let purchaseAccountNetDebit = 0;

  for (const acc of accounts) {
    const sums = sumByAccount.get(String(acc._id));
    if (acc.account_type === "revenue") {
      salesRevenueBalance = roundMoney2(
        salesRevenueBalance + signedBalanceForAccountType("revenue", sums),
      );
    } else if (acc.account_type === "cost_of_goods_sold_account") {
      purchaseAccountNetDebit = roundMoney2(
        purchaseAccountNetDebit + (sums?.net_debit_minus_credit || 0),
      );
    }
  }

  const impliedCogsSold = roundMoney2(
    purchaseAccountNetDebit - inventoryValue,
  );
  const glBridgedEquity = roundMoney2(
    salesRevenueBalance - impliedCogsSold,
  );

  return {
    sales_revenue_gl_balance: salesRevenueBalance,
    purchase_account_net_debit: purchaseAccountNetDebit,
    implied_cogs_sold: impliedCogsSold,
    gl_bridged_equity: glBridgedEquity,
  };
}

function partitionEquityAccounts(equitySection) {
  const glPoolAccounts = [];
  const otherEquityAccounts = [];

  for (const row of equitySection) {
    if (GL_POOL_ACCOUNT_TYPES.has(row.account_type)) {
      glPoolAccounts.push(row);
    } else {
      otherEquityAccounts.push(row);
    }
  }

  return { glPoolAccounts, otherEquityAccounts };
}

async function sumPurchaseOrderGlDebits(companyId) {
  const rows = await Transaction.aggregate([
    {
      $match: {
        company_id: companyId,
        description: "Purchase Order",
        type: "debit",
        deletedAt: null,
        status: "active",
      },
    },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);
  return roundMoney2(rows[0]?.total || 0);
}

/**
 * Build balance-sheet totals and equation check for one tenant.
 * Inventory is operational (qty × wholesale_price), not the purchase GL debit account.
 *
 * @param {import("mongoose").Types.ObjectId|string} companyId
 * @returns {Promise<object>}
 */
async function computeBalanceSheetDifference(companyId) {
  const cid = coalesceObjectId(companyId);
  if (!cid || !mongoose.Types.ObjectId.isValid(String(cid))) {
    return { ok: false, status: 400, error: "Valid company_id is required" };
  }

  const accounts = await Account.find(activeAccountFilter(cid))
    .select("_id name account_type")
    .sort({ account_type: 1, name: 1 })
    .lean();

  const accountIds = accounts.map((a) => a._id);
  const sumByAccount = await aggregateTransactionSumsByAccountIds(
    accountIds,
    cid,
  );

  const currentAssets = [];
  const fixedAssets = [];
  const currentLiabilities = [];
  const longTermLiabilities = [];
  const equitySection = [];

  for (const acc of accounts) {
    const sums = sumByAccount.get(String(acc._id));
    const balance = signedBalanceForAccountType(acc.account_type, sums);
    const row = {
      account_id: acc._id,
      name: acc.name,
      account_type: acc.account_type,
      balance,
      transactions_sum: sums || null,
    };

    if (acc.account_type === "current_asset") currentAssets.push(row);
    else if (acc.account_type === "fixed_asset") fixedAssets.push(row);
    else if (acc.account_type === "current_liability") {
      currentLiabilities.push(row);
    } else if (acc.account_type === "long_term_liability") {
      longTermLiabilities.push(row);
    } else if (EQUITY_SECTION_ACCOUNT_TYPES.has(acc.account_type)) {
      equitySection.push(row);
    }
  }

  const sumBalances = (rows) =>
    roundMoney2(rows.reduce((t, r) => t + r.balance, 0));

  const inventory = await computeInventoryValuation(cid);
  const currentAssetsTotal = sumBalances(currentAssets);
  const fixedAssetsTotal = sumBalances(fixedAssets);
  const inventoryTotal = inventory.total;
  const totalAssets = roundMoney2(
    currentAssetsTotal + inventoryTotal + fixedAssetsTotal,
  );

  const currentLiabilitiesTotal = sumBalances(currentLiabilities);
  const longTermLiabilitiesTotal = sumBalances(longTermLiabilities);
  const equitySectionTotal = sumBalances(equitySection);
  const totalLiabilitiesEquity = roundMoney2(
    currentLiabilitiesTotal +
      longTermLiabilitiesTotal +
      equitySectionTotal,
  );

  const difference = roundMoney2(totalAssets - totalLiabilitiesEquity);
  const purchaseGlDebitTotal = await sumPurchaseOrderGlDebits(cid);
  const lineSubtotalMismatches = await findLineSubtotalMismatches(cid);

  return {
    ok: true,
    company_id: cid,
    assets: {
      current_assets: {
        accounts: currentAssets,
        total: currentAssetsTotal,
      },
      inventory: {
        lines: inventory.lines,
        total: inventoryTotal,
      },
      fixed_assets: {
        accounts: fixedAssets,
        total: fixedAssetsTotal,
      },
      total: totalAssets,
    },
    liabilities_equity: {
      current_liabilities: {
        accounts: currentLiabilities,
        total: currentLiabilitiesTotal,
      },
      long_term_liabilities: {
        accounts: longTermLiabilities,
        total: longTermLiabilitiesTotal,
      },
      owners_equity: {
        accounts: equitySection,
        total: equitySectionTotal,
      },
      total: totalLiabilitiesEquity,
    },
    equation: {
      assets: totalAssets,
      liabilities_plus_equity: totalLiabilitiesEquity,
      difference,
      balanced: Math.abs(difference) < 0.02,
      status:
        Math.abs(difference) < 0.02 ? "balanced"
        : difference < 0 ? "out_of_balance_liabilities_high"
        : "out_of_balance_assets_high",
    },
    diagnostics: {
      inventory_value: inventoryTotal,
      purchase_order_gl_debit_total: purchaseGlDebitTotal,
      inventory_vs_purchase_gl_debit: roundMoney2(
        inventoryTotal - purchaseGlDebitTotal,
      ),
      inventory_vs_accounts_payable:
        currentLiabilities.find((a) =>
          /payable/i.test(String(a.name || "")),
        ) ?
          roundMoney2(
            inventoryTotal -
              currentLiabilities.find((a) => /payable/i.test(String(a.name)))
                .balance,
          )
        : null,
      line_subtotal_vs_qty_price_mismatch_count: lineSubtotalMismatches.length,
      line_subtotal_mismatches: lineSubtotalMismatches,
      notes: [
        "Inventory uses warehouse qty × product.wholesale_price (not purchase GL debits).",
        "A non-zero difference often means line subtotal ≠ qty×price or weighted wholesale ≠ invoice amount.",
      ],
    },
  };
}

/**
 * Full balance-sheet payload for UI: assets, liabilities, equity rows, line profits,
 * GL-bridged equity, and out-of-balance summary.
 *
 * @param {import("mongoose").Types.ObjectId|string} companyId
 * @returns {Promise<object>}
 */
async function computeBalanceSheetReport(companyId) {
  const base = await computeBalanceSheetDifference(companyId);
  if (!base.ok) return base;

  const cid = base.company_id;
  const lineProfits = await aggregateLineProfitSums(cid);

  const accounts = await Account.find(activeAccountFilter(cid))
    .select("_id name account_type")
    .lean();
  const sumByAccount = await aggregateTransactionSumsByAccountIds(
    accounts.map((a) => a._id),
    cid,
  );
  const glBridgeAccurate = computeGlBridgedEquity(
    accounts,
    sumByAccount,
    base.assets.inventory.total,
  );

  const { glPoolAccounts, otherEquityAccounts } = partitionEquityAccounts(
    base.liabilities_equity.owners_equity.accounts,
  );
  const otherEquityTotal = roundMoney2(
    otherEquityAccounts.reduce((t, r) => t + r.balance, 0),
  );
  const ownersEquityLineProfitSubtotal = roundMoney2(
    lineProfits.line_profit_total + otherEquityTotal,
  );

  const currentLiabilitiesTotal = base.liabilities_equity.current_liabilities.total;
  const longTermLiabilitiesTotal =
    base.liabilities_equity.long_term_liabilities.total;
  const liabilitiesTotal = roundMoney2(
    currentLiabilitiesTotal + longTermLiabilitiesTotal,
  );

  const totalLiabilitiesEquityLineProfit = roundMoney2(
    liabilitiesTotal + ownersEquityLineProfitSubtotal,
  );
  const totalLiabilitiesEquityGlBridged = roundMoney2(
    liabilitiesTotal + glBridgeAccurate.gl_bridged_equity,
  );

  const outOfBalanceLineProfit = roundMoney2(
    base.assets.total - totalLiabilitiesEquityLineProfit,
  );
  const outOfBalanceGlBridged = roundMoney2(
    base.assets.total - totalLiabilitiesEquityGlBridged,
  );
  const profitVsGlGap = roundMoney2(
    glBridgeAccurate.gl_bridged_equity - lineProfits.line_profit_total,
  );

  return {
    ok: true,
    company_id: cid,
    as_of: new Date().toISOString(),
    assets: {
      current_assets: {
        label: "Current Assets",
        accounts: base.assets.current_assets.accounts.map((row) => ({
          account_id: row.account_id,
          name: row.name,
          balance: row.balance,
        })),
        subtotal: base.assets.current_assets.total,
      },
      inventory: {
        label: "Inventory",
        lines: base.assets.inventory.lines,
        subtotal: base.assets.inventory.total,
      },
      fixed_assets: {
        label: "Fixed Assets",
        accounts: base.assets.fixed_assets.accounts.map((row) => ({
          account_id: row.account_id,
          name: row.name,
          balance: row.balance,
        })),
        subtotal: base.assets.fixed_assets.total,
      },
      total: base.assets.total,
    },
    liabilities_and_equity: {
      current_liabilities: {
        label: "Current Liabilities",
        accounts: base.liabilities_equity.current_liabilities.accounts.map(
          (row) => ({
            account_id: row.account_id,
            name: row.name,
            balance: row.balance,
          }),
        ),
        subtotal: currentLiabilitiesTotal,
      },
      long_term_liabilities: {
        label: "Long-Term Liabilities",
        accounts: base.liabilities_equity.long_term_liabilities.accounts.map(
          (row) => ({
            account_id: row.account_id,
            name: row.name,
            balance: row.balance,
          }),
        ),
        subtotal: longTermLiabilitiesTotal,
      },
      owners_equity: {
        label: "Owner's Equity",
        profit_from_orders: {
          label: "Profit",
          amount: lineProfits.profit_from_orders,
          line_count: lineProfits.order_line_count,
          source: "order_item.profit",
        },
        profit_from_sales_returns: {
          label: "Sales Return Profit",
          amount: lineProfits.profit_from_sales_returns,
          line_count: lineProfits.sales_return_line_count,
          source: "sales_return_item.profit",
        },
        other_accounts: otherEquityAccounts.map((row) => ({
          account_id: row.account_id,
          name: row.name,
          account_type: row.account_type,
          balance: row.balance,
        })),
        gl_pool_accounts: glPoolAccounts.map((row) => ({
          account_id: row.account_id,
          name: row.name,
          account_type: row.account_type,
          balance: row.balance,
        })),
        subtotal_line_profit_method: ownersEquityLineProfitSubtotal,
        gl_bridged_equity: glBridgeAccurate.gl_bridged_equity,
        gl_bridge: glBridgeAccurate,
      },
      total_line_profit_method: totalLiabilitiesEquityLineProfit,
      total_gl_bridged_method: totalLiabilitiesEquityGlBridged,
    },
    summary: {
      total_assets: base.assets.total,
      total_liabilities_and_equity: totalLiabilitiesEquityLineProfit,
      out_of_balance: outOfBalanceLineProfit,
      balanced: Math.abs(outOfBalanceLineProfit) < 0.02,
      status:
        Math.abs(outOfBalanceLineProfit) < 0.02 ? "balanced"
        : outOfBalanceLineProfit < 0 ?
          "out_of_balance_liabilities_high"
        : "out_of_balance_assets_high",
      total_liabilities_and_equity_gl_bridged: totalLiabilitiesEquityGlBridged,
      out_of_balance_gl_bridged: outOfBalanceGlBridged,
      gl_bridged_balanced: Math.abs(outOfBalanceGlBridged) < 0.02,
      profit_vs_gl_gap: profitVsGlGap,
      profit_reconciliation_aligned: Math.abs(profitVsGlGap) < 0.02,
    },
    diagnostics: base.diagnostics,
  };
}

module.exports = {
  computeBalanceSheetDifference,
  computeBalanceSheetReport,
  roundMoney2,
};
