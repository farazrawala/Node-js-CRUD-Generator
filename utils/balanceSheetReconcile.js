const mongoose = require("mongoose");
const Account = require("../models/account");
const Transaction = require("../models/transaction");
const Product = require("../models/product");
const WarehouseInventory = require("../models/warehouse_inventory");
const PurchaseOrderItem = require("../models/purchase_order_item");
const { coalesceObjectId } = require("./modelHelper");

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

module.exports = {
  computeBalanceSheetDifference,
  roundMoney2,
};
