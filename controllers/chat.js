const crypto = require("crypto");
const Chat = require("../models/chat");
const { handleGenericCreate, coalesceObjectId, activeNotDeletedCriteria } = require("../utils/modelHelper");
const { hydrateUserFromToken } = require("../middlewares/auth");
const { generateExpectedReply } = require("../utils/groqReply");

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
    // Automation replies are served first and in order by claimNextAutomationReply
    source: { $ne: "automation" },
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
 * The stable part of the extension's WhatsApp message id ("false_92300…@c.us_3EB0…"
 * → "3EB0…"; the chat part can switch between @c.us and @lid). "" for the
 * extension's dom_ fallback ids, which are not WhatsApp's.
 */
function whatsappMessageKey(rawId) {
  const id = String(rawId || "").trim();
  if (!id || id.startsWith("dom_")) return "";
  const legacy = id.match(/^(?:true|false)_[^_]+_([^_]+)/);
  return legacy ? legacy[1] : id;
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

/**
 * POST /chat(s)/create/:pos_auth_token  (optionally .../swap or ?swap=1)
 *
 * Saves one WhatsApp chat message and, for incoming customer messages,
 * triggers the Groq auto-reply.
 *
 * Flow:
 *   Step 1  – Authenticate the POS token (sets req.user).
 *   Step 2  – Detect swap mode (/swap or ?swap=1|true|yes).
 *   Step 3  – Default from_user_id to the logged-in POS user if missing.
 *   Step 4  – In swap mode, swap from_user_id ↔ to_user_id.
 *   Step 5  – Normalize whatsapp_time to an ISO string.
 *   Step 6  – Resolve company_id and chat type (swap → "sent", else "received").
 *   Step 7  – Build a stable message_id hash and skip duplicates.
 *   Step 8  – Insert the chat through the generic create handler.
 *   Step 9  – For new "received" messages, run WhatsApp automation flows; when no
 *             flow takes the message, generate/queue the Groq auto-reply.
 *   Step 10 – Send the response (duplicate-key race → 200 skipped).
 */
async function chatCreate(req, res) {
  try {
    // Step 1: Validate :pos_auth_token and load the POS user onto req.user.
    // Returns an error object (401 etc.) when the token is missing/invalid.
    const authError = await authenticatePosToken(req);
    if (authError) {
      return res.status(authError.status).json(authError);
    }

    // Step 2: Swap mode means the message was SENT by the company (outgoing),
    // not received from a customer. Triggered by /swap path or ?swap=1.
    const swapUsers = wantsChatUserSwap(req);

    // Step 3: Default sender to the authenticated POS user when omitted
    if (!req.body?.from_user_id && req.user?._id) {
      req.body = { ...req.body, from_user_id: String(req.user._id) };
    }

    // Step 4: /swap or ?swap=1 → from_user_id ↔ to_user_id (e.g. company phone becomes from)
    if (swapUsers) {
      const from = req.body?.from_user_id;
      const to = req.body?.to_user_id;
      req.body = {
        ...req.body,
        from_user_id: to,
        to_user_id: from,
      };
    }

    // Step 5: Convert whatsapp_time to ISO format so the same message always
    // produces the same timestamp string (needed for the dedupe hash below).
    // Unparseable values are kept as trimmed text.
    const whatsapp_time = normalizeWhatsappTime(req.body?.whatsapp_time);
    if (whatsapp_time) {
      req.body = { ...req.body, whatsapp_time };
    }

    // Step 6: company_id comes from query → body → POS user (invalid ids → null).
    // Swap mode = outgoing "sent" message; otherwise it's an incoming "received" one.
    const companyId = resolveCompanyId(req);
    const chatType = swapUsers ? "sent" : "received";

    // Step 7: WhatsApp message ids change between syncs, so build our own
    // stable id = hash(company + from + message + whatsapp_time).
    // Returns null when message or time is missing (dedupe is skipped then).
    const stableMessageId = buildStableReceivedMessageId({
      companyId,
      fromUserId: req.body?.from_user_id,
      message: req.body?.message,
      whatsappTime: whatsapp_time,
    });

    if (stableMessageId) {
      const findSaved = (messageId) =>
        Chat.findOne({ company_id: companyId, message_id: messageId, type: chatType, deletedAt: null }).lean();

      // WhatsApp times are whole minutes, so a customer sending "2" twice in one
      // minute gives the same fingerprint. Two different WhatsApp ids mean two
      // messages: the second one gets its own id instead of being skipped.
      const waMessageKey = whatsappMessageKey(req.body?.message_id);
      let messageId = stableMessageId;
      let existing = await findSaved(messageId);
      if (existing && waMessageKey && existing.wa_message_key && existing.wa_message_key !== waMessageKey) {
        messageId = crypto.createHash("sha256").update(`${stableMessageId}|${waMessageKey}`, "utf8").digest("hex");
        existing = await findSaved(messageId);
      }

      // Store our stable id as message_id instead of WhatsApp's
      req.body = { ...req.body, message_id: messageId, ...(waMessageKey ? { wa_message_key: waMessageKey } : {}) };

      // Same message already saved (same company, id, type, not deleted)?
      // Return the existing row with 200 + skipped: true instead of inserting again.
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

    // Step 8: Save the chat with its type via the shared generic create handler
    // (validation + insert). Tag the response with whether users were swapped.
    req.body = { ...req.body, type: chatType };

    const response = await handleGenericCreate(req, "chat", {});
    if (response && typeof response === "object") {
      response.swapped = swapUsers;
    }

    // Step 9a: WhatsApp automation flows answer first (keyword / new conversation /
    // customer mid-flow / handed to the team). Errors never fail the create.
    let automation = null;
    if (response?.success && chatType === "received" && response.data?.from_user_id) {
      try {
        const { handleInboundMessage } = require("../utils/waAutomation/inbound");
        automation = await handleInboundMessage({ companyId, chat: response.data });
        response.automation = automation;
      } catch (automationErr) {
        console.error("❌ chatCreate → automation:", automationErr);
        response.automation = { handled: false, error: automationErr.message || "Automation failed" };
      }
    }

    // Step 9b: New customer message → same as GET /chat/list?date=today&limit=5&number=<sender>
    // Loads today's conversation with the sender, asks Groq for expected_reply
    // and queues it as a WhatsApp message. Only for successfully saved
    // "received" messages no automation flow handled. Auto-reply errors are
    // reported in response.auto_reply but never fail the create itself.
    if (
      response?.success &&
      chatType === "received" &&
      response.data?.from_user_id &&
      !automation?.handled &&
      !automation?.suppress_ai
    ) {
      try {
        const autoReply = await autoReplyToNumber(
          req,
          companyId,
          response.data.from_user_id,
        );
        if (autoReply) {
          response.auto_reply = {
            expected_reply: autoReply.expected_reply,
            expected_reply_error: autoReply.expected_reply_error,
            expected_reply_queued: autoReply.expected_reply_queued,
          };
        }
      } catch (autoErr) {
        console.error("❌ chatCreate → auto reply:", autoErr);
        response.auto_reply = {
          expected_reply: null,
          expected_reply_error: autoErr.message || "Auto reply failed",
        };
      }

      // Step 9c: the flow handed a question (not a menu choice) to the AI. Note the
      // AI's answer in the conversation, or let the bot reply when the AI couldn't.
      if (automation?.reason === "ask_ai") {
        try {
          const inbound = require("../utils/waAutomation/inbound");
          const reply = response.auto_reply?.expected_reply;
          if (reply && response.auto_reply?.expected_reply_queued?.success) {
            await inbound.recordAiAnswer({ sessionId: automation.session_id, text: response.data.message, reply });
          } else {
            response.automation = await inbound.handleInboundMessage({ companyId, chat: response.data, allowAi: false });
          }
        } catch (automationErr) {
          console.error("❌ chatCreate → automation after AI:", automationErr);
        }
      }
    }

    // Step 10: Return the create result (with auto_reply details if any)
    return res.status(response.status).json(response);
  } catch (error) {
    console.error("❌ chatCreate:", error);
    // Race: two identical requests passed the Step 7 check at the same time and
    // the DB unique index rejected the second insert (Mongo error 11000).
    // Treat it as a skipped duplicate, not a failure.
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

/** The extension sends a fetched message within ~30s; a claim older than this was dropped (reload, Stop). */
const AUTOMATION_CLAIM_TIMEOUT_MS = 2 * 60 * 1000;
/** Dropped replies are handed out again only while still fresh (matches the runtime's 10-minute "on its way"). */
const AUTOMATION_RESEND_WINDOW_MS = 10 * 60 * 1000;

/**
 * Oldest due WhatsApp-automation reply, claimed (status → inprocess).
 * Customers wrote first, so the unknown-number daily limit does not apply, and
 * oldest-first keeps one customer's messages in order. A reply the extension
 * claimed but never marked sent or failed is handed out again.
 */
async function claimNextAutomationReply(companyId) {
  const now = Date.now();
  return Chat.findOneAndUpdate(
    {
      company_id: companyId,
      source: "automation",
      type: "sent",
      deletedAt: null,
      $and: [
        { $or: [{ send_after: null }, { send_after: { $lte: new Date(now) } }] },
        {
          $or: [
            { status: "not_started" },
            {
              status: "inprocess",
              updatedAt: { $lt: new Date(now - AUTOMATION_CLAIM_TIMEOUT_MS) },
              createdAt: { $gte: new Date(now - AUTOMATION_RESEND_WINDOW_MS) },
            },
          ],
        },
      ],
    },
    { $set: { status: "inprocess", sending_status: "inprocess" } },
    { sort: { createdAt: 1, _id: 1 }, new: true },
  ).lean();
}

/**
 * GET /api/chat/fetch-random?company_id=...
 * Returns one random pending chat (status: not_started, type: sent) whose
 * to_user_id passes can-send-unknown (can_send: true). Claims it by setting
 * status to inprocess. If can_send is false, skips that number and samples
 * another pending chat. WhatsApp-automation replies always go first.
 */
async function fetchRandomChat(req, res) {
  try {
    const companyId = resolveCompanyId(req);
    if (!companyId) {
      return res.status(400).json(companyIdMissingOrInvalidResponse(req));
    }

    const automationReply = await claimNextAutomationReply(companyId);
    if (automationReply) {
      return res.status(200).json({
        success: true,
        status: 200,
        message: "Pending automation reply fetched",
        data: automationReply,
      });
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
 * Number not on WhatsApp → mark all pending chat + whatsapp_message rows
 * for every format variant of that phone.
 */
async function markChatNotAvailable(req, res) {
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

    const findFilter = {
      $and: [activeNotDeletedCriteria(), { $or: orClauses }],
    };

    const source = await Chat.findOne(findFilter).lean();
    if (!source) {
      return res.status(404).json({
        success: false,
        status: 404,
        message: "Chat message not found",
        received_id: messageIdStr,
        hint: "Pass the chat `_id` from GET /api/chat/fetch-random (data._id).",
      });
    }

    const number =
      String(source.to_user_id || "").trim() ||
      String(source.from_user_id || "").trim();
    const variants = phoneMatchVariants(number);
    if (!variants.length) {
      return res.status(400).json({
        success: false,
        status: 400,
        message: "Chat has no phone number to mark",
      });
    }

    const scopeCompanyId = coalesceObjectId(
      source.company_id ||
        req.query?.company_id ||
        req.body?.company_id ||
        req.user?.company_id,
    );
    const updatedBy = req.user?._id
      ? coalesceObjectId(req.user._id)
      : undefined;
    const pendingStatuses = ["not_started", "inprocess"];

    const chatFilter = {
      status: { $in: pendingStatuses },
      $and: [
        activeNotDeletedCriteria(),
        {
          $or: [
            { to_user_id: { $in: variants } },
            { from_user_id: { $in: variants } },
          ],
        },
      ],
    };
    if (scopeCompanyId) chatFilter.company_id = scopeCompanyId;

    const chatUpdate = {
      status: "not_available",
      sending_status: "not_available",
    };
    if (updatedBy) chatUpdate.updated_by = updatedBy;

    const chatResult = await Chat.updateMany(chatFilter, chatUpdate);

    const WhatsappMessage = require("../models/whatsapp_message");
    const wmFilter = {
      number: { $in: variants },
      status: { $in: pendingStatuses },
      $and: [activeNotDeletedCriteria()],
    };
    if (scopeCompanyId) wmFilter.company_id = scopeCompanyId;

    const wmUpdate = { status: "not_available" };
    if (updatedBy) wmUpdate.updated_by = updatedBy;

    const wmResult = await WhatsappMessage.updateMany(wmFilter, wmUpdate);

    return res.status(200).json({
      success: true,
      status: 200,
      message:
        "All pending messages for this number marked as not available",
      data: {
        number,
        number_variants: variants,
        company_id: scopeCompanyId,
        chats_updated: chatResult.modifiedCount ?? 0,
        whatsapp_messages_updated: wmResult.modifiedCount ?? 0,
        source_chat_id: source._id,
      },
    });
  } catch (error) {
    console.error("❌ markChatNotAvailable:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      message: error.message || "Failed to mark chat as not available",
    });
  }
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
  const raw = String(phone || "").trim();
  const digits = normalizePkWhatsappDigits(phone);
  if (!digits) return [];
  const variants = new Set([digits, raw]);

  // PK local forms: 923XXXXXXXXX ↔ 03XXXXXXXXX ↔ 3XXXXXXXXX
  if (digits.startsWith("92") && digits.length >= 12) {
    variants.add(`0${digits.slice(2)}`);
    variants.add(digits.slice(2));
  }

  // Mistaken "92" prefix on an already-international number
  // e.g. 16558112317 ↔ 9216558112317
  if (!digits.startsWith("92")) {
    variants.add(`92${digits}`);
  } else if (digits.length > 12) {
    const without92 = digits.slice(2);
    variants.add(without92);
    if (!without92.startsWith("0")) {
      variants.add(`0${without92}`);
    }
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

/**
 * GET|POST /api/chat/reset-unknown-usage-only
 * Query/body: company_id
 * Sets usage = 0 only — does not increase daily_limit.
 */
async function resetUnknownWhatsappUsageOnly(req, res) {
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

    const updated = await Company.findOneAndUpdate(
      { _id: companyId },
      {
        $set: {
          unknown_whatsapp_settings: [
            {
              daily_limit: settings.daily_limit,
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

    const next = readUnknownWhatsappSettings(
      updated || {
        unknown_whatsapp_settings: [
          {
            daily_limit: settings.daily_limit,
            usage: 0,
            increase_daily: step,
          },
        ],
      },
    );

    return res.status(200).json({
      success: true,
      status: 200,
      message: "Unknown WhatsApp usage reset to 0 (daily_limit unchanged).",
      data: {
        usage: 0,
        daily_limit: next.daily_limit,
        increase_daily: next.increase_daily,
        previous_usage: settings.usage,
        previous_daily_limit: settings.daily_limit,
      },
    });
  } catch (error) {
    console.error("❌ resetUnknownWhatsappUsageOnly:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      message: error.message || "Failed to reset unknown WhatsApp usage",
    });
  }
}

const LAST_CHATS_DEFAULT_LIMIT = 10;
const LAST_CHATS_MAX_LIMIT = 50;
const AUTO_REPLY_CHAT_LIMIT = 5;

// "Today" is measured in Pakistan time (UTC+5, no DST), not the server's timezone.
const TODAY_UTC_OFFSET_MINUTES = 5 * 60;

function startOfTodayUtc(now = new Date()) {
  const offsetMs = TODAY_UTC_OFFSET_MINUTES * 60 * 1000;
  const local = new Date(now.getTime() + offsetMs);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - offsetMs);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `?date=` → { from, to } in UTC for one Pakistan-time day.
 * Accepts "today" (default), "yesterday", or "YYYY-MM-DD". Returns null when invalid.
 */
function resolveChatDayRange(rawDate) {
  const value = String(rawDate ?? "").trim().toLowerCase();
  const todayStart = startOfTodayUtc();
  if (value === "" || value === "today") {
    return { from: todayStart, to: new Date(todayStart.getTime() + DAY_MS) };
  }
  if (value === "yesterday") {
    return { from: new Date(todayStart.getTime() - DAY_MS), to: todayStart };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const midnightUtc = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(midnightUtc.getTime())) return null;
  const from = new Date(midnightUtc.getTime() - TODAY_UTC_OFFSET_MINUTES * 60 * 1000);
  return { from, to: new Date(from.getTime() + DAY_MS) };
}

/**
 * Loads the newest chats for `filter`, asks Groq for the next reply and — when
 * filtered to one number (`variants`) and the customer spoke last — queues it
 * as a whatsapp_message. Shared by GET /chat/list and chatCreate (received).
 */
async function loadChatsAndQueueReply(req, { companyId, filter, limit, variants }) {
  const chats = await Chat.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit)
    .populate("whatsapp_message_id")
    .lean();

  // Oldest → newest, trimmed to what an AI prompt needs
  const conversation = chats
    .slice()
    .reverse()
    .map((chat) => ({
      message: chat.message,
      whatsapp_time: chat.whatsapp_time || null,
      type: chat.type,
      createdAt: chat.createdAt,
    }));

  // Groq-suggested next message to send; failures never break the chat list
  const { reply: expected_reply = null, error: expected_reply_error } =
    conversation.length ? await generateExpectedReply(conversation) : {};

  // Queue the reply to the customer (same as POST /whatsapp_message/create).
  // Only for one number and only when the customer spoke last — the queued
  // message adds a "sent" chat, so repeating this request won't send it twice.
  let expected_reply_queued = null;
  const newestChat = chats[0];
  if (expected_reply && variants.length && newestChat?.type === "received") {
    try {
      // Lazy require: whatsapp_message.js requires this file
      const { createWhatsappMessageWithChat } = require("./whatsapp_message");
      const createReq = Object.create(req);
      createReq.body = {
        number: newestChat.from_user_id,
        message: expected_reply,
        company_id: companyId,
      };
      expected_reply_queued = await createWhatsappMessageWithChat(createReq, {
        is_ai_resond: true,
        // The conversation Groq replied to (oldest → newest), as JSON
        chat_history: JSON.stringify(conversation),
      });
    } catch (queueErr) {
      console.error("❌ fetchLastChats → queue expected_reply:", queueErr);
      expected_reply_queued = {
        success: false,
        message: queueErr.message || "Failed to queue expected_reply",
      };
    }
  }

  return {
    chats,
    conversation,
    expected_reply,
    expected_reply_error,
    expected_reply_queued,
  };
}

/**
 * Same as GET /chat/list?date=today&limit=5&number=<number>, run after a
 * received chat is saved so the customer gets an AI reply queued.
 */
async function autoReplyToNumber(req, companyId, number) {
  const variants = phoneMatchVariants(number);
  if (!companyId || variants.length === 0) return null;
  const range = resolveChatDayRange("today");
  const filter = {
    company_id: companyId,
    createdAt: { $gte: range.from, $lt: range.to },
    $and: [
      activeNotDeletedCriteria(),
      {
        $or: [
          { from_user_id: { $in: variants } },
          { to_user_id: { $in: variants } },
        ],
      },
    ],
  };
  return loadChatsAndQueueReply(req, {
    companyId,
    filter,
    limit: AUTO_REPLY_CHAT_LIMIT,
    variants,
  });
}

/**
 * GET /api/chat/last/:limit   (e.g. /api/chat/last/10) — public, needs company_id
 * GET /api/chat/last          (defaults to 10)
 * GET /api/chat/list?date=today&limit=5 — Bearer auth, company from token
 * Query: company_id, date (today|yesterday|YYYY-MM-DD, default today), limit,
 *        number|phone (optional), type (optional: sent|received)
 *
 * Returns that day's newest chats for the company (newest first, max 50), optionally
 * narrowed to one phone number (matches from_user_id OR to_user_id, PK variants).
 */
async function fetchLastChats(req, res) {
  try {
    const companyId = resolveCompanyId(req);
    if (!companyId) {
      return res.status(400).json(companyIdMissingOrInvalidResponse(req));
    }

    const rawLimit = req.params?.limit ?? req.query?.limit;
    let limit = LAST_CHATS_DEFAULT_LIMIT;
    if (rawLimit != null && rawLimit !== "") {
      const requestedLimit = Number(rawLimit);
      if (!Number.isInteger(requestedLimit) || requestedLimit <= 0) {
        return res.status(400).json({
          success: false,
          status: 400,
          message: "limit must be a positive whole number (e.g. /chat/last/10 or ?limit=10)",
        });
      }
      limit = Math.min(requestedLimit, LAST_CHATS_MAX_LIMIT);
    }

    const range = resolveChatDayRange(req.query?.date);
    if (!range) {
      return res.status(400).json({
        success: false,
        status: 400,
        message: "date must be 'today', 'yesterday' or YYYY-MM-DD",
      });
    }
    const since = range.from;
    const filter = {
      company_id: companyId,
      createdAt: { $gte: range.from, $lt: range.to },
      $and: [activeNotDeletedCriteria()],
    };

    const type = String(req.query?.type || "").trim().toLowerCase();
    if (type) {
      if (type !== "sent" && type !== "received") {
        return res.status(400).json({
          success: false,
          status: 400,
          message: "type must be either 'sent' or 'received'",
        });
      }
      filter.type = type;
    }

    const number = req.query?.number ?? req.query?.phone;
    let variants = [];
    if (number != null && String(number).trim() !== "") {
      variants = phoneMatchVariants(number);
      if (variants.length === 0) {
        return res.status(400).json({
          success: false,
          status: 400,
          message: "number must contain digits",
        });
      }
      filter.$and.push({
        $or: [
          { from_user_id: { $in: variants } },
          { to_user_id: { $in: variants } },
        ],
      });
    }

    const {
      chats,
      conversation,
      expected_reply,
      expected_reply_error,
      expected_reply_queued,
    } = await loadChatsAndQueueReply(req, { companyId, filter, limit, variants });

    return res.status(200).json({
      success: true,
      status: 200,
      message: chats.length ? "Last chats fetched" : "No chats found for this date",
      count: chats.length,
      limit,
      since,
      number_variants: variants.length ? variants : undefined,
      conversation,
      expected_reply,
      expected_reply_error,
      expected_reply_queued,
      data: chats,
    });
  } catch (error) {
    console.error("❌ fetchLastChats:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      message: error.message || "Failed to fetch last chats",
    });
  }
}

const CONVERSATIONS_DEFAULT_LIMIT = 50;
const CONVERSATIONS_MAX_LIMIT = 200;

/** Company from the Bearer token only — never a company_id from the query. */
function tokenCompanyId(req) {
  const raw = req.user?.company_id;
  const id = coalesceObjectId(raw?._id || raw);
  const mongoose = require("mongoose");
  return id instanceof mongoose.Types.ObjectId ? id : null;
}

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Normalized phones whose POS user or automation customer name contains `text`. */
async function phonesMatchingName(companyId, text) {
  const User = require("../models/user");
  const Session = require("../models/wa_automation_session");
  const rx = new RegExp(escapeRegex(text), "i");
  const [users, sessionPhones] = await Promise.all([
    User.find({ company_id: companyId, deletedAt: null, name: rx, phone: { $nin: [null, ""] } })
      .select("phone")
      .limit(500)
      .lean(),
    Session.distinct("phone", { company_id: companyId, deletedAt: null, customer_name: rx }),
  ]);
  return new Set(
    [...users.map((u) => u.phone), ...sessionPhones].map(normalizePkWhatsappDigits).filter(Boolean),
  );
}

/** normalized phone → name: the POS user first, else the automation session's customer name. */
async function conversationNames(companyId, phones) {
  const names = new Map();
  if (!phones.length) return names;
  const User = require("../models/user");
  const Session = require("../models/wa_automation_session");
  const variants = [...new Set(phones.flatMap(phoneMatchVariants))];
  const [users, sessions] = await Promise.all([
    User.find({ company_id: companyId, deletedAt: null, phone: { $in: variants } }).select("name phone").lean(),
    Session.find({ company_id: companyId, deletedAt: null, phone: { $in: phones }, customer_name: { $nin: [null, ""] } })
      .sort({ last_activity_at: -1 })
      .select("phone customer_name")
      .lean(),
  ]);
  for (const user of users) {
    const phone = normalizePkWhatsappDigits(user.phone);
    const name = String(user.name || "").trim();
    if (phone && name && !names.has(phone)) names.set(phone, name);
  }
  for (const session of sessions) {
    const phone = normalizePkWhatsappDigits(session.phone);
    if (phone && !names.has(phone)) names.set(phone, String(session.customer_name).trim());
  }
  return names;
}

/**
 * GET /api/chat/conversations?search=&limit=&skip= — Bearer auth, company from the token.
 *
 * One row per customer number in `chat` (their messages plus automation, AI and
 * POS replies), latest conversation first, with the last message and a name from
 * POS users or WhatsApp automation sessions. `search` matches a name or part of
 * a number.
 */
async function fetchChatConversations(req, res) {
  try {
    const companyId = tokenCompanyId(req);
    if (!companyId) {
      return res.status(400).json({ success: false, status: 400, message: "company_id is required" });
    }

    const limit = Math.min(
      Math.max(parseInt(req.query?.limit, 10) || CONVERSATIONS_DEFAULT_LIMIT, 1),
      CONVERSATIONS_MAX_LIMIT,
    );
    const skip = Math.max(parseInt(req.query?.skip, 10) || 0, 0);
    const search = String(req.query?.search || "").trim();

    const Company = require("../models/company");
    const [company, groups] = await Promise.all([
      Company.findById(companyId).select("whatsapp_number").lean(),
      // The customer is the sender of received rows and the recipient of sent ones.
      Chat.aggregate([
        { $match: { company_id: companyId, deletedAt: null } },
        {
          $group: {
            _id: { $cond: [{ $eq: ["$type", "received"] }, "$from_user_id", "$to_user_id"] },
            count: { $sum: 1 },
            last: {
              $top: {
                sortBy: { createdAt: -1, _id: -1 },
                output: {
                  message: "$message",
                  type: "$type",
                  source: "$source",
                  is_ai_resond: "$is_ai_resond",
                  sending_status: "$sending_status",
                  at: "$createdAt",
                },
              },
            },
          },
        },
      ]).allowDiskUse(true),
    ]);

    // 0300…, 300… and 92300… are one customer
    const ownNumber = normalizePkWhatsappDigits(company?.whatsapp_number);
    const byPhone = new Map();
    for (const group of groups) {
      const phone = normalizePkWhatsappDigits(group._id);
      // "unknown", the company's own number and other non-numbers are not a conversation
      if (!/^\d{10,15}$/.test(phone) || phone === ownNumber) continue;
      const row = byPhone.get(phone);
      if (!row) {
        byPhone.set(phone, { phone, count: group.count, last: group.last });
      } else {
        row.count += group.count;
        if (new Date(group.last.at) > new Date(row.last.at)) row.last = group.last;
      }
    }
    let rows = [...byPhone.values()];

    if (search) {
      const digits = search.replace(/\D/g, "").replace(/^0+/, "");
      const namePhones = await phonesMatchingName(companyId, search);
      rows = rows.filter((r) => (digits.length >= 3 && r.phone.includes(digits)) || namePhones.has(r.phone));
    }

    rows.sort((a, b) => new Date(b.last.at) - new Date(a.last.at));
    const page = rows.slice(skip, skip + limit);
    const names = await conversationNames(
      companyId,
      page.map((r) => r.phone),
    );

    return res.status(200).json({
      success: true,
      status: 200,
      message: page.length ? "Conversations fetched" : "No conversations found",
      total: rows.length,
      limit,
      skip,
      hasMore: skip + page.length < rows.length,
      data: page.map((r) => ({
        phone: r.phone,
        name: names.get(r.phone) || "",
        messages_count: r.count,
        last_message: r.last.message || "",
        last_type: r.last.type,
        last_source: r.last.source === "automation" ? "automation" : r.last.is_ai_resond ? "ai" : "",
        last_sending_status: r.last.sending_status || "",
        last_message_at: r.last.at,
      })),
    });
  } catch (error) {
    console.error("❌ fetchChatConversations:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      message: error.message || "Failed to fetch conversations",
    });
  }
}

module.exports = {
  chatCreate,
  fetchLastChats,
  fetchChatConversations,
  authenticatePosToken,
  fetchRandomChat,
  markChatSent,
  markChatNotAvailable,
  canSendUnknownWhatsapp,
  evaluateCanSendUnknownWhatsapp,
  resetUnknownWhatsappUsage,
  resetUnknownWhatsappUsageOnly,
  phoneMatchVariants,
  normalizePkWhatsappDigits,
};
