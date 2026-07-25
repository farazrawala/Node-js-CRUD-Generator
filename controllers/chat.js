const crypto = require("crypto");
const Chat = require("../models/chat");
const { handleGenericCreate, coalesceObjectId, activeNotDeletedCriteria } = require("../utils/modelHelper");
const { hydrateUserFromToken } = require("../middlewares/auth");

/**
 * Resolve and attach req.user from `:pos_auth_token` (JWT).
 * Returns an error response payload when auth fails, otherwise null.
 */
async function authenticatePosToken(req) {
  const token = String(req.params?.pos_auth_token || "").trim();
  if (!token) {
    return {
      success: false,
      status: 401,
      error: "pos_auth_token is required",
      message: "Provide a valid POS auth token in the URL",
    };
  }

  const user = await hydrateUserFromToken(token);
  if (!user?._id) {
    return {
      success: false,
      status: 401,
      error: "Invalid or expired token",
      message: "Please provide a valid pos_auth_token",
    };
  }

  req.user = user;
  return null;
}

function resolveCompanyId(req) {
  return coalesceObjectId(
    req.query?.company_id || req.body?.company_id || req.user?.company_id,
  );
}

function buildPendingChatFilter(companyId) {
  const filter = {
    status: "not_started",
    type: "sent",
    $and: [activeNotDeletedCriteria()],
  };
  if (companyId) {
    filter.company_id = companyId;
  }
  return filter;
}

function normalizeWhatsappTime(raw) {
  if (raw == null || raw === "") return "";
  const asDate = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(asDate.getTime())) return String(raw).trim();
  return asDate.toISOString();
}

/**
 * Stable fingerprint so WhatsApp's changing ids don't create duplicates.
 * Hash of company + from + message + whatsapp_time.
 * @returns {string|null}
 */
function buildStableReceivedMessageId({
  companyId,
  fromUserId,
  message,
  whatsappTime,
}) {
  const msg = String(message || "").trim();
  const time = String(whatsappTime || "").trim();
  if (!msg || !time) return null;

  const material = [
    String(companyId || ""),
    String(fromUserId || "").trim(),
    msg,
    time,
  ].join("|");

  return crypto.createHash("sha256").update(material, "utf8").digest("hex");
}

/**
 * POST /api/chat/create/:pos_auth_token
 * Receive a chat message and insert into the chat collection.
 *
 * Body: from_user_id, to_user_id, message, message_id?, whatsapp_time?
 * company_id / created_by are set from the authenticated POS user.
 * type is always forced to "received".
 * When message + whatsapp_time are present, message_id is a SHA-256 fingerprint
 * so duplicate listens are skipped.
 */
async function chatCreate(req, res) {
  try {
    const authError = await authenticatePosToken(req);
    if (authError) {
      return res.status(authError.status).json(authError);
    }

    // Default sender to the authenticated POS user when omitted
    if (!req.body?.from_user_id && req.user?._id) {
      req.body = { ...req.body, from_user_id: String(req.user._id) };
    }

    const whatsapp_time = normalizeWhatsappTime(req.body?.whatsapp_time);
    if (whatsapp_time) {
      req.body = { ...req.body, whatsapp_time };
    }

    const companyId = resolveCompanyId(req);
    const stableMessageId = buildStableReceivedMessageId({
      companyId,
      fromUserId: req.body?.from_user_id,
      message: req.body?.message,
      whatsappTime: whatsapp_time,
    });

    if (stableMessageId) {
      req.body = { ...req.body, message_id: stableMessageId };

      const existing = await Chat.findOne({
        company_id: companyId,
        message_id: stableMessageId,
        type: "received",
        deletedAt: null,
      }).lean();

      if (existing) {
        return res.status(200).json({
          success: true,
          status: 200,
          skipped: true,
          message: "Duplicate WhatsApp message skipped",
          data: existing,
        });
      }
    }

    // Incoming WhatsApp captures are always "received" (outbound queue uses "sent")
    req.body = { ...req.body, type: "received" };

    const response = await handleGenericCreate(req, "chat", {});
    return res.status(response.status).json(response);
  } catch (error) {
    console.error("❌ chatCreate:", error);
    // Race: unique-ish duplicate insert
    if (error?.code === 11000) {
      return res.status(200).json({
        success: true,
        status: 200,
        skipped: true,
        message: "Duplicate WhatsApp message skipped",
      });
    }
    return res.status(500).json({
      success: false,
      status: 500,
      message: error.message || "Failed to create chat message",
    });
  }
}

/**
 * GET /api/chat/fetch-random?company_id=...
 * Returns one random pending chat message (status: not_started).
 */
async function fetchRandomChat(req, res) {
  try {
    const companyId = resolveCompanyId(req);
    const filter = buildPendingChatFilter(companyId);

    const rows = await Chat.aggregate([
      { $match: filter },
      { $sample: { size: 1 } },
    ]);

    const message = rows[0] || null;

    if (!message) {
      return res.status(200).json({
        success: true,
        status: 200,
        message: "No pending chat messages",
        data: null,
      });
    }

    return res.status(200).json({
      success: true,
      status: 200,
      message: "Pending chat message fetched",
      data: message,
    });
  } catch (error) {
    console.error("❌ fetchRandomChat:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      message: error.message || "Failed to fetch chat message",
    });
  }
}

/**
 * Shared status update for worker callbacks (sent / not_available).
 */
async function updateChatStatus(req, res, status, successMessage) {
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

    const updated = await Chat.findOneAndUpdate(filter, update, {
      new: true,
      runValidators: true,
    }).lean();

    if (!updated) {
      return res.status(404).json({
        success: false,
        status: 404,
        message: "Chat message not found",
      });
    }

    return res.status(200).json({
      success: true,
      status: 200,
      message: successMessage,
      data: updated,
    });
  } catch (error) {
    console.error(`❌ updateChatStatus(${status}):`, error);
    return res.status(500).json({
      success: false,
      status: 500,
      message: error.message || "Failed to update chat message status",
    });
  }
}

/**
 * GET /api/chat/mark-sent/:id?company_id=...
 */
async function markChatSent(req, res) {
  return updateChatStatus(req, res, "sent", "Chat message marked as sent");
}

/**
 * GET /api/chat/mark-not-available/:id?company_id=...
 */
async function markChatNotAvailable(req, res) {
  return updateChatStatus(
    req,
    res,
    "not_available",
    "Chat message marked as not available",
  );
}

module.exports = {
  chatCreate,
  authenticatePosToken,
  fetchRandomChat,
  markChatSent,
  markChatNotAvailable,
};
