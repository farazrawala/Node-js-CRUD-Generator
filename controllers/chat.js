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
  const raw =
    req.query?.company_id || req.body?.company_id || req.user?.company_id;
  if (raw == null || raw === "") return null;

  const id = coalesceObjectId(raw);
  const mongoose = require("mongoose");
  // Reject truncated / non-hex ids so Mongoose never throws CastError → 500
  if (!(id instanceof mongoose.Types.ObjectId)) return null;
  return id;
}

function companyIdMissingOrInvalidResponse(req) {
  const raw =
    req.query?.company_id || req.body?.company_id || req.user?.company_id;
  if (raw == null || String(raw).trim() === "") {
    return {
      success: false,
      status: 400,
      message: "company_id is required",
    };
  }
  return {
    success: false,
    status: 400,
    message:
      "company_id must be a valid 24-character MongoDB ObjectId (e.g. 6a60082a3bbbeaaacd9a4d3e)",
  };
}

const MAX_FETCH_ATTEMPTS = 25;

function buildPendingChatFilter(companyId, excludeIds = []) {
  const filter = {
    status: "not_started",
    type: "sent",
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
 * POST /api/chat/create/:pos_auth_token/swap  (or ?swap=1)
 * Receive a chat message and insert into the chat collection.
 *
 * Body: from_user_id, to_user_id, message, message_id?, whatsapp_time?
 * company_id / created_by are set from the authenticated POS user.
 * Default type is "received". With /swap or ?swap=1, from/to are swapped and type becomes "sent".
 * When message + whatsapp_time are present, message_id is a SHA-256 fingerprint
 * so duplicate listens are skipped.
 */
function wantsChatUserSwap(req) {
  const path = String(req.path || req.url || "");
  if (/\/swap\/?$/i.test(path) || String(req.params?.mode || "") === "swap") {
    return true;
  }
  const q = req.query?.swap ?? req.query?.swap_users;
  if (q == null || q === "") return false;
  const v = String(q).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "swap";
}

async function chatCreate(req, res) {
  try {
    const authError = await authenticatePosToken(req);
    if (authError) {
      return res.status(authError.status).json(authError);
    }

    const swapUsers = wantsChatUserSwap(req);

    // Default sender to the authenticated POS user when omitted
    if (!req.body?.from_user_id && req.user?._id) {
      req.body = { ...req.body, from_user_id: String(req.user._id) };
    }

    // /swap or ?swap=1 → from_user_id ↔ to_user_id (e.g. company phone becomes from)
    if (swapUsers) {
      const from = req.body?.from_user_id;
      const to = req.body?.to_user_id;
      req.body = {
        ...req.body,
        from_user_id: to,
        to_user_id: from,
      };
    }

    const whatsapp_time = normalizeWhatsappTime(req.body?.whatsapp_time);
    if (whatsapp_time) {
      req.body = { ...req.body, whatsapp_time };
    }

    const companyId = resolveCompanyId(req);
    const chatType = swapUsers ? "sent" : "received";

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
        type: chatType,
        deletedAt: null,
      }).lean();

      if (existing) {
        return res.status(200).json({
          success: true,
          status: 200,
          skipped: true,
          message: "Duplicate WhatsApp message skipped",
          data: existing,
          swapped: swapUsers,
        });
      }
    }

    req.body = { ...req.body, type: chatType };

    const response = await handleGenericCreate(req, "chat", {});
    if (response && typeof response === "object") {
      response.swapped = swapUsers;
    }
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
 * Returns one random pending chat (status: not_started, type: sent) whose
 * to_user_id passes can-send-unknown (can_send: true). Claims it by setting
 * status to inprocess. If can_send is false, skips that number and samples
 * another pending chat.
 */
async function fetchRandomChat(req, res) {
  try {
    const companyId = resolveCompanyId(req);
    if (!companyId) {
      return res.status(400).json(companyIdMissingOrInvalidResponse(req));
    }

    const skippedIds = [];
    let lastEligibility = null;

    for (let attempt = 0; attempt < MAX_FETCH_ATTEMPTS; attempt++) {
      const filter = buildPendingChatFilter(companyId, skippedIds);
      const rows = await Chat.aggregate([
        { $match: filter },
        { $sample: { size: 1 } },
      ]);

      const message = rows[0] || null;
      if (!message) {
        break;
      }

      const eligibility = await evaluateCanSendUnknownWhatsapp({
        companyId: message.company_id || companyId,
        number: message.to_user_id,
        incrementOnAllow: true,
      });

      lastEligibility = eligibility;

      if (!eligibility.ok) {
        skippedIds.push(message._id);
        continue;
      }

      if (eligibility.can_send) {
        const claimed = await Chat.findOneAndUpdate(
          {
            _id: message._id,
            status: "not_started",
            deletedAt: null,
          },
          {
            $set: {
              status: "inprocess",
              sending_status: "inprocess",
            },
          },
          { new: true },
        ).lean();

        // Another worker may have claimed it already — try another
        if (!claimed) {
          skippedIds.push(message._id);
          continue;
        }

        return res.status(200).json({
          success: true,
          status: 200,
          message: "Pending chat message fetched",
          data: claimed,
          eligibility: eligibility.data,
        });
      }

      // can_send false (e.g. unknown daily limit) → try another number
      skippedIds.push(message._id);
    }

    const limitReached =
      lastEligibility?.data?.reason === "unknown_daily_limit_reached";

    return res.status(200).json({
      success: true,
      status: 200,
      message:
        limitReached ?
          "No pending chat messages that can be sent (unknown daily limit reached)"
        : "No pending chat messages",
      data: null,
      eligibility: lastEligibility?.data || null,
      skipped_count: skippedIds.length,
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
 * Updates both `status` and `sending_status`.
 *
 * Resolves the chat by `_id` (preferred), or by `message_id` /
 * `whatsapp_message_id` if the worker passes those instead.
 */
async function updateChatStatus(req, res, status, successMessage) {
  try {
    const rawId =
      req.params?.id ||
      req.query?.id ||
      req.body?.id ||
      req.query?.chat_id ||
      req.body?.chat_id ||
      null;

    const messageIdStr = rawId != null ? String(rawId).trim() : "";

    if (
      !messageIdStr ||
      messageIdStr === ":id" ||
      messageIdStr === "undefined" ||
      messageIdStr === "null"
    ) {
      return res.status(400).json({
        success: false,
        status: 400,
        message:
          "Chat id is required. Use the chat `_id` from fetch-random in the URL path.",
        received_id: rawId ?? null,
      });
    }

    const mongoose = require("mongoose");
    const orClauses = [{ message_id: messageIdStr }];

    if (
      mongoose.Types.ObjectId.isValid(messageIdStr) &&
      messageIdStr.length === 24
    ) {
      const oid = new mongoose.Types.ObjectId(messageIdStr);
      orClauses.push({ _id: oid }, { whatsapp_message_id: oid });
    }

    const filter = {
      $and: [activeNotDeletedCriteria(), { $or: orClauses }],
    };

    const update = {
      status,
      sending_status: status,
    };
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
        received_id: messageIdStr,
        hint: "Pass the chat `_id` from GET /api/chat/fetch-random (data._id).",
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

function normalizePkWhatsappDigits(value) {
  let digits = String(value || "").trim().replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `92${digits.slice(1)}`;
  if (!digits.startsWith("92") && digits.length === 10 && digits.startsWith("3")) {
    digits = `92${digits}`;
  }
  return digits;
}

function phoneMatchVariants(phone) {
  const digits = normalizePkWhatsappDigits(phone);
  if (!digits) return [];
  const variants = new Set([digits, String(phone || "").trim()]);
  if (digits.startsWith("92") && digits.length >= 12) {
    variants.add(`0${digits.slice(2)}`);
    variants.add(digits.slice(2));
  }
  return [...variants].filter(Boolean);
}

function readUnknownWhatsappSettings(company) {
  const raw = company?.unknown_whatsapp_settings;
  let row = null;

  if (Array.isArray(raw)) {
    row = raw[0] || null;
  } else if (raw && typeof raw === "object") {
    // Dotted $set can corrupt the field into { "0": {...} } instead of an array
    row = raw["0"] ?? raw[0] ?? raw;
    if (
      row &&
      typeof row === "object" &&
      row.increase_daily == null &&
      raw.increase_daily != null
    ) {
      row = { ...row, increase_daily: raw.increase_daily };
    }
  }

  const daily_limit = Number(row?.daily_limit);
  const usage = Number(row?.usage);
  const increase_daily = Number(row?.increase_daily);
  return {
    daily_limit: Number.isFinite(daily_limit) ? daily_limit : 5,
    usage: Number.isFinite(usage) ? usage : 0,
    increase_daily: Number.isFinite(increase_daily) ? increase_daily : 1,
  };
}

/**
 * Core eligibility check used by HTTP /chat/can-send-unknown and workers.
 * @param {{ companyId: unknown, number: string, incrementOnAllow?: boolean }} opts
 */
async function evaluateCanSendUnknownWhatsapp({
  companyId,
  number,
  incrementOnAllow = true,
}) {
  const phone = normalizePkWhatsappDigits(number);
  if (!companyId) {
    return {
      ok: false,
      status: 400,
      message: "company_id is required",
    };
  }
  if (!phone) {
    return {
      ok: false,
      status: 400,
      message: "number (WhatsApp phone) is required",
    };
  }

  const Company = require("../models/company");
  const company = await Company.findOne({
    _id: companyId,
    deletedAt: null,
  })
    .select("unknown_whatsapp_settings whatsapp_number")
    .lean();

  if (!company) {
    return {
      ok: false,
      status: 404,
      message: "Company not found",
    };
  }

  const settings = readUnknownWhatsappSettings(company);
  const variants = phoneMatchVariants(phone);
  const conversationFilter = {
    company_id: companyId,
    deletedAt: null,
    status: "sent",
    $or: [
      { from_user_id: { $in: variants } },
      { to_user_id: { $in: variants } },
    ],
  };

  const [previousCount, lastConversation] = await Promise.all([
    Chat.countDocuments(conversationFilter),
    Chat.findOne(conversationFilter)
      .sort({ createdAt: -1 })
      .populate("whatsapp_message_id")
      .lean(),
  ]);

  const has_previous_conversation = previousCount > 0;
  let can_send = false;
  let reason = "";
  let usage = settings.usage;

  if (has_previous_conversation) {
    can_send = true;
    reason = "existing_conversation";
  } else if (settings.usage < settings.daily_limit) {
    can_send = true;
    reason = "within_unknown_daily_limit";
  } else {
    can_send = false;
    reason = "unknown_daily_limit_reached";
  }

  // previous_conversation_count === 0 and allowed → usage += 1
  if (incrementOnAllow && can_send && previousCount === 0) {
    const step = 1;
    const nextUsage = settings.usage + step;

    const updated = await Company.findOneAndUpdate(
      { _id: companyId },
      {
        $set: {
          unknown_whatsapp_settings: [
            {
              daily_limit: settings.daily_limit,
              usage: nextUsage,
              increase_daily: settings.increase_daily,
            },
          ],
        },
      },
      {
        new: true,
        upsert: false,
        projection: { unknown_whatsapp_settings: 1 },
      },
    ).lean();

    usage = updated ? readUnknownWhatsappSettings(updated).usage : nextUsage;
    if (!Number.isFinite(usage) || usage < nextUsage) {
      usage = nextUsage;
    }
  }

  return {
    ok: true,
    status: 200,
    can_send,
    data: {
      can_send,
      has_previous_conversation,
      previous_conversation_count: previousCount,
      number: phone,
      usage,
      daily_limit: settings.daily_limit,
      increase_daily: settings.increase_daily,
      reason,
      last_conversation: lastConversation || null,
    },
  };
}

/**
 * GET|POST /api/chat/can-send-unknown
 * Query/body: company_id, number|phone|to_user_id
 *
 * 1) Checks whether this number already has a status=sent chat for the company.
 * 2) If no previous conversation and usage < daily_limit → can_send: true.
 * 3) If previous_conversation_count === 0 and can_send → usage += 1.
 *    Existing sent conversations are always allowed (usage unchanged).
 */
async function canSendUnknownWhatsapp(req, res) {
  try {
    const companyId = resolveCompanyId(req);
    const phoneRaw =
      req.query?.number ||
      req.query?.phone ||
      req.query?.to_user_id ||
      req.body?.number ||
      req.body?.phone ||
      req.body?.to_user_id ||
      "";

    if (!companyId) {
      return res.status(400).json(companyIdMissingOrInvalidResponse(req));
    }

    const result = await evaluateCanSendUnknownWhatsapp({
      companyId,
      number: phoneRaw,
      incrementOnAllow: true,
    });

    if (!result.ok) {
      return res.status(result.status).json({
        success: false,
        status: result.status,
        message: result.message,
      });
    }

    return res.status(200).json({
      success: true,
      status: 200,
      message:
        result.can_send ?
          "Yes, it can be sent."
        : "No, unknown daily limit reached.",
      data: result.data,
    });
  } catch (error) {
    console.error("❌ canSendUnknownWhatsapp:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      message: error.message || "Failed to check unknown WhatsApp send eligibility",
    });
  }
}

/**
 * GET|POST /api/chat/reset-unknown-usage
 * Query/body: company_id
 * Sets usage = 0 and daily_limit = daily_limit + increase_daily
 */
async function resetUnknownWhatsappUsage(req, res) {
  try {
    const companyId = resolveCompanyId(req);
    if (!companyId) {
      return res.status(400).json(companyIdMissingOrInvalidResponse(req));
    }

    const Company = require("../models/company");
    const company = await Company.findOne({
      _id: companyId,
      deletedAt: null,
    })
      .select("unknown_whatsapp_settings")
      .lean();

    if (!company) {
      return res.status(404).json({
        success: false,
        status: 404,
        message: "Company not found",
      });
    }

    const settings = readUnknownWhatsappSettings(company);
    const step =
      Number.isFinite(settings.increase_daily) && settings.increase_daily > 0 ?
        settings.increase_daily
      : 1;
    const nextDailyLimit = settings.daily_limit + step;

    const updated = await Company.findOneAndUpdate(
      { _id: companyId },
      {
        $set: {
          unknown_whatsapp_settings: [
            {
              daily_limit: nextDailyLimit,
              usage: 0,
              increase_daily: step,
            },
          ],
        },
      },
      {
        new: true,
        projection: { unknown_whatsapp_settings: 1 },
      },
    ).lean();

    const next = readUnknownWhatsappSettings(updated || {
      unknown_whatsapp_settings: [
        {
          daily_limit: nextDailyLimit,
          usage: 0,
          increase_daily: step,
        },
      ],
    });

    return res.status(200).json({
      success: true,
      status: 200,
      message:
        "Unknown WhatsApp usage reset to 0 and daily_limit increased.",
      data: {
        usage: 0,
        daily_limit: next.daily_limit,
        increase_daily: next.increase_daily,
        previous_usage: settings.usage,
        previous_daily_limit: settings.daily_limit,
      },
    });
  } catch (error) {
    console.error("❌ resetUnknownWhatsappUsage:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      message: error.message || "Failed to reset unknown WhatsApp usage",
    });
  }
}

module.exports = {
  chatCreate,
  authenticatePosToken,
  fetchRandomChat,
  markChatSent,
  markChatNotAvailable,
  canSendUnknownWhatsapp,
  evaluateCanSendUnknownWhatsapp,
  resetUnknownWhatsappUsage,
};
