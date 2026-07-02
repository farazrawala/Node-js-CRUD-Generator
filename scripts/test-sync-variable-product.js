require("dotenv").config();
process.env.APP_ENV = "live";

const mongoose = require("mongoose");
const { getMongoUri } = require("../connection");
const Process = require("../models/process");
const Product = require("../models/product");
const Integration = require("../models/integration");
const { runProcessExecution } = require("../controllers/process");

async function main() {
  await mongoose.connect(getMongoUri());

  const productId = process.argv[2] || "6a4596b89a34436b09276582";
  const integration = await Integration.findById("6a459115b30edf118f8ba68d").lean();
  const product = await Product.findById(productId).lean();

  const proc = await Process.create({
    integration_id: integration._id,
    product_id: product._id,
    action: "sync_product",
    company_id: product.company_id,
    created_by: "6a458d9c1ca7456beb274b7c",
    status: "active",
    progress: "not_started",
    priority: 1,
    limit: 1,
    page: 1,
    remarks: "Test variable product sync",
  });

  const req = {
    params: { id: String(proc._id) },
    query: {},
    user: { company_id: product.company_id, _id: proc.created_by },
  };

  const result = await runProcessExecution(req);
  console.log(JSON.stringify(result, null, 2));
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
