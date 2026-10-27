/**
 * WhatsApp automation flow engine. Runs a flow's steps for one customer turn and
 * returns what to send — it never touches the database itself. Lookups (orders,
 * products, HTTP) and business hours come in through `ctx`, so live chats and the
 * builder's test chat run exactly the same code.
 *
 * Flow data is the builder's node list: `{ id, type, name, data }`, linked by
 * `data.next`, `data.successNext`, `option.next`, …  (see ai-pos stepTypes.js).
 *
 * A turn returns `{ session, items, status }`:
 *   - items:  [{ type: "send", text, delaySeconds } | { type: "note", text, kind }]
 *   - status: "waiting" (needs the customer) | "completed" | "handed_over"
 *             | "dropped" (gave up after invalid replies) | "error"
 */
const {
  composeMenuText,
  evaluateCondition,
  formatOptionList,
  formatProductList,
  interpolate,
  isClosingReply,
  matchOption,
  presentMenu,
  normalizeOrderNumber,
  normalizePhoneInput,
} = require("./messageFormat");

/** Steps processed in one turn before giving up (loops with no question). */
const MAX_STEPS_PER_TURN = 40;
/** Invalid answers in a row before the bot stops and lets the team / AI reply. */
const MAX_INVALID_REPLIES = 3;
const MAX_DELAY_SECONDS = 7 * 24 * 60 * 60;

const STEP_LABELS = {
  start: "Start",
  message: "Send Message",
  menu: "Show Options / Menu",
  question: "Ask a Question",
  collect_order: "Collect Order Number",
  collect_phone: "Collect Phone Number",
  api: "API Request",
  condition: "Condition / If-Else",
  template: "Send Template",
  agent: "Assign to Live Agent",
  delay: "Delay",
  end: "End Conversation",
};

const DEFAULT_FALLBACK = "Sorry, I didn't get that. Please reply with one of the numbers below.";
const DEFAULT_THANKS = "You're welcome! 😊 Reply *menu* anytime if you need anything else.";

const findNode = (nodes, id) => (id ? (nodes || []).find((n) => n && n.id === id) || null : null);
const nodeTitle = (node) => node?.name || STEP_LABELS[node?.type] || "Step";

/** API step data source; older prototype steps only had a `mock` behaviour. */
const MOCK_TO_SOURCE = {
  order_lookup: "pos_order",
  delivery_lookup: "pos_delivery",
  product_search: "pos_products",
  cancel_order: "pos_cancel_request",
};
function apiSource(data = {}) {
  return data.source || MOCK_TO_SOURCE[data.mock] || "http";
}

function formatDuration(seconds) {
  if (seconds >= 86400) return `${Math.round(seconds / 86400)} day(s)`;
  if (seconds >= 3600) return `${Math.round(seconds / 3600)} hour(s)`;
  if (seconds >= 60) return `${Math.round(seconds / 60)} minute(s)`;
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

function createSession(vars = {}) {
  return {
    node_id: null,
    waiting: null,
    vars: { ...vars },
    products: [],
    invalid_count: 0,
    handed_over: false,
    last_step: "",
  };
}

/**
 * Run from `startId` until the flow needs the customer or ends.
 * Appends to `items`; returns `{ session, status }`.
 */
async function runFrom(nodes, startId, session, ctx, items) {
  let s = { ...session, waiting: null };
  let currentId = startId;
  let delay = 0;
  const send = (text) => {
    const clean = String(text ?? "").trim();
    if (clean) items.push({ type: "send", text: clean, delaySeconds: delay });
  };
  const note = (text, kind = "info") => items.push({ type: "note", text, kind });
  const finished = () => ({ ...s, node_id: null, waiting: null });
  const endStatus = () => (s.handed_over ? "handed_over" : "completed");

  for (let steps = 0; steps < MAX_STEPS_PER_TURN; steps += 1) {
    const node = findNode(nodes, currentId);
    if (!node) {
      note(
        currentId
          ? "This step was deleted — the conversation ends here."
          : "No next step is connected — the conversation ends here.",
        "end",
      );
      return { session: finished(), status: endStatus() };
    }
    s = { ...s, node_id: node.id, last_step: nodeTitle(node) };
    const d = node.data || {};

    switch (node.type) {
      case "start":
        currentId = d.next;
        break;

      case "message":
        send(interpolate(d.text, s.vars));
        currentId = d.next;
        break;

      case "menu":
        send(composeMenuText(d, s.vars, s.products));
        return { session: { ...s, waiting: { type: "options", node_id: node.id } }, status: "waiting" };

      case "question":
      case "collect_order":
      case "collect_phone":
        send(interpolate(d.text, s.vars));
        return { session: { ...s, waiting: { type: "input", node_id: node.id } }, status: "waiting" };

      case "api": {
        let result;
        try {
          result = await ctx.runApi(apiSource(d), d, s.vars, s.products);
        } catch (err) {
          result = { ok: false, summary: err?.message || "Request failed" };
        }
        const label = d.name || nodeTitle(node);
        note(`${label}: ${result.summary || (result.ok ? "OK" : "failed")}`, result.ok ? "api-success" : "api-failure");
        if (result.notice) note(result.notice, "notice");
        s = {
          ...s,
          vars: { ...s.vars, ...(result.vars || {}) },
          products: Array.isArray(result.products) ? result.products : s.products,
        };
        currentId = result.ok ? d.successNext : d.failureNext;
        break;
      }

      case "condition": {
        const passed = evaluateCondition(d, s.vars);
        note(`Check: ${passed ? d.trueLabel || "Yes" : d.falseLabel || "No"}`, "logic");
        currentId = passed ? d.trueNext : d.falseNext;
        break;
      }

      case "template": {
        const tpl = (ctx.templates || []).find((t) => String(t.id ?? t._id) === String(d.templateId));
        if (tpl) send(interpolate(tpl.content, s.vars));
        else note("Template not found — skipped. Pick one in the step settings.", "notice");
        currentId = d.next;
        break;
      }

      case "agent": {
        const open = ctx.isOpen ? ctx.isOpen() : true;
        send(interpolate(open ? d.queueMessage : d.fallback || d.queueMessage, s.vars));
        note(
          `Handed over to your team${open ? "" : " (outside business hours)"} — the bot stops replying to this customer.`,
          "agent",
        );
        s = { ...s, handed_over: true };
        currentId = d.next;
        if (!currentId) return { session: finished(), status: "handed_over" };
        break;
      }

      case "delay": {
        const seconds = Math.min(MAX_DELAY_SECONDS, Math.max(0, Math.round(Number(d.seconds) || 0)));
        if (seconds > 0) {
          delay += seconds;
          note(`Next messages are sent after ${formatDuration(seconds)}.`, "logic");
        }
        currentId = d.next;
        break;
      }

      case "end":
        send(interpolate(d.text, s.vars));
        note("Conversation ended", "end");
        return { session: finished(), status: endStatus() };

      default:
        currentId = d.next;
    }
  }

  note("Stopped: these steps loop without waiting for the customer.", "error");
  return { session: finished(), status: "error" };
}

/** Begin a flow at its Start step. */
async function startConversation(nodes, vars, ctx) {
  const items = [];
  const session = createSession(vars);
  const start = (nodes || []).find((n) => n && n.type === "start");
  if (!start) {
    items.push({ type: "note", text: "This flow has no Start step.", kind: "error" });
    return { session, items, status: "error" };
  }
  const result = await runFrom(nodes, start.id, session, ctx, items);
  return { ...result, items };
}

function invalidReply(node, session, ctx, items, retryText) {
  const count = (session.invalid_count || 0) + 1;
  if (count >= MAX_INVALID_REPLIES) {
    items.push({
      type: "note",
      text: `No valid answer after ${MAX_INVALID_REPLIES} tries — the bot stops so your team can reply.`,
      kind: "end",
    });
    return { session: { ...session, invalid_count: count, waiting: null, node_id: null }, items, status: "dropped" };
  }
  items.push({ type: "send", text: retryText, delaySeconds: 0 });
  return { session: { ...session, invalid_count: count }, items, status: "waiting" };
}

/** "Thanks" / "bye" instead of an answer: say goodbye and close the conversation. */
function closeWithThanks(session, ctx, items) {
  const text = String(ctx.settings?.thanks_message || DEFAULT_THANKS).trim();
  items.push({ type: "send", text: interpolate(text, session.vars), delaySeconds: 0 });
  items.push({ type: "note", text: "The customer said thanks, so the conversation was closed.", kind: "end" });
  return { session: { ...session, invalid_count: 0, waiting: null, node_id: null }, items, status: "completed" };
}

/** Handle a customer reply to the step the session is waiting on. */
async function reply(nodes, session, text, ctx) {
  const items = [];
  const waiting = session?.waiting;
  const node = waiting ? findNode(nodes, waiting.node_id) : null;
  if (!node) {
    items.push({ type: "note", text: "The step this customer was answering no longer exists.", kind: "error" });
    return { session: { ...session, waiting: null, node_id: null }, items, status: "error" };
  }
  const d = node.data || {};

  if (waiting.type === "options") {
    const presented = presentMenu(d, session.products);
    const option = matchOption(presented.choices, text);
    if (!option) {
      if (isClosingReply(text)) return closeWithThanks(session, ctx, items);
      const fallback = String(ctx.settings?.fallback_message || DEFAULT_FALLBACK).trim();
      const list = formatOptionList(presented.shown, { style: d.listStyle, vars: session.vars });
      const productText = presented.numberProducts ? formatProductList(session.products) : "";
      const again = [productText, list].filter(Boolean).join("\n\n");
      return invalidReply(node, session, ctx, items, `${fallback}\n\n${again}`);
    }
    const next = { ...session, invalid_count: 0, vars: { ...session.vars, last_choice: option.title || "" } };
    const result = await runFrom(nodes, option.next, next, ctx, items);
    return { ...result, items };
  }

  let value = String(text ?? "").trim();
  if (node.type === "collect_order") value = normalizeOrderNumber(value);
  if (node.type === "collect_phone") value = normalizePhoneInput(value);
  if (!value) {
    if (isClosingReply(text)) return closeWithThanks(session, ctx, items);
    return invalidReply(node, session, ctx, items, interpolate(d.retryText || "Please try again.", session.vars));
  }
  const next = {
    ...session,
    invalid_count: 0,
    vars: { ...session.vars, [d.variable || "answer"]: value },
  };
  const result = await runFrom(nodes, d.next, next, ctx, items);
  return { ...result, items };
}

module.exports = {
  MAX_INVALID_REPLIES,
  STEP_LABELS,
  apiSource,
  createSession,
  findNode,
  nodeTitle,
  reply,
  runFrom,
  startConversation,
};
