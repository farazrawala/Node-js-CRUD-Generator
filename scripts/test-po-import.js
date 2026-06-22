require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

fs.readdirSync(path.join(__dirname, "../models"))
  .filter((f) => f.endsWith(".js"))
  .forEach((f) => require(path.join(__dirname, "../models", f)));

const { connectMonogodb } = require("../connection");
const User = require("../models/user");
const { setUserToken } = require("../service/auth");
const { importPurchaseOrderFromText } = require("../utils/purchaseOrderCsvImport");
const { buildUserCompanyPopulate, normalizePopulatedCompanyForClient } = require("../utils/userCompanyPopulate");

async function main() {
  await connectMonogodb();
  const user = await User.findOne({
    company_id: "6a36b6ebaae26f7394a21567",
    role: { $elemMatch: { $regex: /ADMIN/i } },
  })
    .populate([buildUserCompanyPopulate()])
    .lean();

  let actor = user;
  if (!actor) {
    actor = await User.findById("6a36b6ebaae26f7394a2156b")
      .populate([buildUserCompanyPopulate()])
      .lean();
  }
  if (actor?.company_id && typeof actor.company_id === "object") {
    normalizePopulatedCompanyForClient(actor.company_id);
  }

  const csv = fs.readFileSync("Final_pos_6.255.csv", "utf8");
  const req = {
    user: actor,
    headers: { authorization: `Bearer ${setUserToken(actor).token}` },
    path: "/api/purchase_order/import",
    method: "POST",
  };

  const result = await importPurchaseOrderFromText(csv, {
    companyId: "6a36b6ebaae26f7394a21567",
    req,
    options: { updateProductPrices: false },
  });

  console.log(
    JSON.stringify(
      {
        summary: result.summary,
        po: {
          success: result.purchase_order?.success,
          purchase_order_no: result.purchase_order?.purchase_order_no,
          line_count: result.purchase_order?.line_count,
          message: result.purchase_order?.message,
        },
      },
      null,
      2,
    ),
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
