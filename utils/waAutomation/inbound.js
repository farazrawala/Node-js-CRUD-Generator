/**
 * WhatsApp automation runtime.
 *
 * The WhatsApp Web extension posts every customer message to POST /chat/create;
 * `handleInboundMessage` runs it through the company's active flows and queues
 * the replies as `chat` rows (source "automation") that the extension's
 * fetch-random picks up first. Returns `{ handled, suppress_ai, … }` so the chat
 * controller only falls back to the AI auto-reply when no flow took the message.
 *
 * The extension also posts older messages when it catches up on a chat (and can
 * misread their dates), so a message only moves a conversation when it was
 * written after the bot's last message and the customer could have seen it.
 *
 * `runTestTurn` is the builder's test chat: same engine, real POS lookups,
 * nothing written or queued.
 */
const Chat = require("../../models/chat");
const Flow = require("../../models/wa_automation_flow");
const Session = require("../../models/wa_automation_session");
const Settings = require("../../models/wa_automation_settings");
const Template = require("../../models/wa_automation_template");
const { DEFAULT_SETTINGS } = require("../../models/wa_automation_settings");
const { TRANSCRIPT_LIMIT } = require("../../models/wa_automation_session");
const { AVAILABLE_TRIGGERS } = require("../../models/wa_automation_flow");
const engine = require("./engine");
const { runApi } = require("./lookups");
const { isAiReplyConfigured } = require("../groqReply");
const {
  BUSINESS_TZ_OFFSET_MINUTES,
  FUTURE_TOLERANCE_MS,
  isClosingReply,
  isLikelyPhone,
  isWithinBusinessHours,
  matchOption,
  normalizeReply,
  parseKeywords,
  planMessages,
  whatsappTime,
} = require("./messageFormat");

/**
 * Safety valve against bot-to-bot loops (and WhatsApp bans): replies per customer per
 * window. Loops of wrong answers already stop after MAX_INVALID_REPLIES; this is set
 * well above what a customer moving quickly through menus needs.
 */
const REPLY_BURST_LIMIT = 40;
const REPLY_BURST_WINDOW_MS = 10 * 60 * 1000;
const MENU_COMMAND = "menu";
/** WhatsApp times are whole minutes; allow that much (plus clock drift) either way. */
const CLOCK_SLACK_MS = 60 * 1000;
/** A queued reply the extension hasn't sent within this long no longer counts as on its way. */
const DELIVERY_WAIT_MS = 10 * 60 * 1000;

const minuteStart = (date) => Math.floor(new Date(date).getTime() / 60000) * 60000;

/** "10 Dec 2026, 21:15" in business time. */
function formatBusinessTime(date) {
  return new Date(date.getTime() + BUSINESS_TZ_OFFSET_MINUTES * 60000).toLocaleString("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "too_old" / "future_time" when the message's WhatsApp time rules it out, else null. */
function staleReason(sentAt, settings) {
  if (!sentAt) return null;
  const age = Date.now() - sentAt.getTime();
  if (age > settings.reply_window_minutes * 60000) return "too_old";
  if (age < -FUTURE_TOLERANCE_MS) return "future_time";
  return null;
}

/** Shown in the Automation Logs transcript next to a message the bot left unanswered. */
const IGNORED_NOTES = {
  too_old: (sentAt, settings) =>
    `Not answered: sent ${formatBusinessTime(sentAt)}, more than ${settings.reply_window_minutes} minutes ago.`,
  future_time: (sentAt) =>
    `Not answered: the extension dated it ${formatBusinessTime(sentAt)}, which is in the future.`,
  before_question: (sentAt) => `Not answered: sent ${formatBusinessTime(sentAt)}, before the bot's last message.`,
  reply_pending: () => "Not answered: the customer hadn't received the bot's last message yet.",
  reply_limit: () =>
    `Not answered: the bot already sent this customer ${REPLY_BURST_LIMIT} replies in the last 10 minutes (a safety limit against bot loops).`,
};

const STATUS_TO_OUTCOME = {
  completed: "completed",
  handed_over: "handed_over",
  dropped: "dropped",
  error: "error",
};

function chatHelpers() {
  // Lazy: controllers/chat requires this module
  return require("../../controllers/chat");
}

async function getSettings(companyId) {
  const row = companyId ? await Settings.findOne({ company_id: companyId }).lean() : null;
  return { ...DEFAULT_SETTINGS, ...(row || {}) };
}

function buildContext({ companyId, phone, settings, templates, test }) {
  return {
    test: Boolean(test),
    settings,
    templates: (templates || []).map((t) => ({ id: String(t._id), content: t.content })),
    isOpen: () => isWithinBusinessHours(new Date(), settings.business_hours),
    runApi: (source, data, vars) =>
      runApi(source, data, vars, { companyId, phone, test: Boolean(test), appUrl: settings.app_url }),
  };
}

const startKeywords = (nodes) => parseKeywords((nodes || []).find((n) => n?.type === "start")?.data?.keywords);

/** The fields the engine works with, from a stored session. */
function engineSession(doc) {
  return {
    node_id: doc.node_id || null,
    waiting: doc.waiting || null,
    vars: doc.vars || {},
    products: doc.products || [],
    invalid_count: doc.invalid_count || 0,
    handed_over: Boolean(doc.handed_over),
    last_step: doc.last_step || "",
  };
}

/** Per-customer lock so two quick messages from one customer are handled in order. */
const locks = new Map();
async function withLock(key, fn) {
  const previous = locks.get(key) || Promise.resolve();
  let release;
  const mine = new Promise((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => mine);
  locks.set(key, chained);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === chained) locks.delete(key);
  }
}

function transcriptEntries(customerText, items, at = new Date()) {
  const entries = [];
  if (customerText != null) entries.push({ from: "customer", text: String(customerText), at });
  for (const item of items) {
    entries.push(
      item.type === "bubble"
        ? { from: "bot", text: item.text, kind: item.delaySeconds ? "delayed" : "", at }
        : { from: "system", text: item.text, kind: item.kind || "", at },
    );
  }
  return entries;
}

/** Queue the customer-facing messages for the extension (oldest first, after any delay). */
async function queueReplies({ companyId, phone, sessionId, bubbles, company }) {
  if (!bubbles.length) return 0;
  let fromUserId = String(company?.whatsapp_number || "").trim();
  if (!fromUserId) fromUserId = "92";
  const now = Date.now();
  await Chat.insertMany(
    bubbles.map((b) => ({
      from_user_id: fromUserId,
      to_user_id: phone,
      message: b.text,
      whatsapp_time: new Date(now).toISOString(),
      type: "sent",
      status: "not_started",
      sending_status: "not_started",
      source: "automation",
      automation_session_id: sessionId,
      send_after: b.delaySeconds ? new Date(now + b.delaySeconds * 1000) : null,
      company_id: companyId,
    })),
    { ordered: true },
  );
  return bubbles.length;
}

async function recentReplyCount(companyId, phone) {
  return Chat.countDocuments({
    company_id: companyId,
    to_user_id: phone,
    source: "automation",
    createdAt: { $gte: new Date(Date.now() - REPLY_BURST_WINDOW_MS) },
  });
}

/** Did this customer write to us within the session timeout before this message? */
async function isNewConversation({ companyId, phone, chat, settings }) {
  const { phoneMatchVariants } = chatHelpers();
  const since = new Date(Date.now() - settings.session_timeout_minutes * 60000);
  const earlier = await Chat.exists({
    company_id: companyId,
    type: "received",
    deletedAt: null,
    _id: { $ne: chat._id },
    from_user_id: { $in: phoneMatchVariants(phone) },
    createdAt: { $gte: since, $lt: chat.createdAt ? new Date(chat.createdAt) : new Date() },
  });
  return !earlier;
}

/** Name from the customer's latest order. Orders have no phone index, so give up quickly. */
async function customerName(companyId, phone) {
  const Order = require("../../models/order");
  const { phoneMatchVariants } = chatHelpers();
  try {
    const order = await Order.findOne({ company_id: companyId, deletedAt: null, phone: { $in: phoneMatchVariants(phone) } })
      .sort({ createdAt: -1 })
      .select("name")
      .maxTimeMS(1500)
      .lean();
    return String(order?.name || "").trim();
  } catch {
    return "";
  }
}

/** Has the bot queued a message for this conversation that the extension hasn't sent yet? */
async function replyOnItsWay(companyId, sessionId) {
  const now = Date.now();
  const pending = await Chat.exists({
    company_id: companyId,
    source: "automation",
    automation_session_id: sessionId,
    status: { $in: ["not_started", "inprocess"] },
    deletedAt: null,
    createdAt: { $gte: new Date(now - DELIVERY_WAIT_MS) },
    $or: [{ send_after: null }, { send_after: { $lte: new Date(now) } }],
  });
  return Boolean(pending);
}

/** Leave a message unanswered (bot and AI quiet) and say why in the session's transcript. */
async function ignoreMessage(session, text, reason, note) {
  const at = new Date();
  await Session.updateOne(
    { _id: session._id },
    {
      $push: {
        transcript: {
          $each: [
            { from: "customer", text, at },
            { from: "system", text: note, kind: "notice", at },
          ],
          $slice: -TRANSCRIPT_LIMIT,
        },
      },
    },
  );
  return { handled: true, suppress_ai: true, reason, session_id: session._id };
}

/** The AI auto-reply answered a message that wasn't a menu choice; the menu stays open. */
async function recordAiAnswer({ sessionId, text, reply }) {
  const at = new Date();
  await Session.updateOne(
    { _id: sessionId },
    {
      $set: { last_activity_at: at },
      $push: {
        transcript: {
          $each: [
            { from: "customer", text: String(text ?? ""), at },
            { from: "system", text: "Not a menu choice, so the AI auto-reply answered. The menu stays open.", kind: "logic", at },
            { from: "bot", text: String(reply ?? ""), kind: "ai", at },
          ],
          $slice: -TRANSCRIPT_LIMIT,
        },
      },
    },
  );
}

async function endSession(session, outcome) {
  await Session.updateOne(
    { _id: session._id },
    { $set: { status: "ended", outcome, ended_at: new Date(), waiting: null } },
  );
}

/** Persist a turn's result on a new or existing session. */
async function saveTurn({ companyId, phone, flow, existing, result, transcript, sent, name }) {
  const now = new Date();
  const status = result.status === "waiting" ? "active" : result.status === "handed_over" ? "agent" : "ended";
  const outcome = result.status === "waiting" ? "in_progress" : STATUS_TO_OUTCOME[result.status] || "completed";
  const fields = {
    flow_id: flow._id,
    flow_name: flow.name,
    status,
    outcome,
    node_id: result.session.node_id || null,
    waiting: result.session.waiting || null,
    vars: result.session.vars || {},
    products: result.session.products || [],
    invalid_count: result.session.invalid_count || 0,
    handed_over: Boolean(result.session.handed_over),
    last_step: result.session.last_step || "",
    last_activity_at: now,
    ended_at: status === "ended" ? now : null,
  };
  if (existing) {
    await Session.updateOne(
      { _id: existing._id },
      {
        $set: fields,
        $inc: { messages_count: sent },
        $push: { transcript: { $each: transcript, $slice: -TRANSCRIPT_LIMIT } },
      },
    );
    return existing._id;
  }
  const created = await Session.create({
    ...fields,
    company_id: companyId,
    phone,
    customer_name: name || "",
    started_at: now,
    messages_count: sent,
    transcript: transcript.slice(-TRANSCRIPT_LIMIT),
  });
  return created._id;
}

/**
 * Run the company's automation for one received message.
 * `chat` is the saved `chat` row (type "received"). `allowAi: false` when the AI
 * auto-reply couldn't answer a question the bot handed it ("ask_ai").
 */
async function handleInboundMessage({ companyId, chat, allowAi = true }) {
  if (!companyId || !chat) return { handled: false, reason: "no_company" };
  const { normalizePkWhatsappDigits } = chatHelpers();
  const phone = normalizePkWhatsappDigits(chat.from_user_id);
  if (!isLikelyPhone(phone)) return { handled: false, reason: "not_a_phone" };

  // Take the lock before any await so messages are handled in arrival order.
  return withLock(`${companyId}:${phone}`, async () => {
    const settings = await getSettings(companyId);
    if (!settings.automation_enabled) return { handled: false, reason: "disabled" };
    return runInbound({ companyId, phone, chat, settings, allowAi });
  });
}

async function runInbound({ companyId, phone, chat, settings, allowAi }) {
  const text = String(chat.message || "");
  const norm = normalizeReply(text);

  const flows = await Flow.find({ company_id: companyId, deletedAt: null, status: "active" })
    .sort({ published_at: -1, updatedAt: -1 })
    .lean();
  const liveFlows = flows.filter((f) => Array.isArray(f.live_nodes) && f.live_nodes.length);
  const byId = new Map(liveFlows.map((f) => [String(f._id), f]));

  let session = await Session.findOne({ company_id: companyId, phone, status: { $in: ["active", "agent"] } })
    .sort({ last_activity_at: -1 })
    .lean();

  // Timed out, or its flow was paused / deleted → that conversation is over.
  if (session) {
    const idleMs = Date.now() - new Date(session.last_activity_at).getTime();
    const flowGone = !byId.has(String(session.flow_id));
    if (idleMs > settings.session_timeout_minutes * 60000 || (flowGone && session.status === "active")) {
      await endSession(session, session.status === "agent" ? "handed_over" : "dropped");
      session = null;
    }
  }

  // Old or misdated messages never move a conversation. Mid-conversation the AI stays
  // quiet too; otherwise it decides as before — except for impossible (future) dates.
  const sentAt = whatsappTime(chat.whatsapp_time);
  const stale = staleReason(sentAt, settings);
  if (stale) {
    if (session) return ignoreMessage(session, text, stale, IGNORED_NOTES[stale](sentAt, settings));
    return { handled: false, suppress_ai: stale === "future_time", reason: stale };
  }
  // Written before the bot's last message, so it can't be a reply to it.
  if (session?.status === "active" && sentAt && sentAt.getTime() < minuteStart(session.last_activity_at) - CLOCK_SLACK_MS) {
    return ignoreMessage(session, text, "before_question", IGNORED_NOTES.before_question(sentAt));
  }

  // A trigger keyword starts its flow (the customer's current flow wins a tie).
  const matchesKeyword = (f) => Boolean(f && norm && startKeywords(f.live_nodes).includes(norm));
  const sessionFlow = session ? byId.get(String(session.flow_id)) : null;
  const keywordFlow = matchesKeyword(sessionFlow) ? sessionFlow : liveFlows.find(matchesKeyword);

  // "menu" restarts the customer's flow — the open one, or the last one they used.
  let restartFlow = null;
  if (norm === MENU_COMMAND) {
    if (session) {
      restartFlow = sessionFlow;
    } else {
      const last = await Session.findOne({ company_id: companyId, phone }).sort({ last_activity_at: -1 }).select("flow_id").lean();
      restartFlow = last ? byId.get(String(last.flow_id)) || null : null;
    }
  }

  let flow = null;
  let mode = null; // "start" | "reply"
  let notAChoice = false; // free text where the bot shows a menu

  if (session?.status === "agent") {
    if (keywordFlow || restartFlow) {
      await endSession(session, "handed_over");
      flow = restartFlow || keywordFlow;
      mode = "start";
      session = null;
    } else {
      // The team has this chat: keep the bot (and the AI) quiet.
      await Session.updateOne(
        { _id: session._id },
        {
          $set: { last_activity_at: new Date() },
          $push: { transcript: { $each: [{ from: "customer", text, at: new Date() }], $slice: -TRANSCRIPT_LIMIT } },
        },
      );
      return { handled: true, suppress_ai: true, reason: "with_agent", session_id: session._id };
    }
  } else if (session) {
    const current = byId.get(String(session.flow_id));
    const waitingNode = engine.findNode(current?.live_nodes, session.waiting?.node_id);
    const picksOption =
      session.waiting?.type === "options" && waitingNode && matchOption(waitingNode.data?.options, text);
    if (picksOption) {
      flow = current;
      mode = "reply";
    } else if (restartFlow || keywordFlow) {
      // A greeting that crossed the bot's welcome would only get the welcome twice.
      if (await replyOnItsWay(companyId, session._id)) {
        return ignoreMessage(session, text, "reply_pending", IGNORED_NOTES.reply_pending());
      }
      await endSession(session, "dropped");
      flow = restartFlow || keywordFlow;
      mode = "start";
      session = null;
    } else {
      flow = current;
      mode = "reply";
      notAChoice = session.waiting?.type === "options";
    }
  } else if (restartFlow || keywordFlow) {
    flow = restartFlow || keywordFlow;
    mode = "start";
  } else {
    const welcome = liveFlows.find((f) => f.trigger === "new_conversation");
    if (welcome && (await isNewConversation({ companyId, phone, chat, settings }))) {
      flow = welcome;
      mode = "start";
    }
  }

  if (!flow) return { handled: false, reason: "no_flow" };
  if (!AVAILABLE_TRIGGERS.includes(flow.trigger)) return { handled: false, reason: "trigger_unavailable" };

  if ((await recentReplyCount(companyId, phone)) >= REPLY_BURST_LIMIT) {
    console.warn(`⚠️ WA automation: reply limit reached for …${phone.slice(-4)} (company ${companyId})`);
    if (session) return ignoreMessage(session, text, "reply_limit", IGNORED_NOTES.reply_limit());
    return { handled: true, suppress_ai: true, reason: "reply_limit" };
  }

  // A question rather than a menu choice: the AI auto-reply answers it and the menu
  // stays open. When the AI can't, the chat controller runs this again with
  // allowAi off and the bot sends its "Sorry, I didn't get that…".
  if (notAChoice && allowAi && !isClosingReply(text) && isAiReplyConfigured()) {
    if (await replyOnItsWay(companyId, session._id)) {
      return ignoreMessage(session, text, "reply_pending", IGNORED_NOTES.reply_pending());
    }
    return { handled: false, suppress_ai: false, reason: "ask_ai", session_id: session._id };
  }

  const Company = require("../../models/company");
  const [templates, company] = await Promise.all([
    Template.find({ company_id: companyId, deletedAt: null }).select("content").lean(),
    Company.findById(companyId).select("company_name whatsapp_number").lean(),
  ]);
  const ctx = buildContext({ companyId, phone, settings, templates, test: false });

  let name = "";
  let result;
  if (mode === "start") {
    name = await customerName(companyId, phone);
    result = await engine.startConversation(
      flow.live_nodes,
      { customer_name: name, customer_phone: `+${phone}`, store_name: company?.company_name || "" },
      ctx,
    );
  } else {
    result = await engine.reply(flow.live_nodes, engineSession(session), text, ctx);
    // "Sorry, I didn't get that" only makes sense once the customer has seen the question.
    const invalid = (result.session?.invalid_count || 0) > (session.invalid_count || 0);
    if (invalid && (await replyOnItsWay(companyId, session._id))) {
      return ignoreMessage(session, text, "reply_pending", IGNORED_NOTES.reply_pending());
    }
  }

  const planned = planMessages(result.items, { combine: settings.combine_messages !== false });
  const bubbles = planned.filter((p) => p.type === "bubble");
  const transcript = transcriptEntries(text, planned);
  const sessionId = await saveTurn({
    companyId,
    phone,
    flow,
    existing: mode === "reply" ? session : null,
    result,
    transcript,
    sent: bubbles.length,
    name,
  });
  const queued = await queueReplies({ companyId, phone, sessionId, bubbles, company });

  // Gave up after invalid answers: let the AI / team answer this message instead.
  const released = result.status === "dropped";
  return {
    handled: !released,
    suppress_ai: false,
    reason: released ? "released" : mode,
    session_id: sessionId,
    flow_id: flow._id,
    status: result.status,
    queued,
  };
}

/**
 * Builder test chat. `session` is what the previous call returned (null to start).
 * Returns `{ session, status, messages: [{ from: "bot" | "system", text, kind }] }`.
 */
async function runTestTurn({ companyId, nodes, session, text, restart, vars }) {
  const settings = await getSettings(companyId);
  const templates = await Template.find({ company_id: companyId, deletedAt: null }).select("content").lean();
  const ctx = buildContext({ companyId, phone: "", settings, templates, test: true });
  const norm = normalizeReply(text);
  const ended = !session || !session.waiting;
  // Same order as live chats: an option the customer picks beats a restart keyword.
  const waitingNode = !ended && session.waiting.type === "options" ? engine.findNode(nodes, session.waiting.node_id) : null;
  const picksOption = Boolean(waitingNode && matchOption(waitingNode.data?.options, text));
  const isRestart =
    restart || !session || (!picksOption && (norm === MENU_COMMAND || startKeywords(nodes).includes(norm)));

  let result;
  if (isRestart) {
    result = await engine.startConversation(nodes, vars || {}, ctx);
  } else if (ended) {
    return {
      session,
      status: session?.status || "completed",
      messages: [
        {
          from: "system",
          kind: "info",
          text: "This flow is not waiting for a reply. On WhatsApp this message goes to your AI auto-reply. Send a trigger keyword or “menu” to start again.",
        },
      ],
    };
  } else if (waitingNode && !picksOption && !isClosingReply(text) && isAiReplyConfigured()) {
    return {
      session,
      status: "waiting",
      messages: [
        {
          from: "system",
          kind: "info",
          text: "Not a menu choice. On WhatsApp your AI auto-reply answers this and the menu stays open.",
        },
      ],
    };
  } else {
    result = await engine.reply(nodes, engineSession(session), text, ctx);
  }

  const planned = planMessages(result.items, { combine: settings.combine_messages !== false });
  const messages = planned.map((p) =>
    p.type === "bubble"
      ? { from: "bot", text: p.text, kind: p.delaySeconds ? "delayed" : "", delaySeconds: p.delaySeconds || 0 }
      : { from: "system", text: p.text, kind: p.kind || "info" },
  );
  if (result.status === "dropped") {
    messages.push({ from: "system", kind: "info", text: "On WhatsApp, the AI auto-reply answers this message instead." });
  }
  return { session: { ...result.session, status: result.status }, status: result.status, messages };
}

module.exports = {
  REPLY_BURST_LIMIT,
  getSettings,
  handleInboundMessage,
  recordAiAnswer,
  runTestTurn,
  withLock,
};
