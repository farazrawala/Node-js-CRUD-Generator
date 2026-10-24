const SmsMessage = require("../models/sms_message");
const {
  coalesceObjectId,
  activeNotDeletedCriteria,
} = require("../utils/modelHelper");

const MAX_FETCH_ATTEMPTS = 10;

function resolveCompanyId(req) {
  return coalesceObjectId(
    req.query?.company_id || req.body?.company_id || req.user?.company_id,
  );
}

function parseSkipLimit(query = {}) {
  const limitRaw = parseInt(query.limit, 10);
  const skipRaw = parseInt(query.skip, 10);
  const pageRaw = parseInt(query.page, 10);

  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 25;
  let skip = Number.isFinite(skipRaw) && skipRaw >= 0 ? skipRaw : 0;
  if ((!Number.isFinite(skipRaw) || skipRaw < 0) && Number.isFinite(pageRaw) && pageRaw > 0) {
    skip = (pageRaw - 1) * limit;
  }
  return { skip, limit, page: Math.floor(skip / limit) + 1 };
}

function onHoldFilter(companyId) {
  const filter = {
    status: "on_hold",
    $and: [activeNotDeletedCriteria()],
  };
  if (companyId) filter.company_id = companyId;
  return filter;
}

/**
 * GET /api/sms_message/on-hold
 * GET /api/sms_message/list-on-hold
 *
 * Lists on_hold SMS messages with total count and pagination.
 * Query: company_id (required unless Bearer has company), skip, limit, page, search
 */
async function listOnHoldSmsMessages(req, res) {
  try {
    const companyId = resolveCompanyId(req);
    if (!companyId) {
      return res.status(400).json({
        success: false,
        status: 400,
        message: "company_id is required",
      });
    }

    const { skip, limit, page } = parseSkipLimit(req.query);
    const filter = onHoldFilter(companyId);

    const search = String(req.query.search || "").trim();
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.$or = [
        { number: { $regex: escaped, $options: "i" } },
        { message: { $regex: escaped, $options: "i" } },
      ];
    }

    const [total, data] = await Promise.all([
      SmsMessage.countDocuments(filter),
      SmsMessage.find(filter)
        .sort({ createdAt: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    return res.status(200).json({
      success: true,
      status: 200,
      message: "On-hold SMS messages",
      data,
      count: total,
      pagination: {
        total,
        count: data.length,
        skip,
        limit,
        page,
        totalPages: limit > 0 ? Math.ceil(total / limit) : 0,
      },
    });
  } catch (error) {
    console.error("❌ listOnHoldSmsMessages:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      message: error.message || "Failed to list on-hold SMS messages",
    });
  }
}

/**
 * GET /api/sms_message/fetch-random?company_id=...
 *
 * Picks one random on_hold message and atomically marks it processing.
 * Returns data: null when the queue is empty.
 */
async function fetchRandomSmsMessage(req, res) {
  try {
    const companyId = resolveCompanyId(req);
    if (!companyId) {
      return res.status(400).json({
        success: false,
        status: 400,
        message: "company_id is required",
      });
    }

    const skippedIds = [];

    for (let attempt = 0; attempt < MAX_FETCH_ATTEMPTS; attempt++) {
      const match = onHoldFilter(companyId);
      if (skippedIds.length) {
        match._id = { $nin: skippedIds };
      }

      const rows = await SmsMessage.aggregate([
        { $match: match },
        { $sample: { size: 1 } },
      ]);
      const sampled = rows[0] || null;
      if (!sampled) break;

      const update = { status: "processing" };
      if (req.user?._id) {
        update.updated_by = coalesceObjectId(req.user._id);
      }

      const claimed = await SmsMessage.findOneAndUpdate(
        {
          _id: sampled._id,
          status: "on_hold",
          deletedAt: null,
          company_id: companyId,
        },
        { $set: update },
        { new: true, runValidators: true },
      ).lean();

      if (!claimed) {
        skippedIds.push(sampled._id);
        continue;
      }

      return res.status(200).json({
        success: true,
        status: 200,
        message: "On-hold SMS message claimed for processing",
        data: claimed,
      });
    }

    return res.status(200).json({
      success: true,
      status: 200,
      message: "No on-hold SMS messages",
      data: null,
      skipped_count: skippedIds.length,
    });
  } catch (error) {
    console.error("❌ fetchRandomSmsMessage:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      message: error.message || "Failed to fetch SMS message",
    });
  }
}

/**
 * GET|PATCH|POST /api/sms_message/mark-sent/:id?company_id=...
 *
 * Marks a processing SMS message as sent.
 */
async function markSmsMessageSent(req, res) {
  try {
    const messageId = coalesceObjectId(req.params?.id);
    if (!messageId) {
      return res.status(400).json({
        success: false,
        status: 400,
        message: "Message id is required",
      });
    }

    const companyId = resolveCompanyId(req);
    const filter = {
      _id: messageId,
      status: "processing",
      $and: [activeNotDeletedCriteria()],
    };
    if (companyId) {
      filter.company_id = companyId;
    }

    const update = { status: "sent" };
    if (req.user?._id) {
      update.updated_by = coalesceObjectId(req.user._id);
    }

    const updated = await SmsMessage.findOneAndUpdate(filter, update, {
      new: true,
      runValidators: true,
    }).lean();

    if (!updated) {
      return res.status(404).json({
        success: false,
        status: 404,
        message:
          "SMS message not found, or it is not in processing status",
      });
    }

    return res.status(200).json({
      success: true,
      status: 200,
      message: "SMS message marked as sent",
      data: updated,
    });
  } catch (error) {
    console.error("❌ markSmsMessageSent:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      message: error.message || "Failed to mark SMS message as sent",
    });
  }
}

module.exports = {
  listOnHoldSmsMessages,
  fetchRandomSmsMessage,
  markSmsMessageSent,
};
