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

module.exports = {
  calendarMonthDateRange,
  currentMonthDateRange,
  lastMonthDateRange,
  last30DaysDateRange,
  resolveReportPeriodRange,
  periodResponse,
};
