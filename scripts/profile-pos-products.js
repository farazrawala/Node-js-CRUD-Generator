/**
 * Profile GET /product/get-all-active-pos query steps.
 * Usage: node scripts/profile-pos-products.js [companyId]
 */
require("dotenv").config();
const mongoose = require("mongoose");
const { connectMonogodb, getMongoUri } = require("../connection");
const Product = require("../models/product");
require("../models/warehouse_inventory");
require("../models/warehouse");

function ms(start) {
  return `${(Date.now() - start).toFixed(0)}ms`;
}

async function main() {
  const companyIdArg = process.argv[2];
  await connectMonogodb(getMongoUri());

  const companySample = await Product.findOne({ deletedAt: null })
    .select("company_id")
    .lean();
  const companyId =
    companyIdArg && mongoose.Types.ObjectId.isValid(companyIdArg) ?
      new mongoose.Types.ObjectId(companyIdArg)
    : companySample?.company_id;

  if (!companyId) {
    console.error("No company_id found. Pass one: node scripts/profile-pos-products.js <companyId>");
    process.exit(1);
  }

  const filter = { deletedAt: null, company_id: companyId };
  const warehouseInventoryMatch = {
    status: "active",
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    company_id: companyId,
  };

  console.log("company_id:", String(companyId));
  console.log("filter:", JSON.stringify(filter));

  let t = Date.now();
  const total = await Product.countDocuments(filter);
  console.log(`countDocuments (POS filter): ${ms(t)} total=${total}`);

  t = Date.now();
  const activeTotal = await Product.countDocuments({ ...filter, status: "active" });
  console.log(`countDocuments (+ status active): ${ms(t)} total=${activeTotal}`);

  t = Date.now();
  const rows = await Product.find(filter)
    .sort({ createdAt: -1 })
    .skip(0)
    .limit(10)
    .lean();
  console.log(`find 10 (no populate): ${ms(t)} count=${rows.length}`);

  t = Date.now();
  const rowsPop = await Product.find(filter)
    .populate({
      path: "parent_product_id",
      select: "product_name",
    })
    .populate({
      path: "warehouse_inventory",
      match: warehouseInventoryMatch,
      select: "warehouse_id quantity status company_id",
      populate: {
        path: "warehouse_id",
        select: "name code",
      },
    })
    .sort({ createdAt: -1 })
    .skip(0)
    .limit(10);
  console.log(`find 10 (+ POS populate): ${ms(t)} count=${rowsPop.length}`);

  t = Date.now();
  const explain = await Product.find(filter)
    .sort({ createdAt: -1 })
    .limit(10)
    .explain("executionStats");
  const stats = explain?.executionStats || {};
  console.log("find explain:", {
    ms: ms(t),
    docsExamined: stats.totalDocsExamined,
    keysExamined: stats.totalKeysExamined,
    nReturned: stats.nReturned,
    stage: explain?.queryPlanner?.winningPlan?.inputStage?.stage,
    indexName: explain?.queryPlanner?.winningPlan?.inputStage?.indexName,
  });

  t = Date.now();
  const countExplain = await Product.countDocuments(filter).explain("executionStats");
  const cStats = countExplain?.executionStats || {};
  console.log("count explain:", {
    ms: ms(t),
    docsExamined: cStats.totalDocsExamined,
    keysExamined: cStats.totalKeysExamined,
    stage: countExplain?.queryPlanner?.winningPlan?.inputStage?.stage,
    indexName: countExplain?.queryPlanner?.winningPlan?.inputStage?.indexName,
  });

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
