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
    $and: [activeNotDeletedCriteria()],
  };
  if (companyId) {
    filter.company_id = companyId;
  }
  return filter;
}

/**
 * POST /api/chat/create/:pos_auth_token
 * Receive a chat message and insert into the chat collection.
 *
 * Body: from_user_id, to_user_id, message, message_id? (optional)
 * company_id / created_by are set from the authenticated POS user.
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

    const response = await handleGenericCreate(req, "chat", {});
    return res.status(response.status).json(response);
  } catch (error) {
    console.error("❌ chatCreate:", error);
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
