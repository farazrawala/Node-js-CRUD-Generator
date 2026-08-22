/**
 * Order analytics helpers for admin Orders chart (APP_TZ, default Asia/Karachi).
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

/** YYYY-MM-DD list ending at endLabel, length = days (calendar days). */
function buildDateKeys(endLabel, days) {
  const [y, m, d] = String(endLabel)
    .split("-")
    .map((n) => Number(n));
  const endUtc = Date.UTC(y, m - 1, d);
  const keys = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const dt = new Date(endUtc - i * 24 * 60 * 60 * 1000);
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(dt.getUTCDate()).padStart(2, "0");
    keys.push(`${yy}-${mm}-${dd}`);
  }
  return keys;
}

function formatShortDate(isoDate) {
  const [y, m, d] = String(isoDate).split("-").map(Number);
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${months[m - 1]} ${d}`;
}

function formatLongDate(isoDate) {
  const [y, m, d] = String(isoDate).split("-").map(Number);
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${months[m - 1]} ${d}, ${y}`;
}

const LINE_COLORS = [
  "#2563eb",
  "#059669",
  "#d97706",
  "#dc2626",
  "#7c3aed",
  "#0891b2",
  "#db2777",
  "#4f46e5",
  "#0d9488",
  "#ca8a04",
  "#e11d48",
  "#6366f1",
  "#14b8a6",
  "#f97316",
  "#8b5cf6",
];

function colorForIndex(i) {
  return LINE_COLORS[i % LINE_COLORS.length];
}

/**
 * Multi-series daily order counts for the last `days` days (today inclusive).
 * Fills missing company/day pairs with 0.
 */
async function getOrdersDailyTrendByCompany(
  Order,
  Company,
  { days = 30 } = {},
) {
  const safeDays = Math.min(90, Math.max(1, Number(days) || 30));
  const today = getTodayBounds();
  const { end, label: todayLabel, timeZone } = today;
  const rangeStart = new Date(
    today.start.getTime() - (safeDays - 1) * 24 * 60 * 60 * 1000,
  );
  const prevStart = new Date(
    rangeStart.getTime() - safeDays * 24 * 60 * 60 * 1000,
  );
  const dateKeys = buildDateKeys(todayLabel, safeDays);
  const labelsShort = dateKeys.map(formatShortDate);
  const labelsLong = dateKeys.map(formatLongDate);

  // Prefer deletedAt: null so Mongo can use partial indexes on orders.
  const activeFilter = { deletedAt: null };

  const [companies, grouped, prevTotal] = await Promise.all([
    Company.find(activeFilter)
      .select("_id company_name")
      .sort({ company_name: 1 })
      .lean(),
    Order.aggregate([
      {
        $match: {
          deletedAt: null,
          createdAt: { $gte: rangeStart, $lt: end },
        },
      },
      {
        $group: {
          _id: {
            companyId: "$company_id",
            date: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$createdAt",
                timezone: timeZone,
              },
            },
          },
          orders: { $sum: 1 },
        },
      },
    ]),
    Order.countDocuments({
      deletedAt: null,
      createdAt: { $gte: prevStart, $lt: rangeStart },
    }),
  ]);

  const counts = new Map();
  for (const row of grouped) {
    const cid = row._id?.companyId ? String(row._id.companyId) : "";
    const date = row._id?.date;
    if (!date) continue;
    counts.set(`${cid}|${date}`, Number(row.orders) || 0);
  }

  const series = companies.map((c, index) => {
    const companyId = String(c._id);
    const companyName = c.company_name || "Unnamed";
    const data = dateKeys.map((date) => ({
      date,
      orders: counts.get(`${companyId}|${date}`) || 0,
    }));
    const total = data.reduce((sum, p) => sum + p.orders, 0);
    return {
      companyId,
      companyName,
      color: colorForIndex(index),
      total,
      data,
      points: data.map((p) => p.orders),
    };
  });

  // Include unassigned company_id only if it had orders in range
  const unassignedTotal = dateKeys.reduce(
    (sum, date) => sum + (counts.get(`|${date}`) || 0),
    0,
  );
  if (unassignedTotal > 0) {
    const data = dateKeys.map((date) => ({
      date,
      orders: counts.get(`|${date}`) || 0,
    }));
    series.push({
      companyId: "",
      companyName: "No Company",
      color: colorForIndex(series.length),
      total: unassignedTotal,
      data,
      points: data.map((p) => p.orders),
    });
  }

  const totalOrders = series.reduce((sum, s) => sum + s.total, 0);
  const ordersToday = series.reduce((sum, s) => {
    const last = s.data[s.data.length - 1];
    return sum + (last ? last.orders : 0);
  }, 0);
  const activeCompanies = series.filter((s) => s.total > 0).length;
  const avgOrdersPerDay =
    safeDays > 0 ? Math.round((totalOrders / safeDays) * 10) / 10 : 0;

  let topCompany = null;
  for (const s of series) {
    if (!topCompany || s.total > topCompany.total) {
      topCompany = { companyName: s.companyName, total: s.total };
    }
  }
  if (topCompany && topCompany.total === 0) topCompany = null;

  let growthPct = null;
  if (prevTotal > 0) {
    growthPct = Math.round(((totalOrders - prevTotal) / prevTotal) * 1000) / 10;
  } else if (totalOrders > 0) {
    growthPct = 100;
  } else {
    growthPct = 0;
  }

  return {
    days: safeDays,
    timeZone,
    todayLabel,
    dateKeys,
    labelsShort,
    labelsLong,
    series,
    summary: {
      totalOrders,
      ordersToday,
      activeCompanies,
      companyCount: series.length,
      avgOrdersPerDay,
      topCompany,
      previousPeriodOrders: prevTotal,
      growthPct,
    },
  };
}

/** @deprecated Prefer getOrdersDailyTrendByCompany — kept for compatibility */
async function getTodayOrdersByCompanyChart(Order, Company) {
  const trend = await getOrdersDailyTrendByCompany(Order, Company, { days: 1 });
  return {
    dateLabel: trend.todayLabel,
    timeZone: trend.timeZone,
    totalOrders: trend.summary.ordersToday,
    totalAmount: 0,
    labels: trend.series.map((s) => s.companyName),
    counts: trend.series.map((s) => s.points[0] || 0),
    amounts: trend.series.map(() => 0),
    rows: trend.series.map((s) => ({
      companyId: s.companyId,
      companyName: s.companyName,
      count: s.points[0] || 0,
      totalAmount: 0,
    })),
  };
}

module.exports = {
  getTodayBounds,
  buildDateKeys,
  getTodayOrdersByCompanyChart,
  getOrdersDailyTrendByCompany,
};
