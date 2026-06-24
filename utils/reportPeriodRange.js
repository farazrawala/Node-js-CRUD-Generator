/** Shared period helpers for dashboard / finance report APIs. */

function calendarMonthDateRange(year, month) {
  const fromDate = new Date(year, month, 1);
  const toDate = new Date(year, month + 1, 0, 23, 59, 59, 999);
  return { fromDate, toDate, year, month: month + 1 };
}

function currentMonthDateRange(refDate = new Date()) {
  const d = refDate instanceof Date ? refDate : new Date(refDate);
  return calendarMonthDateRange(d.getFullYear(), d.getMonth());
}

function lastMonthDateRange(refDate = new Date()) {
  const d = refDate instanceof Date ? refDate : new Date(refDate);
  const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  return calendarMonthDateRange(prev.getFullYear(), prev.getMonth());
}

function last30DaysDateRange(refDate = new Date()) {
  const d = refDate instanceof Date ? refDate : new Date(refDate);
  const toDate = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    23,
    59,
    59,
    999,
  );
  const fromDate = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() - 29,
    0,
    0,
    0,
    0,
  );
  return { fromDate, toDate };
}

const DEFAULT_RANGE_DAYS = 90;

/**
 * Resolve `period` or `from` / `to` from query.
 * @param {object} query
 * @param {{ defaultPeriod?: string, defaultRangeDays?: number }} [options]
 */
function resolveReportPeriodRange(query = {}, options = {}) {
  const defaultPeriod = options.defaultPeriod || "last_90_days";
  const defaultRangeDays = options.defaultRangeDays || DEFAULT_RANGE_DAYS;

  const hasFrom = query?.from != null && String(query.from).trim() !== "";
  const hasTo = query?.to != null && String(query.to).trim() !== "";

  if (hasFrom || hasTo) {
    const fromDate = hasFrom ? new Date(String(query.from).trim()) : null;
    const toDate = hasTo ? new Date(String(query.to).trim()) : new Date();
    if (hasFrom && Number.isNaN(fromDate.getTime())) {
      return {
        error: {
          status: 400,
          body: { success: false, status: 400, error: "Invalid from date" },
        },
      };
    }
    if (hasTo && Number.isNaN(toDate.getTime())) {
      return {
        error: {
          status: 400,
          body: { success: false, status: 400, error: "Invalid to date" },
        },
      };
    }
    if (hasFrom && hasTo && fromDate > toDate) {
      return {
        error: {
          status: 400,
          body: {
            success: false,
            status: 400,
            error: "Invalid date range",
            message: "`from` must be on or before `to`",
          },
        },
      };
    }
    if (!hasFrom) {
      const start = new Date(toDate);
      start.setDate(start.getDate() - defaultRangeDays);
      return { fromDate: start, toDate, periodLabel: "custom" };
    }
    return {
      fromDate,
      toDate: hasTo ? toDate : new Date(),
      periodLabel: "custom",
    };
  }

  const period = String(query?.period || defaultPeriod).trim().toLowerCase();
  if (
    period === "last_30_days" ||
    period === "last30days" ||
    period === "30_days"
  ) {
    const r = last30DaysDateRange();
    return {
      fromDate: r.fromDate,
      toDate: r.toDate,
      periodLabel: "last_30_days",
    };
  }
  if (period === "last_month") {
    const r = lastMonthDateRange();
    return {
      fromDate: r.fromDate,
      toDate: r.toDate,
      periodLabel: "last_month",
    };
  }
  if (period === "current_month") {
    const r = currentMonthDateRange();
    return {
      fromDate: r.fromDate,
      toDate: r.toDate,
      periodLabel: "current_month",
    };
  }

  const toDate = new Date();
  const fromDate = new Date(toDate);
  fromDate.setDate(fromDate.getDate() - defaultRangeDays);
  return { fromDate, toDate, periodLabel: "last_90_days" };
}

function periodResponse(label, fromDate, toDate) {
  return {
    label,
    from: fromDate.toISOString(),
    to: toDate.toISOString(),
  };
}

function formatLocalDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfLocalDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function roundMoney2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Monday-based week start for a local calendar date. */
function weekStartMonday(d) {
  const cur = startOfLocalDay(d);
  const day = cur.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  cur.setDate(cur.getDate() + diff);
  return cur;
}

/**
 * Zero-fill daily chart series from aggregation rows `{ date, total_amount, document_count }`.
 */
function buildDayWiseDocumentSeries(fromDate, toDate, aggregatedRows) {
  const byDate = new Map(
    (aggregatedRows || []).map((row) => [
      String(row.date),
      {
        total_amount: Number(row.total_amount) || 0,
        document_count: Number(row.document_count) || 0,
      },
    ]),
  );

  const days = [];
  const cur = startOfLocalDay(fromDate);
  const end = startOfLocalDay(toDate);
  let total_amount = 0;
  let document_count = 0;

  while (cur <= end) {
    const key = formatLocalDateKey(cur);
    const row = byDate.get(key);
    const dayTotal = row?.total_amount ?? 0;
    const dayCount = row?.document_count ?? 0;
    total_amount += dayTotal;
    document_count += dayCount;
    days.push({
      date: key,
      total_amount: roundMoney2(dayTotal),
      document_count: dayCount,
      average_amount:
        dayCount > 0 ? roundMoney2(dayTotal / dayCount) : 0,
    });
    cur.setDate(cur.getDate() + 1);
  }

  return {
    days,
    summary: {
      total_amount: roundMoney2(total_amount),
      document_count,
      average_amount:
        document_count > 0 ?
          roundMoney2(total_amount / document_count)
        : 0,
    },
  };
}

/** Roll daily purchase/sales points into Monday-start weeks. */
function rollupDailyToWeeklySeries(dailyRows) {
  const byWeek = new Map();

  for (const row of dailyRows || []) {
    const d = new Date(`${row.date}T00:00:00`);
    const weekStart = formatLocalDateKey(weekStartMonday(d));
    const existing = byWeek.get(weekStart) || {
      week_start: weekStart,
      total_amount: 0,
      document_count: 0,
    };
    existing.total_amount += Number(row.total_amount) || 0;
    existing.document_count += Number(row.document_count) || 0;
    byWeek.set(weekStart, existing);
  }

  return [...byWeek.values()]
    .sort((a, b) => a.week_start.localeCompare(b.week_start))
    .map((row) => ({
      week_start: row.week_start,
      total_amount: roundMoney2(row.total_amount),
      document_count: row.document_count,
      average_amount:
        row.document_count > 0 ?
          roundMoney2(row.total_amount / row.document_count)
        : 0,
    }));
}

module.exports = {
  calendarMonthDateRange,
  currentMonthDateRange,
  lastMonthDateRange,
  last30DaysDateRange,
  resolveReportPeriodRange,
  periodResponse,
  formatLocalDateKey,
  startOfLocalDay,
  roundMoney2,
  buildDayWiseDocumentSeries,
  rollupDailyToWeeklySeries,
};
