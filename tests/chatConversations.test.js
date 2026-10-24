/**
 * GET /chat/conversations against a throwaway local MongoDB database (dropped
 * afterwards). Skipped when no MongoDB answers.
 */
const { after, before, describe, it } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const MONGO = process.env.WA_AUTOMATION_TEST_MONGO || "mongodb://127.0.0.1:27017";
const DB_NAME = `chat_conversations_it_${Date.now()}`;

let available = false;
let fetchChatConversations;
const companyId = new mongoose.Types.ObjectId();
const otherCompanyId = new mongoose.Types.ObjectId();
const user = { _id: new mongoose.Types.ObjectId(), name: "Aslam", company_id: { _id: companyId } };

const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60000);
const chat = (fields, minutesAgo) => ({
  company_id: companyId,
  status: "sent",
  sending_status: "sent",
  deletedAt: null,
  createdAt: at(minutesAgo),
  updatedAt: at(minutesAgo),
  ...fields,
});

async function call(query = {}, as = user) {
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
  await fetchChatConversations({ query, params: {}, body: {}, user: as }, res);
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
  ({ fetchChatConversations } = require("../controllers/chat"));
  const db = mongoose.connection.db;
  await db.collection("companies").insertOne({ _id: companyId, company_name: "OrdersHub", whatsapp_number: "923000000000" });
  await db.collection("users").insertOne({ company_id: companyId, name: "Bilal Khan", phone: "03002222222", deletedAt: null });
  await db.collection("wa_automation_sessions").insertOne({
    company_id: companyId,
    phone: "923003333333",
    customer_name: "Sana",
    status: "ended",
    last_activity_at: at(5),
    deletedAt: null,
  });
  await db.collection("chats").insertMany([
    // A: local and international forms of one number, newest is an automation reply
    chat({ type: "received", from_user_id: "03001111111", to_user_id: "923000000000", message: "hi" }, 20),
    chat({ type: "sent", from_user_id: "923000000000", to_user_id: "923001111111", message: "Welcome!", source: "automation", sending_status: "not_started" }, 1),
    // B: a POS user
    chat({ type: "received", from_user_id: "923002222222", to_user_id: "923000000000", message: "Price?" }, 10),
    // C: AI reply, name from an automation session
    chat({ type: "received", from_user_id: "923003333333", to_user_id: "923000000000", message: "Where is my order" }, 6),
    chat({ type: "sent", from_user_id: "923000000000", to_user_id: "923003333333", message: "On its way", is_ai_resond: true }, 5),
    // Not conversations: unknown sender, our own number, deleted rows, another company
    chat({ type: "received", from_user_id: "unknown", to_user_id: "923000000000", message: "?" }, 2),
    chat({ type: "received", from_user_id: "923000000000", to_user_id: "923000000000", message: "self" }, 2),
    chat({ type: "received", from_user_id: "923004444444", to_user_id: "923000000000", message: "gone", deletedAt: at(1) }, 3),
    chat({ type: "received", from_user_id: "923005555555", to_user_id: "923009999999", message: "other", company_id: otherCompanyId }, 1),
  ]);
});

after(async () => {
  if (!available) return;
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
});

describe("GET /chat/conversations", () => {
  it("lists one row per customer number, latest first", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const res = await call();
    assert.equal(res.code, 200);
    assert.equal(res.body.total, 3);
    assert.deepEqual(
      res.body.data.map((r) => r.phone),
      ["923001111111", "923003333333", "923002222222"],
    );

    const [a, c, b] = res.body.data;
    assert.equal(a.messages_count, 2);
    assert.equal(a.last_type, "sent");
    assert.equal(a.last_source, "automation");
    assert.equal(a.last_message, "Welcome!");
    assert.equal(a.last_sending_status, "not_started");
    assert.equal(a.name, "");
    assert.equal(c.name, "Sana");
    assert.equal(c.last_source, "ai");
    assert.equal(b.name, "Bilal Khan");
    assert.equal(b.last_type, "received");
    assert.equal(b.last_source, "");
  });

  it("searches by name (POS user or automation customer) and by part of a number", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    assert.deepEqual((await call({ search: "bil" })).body.data.map((r) => r.phone), ["923002222222"]);
    assert.deepEqual((await call({ search: "sana" })).body.data.map((r) => r.phone), ["923003333333"]);
    assert.deepEqual((await call({ search: "0300 111" })).body.data.map((r) => r.phone), ["923001111111"]);
    assert.equal((await call({ search: "nobody" })).body.total, 0);
  });

  it("pages with limit / skip", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const res = await call({ limit: "1", skip: "1" });
    assert.deepEqual(res.body.data.map((r) => r.phone), ["923003333333"]);
    assert.equal(res.body.hasMore, true);
  });

  it("uses the token's company only", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const res = await call({ company_id: String(otherCompanyId) });
    assert.equal(res.body.total, 3);
    assert.ok(!res.body.data.some((r) => r.phone === "923005555555"));
    assert.equal((await call({}, { _id: user._id })).code, 400);
  });
});
