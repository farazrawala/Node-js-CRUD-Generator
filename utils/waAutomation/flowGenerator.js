/**
 * Builds (or changes) an automation flow from a plain-language description with the
 * AI (Groq). The model drafts the steps as JSON; `normalizeGeneratedFlow` then checks
 * and tidies them — unknown step types dropped, broken links cleared, menus numbered,
 * steps laid out left → right — so the builder only ever gets a flow it can open.
 * Nothing goes live from here: the user reviews the draft and publishes it.
 */
const { groqChat } = require("../groqReply");

const MAX_PROMPT_LENGTH = 2000;
const MAX_NODES = 60;
const MAX_OPTIONS = 10;
const MAX_TEXT = 1500;

const API_SOURCES = ["pos_order", "pos_delivery", "pos_products", "pos_cancel_request"];
const OPERATORS = ["equals", "not_equals", "contains", "in", "not_in", "is_empty", "not_empty"];

/** Every step type the AI may use, with the data fields it keeps (and their defaults). */
const STEP_DEFAULTS = {
  start: () => ({ keywords: "hi, hello, salam, menu", next: "" }),
  message: () => ({ text: "", next: "" }),
  menu: () => ({ text: "", appendOptions: true, listStyle: "emoji", showProducts: false, options: [] }),
  question: () => ({ text: "", variable: "answer", next: "" }),
  collect_order: () => ({
    text: "Please send your order number (for example ORD-1001).",
    variable: "order_number",
    retryText: "That does not look like an order number. Please try again (e.g. ORD-1001).",
    next: "",
  }),
  collect_phone: () => ({
    text: "Please share your phone number.",
    variable: "phone_number",
    retryText: "Please enter a valid phone number, e.g. 0300 1234567.",
    next: "",
  }),
  api: () => ({
    name: "Look up order",
    source: "pos_order",
    method: "GET",
    url: "",
    headers: [],
    params: [],
    body: "",
    mapping: [],
    successNext: "",
    failureNext: "",
  }),
  condition: () => ({
    variable: "",
    operator: "equals",
    value: "",
    trueLabel: "Yes",
    falseLabel: "No",
    trueNext: "",
    falseNext: "",
  }),
  agent: () => ({
    queueMessage: "Thanks! Our team will reply to you here shortly.",
    fallback: "Our team is offline right now. We will reply as soon as we are back.",
    next: "",
  }),
  delay: () => ({ seconds: 3600, next: "" }),
  end: () => ({ text: "Thank you for contacting us! 🙏 Reply *menu* anytime to start again." }),
};

const LINK_FIELDS = ["next", "successNext", "failureNext", "trueNext", "falseNext"];

const SYSTEM_PROMPT = `You design WhatsApp customer-support automation flows for an online store, for a no-code flow builder. Reply with one JSON object only: {"name": string, "description": string, "nodes": [step, ...]}.

How the bot works
- Messages are plain WhatsApp text: no buttons, images or lists. A menu is a numbered list and the customer replies with a number.
- Each step: {"id": short_snake_case (unique), "type", "name": short title shown in the builder, "data": {...}}. Steps link to other steps by id.
- Text may use *bold* and variables written {{name}} or {{name|fallback}}. Always available: {{customer_name}}, {{customer_phone}}, {{store_name}}.

Step types and their data
- start: {"keywords": "hi, hello, salam", "next": id}. Exactly one; it is the first step. Keywords are comma-separated words that start the flow.
- message: {"text", "next": id}. Sends text, then continues.
- menu: {"text", "options": [{"title", "next": id}], "showProducts": false}. Put {{options}} in the text where the numbered list goes and end with "Reply with a number." At most 10 options; every option needs a next step.
- question: {"text", "variable", "next": id}. Saves any reply in the variable.
- collect_order: {"text", "variable": "order_number", "retryText", "next": id}. Asks for and checks an order number.
- collect_phone: {"text", "variable": "phone_number", "retryText", "next": id}.
- api: {"name", "source", "successNext": id, "failureNext": id}. "source" is one of:
  pos_order: needs {{order_number}}; sets order_status, order_date, order_total, payment_status, order_items, item_count, can_cancel ("yes"/"no"), customer_name.
  pos_delivery: needs {{order_number}}; also sets delivery_status, courier_name, tracking_number, tracking_details.
  pos_products: needs {{search_query}} (ask it with a question step whose variable is "search_query"); sets product_count, product_name, product_price, product_stock, product_url. Follow it with a menu that has "showProducts": true; the results are listed above its options.
  pos_cancel_request: needs {{order_number}}; sends a cancellation request to the team (only for the customer's own order).
- condition: {"variable", "operator": "equals"|"not_equals"|"contains"|"in"|"not_in"|"is_empty"|"not_empty", "value", "trueLabel", "falseLabel", "trueNext": id, "falseNext": id}.
- agent: {"queueMessage", "fallback"}. Hands the chat to a person: queueMessage in business hours, fallback when closed. It ends that branch.
- delay: {"seconds", "next": id}.
- end: {"text"}. Closing message; the conversation ends.

Rules
- Usual shape: start → welcome menu → one branch per topic.
- After an answer (order status, product results, …) show a menu such as "Main Menu" / "Live Support" so the customer is never stuck. "Main Menu" options link back to the welcome menu's id.
- Every api step needs both successNext and failureNext. On failure, say what went wrong and offer "Try Again" / "Main Menu" / "Live Support".
- Short, friendly messages. Write in English unless the description asks for another language (Roman Urdu is fine when asked).
- Only use the step types and sources above; don't promise payments, refunds or anything the steps can't do.
- Every id you link to must exist in "nodes".

Example (shortened):
{"name":"Order help","description":"Order status and live support","nodes":[
{"id":"start","type":"start","name":"Customer says hi","data":{"keywords":"hi, hello, salam","next":"welcome"}},
{"id":"welcome","type":"menu","name":"Welcome","data":{"text":"Hi {{customer_name|there}}! 👋 Welcome to {{store_name}}.\\n\\n{{options}}\\n\\nReply with a number.","options":[{"title":"Order Status","next":"ask_order"},{"title":"Live Support","next":"agent"}]}},
{"id":"ask_order","type":"collect_order","name":"Ask Order Number","data":{"text":"Please send your order number (e.g. ORD-1001).","variable":"order_number","retryText":"That doesn't look like an order number. Please try again.","next":"find_order"}},
{"id":"find_order","type":"api","name":"Find Order","data":{"name":"Find Order","source":"pos_order","successNext":"order_result","failureNext":"not_found"}},
{"id":"order_result","type":"menu","name":"Order Result","data":{"text":"Order *{{order_number}}* is {{order_status}} ({{order_total}}).\\n\\n{{options}}","options":[{"title":"Main Menu","next":"welcome"},{"title":"Live Support","next":"agent"}]}},
{"id":"not_found","type":"menu","name":"Order Not Found","data":{"text":"Sorry, we couldn't find that order.\\n\\n{{options}}","options":[{"title":"Try Again","next":"ask_order"},{"title":"Main Menu","next":"welcome"},{"title":"Live Support","next":"agent"}]}},
{"id":"agent","type":"agent","name":"Live Support","data":{"queueMessage":"Thanks! Our team will reply here shortly.","fallback":"Our team is offline right now. We will reply as soon as we are back."}}]}`;

const str = (value, max = MAX_TEXT) => String(value ?? "").slice(0, max);

/** Node card height in the builder (keep in step with ai-pos flowGraph.js). */
const nodeHeight = (outputs) => 40 + 46 + outputs * 26 + 8;

function outputsOf(node) {
  if (node.type === "menu") return node.data.options.map((o) => o.next);
  if (node.type === "api") return [node.data.successNext, node.data.failureNext];
  if (node.type === "condition") return [node.data.trueNext, node.data.falseNext];
  if (node.type === "end") return [];
  return [node.data.next];
}

/** Columns by distance from Start (left → right), stacked top → bottom. */
function layOut(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = new Map();
  const start = nodes.find((n) => n.type === "start");
  const queue = start ? [start.id] : [];
  if (start) depth.set(start.id, 0);
  while (queue.length) {
    const id = queue.shift();
    for (const target of outputsOf(byId.get(id))) {
      if (target && byId.has(target) && !depth.has(target)) {
        depth.set(target, depth.get(id) + 1);
        queue.push(target);
      }
    }
  }
  const lastColumn = Math.max(0, ...depth.values());
  const nextY = new Map();
  return nodes.map((node) => {
    const column = depth.has(node.id) ? depth.get(node.id) : lastColumn + 1;
    const y = nextY.get(column) ?? 40;
    nextY.set(column, y + nodeHeight(outputsOf(node).length) + 40);
    return { ...node, x: 40 + column * 300, y };
  });
}

/**
 * The AI's draft → a flow the builder can open: known step types only, unique ids,
 * links to existing steps, numbered menu options, one Start step, laid out.
 */
function normalizeGeneratedFlow(raw) {
  const draft = raw && typeof raw === "object" ? raw : {};
  const input = (Array.isArray(draft.nodes) ? draft.nodes : []).filter(
    (n) => n && typeof n === "object" && STEP_DEFAULTS[n.type],
  );

  // Unique, tidy ids; remember what each original id became
  const idMap = new Map();
  const used = new Set();
  const steps = [];
  for (const n of input.slice(0, MAX_NODES)) {
    if (n.type === "start" && steps.some((s) => s.type === "start")) continue;
    let id = String(n.id ?? "").replace(/[^\w-]/g, "_").slice(0, 40) || `${n.type}_${steps.length + 1}`;
    while (used.has(id)) id = `${id}_${steps.length + 1}`;
    used.add(id);
    if (n.id != null && !idMap.has(String(n.id))) idMap.set(String(n.id), id);
    steps.push({ id, type: n.type, name: str(n.name, 80), source: n.data && typeof n.data === "object" ? n.data : {} });
  }
  const link = (target) => idMap.get(String(target ?? "")) || "";

  const nodes = steps.map(({ id, type, name, source: d }) => {
    const data = STEP_DEFAULTS[type]();
    for (const field of LINK_FIELDS) if (field in data) data[field] = link(d[field]);
    switch (type) {
      case "start":
        data.keywords = str(d.keywords, 300) || data.keywords;
        break;
      case "message":
      case "end":
        data.text = str(d.text) || data.text;
        break;
      case "menu":
        data.text = str(d.text) || "Please choose an option:\n\n{{options}}\n\nReply with a number.";
        data.showProducts = Boolean(d.showProducts);
        data.options = (Array.isArray(d.options) ? d.options : [])
          .filter((o) => o && typeof o === "object" && String(o.title ?? "").trim())
          .slice(0, MAX_OPTIONS)
          .map((o, i) => ({ id: `${id}_opt${i + 1}`, title: str(o.title, 60).trim(), value: String(i + 1), next: link(o.next) }));
        break;
      case "question":
      case "collect_order":
      case "collect_phone":
        data.text = str(d.text) || data.text;
        data.variable = String(d.variable ?? "").replace(/\W/g, "_").slice(0, 40) || data.variable;
        if ("retryText" in data) data.retryText = str(d.retryText) || data.retryText;
        break;
      case "api":
        data.source = API_SOURCES.includes(d.source) ? d.source : "pos_order";
        data.name = str(d.name, 80) || name || data.name;
        break;
      case "condition":
        data.variable = String(d.variable ?? "").replace(/\W/g, "_").slice(0, 40);
        data.operator = OPERATORS.includes(d.operator) ? d.operator : "equals";
        data.value = str(d.value, 200);
        data.trueLabel = str(d.trueLabel, 40) || "Yes";
        data.falseLabel = str(d.falseLabel, 40) || "No";
        break;
      case "agent":
        data.queueMessage = str(d.queueMessage) || data.queueMessage;
        data.fallback = str(d.fallback) || data.fallback;
        break;
      case "delay":
        data.seconds = Math.min(7 * 86400, Math.max(1, Math.round(Number(d.seconds) || data.seconds)));
        break;
      default:
    }
    return { id, type, name: name || "", x: 0, y: 0, data };
  });

  // Always one Start step, pointing somewhere
  let start = nodes.find((n) => n.type === "start");
  if (!start) {
    start = { id: used.has("start") ? "start_step" : "start", type: "start", name: "Customer says hi", x: 0, y: 0, data: STEP_DEFAULTS.start() };
    nodes.unshift(start);
  }
  if (!start.data.next) start.data.next = nodes.find((n) => n.type !== "start")?.id || "";

  return {
    name: str(draft.name, 80).trim(),
    description: str(draft.description, 300).trim(),
    nodes: layOut(nodes),
  };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

/** Steps as the AI sees them when changing a flow: no positions or option ids. */
function compactNodes(nodes) {
  return (nodes || []).map((n) => {
    const data = { ...(n.data || {}) };
    if (Array.isArray(data.options)) data.options = data.options.map((o) => ({ title: o.title, next: o.next }));
    for (const key of ["appendOptions", "listStyle", "method", "url", "headers", "params", "body", "mapping"]) delete data[key];
    return { id: n.id, type: n.type, name: n.name, data };
  });
}

/**
 * `prompt`: what the business wants. `nodes`: the flow to change, if any.
 * Returns { name, description, nodes } or throws an Error with a user-facing message.
 * `complete` is the chat call (tests pass their own).
 */
async function generateFlow({ prompt, trigger = "keyword", nodes = null }, { complete = groqChat, retryDelayMs = 1500 } = {}) {
  const request = String(prompt ?? "").trim().slice(0, MAX_PROMPT_LENGTH);
  if (request.length < 5) throw Object.assign(new Error("Describe the flow you want in a sentence or two."), { status: 400 });

  const triggerNote =
    trigger === "new_conversation"
      ? "This flow starts by itself on a customer's first message, so the Start keywords don't matter."
      : "This flow starts when the customer sends one of the Start keywords.";
  const userMessage = nodes?.length
    ? `Change this flow as asked. Keep the steps, ids and wording the request doesn't touch, and return the whole flow.\n${triggerNote}\n\nRequest: ${request}\n\nCurrent flow:\n${JSON.stringify({ nodes: compactNodes(nodes) })}`
    : `Build this flow.\n${triggerNote}\n\nRequest: ${request}`;

  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { content, error } = await complete({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      json: true,
      temperature: 0.3,
      reasoningEffort: "medium",
      maxTokens: 8000,
      timeoutMs: 90000,
    });
    if (error) {
      lastError = error;
      // Network blips ("fetch failed") usually clear within a moment
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      continue;
    }
    const draft = parseJson(content);
    if (draft && Array.isArray(draft.nodes) && draft.nodes.length) {
      const flow = normalizeGeneratedFlow(draft);
      if (flow.nodes.length > 1) return flow;
    }
    lastError = "The AI's answer wasn't a usable flow";
  }
  console.warn(`⚠️ WA automation: AI flow generation failed: ${lastError}`);
  throw Object.assign(new Error("The AI couldn't build a flow from that. Try again, or describe it a little differently."), {
    status: 502,
  });
}

module.exports = { generateFlow, normalizeGeneratedFlow, MAX_PROMPT_LENGTH };
