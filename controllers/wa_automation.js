/**
 * WhatsApp Automation API (ai-pos → WhatsApp Automation pages).
 * Every route is scoped to the logged-in user's company.
 *
 *   flows      GET/POST /wa-automation/flows, GET/PATCH/DELETE /wa-automation/flows/:id,
 *              PUT …/:id/nodes (save draft / publish), POST …/:id/status, POST …/:id/duplicate
 *   templates  GET/POST /wa-automation/templates, PATCH/DELETE …/:id
 *   settings   GET/PUT /wa-automation/settings
 *   logs       GET /wa-automation/sessions, GET …/:id, POST …/:id/end
 *   dashboard  GET /wa-automation/dashboard
 *   testing    POST /wa-automation/test-chat, POST /wa-automation/test-api
 */
const mongoose = require("mongoose");
const Chat = require("../models/chat");
const Flow = require("../models/wa_automation_flow");
const Session = require("../models/wa_automation_session");
const Settings = require("../models/wa_automation_settings");
const Template = require("../models/wa_automation_template");
const { AVAILABLE_TRIGGERS, TRIGGER_VALUES } = require("../models/wa_automation_flow");
const { OUTCOME_VALUES } = require("../models/wa_automation_session");
const { DEFAULT_SETTINGS } = require("../models/wa_automation_settings");
const { coalesceObjectId } = require("../utils/modelHelper");
const { getSettings, runTestTurn } = require("../utils/waAutomation/inbound");
const { runApi } = require("../utils/waAutomation/lookups");
const { apiSource, STEP_LABELS } = require("../utils/waAutomation/engine");
const { parseKeywords } = require("../utils/waAutomation/messageFormat");
const { generateFlow } = require("../utils/waAutomation/flowGenerator");
const { isAiReplyConfigured } = require("../utils/groqReply");

const MAX_NODES = 300;
const MAX_NODES_BYTES = 512 * 1024;
const MAX_TEST_SESSION_BYTES = 64 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

// ─── Helpers ──────────────────────────────────────────────────────────

function companyIdOf(req) {
  const raw = req.user?.company_id;
  if (!raw) return null;
  const id = coalesceObjectId(raw?._id || raw);
  return id instanceof mongoose.Types.ObjectId ? id : null;
}

const userIdOf = (req) => coalesceObjectId(req.user?._id) || undefined;

function oid(value) {
  return mongoose.Types.ObjectId.isValid(String(value || "")) ? new mongoose.Types.ObjectId(String(value)) : null;
}

function fail(res, status, message, extra = {}) {
  return res.status(status).json({ success: false, status, message, ...extra });
}

function ok(res, data, extra = {}) {
  return res.status(200).json({ success: true, status: 200, data, ...extra });
}

/** Wrap a handler: resolves the company, turns thrown errors into JSON 500s. */
function handler(fn) {
  return async (req, res) => {
    const companyId = companyIdOf(req);
    if (!companyId) return fail(res, 401, "Log in to a company to use WhatsApp automation");
    try {
      return await fn(req, res, companyId);
    } catch (err) {
      console.error("❌ wa_automation:", req.method, req.originalUrl, err);
      return fail(res, 500, err?.message || "Something went wrong");
    }
  };
}

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function nameTaken(Model, companyId, name, exceptId) {
  const filter = {
    company_id: companyId,
    deletedAt: null,
    name: { $regex: `^${escapeRegex(name)}$`, $options: "i" },
  };
  if (exceptId) filter._id = { $ne: exceptId };
  return Boolean(await Model.exists(filter));
}

async function uniqueName(Model, companyId, base) {
  if (!(await nameTaken(Model, companyId, base))) return base;
  for (let i = 2; i < 500; i += 1) {
    const candidate = `${base} (${i})`;
    if (!(await nameTaken(Model, companyId, candidate))) return candidate;
  }
  return `${base} (${Date.now()})`;
}

/** Basic shape check for builder steps; returns an error message or "". */
function nodesProblem(nodes) {
  if (!Array.isArray(nodes)) return "nodes must be a list of steps";
  if (nodes.length > MAX_NODES) return `A flow can have at most ${MAX_NODES} steps`;
  if (Buffer.byteLength(JSON.stringify(nodes), "utf8") > MAX_NODES_BYTES) return "This flow is too large to save";
  const ids = new Set();
  for (const n of nodes) {
    if (!n || typeof n !== "object" || typeof n.id !== "string" || !n.id) return "Every step needs an id";
    if (!STEP_LABELS[n.type]) return `Unknown step type “${n.type}”`;
    if (n.data != null && typeof n.data !== "object") return "Step data must be an object";
    if (ids.has(n.id)) return "Two steps share the same id";
    ids.add(n.id);
  }
  return "";
}

/** What has to be true before customers can get a flow. */
async function publishProblem(flow, nodes, companyId) {
  if (!AVAILABLE_TRIGGERS.includes(flow.trigger)) {
    return "This trigger is not connected yet. Use “Keyword message” or “New conversation”.";
  }
  const start = nodes.find((n) => n.type === "start");
  if (!start) return "The flow has no Start step.";
  if (!start.data?.next) return "The Start step is not connected to a first step.";
  if (flow.trigger === "keyword" && !parseKeywords(start.data?.keywords).length) {
    return "Add at least one trigger keyword to the Start step.";
  }
  if (flow.trigger === "new_conversation") {
    const other = await Flow.findOne({
      company_id: companyId,
      deletedAt: null,
      status: "active",
      trigger: "new_conversation",
      _id: { $ne: flow._id },
    })
      .select("name")
      .lean();
    if (other) return `Only one flow can answer new conversations. Pause “${other.name}” first.`;
  }
  return "";
}

async function flowStats(companyId, flowIds) {
  if (!flowIds.length) return new Map();
  const rows = await Session.aggregate([
    { $match: { company_id: companyId, flow_id: { $in: flowIds }, deletedAt: null } },
    {
      $group: {
        _id: "$flow_id",
        conversations: { $sum: 1 },
        completed: { $sum: { $cond: [{ $in: ["$outcome", ["completed", "handed_over"]] }, 1, 0] } },
      },
    },
  ]);
  return new Map(rows.map((r) => [String(r._id), { conversations: r.conversations, completed: r.completed }]));
}

function toClientFlow(flow, stats) {
  return {
    _id: flow._id,
    name: flow.name,
    description: flow.description || "",
    trigger: flow.trigger,
    status: flow.status,
    nodes: Array.isArray(flow.nodes) ? flow.nodes : [],
    has_live: Array.isArray(flow.live_nodes) && flow.live_nodes.length > 0,
    published_at: flow.published_at,
    unpublished_changes: Boolean(flow.unpublished_changes),
    created_by_name: flow.created_by_name || "",
    createdAt: flow.createdAt,
    updatedAt: flow.updatedAt,
    stats: stats || { conversations: 0, completed: 0 },
  };
}

async function sendFlow(res, companyId, flow) {
  const stats = await flowStats(companyId, [flow._id]);
  return ok(res, toClientFlow(flow, stats.get(String(flow._id))));
}

async function findFlow(companyId, id) {
  const _id = oid(id);
  if (!_id) return null;
  return Flow.findOne({ _id, company_id: companyId, deletedAt: null }).lean();
}

// ─── Flows ────────────────────────────────────────────────────────────

const listFlows = handler(async (req, res, companyId) => {
  const flows = await Flow.find({ company_id: companyId, deletedAt: null }).sort({ updatedAt: -1 }).lean();
  const stats = await flowStats(
    companyId,
    flows.map((f) => f._id),
  );
  return ok(
    res,
    flows.map((f) => toClientFlow(f, stats.get(String(f._id)))),
  );
});

const getFlow = handler(async (req, res, companyId) => {
  const flow = await findFlow(companyId, req.params.id);
  if (!flow) return fail(res, 404, "Flow not found");
  return sendFlow(res, companyId, flow);
});

const createFlow = handler(async (req, res, companyId) => {
  const body = req.body || {};
  let name = String(body.name || "").trim();
  if (!name) return fail(res, 400, "Give the flow a name");
  const trigger = TRIGGER_VALUES.includes(body.trigger) ? body.trigger : "keyword";

  let nodes = Array.isArray(body.nodes) ? body.nodes : [];
  if (body.copy_from_id) {
    const source = await findFlow(companyId, body.copy_from_id);
    if (!source) return fail(res, 404, "The flow to copy was not found");
    nodes = source.nodes || [];
  }
  const problem = nodesProblem(nodes);
  if (problem) return fail(res, 400, problem);

  if (body.unique_name) name = await uniqueName(Flow, companyId, name);
  else if (await nameTaken(Flow, companyId, name)) return fail(res, 409, "Another flow already has this name");

  const flow = await Flow.create({
    name,
    description: String(body.description || "").trim(),
    trigger,
    status: "draft",
    nodes,
    company_id: companyId,
    created_by: userIdOf(req),
    created_by_name: String(req.user?.name || "").trim(),
  });
  return sendFlow(res, companyId, flow.toObject());
});

const updateFlowDetails = handler(async (req, res, companyId) => {
  const flow = await findFlow(companyId, req.params.id);
  if (!flow) return fail(res, 404, "Flow not found");
  const body = req.body || {};
  const set = { updated_by: userIdOf(req) };

  if (body.name !== undefined) {
    const name = String(body.name || "").trim();
    if (!name) return fail(res, 400, "Give the flow a name");
    if (await nameTaken(Flow, companyId, name, flow._id)) return fail(res, 409, "Another flow already has this name");
    set.name = name;
  }
  if (body.description !== undefined) set.description = String(body.description || "").trim();
  if (body.trigger !== undefined) {
    if (!TRIGGER_VALUES.includes(body.trigger)) return fail(res, 400, "Unknown trigger");
    if (flow.status === "active" && body.trigger !== flow.trigger) {
      const problem = await publishProblem({ ...flow, trigger: body.trigger }, flow.live_nodes || [], companyId);
      if (problem) return fail(res, 409, problem);
    }
    set.trigger = body.trigger;
  }
  const updated = await Flow.findOneAndUpdate({ _id: flow._id }, { $set: set }, { new: true }).lean();
  return sendFlow(res, companyId, updated);
});

/** Body: `{ nodes, publish }`. A draft save never changes what customers get. */
const saveFlowNodes = handler(async (req, res, companyId) => {
  const flow = await findFlow(companyId, req.params.id);
  if (!flow) return fail(res, 404, "Flow not found");
  const nodes = req.body?.nodes;
  const problem = nodesProblem(nodes);
  if (problem) return fail(res, 400, problem);

  const set = { nodes, updated_by: userIdOf(req) };
  if (req.body?.publish) {
    const blocker = await publishProblem(flow, nodes, companyId);
    if (blocker) return fail(res, 409, blocker);
    Object.assign(set, { status: "active", live_nodes: nodes, published_at: new Date(), unpublished_changes: false });
  } else {
    set.unpublished_changes = flow.status === "active" || (flow.status === "paused" && Boolean(flow.live_nodes));
  }
  const updated = await Flow.findOneAndUpdate({ _id: flow._id }, { $set: set }, { new: true }).lean();
  return sendFlow(res, companyId, updated);
});

/** Body: `{ status: "active" | "paused" }`. Activating publishes the saved steps. */
const setFlowStatus = handler(async (req, res, companyId) => {
  const flow = await findFlow(companyId, req.params.id);
  if (!flow) return fail(res, 404, "Flow not found");
  const status = req.body?.status;
  if (!["active", "paused"].includes(status)) return fail(res, 400, "status must be active or paused");

  const set = { status, updated_by: userIdOf(req) };
  if (status === "active") {
    const nodes = flow.nodes || [];
    const blocker = await publishProblem(flow, nodes, companyId);
    if (blocker) return fail(res, 409, blocker);
    Object.assign(set, { live_nodes: nodes, published_at: new Date(), unpublished_changes: false });
  }
  const updated = await Flow.findOneAndUpdate({ _id: flow._id }, { $set: set }, { new: true }).lean();
  return sendFlow(res, companyId, updated);
});

const duplicateFlow = handler(async (req, res, companyId) => {
  const source = await findFlow(companyId, req.params.id);
  if (!source) return fail(res, 404, "Flow not found");
  const flow = await Flow.create({
    name: await uniqueName(Flow, companyId, `${source.name} (copy)`),
    description: source.description,
    trigger: source.trigger,
    status: "draft",
    nodes: source.nodes || [],
    company_id: companyId,
    created_by: userIdOf(req),
    created_by_name: String(req.user?.name || "").trim(),
  });
  return sendFlow(res, companyId, flow.toObject());
});

const deleteFlow = handler(async (req, res, companyId) => {
  const flow = await findFlow(companyId, req.params.id);
  if (!flow) return fail(res, 404, "Flow not found");
  await Flow.updateOne({ _id: flow._id }, { $set: { deletedAt: new Date(), status: "paused", updated_by: userIdOf(req) } });
  return ok(res, { _id: flow._id });
});

// ─── Templates ────────────────────────────────────────────────────────

const toClientTemplate = (t) => ({
  _id: t._id,
  name: t.name,
  category: t.category,
  language: t.language,
  content: t.content,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
});

function templateFields(body) {
  const fields = {};
  for (const key of ["name", "category", "language", "content"]) {
    if (body[key] !== undefined) fields[key] = String(body[key] ?? "").trim();
  }
  return fields;
}

const listTemplates = handler(async (req, res, companyId) => {
  const rows = await Template.find({ company_id: companyId, deletedAt: null }).sort({ updatedAt: -1 }).lean();
  return ok(res, rows.map(toClientTemplate));
});

const createTemplate = handler(async (req, res, companyId) => {
  const fields = templateFields(req.body || {});
  if (!fields.name) return fail(res, 400, "Give the template a name");
  if (!fields.content) return fail(res, 400, "Write the message");
  if (req.body?.unique_name) fields.name = await uniqueName(Template, companyId, fields.name);
  else if (await nameTaken(Template, companyId, fields.name)) {
    return fail(res, 409, "Another template already has this name");
  }
  const row = await Template.create({ ...fields, company_id: companyId, created_by: userIdOf(req) });
  return ok(res, toClientTemplate(row.toObject()));
});

const updateTemplate = handler(async (req, res, companyId) => {
  const _id = oid(req.params.id);
  const existing = _id && (await Template.findOne({ _id, company_id: companyId, deletedAt: null }).lean());
  if (!existing) return fail(res, 404, "Template not found");
  const fields = templateFields(req.body || {});
  if (fields.name !== undefined) {
    if (!fields.name) return fail(res, 400, "Give the template a name");
    if (await nameTaken(Template, companyId, fields.name, _id)) {
      return fail(res, 409, "Another template already has this name");
    }
  }
  if (fields.content !== undefined && !fields.content) return fail(res, 400, "Write the message");
  const row = await Template.findOneAndUpdate(
    { _id },
    { $set: { ...fields, updated_by: userIdOf(req) } },
    { new: true, runValidators: true },
  ).lean();
  return ok(res, toClientTemplate(row));
});

const deleteTemplate = handler(async (req, res, companyId) => {
  const _id = oid(req.params.id);
  const result = _id
    ? await Template.updateOne({ _id, company_id: companyId, deletedAt: null }, { $set: { deletedAt: new Date() } })
    : null;
  if (!result?.matchedCount) return fail(res, 404, "Template not found");
  return ok(res, { _id });
});

// ─── Settings & connection ────────────────────────────────────────────

/**
 * Is the WhatsApp Web extension doing its job? Last message it captured, last one
 * it sent, and automation replies still waiting for it.
 */
async function connectionStatus(companyId) {
  const Company = require("../models/company");
  const [company, lastIn, lastSent, pending, oldestPending] = await Promise.all([
    Company.findById(companyId).select("whatsapp_number display_store_on_bigcommerce").lean(),
    Chat.findOne({ company_id: companyId, type: "received", deletedAt: null }).sort({ createdAt: -1 }).select("createdAt").lean(),
    Chat.findOne({ company_id: companyId, type: "sent", status: "sent", deletedAt: null })
      .sort({ updatedAt: -1 })
      .select("updatedAt")
      .lean(),
    Chat.countDocuments({ company_id: companyId, source: "automation", status: { $in: ["not_started", "inprocess"] }, deletedAt: null }),
    Chat.findOne({
      company_id: companyId,
      source: "automation",
      status: "not_started",
      deletedAt: null,
      $or: [{ send_after: null }, { send_after: { $lte: new Date() } }],
    })
      .sort({ createdAt: 1 })
      .select("createdAt")
      .lean(),
  ]);
  return {
    whatsapp_number: company?.whatsapp_number || "",
    last_received_at: lastIn?.createdAt || null,
    last_sent_at: lastSent?.updatedAt || null,
    pending_replies: pending,
    oldest_pending_at: oldestPending?.createdAt || null,
    // Product links in WhatsApp open the public shop, which needs the store to be public
    shop_public: Boolean(company?.display_store_on_bigcommerce),
  };
}

function settingsForClient(settings) {
  const pick = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) pick[key] = settings[key];
  return pick;
}

const getSettingsRoute = handler(async (req, res, companyId) => {
  const settings = await getSettings(companyId);
  return ok(res, settingsForClient(settings), { connection: await connectionStatus(companyId) });
});

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const saveSettingsRoute = handler(async (req, res, companyId) => {
  const body = req.body || {};
  const set = { updated_by: userIdOf(req) };
  if (body.automation_enabled !== undefined) set.automation_enabled = Boolean(body.automation_enabled);
  if (body.combine_messages !== undefined) set.combine_messages = Boolean(body.combine_messages);
  for (const [key, min, max] of [
    ["session_timeout_minutes", 1, 1440],
    ["reply_window_minutes", 1, 10080],
  ]) {
    if (body[key] === undefined) continue;
    const n = Math.round(Number(body[key]));
    if (!Number.isFinite(n) || n < min || n > max) return fail(res, 400, `${key} must be between ${min} and ${max}`);
    set[key] = n;
  }
  if (body.fallback_message !== undefined) {
    const text = String(body.fallback_message || "").trim();
    if (!text) return fail(res, 400, "Write a fallback message");
    set.fallback_message = text.slice(0, 1000);
  }
  if (body.thanks_message !== undefined) {
    const text = String(body.thanks_message || "").trim();
    if (!text) return fail(res, 400, "Write a reply for when a customer says thanks");
    set.thanks_message = text.slice(0, 1000);
  }
  if (body.app_url !== undefined) {
    const url = String(body.app_url || "").trim().replace(/\/+$/, "");
    if (url && !/^https?:\/\/\S+$/i.test(url)) return fail(res, 400, "The POS address must start with http:// or https://");
    set.app_url = url.slice(0, 300);
  }
  if (body.business_hours !== undefined) {
    if (!Array.isArray(body.business_hours)) return fail(res, 400, "business_hours must be a list");
    const rows = [];
    for (const day of DAYS) {
      const row = body.business_hours.find((d) => d?.day === day) || { day, open: false };
      const from = String(row.from || "10:00");
      const to = String(row.to || "19:00");
      if (!/^\d{2}:\d{2}$/.test(from) || !/^\d{2}:\d{2}$/.test(to)) return fail(res, 400, `Times for ${day} must be HH:MM`);
      if (row.open && from >= to) return fail(res, 400, `${day}: closing time must be after opening time`);
      rows.push({ day, open: Boolean(row.open), from, to });
    }
    set.business_hours = rows;
  }
  await Settings.findOneAndUpdate(
    { company_id: companyId },
    { $set: set },
    { upsert: true, new: true, runValidators: true },
  );
  return ok(res, settingsForClient(await getSettings(companyId)), { connection: await connectionStatus(companyId) });
});

// ─── Logs (sessions) ──────────────────────────────────────────────────

const SESSION_LIST_FIELDS =
  "phone customer_name flow_id flow_name status outcome last_step started_at last_activity_at ended_at messages_count";

const listSessions = handler(async (req, res, companyId) => {
  const q = req.query || {};
  const limit = Math.min(500, Math.max(1, parseInt(q.limit, 10) || 25));
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const filter = { company_id: companyId, deletedAt: null };
  if (q.flow_id) {
    const flowId = oid(q.flow_id);
    if (!flowId) return fail(res, 400, "Invalid flow_id");
    filter.flow_id = flowId;
  }
  if (q.outcome) {
    if (!OUTCOME_VALUES.includes(q.outcome)) return fail(res, 400, "Unknown outcome");
    filter.outcome = q.outcome;
  }
  const search = String(q.q || "").trim();
  if (search) {
    const rx = { $regex: escapeRegex(search), $options: "i" };
    const digits = search.replace(/\D/g, "");
    filter.$or = [{ customer_name: rx }, { last_step: rx }, { flow_name: rx }];
    if (digits.length >= 3) filter.$or.push({ phone: { $regex: escapeRegex(digits) } });
  }
  const [rows, total] = await Promise.all([
    Session.find(filter)
      .sort({ started_at: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select(SESSION_LIST_FIELDS)
      .lean(),
    Session.countDocuments(filter),
  ]);
  return ok(res, rows, { total, page, limit });
});

const getSessionRoute = handler(async (req, res, companyId) => {
  const _id = oid(req.params.id);
  const row = _id && (await Session.findOne({ _id, company_id: companyId, deletedAt: null }).select(`${SESSION_LIST_FIELDS} transcript vars`).lean());
  if (!row) return fail(res, 404, "Conversation not found");
  return ok(res, row);
});

/** Staff closes a conversation, e.g. after handling a handover — the bot can answer again. */
const endSessionRoute = handler(async (req, res, companyId) => {
  const _id = oid(req.params.id);
  const row = _id && (await Session.findOne({ _id, company_id: companyId, deletedAt: null }).lean());
  if (!row) return fail(res, 404, "Conversation not found");
  if (row.status !== "ended") {
    const outcome = row.status === "agent" ? "handed_over" : "dropped";
    await Session.updateOne(
      { _id },
      {
        $set: { status: "ended", outcome, ended_at: new Date(), waiting: null },
        $push: { transcript: { from: "system", text: `Ended by ${req.user?.name || "staff"}`, kind: "end", at: new Date() } },
      },
    );
  }
  const updated = await Session.findById(_id).select(`${SESSION_LIST_FIELDS} transcript vars`).lean();
  return ok(res, updated);
});

// ─── Dashboard ────────────────────────────────────────────────────────

const dashboard = handler(async (req, res, companyId) => {
  const now = Date.now();
  const from30 = new Date(now - 30 * DAY_MS);
  const from60 = new Date(now - 60 * DAY_MS);
  const settings = await getSettings(companyId);
  const base = { company_id: companyId, deletedAt: null };

  const [flowCounts, messagesNow, messagesPrev, convNow, convPrev, outcomes, withAgent, connection] = await Promise.all([
    Flow.aggregate([{ $match: base }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
    Chat.countDocuments({ ...base, source: "automation", createdAt: { $gte: from30 } }),
    Chat.countDocuments({ ...base, source: "automation", createdAt: { $gte: from60, $lt: from30 } }),
    Session.countDocuments({ ...base, started_at: { $gte: from30 } }),
    Session.countDocuments({ ...base, started_at: { $gte: from60, $lt: from30 } }),
    Session.aggregate([{ $match: { ...base, started_at: { $gte: from30 } } }, { $group: { _id: "$outcome", n: { $sum: 1 } } }]),
    Session.countDocuments({
      ...base,
      status: "agent",
      last_activity_at: { $gte: new Date(now - settings.session_timeout_minutes * 60000) },
    }),
    connectionStatus(companyId),
  ]);

  const byStatus = Object.fromEntries(flowCounts.map((r) => [r._id, r.n]));
  return ok(res, {
    flows: {
      total: flowCounts.reduce((sum, r) => sum + r.n, 0),
      active: byStatus.active || 0,
      draft: byStatus.draft || 0,
      paused: byStatus.paused || 0,
    },
    messages_automated: { last_30_days: messagesNow, previous_30_days: messagesPrev },
    conversations: { last_30_days: convNow, previous_30_days: convPrev },
    outcomes: Object.fromEntries(outcomes.map((r) => [r._id, r.n])),
    waiting_for_team: withAgent,
    automation_enabled: settings.automation_enabled,
    connection,
  });
});

// ─── Testing ──────────────────────────────────────────────────────────

/**
 * Body: `{ nodes, session, text, restart, vars }`. Runs the flow on real POS data
 * without sending or saving anything.
 */
const testChat = handler(async (req, res, companyId) => {
  const body = req.body || {};
  const problem = nodesProblem(body.nodes);
  if (problem) return fail(res, 400, problem);
  const session = body.session && typeof body.session === "object" ? body.session : null;
  if (session && Buffer.byteLength(JSON.stringify(session), "utf8") > MAX_TEST_SESSION_BYTES) {
    return fail(res, 400, "Test conversation is too large — restart it");
  }
  const vars = body.vars && typeof body.vars === "object" ? body.vars : {};
  const result = await runTestTurn({
    companyId,
    nodes: body.nodes,
    session,
    text: String(body.text ?? "").slice(0, 4096),
    restart: Boolean(body.restart),
    vars,
  });
  return ok(res, result);
});

/** Body: `{ data, vars }` — try one API step (GET requests are really sent). */
const testApi = handler(async (req, res, companyId) => {
  const data = req.body?.data && typeof req.body.data === "object" ? req.body.data : null;
  if (!data) return fail(res, 400, "data is required");
  const vars = req.body?.vars && typeof req.body.vars === "object" ? req.body.vars : {};
  const { app_url: appUrl } = await getSettings(companyId);
  const result = await runApi(apiSource(data), data, vars, { companyId, phone: "", test: true, appUrl });
  return ok(res, result);
});

/** Body: `{ prompt, trigger, nodes? }` — the AI drafts a flow, or changes `nodes`. Nothing is saved. */
const generateFlowRoute = handler(async (req, res) => {
  if (!isAiReplyConfigured()) {
    return fail(res, 400, "AI isn't set up on the server yet: add GROQ_API_KEY to the backend .env.");
  }
  const body = req.body || {};
  const nodes = Array.isArray(body.nodes) && body.nodes.length ? body.nodes : null;
  if (nodes) {
    const problem = nodesProblem(nodes);
    if (problem) return fail(res, 400, problem);
  }
  try {
    return ok(res, await generateFlow({ prompt: body.prompt, trigger: body.trigger, nodes }));
  } catch (err) {
    if (err.status) return fail(res, err.status, err.message);
    throw err;
  }
});

module.exports = {
  listFlows,
  getFlow,
  createFlow,
  generateFlow: generateFlowRoute,
  updateFlowDetails,
  saveFlowNodes,
  setFlowStatus,
  duplicateFlow,
  deleteFlow,
  listTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  getSettings: getSettingsRoute,
  saveSettings: saveSettingsRoute,
  listSessions,
  getSession: getSessionRoute,
  endSession: endSessionRoute,
  dashboard,
  testChat,
  testApi,
};
