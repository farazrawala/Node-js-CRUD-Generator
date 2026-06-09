require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { connectMonogodb } = require("../connection");
const {
  computeBalanceSheetDifference,
} = require("../utils/balanceSheetReconcile");

const modelsPath = path.join(__dirname, "..", "models");
for (const file of fs.readdirSync(modelsPath).filter((f) => f.endsWith(".js"))) {
  require(path.join(modelsPath, file));
}

async function main() {
  await connectMonogodb();
  const cidArg = process.argv[2] || "6a27581c2e5bb6354b684183";
  const cid = new mongoose.Types.ObjectId(cidArg);

  const report = await computeBalanceSheetDifference(cid);
  console.log("\n=== Balance sheet equation ===");
  console.log(JSON.stringify(report.equation, null, 2));
  console.log("\n=== Diagnostics ===");
  console.log(JSON.stringify(report.diagnostics, null, 2));
  console.log("\n=== Inventory lines ===");
  console.log(report.assets.inventory.lines);

  const legacyCid = cid;
  const PO = mongoose.model("purchase_order");
  const POI = mongoose.model("purchase_order_item");
  const Txn = mongoose.model("transaction");
  const Product = mongoose.model("product");
  const WI = mongoose.model("warehouse_inventory");

  const pos = await PO.find({ company_id: legacyCid, deletedAt: null })
    .sort({ createdAt: -1 })
    .limit(5)
    .lean();
  console.log(
    "Recent POs:",
    pos.map((p) => ({
      id: String(p._id),
      no: p.purchase_order_no,
      lines_subtotal: p.lines_subtotal,
      total_amount: p.total_amount,
      amount_paid: p.amount_paid,
      discount: p.discount,
      shipment: p.shipment,
      txn: p.transaction_number,
    })),
  );

  let totalInventoryValue = 0;
  for (const po of pos) {
    const items = await POI.find({
      purchase_order_id: po._id,
      deletedAt: null,
    }).lean();
    console.log(`\n=== PO ${po.purchase_order_no} ===`);
    for (const it of items) {
      const calc = Math.round(it.qty * it.price * 100) / 100;
      console.log({
        product_id: String(it.product_id),
        qty: it.qty,
        price: it.price,
        subtotal: it.subtotal,
        qty_x_price: calc,
        diff: Math.round((it.subtotal - calc) * 100) / 100,
      });
    }
    const txns = await Txn.find({
      transaction_number: po.transaction_number,
      deletedAt: null,
    }).lean();
    console.log("GL txns:");
    for (const t of txns) {
      console.log({
        desc: t.description,
        type: t.type,
        amount: t.amount,
      });
    }
  }

  const products = await Product.find({ company_id: legacyCid, deletedAt: null })
    .select("product_name wholesale_price stock")
    .lean();
  const inv = await WI.aggregate([
    {
      $match: {
        company_id: legacyCid,
        quantity: { $gt: 0 },
        $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
      },
    },
    { $group: { _id: "$product_id", total_qty: { $sum: "$quantity" } } },
  ]);
  console.log("\n=== Inventory valuation (qty × wholesale_price) ===");
  for (const row of inv) {
    const p = products.find((x) => String(x._id) === String(row._id));
    const wp = Number(p?.wholesale_price) || 0;
    const val = Math.round(row.total_qty * wp * 100) / 100;
    totalInventoryValue += val;
    console.log({
      name: p?.product_name,
      qty: row.total_qty,
      wholesale_price: wp,
      inventory_value: val,
    });
  }
  console.log("Total inventory value:", Math.round(totalInventoryValue * 100) / 100);

  const apId = new mongoose.Types.ObjectId("6a272785216642e78e15d9d8");
  const apAgg = await Txn.aggregate([
    {
      $match: {
        company_id: legacyCid,
        account_id: apId,
        deletedAt: null,
        status: "active",
      },
    },
    {
      $group: {
        _id: "$type",
        total: { $sum: "$amount" },
      },
    },
  ]);
  const credit = apAgg.find((r) => r._id === "credit")?.total || 0;
  const debit = apAgg.find((r) => r._id === "debit")?.total || 0;
  const apBalance = Math.round((credit - debit) * 100) / 100;
  console.log("\n=== Accounts Payable ===");
  console.log({ credit, debit, ap_balance: apBalance });
  console.log(
    "Difference (inventory - AP):",
    Math.round((totalInventoryValue - apBalance) * 100) / 100,
  );

  const product1Id = new mongoose.Types.ObjectId("6a27278c216642e78e15da82");
  const p1 = await Product.findById(product1Id).lean();
  const p1inv = await WI.aggregate([
    {
      $match: {
        company_id: legacyCid,
        product_id: product1Id,
        $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
      },
    },
    { $group: { _id: null, total_qty: { $sum: "$quantity" } } },
  ]);
  const p1qty = p1inv[0]?.total_qty || 0;
  const p1val = Math.round(p1qty * Number(p1?.wholesale_price || 0) * 100) / 100;
  console.log("\n=== product 1 only ===");
  console.log({
    qty: p1qty,
    wholesale_price: p1?.wholesale_price,
    inventory_value: p1val,
  });

  const allItems = await POI.find({ company_id: legacyCid, deletedAt: null })
    .select("purchase_order_id product_id qty price subtotal")
    .lean();
  const mismatches = allItems
    .map((it) => {
      const calc = Math.round(it.qty * it.price * 100) / 100;
      const diff = Math.round((it.subtotal - calc) * 100) / 100;
      return { ...it, qty_x_price: calc, diff };
    })
    .filter((x) => Math.abs(x.diff) > 0.001);
  console.log("\nLine subtotal vs qty×price mismatches:", mismatches.length);
  if (mismatches.length) console.log(mismatches.slice(0, 10));

  const purchaseDebits = await Txn.aggregate([
    {
      $match: {
        company_id: legacyCid,
        description: "Purchase Order",
        type: "debit",
        deletedAt: null,
        status: "active",
      },
    },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);
  const purchaseDebitTotal = purchaseDebits[0]?.total || 0;
  console.log("\nTotal Purchase Order GL debits:", purchaseDebitTotal);
  console.log(
    "Purchase debit - inventory value:",
    Math.round((purchaseDebitTotal - totalInventoryValue) * 100) / 100,
  );

  const SR = mongoose.model("sales_return");
  const SRI = mongoose.model("sales_return_item");
  const srs = await SR.find({ company_id: legacyCid, deletedAt: null })
    .sort({ createdAt: -1 })
    .limit(3)
    .lean();
  console.log("\n=== Recent sales returns ===");
  for (const sr of srs) {
    console.log({
      no: sr.sales_return_no,
      lines_subtotal: sr.lines_subtotal,
      amount_paid: sr.amount_paid,
      total_amount: sr.total_amount,
      payment_account: String(sr.payment_method_accounts_id || ""),
      txn: sr.transaction_number,
    });
    const items = await SRI.find({
      sales_return_id: sr._id,
      deletedAt: null,
    }).lean();
    for (const it of items) {
      const calc = Math.round(it.qty * it.price * 100) / 100;
      console.log("  line", {
        qty: it.qty,
        price: it.price,
        subtotal: it.subtotal,
        qty_x_price: calc,
      });
    }
    const txns = await Txn.find({
      transaction_number: sr.transaction_number,
      deletedAt: null,
    }).lean();
    console.log("  GL:");
    let debits = 0;
    let credits = 0;
    for (const t of txns) {
      console.log(`    ${t.description}: ${t.type} ${t.amount}`);
      if (t.type === "debit") debits += t.amount;
      else credits += t.amount;
    }
    console.log("  txn balance debits-credits:", Math.round((debits - credits) * 100) / 100);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
