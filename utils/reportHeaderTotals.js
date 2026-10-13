const mongoose = require("mongoose");
const { coalesceObjectId } = require("./modelHelper");

const DEFAULT_REPORT_RANGE_DAYS = 365;

/**
 * Resolve tenant company from authenticated user.
 * @returns {{ cid: import('mongoose').Types.ObjectId } | { error: object }}
 */
function resolveReportCompanyFromReq(req) {
  const rawCompany = req.user?.company_id;
  const companyId =
    rawCompany && typeof rawCompany === "object" && rawCompany._id ?
      rawCompany._id
    : rawCompany;
  if (!companyId) {
    return {
      error: {
        status: 400,
        body: {
          success: false,
          status: 400,
          error: "company_id is required",
          message: "Authentication with company context is required",
        },
      },
    };
  }
  const companyObjectId = coalesceObjectId(companyId);
  if (
    !companyObjectId ||
    !mongoose.Types.ObjectId.isValid(String(companyObjectId))
  ) {
    return {
      error: {
        status: 400,
        body: {
          success: false,
          status: 400,
          error: "company_id is required",
          message: "Invalid company context",
        },
      },
    };
  }
  return { cid: new mongoose.Types.ObjectId(String(companyObjectId)) };
}

/**
 * Build `createdAt` filter from `from`/`to` or `startDate`/`endDate` (YYYY-MM-DD).
 * Days run midnight → midnight in the business timezone (see `resolveReportTimezone`).
 * @returns {{ createdAt: object } | { error: object }}
 */
function resolveReportCreatedAtFilter(query = {}, defaultRangeDays = DEFAULT_REPORT_RANGE_DAYS) {
  const rawFrom = query.from ?? query.startDate ?? query.start_date;
  const rawTo = query.to ?? query.endDate ?? query.end_date;

  const hasFrom = rawFrom != null && String(rawFrom).trim() !== "";
  const hasTo = rawTo != null && String(rawTo).trim() !== "";

  if (!hasFrom && !hasTo) {
    if (defaultRangeDays == null || defaultRangeDays === false) {
      return {};
    }
    const toDate = new Date();
    const fromDate = new Date(toDate);
    fromDate.setDate(fromDate.getDate() - defaultRangeDays);
    return { createdAt: { $gte: fromDate, $lte: toDate } };
  }

  const timeZone = resolveReportTimezone(query);
  const createdAt = {};
  if (hasFrom) {
    const fromDate = parseReportDateStart(rawFrom, timeZone);
    if (!fromDate) {
      return {
        error: {
          status: 400,
          body: {
            success: false,
            status: 400,
            error: "Invalid from date",
            message: "Use YYYY-MM-DD for from / startDate",
          },
        },
      };
    }
    createdAt.$gte = fromDate;
  }
  if (hasTo) {
    const toDate = parseReportDateEnd(rawTo, timeZone);
    if (!toDate) {
      return {
        error: {
          status: 400,
          body: {
            success: false,
            status: 400,
            error: "Invalid to date",
            message: "Use YYYY-MM-DD for to / endDate",
          },
        },
      };
    }
    createdAt.$lte = toDate;
  }
  return { createdAt };
}

const DEFAULT_REPORT_TIMEZONE = "Asia/Karachi";

/**
 * IANA zone that YYYY-MM-DD report days are measured in: `?timezone=`, else
 * `SALES_TIMEZONE`, else Asia/Karachi. Never the server's own zone — the live box
 * runs on US time, which shifted "3 Oct" to 3 Oct 12:00 PM → 4 Oct 11:59 AM PKT.
 */
function resolveReportTimezone(query = {}) {
  const candidates = [
    query.timezone,
    process.env.SALES_TIMEZONE,
    DEFAULT_REPORT_TIMEZONE,
  ];
  for (const raw of candidates) {
    const tz = String(raw ?? "").trim();
    if (!tz) continue;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return tz;
    } catch (_) {
      /* invalid zone — try the next one */
    }
  }
  return DEFAULT_REPORT_TIMEZONE;
}

/** Wall-clock offset of `timeZone` from UTC at instant `ms` (ms; +5h for Karachi). */
function timezoneOffsetMs(ms, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  const wallAsUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return wallAsUtc - (ms - (ms % 1000));
}

/** UTC instant of 00:00 on y-m-d in `timeZone` (second pass settles DST edges). */
function zonedMidnight(y, m, d, timeZone) {
  const wall = Date.UTC(y, m - 1, d);
  const first = wall - timezoneOffsetMs(wall, timeZone);
  return new Date(wall - timezoneOffsetMs(first, timeZone));
}

function parseReportDateStart(raw, timeZone = DEFAULT_REPORT_TIMEZONE) {
  const s = String(raw).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const d = zonedMidnight(Number(m[1]), Number(m[2]), Number(m[3]), timeZone);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Last millisecond of y-m-d in `timeZone` (next day's midnight − 1 ms). */
function parseReportDateEnd(raw, timeZone = DEFAULT_REPORT_TIMEZONE) {
  const s = String(raw).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const nextMidnight = zonedMidnight(
      Number(m[1]),
      Number(m[2]),
      Number(m[3]) + 1,
      timeZone,
    );
    const d = new Date(nextMidnight.getTime() - 1);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * GET sum of `total_amount` for a tenant document collection (orders, returns, POs).
 */
async function sumHeaderTotalAmount(req, res, Model, options = {}) {
  try {
    const company = resolveReportCompanyFromReq(req);
    if (company.error) {
      return res.status(company.error.status).json(company.error.body);
    }

    const dateResolved = resolveReportCreatedAtFilter(
      req.query,
      options.defaultRangeDays ?? DEFAULT_REPORT_RANGE_DAYS,
    );
    if (dateResolved.error) {
      return res.status(dateResolved.error.status).json(dateResolved.error.body);
    }

    const match = {
      company_id: company.cid,
      status: "active",
      deletedAt: null,
      createdAt: dateResolved.createdAt,
    };

    const statusField = options.statusQueryField || "order_status";
    const rawStatus = req.query?.[statusField];
    if (rawStatus != null && String(rawStatus).trim() !== "") {
      match[statusField] = String(rawStatus).trim();
    }

    const rows = await Model.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          total_amount: { $sum: { $ifNull: ["$total_amount", 0] } },
          document_count: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          total_amount: { $round: ["$total_amount", 2] },
          document_count: 1,
        },
      },
    ]);

    const total_amount = rows[0]?.total_amount ?? 0;
    const document_count = rows[0]?.document_count ?? 0;

    return res.status(200).json({
      success: true,
      status: 200,
      company_id: String(company.cid),
      total_amount,
      document_count,
    });
  } catch (error) {
    console.error(`❌ sumHeaderTotalAmount (${Model?.modelName || "model"}):`, error);
    return res.status(500).json({
      success: false,
      status: 500,
      error: error.message || "Internal server error",
    });
  }
}

module.exports = {
  DEFAULT_REPORT_RANGE_DAYS,
  resolveReportCompanyFromReq,
  resolveReportCreatedAtFilter,
  sumHeaderTotalAmount,
};
