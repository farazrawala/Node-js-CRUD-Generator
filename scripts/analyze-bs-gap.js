require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { connectMonogodb } = require("../connection");

for (const file of fs
  .readdirSync(path.join(__dirname, "..", "models"))
  .filter((f) => f.endsWith(".js"))) {
  require(path.join(__dirname, "..", "models", file));
}

const round = (n) => Math.round(Number(n || 0) * 100) / 100;

async function main() {
  await connectMonogodb();
  const cid = new mongoose.Types.ObjectId(process.argv[2]);

  const OI = mongoose.model("order_item");
  const SRI = mongoose.model("sales_return_item");
  const Account = mongoose.model("account");
  const Txn = mongoose.model("transaction");
  const WI = mongoose.model("warehouse_inventory");
  const Product = mongoose.model("product");

  const accounts = await Account.find({
    company_id: cid,
    status: "active",
    deletedAt: null,
  })
    .select("_id name account_type")
    .lean();

  const orderProfit = await OI.aggregate([
    { $match: { company_id: cid, status: "active", deletedAt: null } },
    {
      $group: {
        _id: null,
        profit: { $sum: "$profit" },
        revenue: { $sum: { $multiply: ["$price", "$qty"] } },
        cost: { $sum: { $multiply: ["$cost_price_at_sale", "$qty"] } },
        lines: { $sum: 1 },
      },
    },
  ]);

  const srProfit = await SRI.aggregate([
    { $match: { company_id: cid, status: "active", deletedAt: null } },
    {
      $group: {
        _id: null,
        profit: { $sum: "$profit" },
        revenue: { $sum: { $multiply: ["$price", "$qty"] } },
        cost: { $sum: { $multiply: ["$cost_price_at_return", "$qty"] } },
        lines: { $sum: 1 },
      },
    },
  ]);

  const invRows = await WI.aggregate([
    {
      $match: {
        company_id: cid,
        quantity: { $gt: 0 },
        $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
      },
    },
    { $group: { _id: "$product_id", total_qty: { $sum: "$quantity" } } },
  ]);
  const products = await Product.find({
    _id: { $in: invRows.map((r) => r._id) },
    company_id: cid,
  })
    .select("wholesale_price product_name")
    .lean();
  const pmap = new Map(products.map((p) => [String(p._id), p]));
  let inventoryValue = 0;
  for (const row of invRows) {
    const p = pmap.get(String(row._id));
    inventoryValue += row.total_qty * (Number(p?.wholesale_price) || 0);
  }
  inventoryValue = round(inventoryValue);

  let salesRevenue = 0;
  let purchaseNetDebit = 0;
  let arBalance = 0;
  let apBalance = 0;

  for (const acc of accounts) {
    const rows = await Txn.aggregate([
      {
        $match: {
          company_id: cid,
          account_id: acc._id,
          deletedAt: null,
          status: "active",
        },
      },
      { $group: { _id: "$type", total: { $sum: "$amount" } } },
    ]);
    const debit = rows.find((r) => r._id === "debit")?.total || 0;
    const credit = rows.find((r) => r._id === "credit")?.total || 0;
    if (acc.account_type === "revenue") salesRevenue += credit - debit;
    if (acc.account_type === "cost_of_goods_sold_account")
      purchaseNetDebit += debit - credit;
    if (acc.account_type === "current_asset" && /receivable/i.test(acc.name))
      arBalance += debit - credit;
    if (acc.account_type === "current_liability" && /payable/i.test(acc.name))
      apBalance += credit - debit;
  }

  salesRevenue = round(salesRevenue);
  purchaseNetDebit = round(purchaseNetDebit);
  arBalance = round(arBalance);
  apBalance = round(apBalance);

  const cogsSold = round(purchaseNetDebit - inventoryValue);
  const glBridgedEquity = round(salesRevenue - cogsSold);
  const uiProfit = round(
    (orderProfit[0]?.profit || 0) + (srProfit[0]?.profit || 0),
  );
  const assets = round(arBalance + inventoryValue);
  const leGl = round(apBalance + glBridgedEquity);
  const leUi = round(apBalance + uiProfit);

  console.log(
    JSON.stringify(
      {
        order_item: orderProfit[0] || null,
        sales_return_item: srProfit[0] || null,
        inventory_value: inventoryValue,
        ar_balance: arBalance,
        ap_balance: apBalance,
        sales_revenue_gl: salesRevenue,
        purchase_net_debit: purchaseNetDebit,
        implied_cogs_sold: cogsSold,
        gl_bridged_equity: glBridgedEquity,
        ui_profit_sum: uiProfit,
        profit_vs_gl_gap: round(glBridgedEquity - uiProfit),
        assets,
        liabilities_equity_gl_bridged: leGl,
        gl_bridged_gap: round(assets - leGl),
        liabilities_equity_ui: leUi,
        ui_balance_sheet_gap: round(assets - leUi),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
