const WhatsappMessage = require("../models/whatsapp_message");
const {
  coalesceObjectId,
  activeNotDeletedCriteria,
} = require("../utils/modelHelper");
const { evaluateCanSendUnknownWhatsapp } = require("./chat");

const MAX_FETCH_ATTEMPTS = 25;

function resolveCompanyId(req) {
  return coalesceObjectId(
    req.query?.company_id || req.body?.company_id || req.user?.company_id,
  );
}

function buildPendingMessageFilter(companyId, excludeIds = []) {
  const filter = {
    status: "not_started",
    $and: [activeNotDeletedCriteria()],
  };
  if (companyId) {
    filter.company_id = companyId;
  }
  if (excludeIds.length > 0) {
    filter._id = { $nin: excludeIds };
  }
  return filter;
}

/**
 * GET /api/whatsapp_message/fetch-random
 * Returns one random pending message (status: not_started) that passes
 * /chat/can-send-unknown (can_send: true). Skips blocked unknown numbers
 * and tries another pending message.
 */
async function fetchRandomWhatsappMessage(req, res) {
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
    let lastEligibility = null;

    for (let attempt = 0; attempt < MAX_FETCH_ATTEMPTS; attempt++) {
      const filter = buildPendingMessageFilter(companyId, skippedIds);
      const rows = await WhatsappMessage.aggregate([
        { $match: filter },
        { $sample: { size: 1 } },
      ]);

      const message = rows[0] || null;
      if (!message) {
        break;
      }

      const eligibility = await evaluateCanSendUnknownWhatsapp({
        companyId: message.company_id || companyId,
        number: message.number,
        incrementOnAllow: true,
      });

      lastEligibility = eligibility;

      if (!eligibility.ok) {
        skippedIds.push(message._id);
        continue;
      }

      if (eligibility.can_send) {
        return res.status(200).json({
          success: true,
          status: 200,
          message: "Pending whatsapp message fetched",
          data: message,
          eligibility: eligibility.data,
        });
      }

      // can_send false (e.g. unknown daily limit) → try another pending message
      skippedIds.push(message._id);
    }

    const limitReached =
      lastEligibility?.data?.reason === "unknown_daily_limit_reached";

    return res.status(200).json({
      success: true,
      status: 200,
      message:
        limitReached ?
          "No pending whatsapp messages that can be sent (unknown daily limit reached)"
        : "No pending whatsapp messages",
      data: null,
      eligibility: lastEligibility?.data || null,
      skipped_count: skippedIds.length,
    });
  } catch (error) {
    console.error("❌ fetchRandomWhatsappMessage:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      message: error.message || "Failed to fetch whatsapp message",
    });
  }
}

/**
 * Shared status update for worker callbacks (sent / not_available).
 */
async function updateWhatsappMessageStatus(req, res, status, successMessage) {
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
      $and: [activeNotDeletedCriteria()],
    };
    if (companyId) {
      filter.company_id = companyId;
    }

    const update = { status };
    if (req.user?._id) {
      update.updated_by = coalesceObjectId(req.user._id);
    }

    const updated = await WhatsappMessage.findOneAndUpdate(filter, update, {
      new: true,
      runValidators: true,
    }).lean();

    if (!updated) {
      return res.status(404).json({
        success: false,
        status: 404,
        message: "Whatsapp message not found",
      });
    }

    return res.status(200).json({
      success: true,
      status: 200,
      message: successMessage,
      data: updated,
    });
  } catch (error) {
    console.error(`❌ updateWhatsappMessageStatus(${status}):`, error);
    return res.status(500).json({
      success: false,
      status: 500,
      message: error.message || "Failed to update whatsapp message",
    });
  }
}

/**
 * PATCH /api/whatsapp_message/mark-sent/:id
 * Marks a whatsapp message as sent.
 */
async function markWhatsappMessageSent(req, res) {
  return updateWhatsappMessageStatus(
    req,
    res,
    "sent",
    "Whatsapp message marked as sent",
  );
}

/**
 * PATCH /api/whatsapp_message/mark-not-available/:id
 * Marks a whatsapp message as not_available (user not on WhatsApp).
 */
async function markWhatsappMessageNotAvailable(req, res) {
  return updateWhatsappMessageStatus(
    req,
    res,
    "not_available",
    "Whatsapp message marked as not available",
  );
}

module.exports = {
  fetchRandomWhatsappMessage,
  markWhatsappMessageSent,
  markWhatsappMessageNotAvailable,
};
