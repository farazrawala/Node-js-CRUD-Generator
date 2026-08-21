/**
 * Start/end of "today" in APP_TZ (default Asia/Karachi) as UTC Dates for Mongo queries.
 */
function getTodayBounds(timeZone = process.env.APP_TZ || "Asia/Karachi") {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    fmt
      .formatToParts(now)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value]),
  );

  // Local wall-clock "now" in the target zone, expressed as a UTC timestamp fake
  const asUtcNow = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const offsetMs = asUtcNow - now.getTime();

  const startLocalUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    0,
    0,
    0,
    0,
  );
  const start = new Date(startLocalUtc - offsetMs);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  const label = `${parts.year}-${parts.month}-${parts.day}`;
  return { start, end, label, timeZone };
}

/**
 * Today's order counts per company (includes companies with zero orders).
 */
async function getTodayOrdersByCompanyChart(Order, Company) {
  const { start, end, label, timeZone } = getTodayBounds();

  const [companies, grouped] = await Promise.all([
    Company.find({
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    })
      .select("_id company_name")
      .sort({ company_name: 1 })
      .lean(),
    Order.aggregate([
      {
        $match: {
          createdAt: { $gte: start, $lt: end },
          $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
        },
      },
      {
        $group: {
          _id: "$company_id",
          count: { $sum: 1 },
          totalAmount: { $sum: { $ifNull: ["$total_amount", 0] } },
        },
      },
    ]),
  ]);

  const byId = new Map(
    grouped.map((row) => [
      row._id ? String(row._id) : "",
      {
        count: row.count || 0,
        totalAmount: Number(row.totalAmount) || 0,
      },
    ]),
  );

  const rows = companies.map((c) => {
    const id = String(c._id);
    const stats = byId.get(id) || { count: 0, totalAmount: 0 };
    return {
      companyId: id,
      companyName: c.company_name || "Unnamed",
      count: stats.count,
      totalAmount: stats.totalAmount,
    };
  });

  // Orders with no company_id
  const unassigned = byId.get("") || byId.get("null");
  if (unassigned && unassigned.count > 0) {
    rows.push({
      companyId: "",
      companyName: "No Company",
      count: unassigned.count,
      totalAmount: unassigned.totalAmount,
    });
  }

  const totalOrders = rows.reduce((sum, r) => sum + r.count, 0);
  const totalAmount = rows.reduce((sum, r) => sum + r.totalAmount, 0);

  return {
    dateLabel: label,
    timeZone,
    totalOrders,
    totalAmount,
    labels: rows.map((r) => r.companyName),
    counts: rows.map((r) => r.count),
    amounts: rows.map((r) => Math.round(r.totalAmount * 100) / 100),
    rows,
  };
}

module.exports = {
  getTodayBounds,
  getTodayOrdersByCompanyChart,
};
