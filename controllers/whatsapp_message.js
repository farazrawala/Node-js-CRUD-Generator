const WhatsappMessage = require("../models/whatsapp_message");
const Chat = require("../models/chat");
const Company = require("../models/company");
const {
  coalesceObjectId,
  activeNotDeletedCriteria,
  handleGenericCreate,
} = require("../utils/modelHelper");
const { evaluateCanSendUnknownWhatsapp } = require("./chat");

const MAX_FETCH_ATTEMPTS = 25;

function resolveCompanyId(req) {
  return coalesceObjectId(
    req.query?.company_id || req.body?.company_id || req.user?.company_id,
  );
}

/**
 * After a whatsapp_message is created, mirror it into `chat` as an outbound (sent) row.
 * from_user_id = company.whatsapp_number, to_user_id = message.number
 *
 * For unknown numbers (no prior status=sent chat), bumps company
 * unknown_whatsapp_settings.usage when still under the daily limit.
 * @returns {{ chat: object|null, eligibility: object|null }}
 */
async function createChatForWhatsappMessage(whatsappMessage, extras = {}) {
  if (!whatsappMessage?._id) {
    return { chat: null, eligibility: null };
  }

  const companyId = coalesceObjectId(
    whatsappMessage.company_id || extras.company_id,
  );
  if (!companyId) {
    throw new Error(
      "company_id is required to create chat for whatsapp_message",
    );
  }

  const company = await Company.findOne({
    _id: companyId,
    deletedAt: null,
  })
    .select("whatsapp_number")
    .lean();

  let fromUserId = String(company?.whatsapp_number || "").trim();
  if (!fromUserId) fromUserId = "92";

  const toUserId = String(whatsappMessage.number || "").trim();
  if (!toUserId) {
    throw new Error("whatsapp_message.number is required for chat insert");
  }

  const messageText = String(whatsappMessage.message || "").trim();
  if (!messageText) {
    throw new Error("whatsapp_message.message is required for chat insert");
  }

  const chat = await Chat.create({
    from_user_id: fromUserId,
    to_user_id: toUserId,
    message: messageText,
    whatsapp_time: new Date().toISOString(),
    whatsapp_message_id: whatsappMessage._id,
    type: "sent",
    status: whatsappMessage.status || "not_started",
    company_id: companyId,
    created_by:
      coalesceObjectId(extras.created_by) ||
      coalesceObjectId(whatsappMessage.created_by) ||
      undefined,
  });

  // not_started chats are ignored by previous-conversation count, so creating
  // a first message to an unknown number increments usage here.
  let eligibility = null;
  try {
    const result = await evaluateCanSendUnknownWhatsapp({
      companyId,
      number: toUserId,
      incrementOnAllow: true,
    });
    eligibility = result?.ok ? result.data : result;
  } catch (usageErr) {
    console.error(
      "❌ createChatForWhatsappMessage → usage bump failed:",
      usageErr?.message || usageErr,
    );
  }

  return { chat, eligibility };
}

/**
 * POST /api/whatsapp_message/create
 * Creates whatsapp_message, then inserts a linked chat row.
 * Unknown numbers (no status=sent history) bump daily usage.
 */
async function whatsappMessageCreate(req, res) {
  try {
    const response = await handleGenericCreate(req, "whatsapp_message", {});
    if (response?.success && response?.data) {
      try {
        const { chat, eligibility } = await createChatForWhatsappMessage(
          response.data,
          {
            created_by: req.user?._id,
            company_id: resolveCompanyId(req),
          },
        );
        if (chat) {
          response.chat = chat.toObject ? chat.toObject() : chat;
        }
        if (eligibility) {
          response.eligibility = eligibility;
        }
      } catch (chatErr) {
        console.error(
          "❌ whatsappMessageCreate → chat insert failed:",
          chatErr?.message || chatErr,
        );
        response.chat_error = chatErr?.message || "Failed to insert chat";
      }
    }
    return res.status(response.status || 500).json(response);
  } catch (error) {
    console.error("❌ whatsappMessageCreate:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      message: error.message || "Failed to create whatsapp message",
    });
  }
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
  whatsappMessageCreate,
  createChatForWhatsappMessage,
  fetchRandomWhatsappMessage,
  markWhatsappMessageSent,
  markWhatsappMessageNotAvailable,
};
