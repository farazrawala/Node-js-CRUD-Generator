/**
 * End-to-end WhatsApp automation runtime against a throwaway local MongoDB
 * database (dropped afterwards). Skipped when no MongoDB answers on
 * WA_AUTOMATION_TEST_MONGO (default mongodb://127.0.0.1:27017).
 */
const { after, before, describe, it } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const MONGO = process.env.WA_AUTOMATION_TEST_MONGO || "mongodb://127.0.0.1:27017";
const DB_NAME = `wa_automation_it_${Date.now()}`;

let available = false;
let Chat;
let Flow;
let Session;
let handleInboundMessage;
let fetchRandomChat;
const companyId = new mongoose.Types.ObjectId();
const CUSTOMER = "923001234567";

const opt = (id, title, value, next) => ({ id, title, value, next });
const node = (id, type, data) => ({ id, type, name: id, x: 0, y: 0, data });

function supportNodes() {
  return [
    node("start", "start", { keywords: "hi, hello", next: "welcome" }),
    node("welcome", "menu", {
      text: "Welcome to {{store_name}}!",
      options: [opt("a", "Order Status", "1", "ask"), opt("b", "Live Support", "2", "agent")],
    }),
    node("ask", "collect_order", { text: "Send your order number.", variable: "order_number", retryText: "Try again.", next: "api" }),
    node("api", "api", { name: "Order lookup", source: "pos_order", successNext: "result", failureNext: "notfound" }),
    node("result", "message", { text: "Order {{order_number}} is {{order_status}}.", next: "end" }),
    node("notfound", "message", { text: "Order not found.", next: "end" }),
    node("agent", "agent", { queueMessage: "Our team will reply.", fallback: "Our team will reply.", next: "" }),
    node("end", "end", { text: "Thanks!" }),
  ];
}

async function saveReceived(phone, message, { minutesAgo = 0, at } = {}) {
  const chat = await Chat.create({
    from_user_id: phone,
    to_user_id: "923000000000",
    message,
    whatsapp_time: (at || new Date(Date.now() - minutesAgo * 60000)).toISOString(),
    type: "received",
    company_id: companyId,
  });
  return chat.toObject();
}

async function receive(phone, message, options) {
  return handleInboundMessage({ companyId, chat: await saveReceived(phone, message, options) });
}

const queuedFor = (phone) =>
  Chat.find({ company_id: companyId, source: "automation", to_user_id: phone }).sort({ createdAt: 1, _id: 1 }).lean();

const activeSession = (phone) => Session.findOne({ company_id: companyId, phone, status: { $ne: "ended" } }).lean();

/** What the extension does after sending: the customer now has the bot's messages. */
const deliver = (phone) =>
  Chat.updateMany(
    { company_id: companyId, source: "automation", to_user_id: phone, status: { $in: ["not_started", "inprocess"] } },
    { $set: { status: "sent", sending_status: "sent" } },
  );

/** The extension's day-first reading of a US date in business time (UTC+5): 12 Oct → 10 Dec. */
function misreadUS(date) {
  const local = new Date(date.getTime() + 5 * 3600000);
  if (local.getUTCDate() > 12) return date;
  return new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCDate() - 1, local.getUTCMonth() + 1, local.getUTCHours(), local.getUTCMinutes()) -
      5 * 3600000,
  );
}

/** A five-day-old message as the extension posts it from a US-format PC. */
const OLD_MISREAD = { at: misreadUS(new Date(Date.now() - 5 * 86400000)) };

/** A date that is in the future however it is read (day 20 can't be a month). */
const FAR_FUTURE = (() => {
  const at = new Date(Date.now() + 60 * 86400000);
  at.setUTCDate(20);
  return { at };
})();

function mockRes() {
  return {
    code: 0,
    body: null,
    status(code) {
      this.code = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

before(async () => {
  try {
    await mongoose.connect(`${MONGO}/${DB_NAME}`, { serverSelectionTimeoutMS: 1500 });
    available = true;
  } catch {
    available = false;
    return;
  }
  Chat = require("../models/chat");
  Flow = require("../models/wa_automation_flow");
  Session = require("../models/wa_automation_session");
  ({ handleInboundMessage } = require("../utils/waAutomation/inbound"));
  ({ fetchRandomChat } = require("../controllers/chat"));

  const db = mongoose.connection.db;
  await db.collection("companies").insertOne({
    _id: companyId,
    company_name: "OrdersHub",
    whatsapp_number: "923000000000",
    deletedAt: null,
    unknown_whatsapp_settings: [{ daily_limit: 5, usage: 0, increase_daily: 1 }],
  });
  await db.collection("orders").insertOne({
    company_id: companyId,
    order_no: "ORD-1001",
    name: "Ayesha Khan",
    phone: "03001234567",
    order_status: "delivered",
    total_amount: 4250,
    amount_received: 4250,
    status: "active",
    deletedAt: null,
    createdAt: new Date(),
  });
  await Flow.create({
    company_id: companyId,
    name: "Support bot",
    trigger: "keyword",
    status: "active",
    nodes: supportNodes(),
    live_nodes: supportNodes(),
    published_at: new Date(),
  });
});

after(async () => {
  if (!available) return;
  // Models loaded during the tests build indexes in the background; an index build
  // that finishes after the drop would create the database again.
  await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init().catch(() => {})));
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
});

describe("WhatsApp automation inbound runtime", () => {
  it("starts the flow on a keyword and queues the numbered menu", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const result = await receive(CUSTOMER, "Hi!");
    assert.equal(result.handled, true);
    assert.equal(result.queued, 1);
    const [menu] = await queuedFor(CUSTOMER);
    assert.equal(menu.message, "Welcome to OrdersHub!\n\n1️⃣ Order Status\n2️⃣ Live Support");
    assert.equal(menu.status, "not_started");
    const session = await activeSession(CUSTOMER);
    assert.deepEqual(session.waiting, { type: "options", node_id: "welcome" });
    assert.equal(session.customer_name, "Ayesha Khan");
  });

  it("serves automation replies before campaign messages, oldest first", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    await Chat.create({
      from_user_id: "923000000000",
      to_user_id: "923339999999",
      message: "Campaign",
      type: "sent",
      company_id: companyId,
    });
    const res = mockRes();
    await fetchRandomChat({ query: { company_id: String(companyId) }, body: {}, user: null }, res);
    assert.equal(res.code, 200);
    assert.equal(res.body.data.source, "automation");
    assert.match(res.body.data.message, /^Welcome to OrdersHub!/);
    assert.equal(res.body.data.status, "inprocess");
  });

  it("follows the chosen option, looks up the customer's order and combines the reply", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    await receive(CUSTOMER, "1");
    const result = await receive(CUSTOMER, "1001");
    assert.equal(result.status, "completed");
    const queued = await queuedFor(CUSTOMER);
    assert.equal(queued.at(-1).message, "Order ORD-1001 is Delivered.\n\nThanks!");
    assert.equal(await activeSession(CUSTOMER), null);
    const ended = await Session.findOne({ company_id: companyId, phone: CUSTOMER }).sort({ started_at: -1 }).lean();
    assert.equal(ended.outcome, "completed");
    assert.ok(ended.transcript.some((e) => e.from === "customer" && e.text === "1001"));
  });

  it("shows an order's status to whoever sends its number, but cancels only for its customer", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const other = "923211111111";
    await receive(other, "hello");
    await receive(other, "Order Status");
    await receive(other, "1001");
    const queued = await queuedFor(other);
    assert.equal(queued.at(-1).message, "Order ORD-1001 is Delivered.\n\nThanks!");

    const { runApi } = require("../utils/waAutomation/lookups");
    const cancel = await runApi("pos_cancel_request", {}, { order_number: "ORD-1001" }, { companyId, phone: other });
    assert.equal(cancel.ok, false);
    assert.match(cancel.summary, /not linked to this customer's phone number/);
  });

  it("'menu' restarts the customer's last flow after it ended", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    assert.equal(await activeSession(CUSTOMER), null);
    const result = await receive(CUSTOMER, "Menu");
    assert.equal(result.handled, true);
    assert.deepEqual((await activeSession(CUSTOMER)).waiting, { type: "options", node_id: "welcome" });
  });

  it("leaves non-trigger messages to the AI when no conversation is open", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const result = await receive("923220000000", "what are your prices?");
    assert.equal(result.handled, false);
    assert.equal(result.reason, "no_flow");
    const menu = await receive("923220000001", "menu");
    assert.equal(menu.handled, false, "'menu' means nothing to someone who never used a flow");
  });

  it("keeps the bot and the AI quiet after a handover until 'menu'", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const phone = "923451234567";
    await receive(phone, "hi");
    const handover = await receive(phone, "2");
    assert.equal(handover.status, "handed_over");
    const before = (await queuedFor(phone)).length;

    const quiet = await receive(phone, "hello? anyone there");
    assert.equal(quiet.handled, true);
    assert.equal(quiet.suppress_ai, true);
    assert.equal((await queuedFor(phone)).length, before);

    const restarted = await receive(phone, "hi");
    assert.equal(restarted.handled, true);
    assert.equal((await activeSession(phone)).status, "active");
  });

  it("gives up after three invalid answers and lets the AI reply", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const phone = "923019876543";
    await receive(phone, "hi");
    await deliver(phone);
    assert.equal((await receive(phone, "banana")).handled, true);
    await deliver(phone);
    assert.equal((await receive(phone, "banana")).handled, true);
    await deliver(phone);
    const third = await receive(phone, "banana");
    assert.equal(third.handled, false);
    assert.equal(third.reason, "released");
  });

  it("ignores old messages from the extension's catch-up", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const result = await receive("923007777777", "hi", { minutesAgo: 180 });
    assert.equal(result.handled, false);
    assert.equal(result.reason, "too_old");
  });

  it("doesn't answer messages the extension dated in the future, and keeps the AI out too", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const result = await receive("923007777778", "hi", FAR_FUTURE);
    assert.equal(result.handled, false);
    assert.equal(result.suppress_ai, true);
    assert.equal(result.reason, "future_time");
    assert.equal(await activeSession("923007777778"), null);
  });

  it("keeps old catch-up messages from moving a conversation", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const phone = "923062222222";
    await receive(phone, "hi");
    await deliver(phone);
    const queued = (await queuedFor(phone)).length;

    const earlier = await receive(phone, "1", { minutesAgo: 20 });
    assert.equal(earlier.reason, "before_question", "an old '1' is not an answer to today's menu");
    assert.equal(earlier.suppress_ai, true);
    const tooOld = await receive(phone, "where is my order", { minutesAgo: 180 });
    assert.equal(tooOld.reason, "too_old");
    assert.equal(tooOld.suppress_ai, true, "no AI reply in the middle of a flow");
    const misread = await receive(phone, "I love my country", OLD_MISREAD);
    assert.equal(misread.reason, "too_old", "a misread US date is read back as the real, old one");
    const future = await receive(phone, "hello", FAR_FUTURE);
    assert.equal(future.reason, "future_time");

    assert.equal((await queuedFor(phone)).length, queued);
    const session = await activeSession(phone);
    assert.deepEqual(session.waiting, { type: "options", node_id: "welcome" });
    assert.equal(session.invalid_count, 0);
    const notes = session.transcript.filter((e) => e.kind === "notice").map((e) => e.text);
    assert.equal(notes.length, 4);
    assert.match(notes[0], /^Not answered: sent .*, before the bot's last message\.$/);
    assert.match(notes[3], /^Not answered: the extension dated it .*in the future\.$/);
  });

  it("waits until the customer has the bot's message before saying 'Sorry'", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const phone = "923061111111";
    await receive(phone, "hi");

    const crossed = await receive(phone, "I love my country");
    assert.equal(crossed.handled, true);
    assert.equal(crossed.suppress_ai, true);
    assert.equal(crossed.reason, "reply_pending");
    const greeting = await receive(phone, "hello");
    assert.equal(greeting.reason, "reply_pending", "a second greeting doesn't send the welcome twice");
    assert.equal((await queuedFor(phone)).length, 1);
    assert.equal((await activeSession(phone)).invalid_count, 0);

    await deliver(phone);
    assert.equal((await receive(phone, "banana")).reason, "reply");
    assert.match((await queuedFor(phone)).at(-1).message, /^Sorry, I didn't get that\./);
  });

  it("answers the extension's catch-up burst with one welcome, then the customer's choice", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    // What the extension posted together when it caught up on the chat: two old
    // messages with misread dates, an hour-old "Hi" and the fresh "Salam".
    const orders = {
      923064444444: [0, 1, 2, 3], // in chat order
      923064444445: [3, 0, 2, 1], // as concurrent requests may reach the lock
    };
    for (const [phone, order] of Object.entries(orders)) {
      const burst = [
        await saveReceived(phone, "My name is Faraz how are you ?", OLD_MISREAD),
        await saveReceived(phone, "I love my country", FAR_FUTURE),
        await saveReceived(phone, "Hi", { minutesAgo: 59 }),
        await saveReceived(phone, "Salam", { minutesAgo: 1 }),
      ];
      await Promise.all(order.map((i) => handleInboundMessage({ companyId, chat: burst[i] })));

      const queued = await queuedFor(phone);
      assert.equal(queued.length, 1, `${phone}: one welcome, no 'Sorry'`);
      assert.match(queued[0].message, /^Welcome to OrdersHub!/);
      assert.equal((await activeSession(phone)).invalid_count, 0);

      await deliver(phone);
      assert.equal((await receive(phone, "1")).reason, "reply");
      assert.deepEqual((await activeSession(phone)).waiting, { type: "input", node_id: "ask" });
    }
  });

  it("hands out again a reply the extension picked up but never sent", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const phone = "923069999999";
    // Earlier tests leave replies in the queue; this one needs it to itself.
    await Chat.updateMany(
      { company_id: companyId, source: "automation", status: { $in: ["not_started", "inprocess"] } },
      { $set: { status: "sent" } },
    );
    await receive(phone, "hi");
    const fetchNext = async () => {
      const res = mockRes();
      await fetchRandomChat({ query: { company_id: String(companyId) }, body: {}, user: null }, res);
      return res.body.data?.source === "automation" ? res.body.data : null;
    };
    const claimed = await fetchNext();
    assert.equal(claimed.to_user_id, phone);
    assert.equal(await fetchNext(), null, "not while the extension may still be sending it");

    // The extension was reloaded mid-send: no mark-sent ever came.
    const ago = (min) => new Date(Date.now() - min * 60000);
    await Chat.collection.updateOne({ _id: claimed._id }, { $set: { updatedAt: ago(3) } });
    const again = await fetchNext();
    assert.equal(String(again?._id), String(claimed._id));

    await Chat.collection.updateOne({ _id: claimed._id }, { $set: { updatedAt: ago(3), createdAt: ago(11) } });
    assert.equal(await fetchNext(), null, "too late to send it now");
  });

  it("goes quiet at the reply limit and says why in the log", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const { REPLY_BURST_LIMIT } = require("../utils/waAutomation/inbound");
    const phone = "923068888888";
    await receive(phone, "hi");
    await deliver(phone);
    const filler = Array.from({ length: REPLY_BURST_LIMIT - 1 }, () => ({
      from_user_id: "923000000000",
      to_user_id: phone,
      message: "earlier reply",
      type: "sent",
      status: "sent",
      source: "automation",
      company_id: companyId,
    }));
    await Chat.insertMany(filler);

    const result = await receive(phone, "1");
    assert.equal(result.reason, "reply_limit");
    assert.equal(result.suppress_ai, true);
    const session = await activeSession(phone);
    assert.deepEqual(session.waiting, { type: "options", node_id: "welcome" });
    assert.match(session.transcript.at(-1).text, /safety limit against bot loops/);
  });

  it("hands questions at a menu to the AI auto-reply, and says goodbye to thanks", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const { recordAiAnswer } = require("../utils/waAutomation/inbound");
    const phone = "923067777777";
    const savedKey = process.env.GROQ_API_KEY;
    process.env.GROQ_API_KEY = "test-key"; // only checked for presence; no AI call is made here
    try {
      await receive(phone, "hi");
      await deliver(phone);
      const queued = (await queuedFor(phone)).length;

      const question = await receive(phone, "do you deliver to Lahore?");
      assert.equal(question.handled, false, "the AI auto-reply answers it");
      assert.equal(question.suppress_ai, false);
      assert.equal(question.reason, "ask_ai");
      assert.equal((await queuedFor(phone)).length, queued, "the bot itself sends nothing");

      await recordAiAnswer({ sessionId: question.session_id, text: "do you deliver to Lahore?", reply: "Yes, all over Pakistan 🙂" });
      let session = await activeSession(phone);
      assert.deepEqual(session.waiting, { type: "options", node_id: "welcome" }, "the menu stays open");
      assert.equal(session.transcript.at(-1).text, "Yes, all over Pakistan 🙂");

      // The AI couldn't answer: the controller asks again without it
      const chat = await saveReceived(phone, "do you have size M?");
      const fallback = await handleInboundMessage({ companyId, chat, allowAi: false });
      assert.equal(fallback.reason, "reply");
      assert.match((await queuedFor(phone)).at(-1).message, /^Sorry, I didn't get that\./);

      await deliver(phone);
      assert.equal((await receive(phone, "1")).reason, "reply", "menu numbers still work");
      await deliver(phone);
      const thanks = await receive(phone, "ok thanks bhai");
      assert.equal(thanks.status, "completed");
      assert.match((await queuedFor(phone)).at(-1).message, /^You're welcome! 😊/);
      session = await Session.findOne({ company_id: companyId, phone }).sort({ started_at: -1 }).lean();
      assert.equal(session.outcome, "completed");
    } finally {
      if (savedKey === undefined) delete process.env.GROQ_API_KEY;
      else process.env.GROQ_API_KEY = savedKey;
    }
  });

  it("finds products as customers see them: parents and products without variants", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const { runApi } = require("../utils/waAutomation/lookups");
    const db = mongoose.connection.db;
    const id = () => new mongoose.Types.ObjectId();
    const product = (fields) => ({ _id: id(), company_id: companyId, status: "active", deletedAt: null, ...fields });
    const parent = product({ product_name: "Two Color Kidwear", product_type: "Variable", sku: "shopify-10634628923691", product_price: 700 });
    const small = product({ product_name: "Two Color Kidwear [pink-7-8-years]", product_type: "Single", parent_product_id: parent._id, sku: "TCK-PINK-7", product_price: 700 });
    const large = product({ product_name: "Two Color Kidwear [pink-9-10-years]", product_type: "Single", parent_product_id: parent._id, sku: "TCK-PINK-9", product_price: 850 });
    const single = product({ product_name: "Two Color Socks", product_type: "Single", sku: "SOCK-2", product_price: 150 });
    await db.collection("products").insertMany([parent, small, large, single]);
    await db.collection("warehouse_inventories").insertMany([
      { company_id: companyId, product_id: large._id, quantity: 4, status: "active", deletedAt: null },
    ]);

    const found = await runApi("pos_products", {}, { search_query: "two color" }, { companyId });
    assert.equal(found.ok, true);
    assert.deepEqual(
      found.products.map((p) => [p.name, p.price, p.stock, p.sku]),
      [
        ["Two Color Kidwear", "PKR 700 – 850", "In stock (4)", ""],
        ["Two Color Socks", "PKR 150", "Out of stock", "SOCK-2"],
      ],
    );

    const bySku = await runApi("pos_products", {}, { search_query: "TCK-PINK-9" }, { companyId });
    assert.deepEqual(bySku.products.map((p) => p.name), ["Two Color Kidwear"], "a variant's SKU shows its parent");

    // Links to the public shop, only while the company's store is public
    const appUrl = "https://pos.example.com/pos/";
    const hidden = await runApi("pos_products", {}, { search_query: "two color" }, { companyId, appUrl });
    assert.equal(hidden.products[0].url, "", "no link while the store isn't public");
    await db.collection("companies").updateOne(
      { _id: companyId },
      { $set: { display_store_on_bigcommerce: true, status: "active", company_slug: "ordershub" } },
    );
    const linked = await runApi("pos_products", {}, { search_query: "two color" }, { companyId, appUrl });
    assert.equal(linked.products[0].url, `https://pos.example.com/pos/shop/ordershub/product/${parent._id}`);
    assert.equal(linked.vars.product_url, linked.products[0].url);
    await db.collection("companies").updateOne({ _id: companyId }, { $set: { display_store_on_bigcommerce: false } });
  });

  it("ignores senders the extension could not resolve to a phone", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const result = await receive("unknown", "hi");
    assert.equal(result.reason, "not_a_phone");
  });

  it("starts a 'New conversation' flow for a first message", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const welcome = [
      node("start", "start", { keywords: "", next: "hello" }),
      node("hello", "end", { text: "Thanks for writing to us!" }),
    ];
    await Flow.create({
      company_id: companyId,
      name: "Welcome",
      trigger: "new_conversation",
      status: "active",
      nodes: welcome,
      live_nodes: welcome,
      published_at: new Date(),
    });
    const phone = "923128888888";
    const first = await receive(phone, "is the blue hoodie available?");
    assert.equal(first.handled, true);
    assert.equal((await queuedFor(phone))[0].message, "Thanks for writing to us!");
    const second = await receive(phone, "and in size M?");
    assert.equal(second.handled, false, "not a new conversation any more");
  });

  it("ends an open conversation when its flow is paused", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const phone = "923335555555";
    await receive(phone, "hi");
    await Flow.updateOne({ company_id: companyId, name: "Support bot" }, { $set: { status: "paused" } });
    const result = await receive(phone, "1");
    assert.equal(result.handled, false);
    assert.equal(await activeSession(phone), null);
    await Flow.updateOne({ company_id: companyId, name: "Support bot" }, { $set: { status: "active" } });
  });

  it("handles two quick messages from one customer in order", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const phone = "923046666666";
    const first = await saveReceived(phone, "hi");
    const second = await saveReceived(phone, "1");
    await Promise.all([
      handleInboundMessage({ companyId, chat: first }),
      handleInboundMessage({ companyId, chat: second }),
    ]);
    const session = await activeSession(phone);
    assert.deepEqual(session.waiting, { type: "input", node_id: "ask" });
  });
});
