/**
 * WhatsApp Automation REST controller against a throwaway local MongoDB database
 * (dropped afterwards). Skipped when no MongoDB answers.
 */
const { after, before, describe, it } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const MONGO = process.env.WA_AUTOMATION_TEST_MONGO || "mongodb://127.0.0.1:27017";
const DB_NAME = `wa_automation_api_it_${Date.now()}`;

let available = false;
let api;
const companyId = new mongoose.Types.ObjectId();
const otherCompanyId = new mongoose.Types.ObjectId();
const user = { _id: new mongoose.Types.ObjectId(), name: "Aslam", company_id: { _id: companyId, company_name: "OrdersHub" } };

const node = (id, type, data) => ({ id, type, name: id, x: 0, y: 0, data });
const NODES = [
  node("start", "start", { keywords: "hi", next: "menu" }),
  node("menu", "menu", {
    text: "Hello {{customer_name|there}}!",
    options: [
      { id: "a", title: "Find a product", value: "1", next: "q" },
      { id: "b", title: "Bye", value: "2", next: "end" },
    ],
  }),
  node("q", "question", { text: "What are you looking for?", variable: "search_query", next: "end" }),
  node("end", "end", { text: "Thanks!" }),
];

async function call(fn, { body, params, query, as = user } = {}) {
  const res = {
    code: 0,
    body: null,
    status(code) {
      this.code = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  await fn({ body: body || {}, params: params || {}, query: query || {}, user: as, method: "TEST", originalUrl: "/test" }, res);
  return res;
}

before(async () => {
  try {
    await mongoose.connect(`${MONGO}/${DB_NAME}`, { serverSelectionTimeoutMS: 1500 });
    available = true;
  } catch {
    available = false;
    return;
  }
  api = require("../controllers/wa_automation");
  await mongoose.connection.db.collection("companies").insertOne({ _id: companyId, company_name: "OrdersHub", whatsapp_number: "923000000000" });
});

after(async () => {
  if (!available) return;
  // Models loaded during the tests build indexes in the background; an index build
  // that finishes after the drop would create the database again.
  await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init().catch(() => {})));
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
});

describe("WhatsApp Automation API", () => {
  let flowId;

  it("rejects requests without a company", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const res = await call(api.listFlows, { as: { _id: user._id } });
    assert.equal(res.code, 401);
  });

  it("creates a draft flow and refuses duplicate names", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const res = await call(api.createFlow, { body: { name: "Support bot", trigger: "keyword", nodes: NODES } });
    assert.equal(res.code, 200);
    assert.equal(res.body.data.status, "draft");
    assert.equal(res.body.data.created_by_name, "Aslam");
    flowId = String(res.body.data._id);

    const clash = await call(api.createFlow, { body: { name: "support BOT" } });
    assert.equal(clash.code, 409);
    const unique = await call(api.createFlow, { body: { name: "Support bot", unique_name: true } });
    assert.equal(unique.body.data.name, "Support bot (2)");
  });

  it("validates steps before saving", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const res = await call(api.saveFlowNodes, { params: { id: flowId }, body: { nodes: [{ id: "x", type: "rocket" }] } });
    assert.equal(res.code, 400);
  });

  it("publishes, and keeps the live version on later draft saves", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const published = await call(api.saveFlowNodes, { params: { id: flowId }, body: { nodes: NODES, publish: true } });
    assert.equal(published.code, 200);
    assert.equal(published.body.data.status, "active");
    assert.equal(published.body.data.unpublished_changes, false);

    const edited = NODES.map((n) => (n.id === "end" ? { ...n, data: { text: "Bye!" } } : n));
    const draft = await call(api.saveFlowNodes, { params: { id: flowId }, body: { nodes: edited } });
    assert.equal(draft.body.data.unpublished_changes, true);
    const Flow = require("../models/wa_automation_flow");
    const row = await Flow.findById(flowId).lean();
    assert.equal(row.live_nodes.find((n) => n.id === "end").data.text, "Thanks!");
  });

  it("won't publish flows customers can't reach", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const noKeywords = NODES.map((n) => (n.type === "start" ? { ...n, data: { ...n.data, keywords: " , " } } : n));
    const created = await call(api.createFlow, { body: { name: "No keywords", nodes: noKeywords } });
    const res = await call(api.setFlowStatus, { params: { id: created.body.data._id }, body: { status: "active" } });
    assert.equal(res.code, 409);
    assert.match(res.body.message, /keyword/);

    const event = await call(api.createFlow, { body: { name: "Order placed", trigger: "order_placed", nodes: NODES } });
    const blocked = await call(api.setFlowStatus, { params: { id: event.body.data._id }, body: { status: "active" } });
    assert.equal(blocked.code, 409);
    assert.match(blocked.body.message, /not connected yet/);
  });

  it("allows only one active 'New conversation' flow", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const a = await call(api.createFlow, { body: { name: "Welcome A", trigger: "new_conversation", nodes: NODES } });
    const b = await call(api.createFlow, { body: { name: "Welcome B", trigger: "new_conversation", nodes: NODES } });
    assert.equal((await call(api.setFlowStatus, { params: { id: a.body.data._id }, body: { status: "active" } })).code, 200);
    const second = await call(api.setFlowStatus, { params: { id: b.body.data._id }, body: { status: "active" } });
    assert.equal(second.code, 409);
    assert.match(second.body.message, /Welcome A/);
  });

  it("keeps companies apart", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const stranger = { _id: new mongoose.Types.ObjectId(), company_id: otherCompanyId };
    assert.equal((await call(api.getFlow, { params: { id: flowId }, as: stranger })).code, 404);
    assert.deepEqual((await call(api.listFlows, { as: stranger })).body.data, []);
  });

  it("runs the test chat without queueing anything", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const first = await call(api.testChat, { body: { nodes: NODES, text: "hi" } });
    assert.equal(first.code, 200);
    assert.equal(first.body.data.messages[0].text, "Hello there!\n\n1️⃣ Find a product\n2️⃣ Bye");
    const next = await call(api.testChat, { body: { nodes: NODES, session: first.body.data.session, text: "1" } });
    assert.equal(next.body.data.messages[0].text, "What are you looking for?");
    const Chat = require("../models/chat");
    assert.equal(await Chat.countDocuments({ company_id: companyId }), 0);
  });

  it("test chat lets an option win over a restart keyword, like live chats", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const nodes = NODES.map((n) => (n.type === "start" ? { ...n, data: { ...n.data, keywords: "hi, 2" } } : n));
    const first = await call(api.testChat, { body: { nodes, text: "hi" } });
    const next = await call(api.testChat, { body: { nodes, session: first.body.data.session, text: "2" } });
    assert.equal(next.body.data.status, "completed", "'2' picked the Bye option instead of restarting");
    assert.equal(next.body.data.messages[0].text, "Thanks!");
  });

  it("saves settings with validation", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const bad = await call(api.saveSettings, { body: { session_timeout_minutes: 0 } });
    assert.equal(bad.code, 400);
    const hours = await call(api.saveSettings, {
      body: { business_hours: [{ day: "Monday", open: true, from: "19:00", to: "10:00" }] },
    });
    assert.equal(hours.code, 400);
    const good = await call(api.saveSettings, { body: { session_timeout_minutes: 45, combine_messages: false } });
    assert.equal(good.code, 200);
    assert.equal(good.body.data.session_timeout_minutes, 45);
    assert.equal(good.body.data.combine_messages, false);
    assert.equal(good.body.data.business_hours.length, 7);
    assert.equal(good.body.connection.whatsapp_number, "923000000000");
    assert.equal(good.body.connection.shop_public, false);

    // What the POS saves on its own: just its address
    const address = await call(api.saveSettings, { body: { app_url: "http://localhost:5173/" } });
    assert.equal(address.code, 200);
    assert.equal(address.body.data.app_url, "http://localhost:5173");
    assert.equal((await call(api.saveSettings, { body: { app_url: "localhost" } })).code, 400);
  });

  it("explains that AI flow building needs the AI key", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const savedKey = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
    try {
      const res = await call(api.generateFlow, { body: { prompt: "Order status bot" } });
      assert.equal(res.code, 400);
      assert.match(res.body.message, /GROQ_API_KEY/);
    } finally {
      if (savedKey !== undefined) process.env.GROQ_API_KEY = savedKey;
    }
  });

  it("manages templates", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const created = await call(api.createTemplate, { body: { name: "Thanks", content: "Thank you {{customer_name}}!" } });
    assert.equal(created.code, 200);
    const id = created.body.data._id;
    assert.equal((await call(api.createTemplate, { body: { name: "thanks", content: "x" } })).code, 409);
    const updated = await call(api.updateTemplate, { params: { id }, body: { content: "Shukriya!" } });
    assert.equal(updated.body.data.content, "Shukriya!");
    assert.equal((await call(api.deleteTemplate, { params: { id } })).code, 200);
    assert.deepEqual((await call(api.listTemplates)).body.data, []);
  });

  it("lists conversations and ends a handover", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const Session = require("../models/wa_automation_session");
    const s = await Session.create({
      company_id: companyId,
      phone: "923001234567",
      customer_name: "Ayesha",
      flow_id: flowId,
      flow_name: "Support bot",
      status: "agent",
      outcome: "handed_over",
      transcript: [{ from: "customer", text: "hi" }],
      vars: { order_number: "ORD-1002", cart_lines: [{ secret: true }] },
    });
    const list = await call(api.listSessions, { query: { q: "1234" } });
    assert.equal(list.body.total, 1);
    assert.equal(list.body.data[0].transcript, undefined, "list rows leave out the transcript");
    assert.equal(list.body.data[0].order_number, "ORD-1002");
    assert.equal(list.body.data[0].vars, undefined, "list rows leave out the cart");
    const byOrder = await call(api.listSessions, { query: { q: "ORD-1002" } });
    assert.equal(byOrder.body.total, 1);

    const ended = await call(api.endSession, { params: { id: String(s._id) } });
    assert.equal(ended.body.data.status, "ended");
    assert.equal(ended.body.data.outcome, "handed_over");
    assert.match(ended.body.data.transcript.at(-1).text, /Ended by Aslam/);
  });

  it("summarises the dashboard", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const res = await call(api.dashboard);
    assert.equal(res.code, 200);
    assert.equal(res.body.data.flows.active, 2);
    assert.equal(res.body.data.conversations.last_30_days, 1);
    assert.equal(res.body.data.outcomes.handed_over, 1);
  });

  it("soft-deletes flows", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    assert.equal((await call(api.deleteFlow, { params: { id: flowId } })).code, 200);
    assert.equal((await call(api.getFlow, { params: { id: flowId } })).code, 404);
  });
});
