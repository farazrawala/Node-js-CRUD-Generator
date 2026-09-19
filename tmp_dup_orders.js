require("dotenv").config();
const mongoose = require("mongoose");

(async () => {
  await mongoose.connect(
    process.env.MONGODB_URI_LIVE || process.env.MONGODB_URI,
  );
  const companyId = new mongoose.Types.ObjectId("6a6bdbf06482efef8105e2ef");
  const from = new Date("2026-09-16T13:57:00.000Z");
  const to = new Date("2026-09-16T14:00:00.000Z");

  const processes = await mongoose.connection.db
    .collection("processes")
    .find({
      company_id: companyId,
      createdAt: { $gte: from, $lte: to },
    })
    .sort({ createdAt: 1 })
    .project({
      action: 1,
      status: 1,
      remarks: 1,
      createdAt: 1,
      updatedAt: 1,
      tags: 1,
    })
    .toArray();

  console.log(
    JSON.stringify(
      processes.map((p) => ({
        action: p.action,
        status: p.status,
        remarks: String(p.remarks || "").slice(0, 280),
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        tags: p.tags,
      })),
      null,
      2,
    ),
  );

  // Check unique index existence on orders
  const indexes = await mongoose.connection.db.collection("orders").indexes();
  console.log(
    "ORDER_INDEXES",
    indexes.map((i) => ({ name: i.name, key: i.key, unique: i.unique })),
  );

  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
