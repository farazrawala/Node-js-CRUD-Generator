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
 * @returns {{ createdAt: object } | { error: object }}
 */
function resolveReportCreatedAtFilter(query = {}, defaultRangeDays = DEFAULT_REPORT_RANGE_DAYS) {
  const rawFrom = query.from ?? query.startDate ?? query.start_date;
  const rawTo = query.to ?? query.endDate ?? query.end_date;

  const hasFrom = rawFrom != null && String(rawFrom).trim() !== "";
  const hasTo = rawTo != null && String(rawTo).trim() !== "";

  if (!hasFrom && !hasTo) {
    const toDate = new Date();
    const fromDate = new Date(toDate);
    fromDate.setDate(fromDate.getDate() - defaultRangeDays);
    return { createdAt: { $gte: fromDate, $lte: toDate } };
  }

  const createdAt = {};
  if (hasFrom) {
    const fromDate = parseReportDateStart(rawFrom);
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
    const toDate = parseReportDateEnd(rawTo);
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

function parseReportDateStart(raw) {
  const s = String(raw).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseReportDateEnd(raw) {
  const s = String(raw).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const d = new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      23,
      59,
      59,
      999,
    );
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
