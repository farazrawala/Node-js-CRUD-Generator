/**
 * OMS order notes + note shortcuts (dynamic CRUD routes) against a throwaway local MongoDB
 * database (dropped afterwards). Skipped when no MongoDB answers.
 */
const { after, before, describe, it } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

process.env.REDIS_ENABLED = "false";

const MONGO = process.env.ORDER_NOTES_TEST_MONGO || "mongodb://127.0.0.1:27017";
const DB_NAME = `order_notes_it_${Date.now()}`;

let available = false;
let notes;
let shortcuts;
const companyId = new mongoose.Types.ObjectId();
const otherCompanyId = new mongoose.Types.ObjectId();
const orderId = new mongoose.Types.ObjectId();
const agent = { _id: new mongoose.Types.ObjectId(), name: "Sara", company_id: companyId };
const otherAgent = { _id: new mongoose.Types.ObjectId(), name: "Ali", company_id: otherCompanyId };

async function call(fn, { body, params, query, as = agent } = {}) {
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
    set() {
      return this;
    },
    setHeader() {},
  };
  await fn(
    {
      body: body || {},
      params: params || {},
      query: query || {},
      user: as,
      headers: {},
      method: "TEST",
      originalUrl: "/test",
      get: () => undefined,
    },
    res,
  );
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
  // The server registers every model at boot; populate needs these two here.
  require("../models/user");
  require("../models/order");
  const { generateControllerFunctions } = require("../utils/dynamicRouteGenerator");
  notes = generateControllerFunctions("order_notes");
  shortcuts = generateControllerFunctions("order_note_shortcuts");
  await mongoose.connection.db.collection("users").insertMany([
    { _id: agent._id, name: "Sara", company_id: companyId },
    { _id: otherAgent._id, name: "Ali", company_id: otherCompanyId },
  ]);
});

after(async () => {
  if (!available) return;
  // CRUD handlers write application logs in the background; let them land so they don't recreate the DB.
  await new Promise((resolve) => setTimeout(resolve, 500));
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
});

describe("order_notes", () => {
  it("stores every note as its own row with author and time, newest first", async (t) => {
    if (!available) return t.skip("no local MongoDB");

    const first = await call(notes.create, {
      body: { order_id: String(orderId), type: "notes", note: "Call not attended" },
    });
    assert.equal(first.code, 201, JSON.stringify(first.body));
    await new Promise((resolve) => setTimeout(resolve, 15));
    await call(notes.create, { body: { order_id: String(orderId), type: "courier", note: "[COURIER] Late" } });
    await call(notes.create, {
      body: { order_id: String(orderId), note: "Other company" },
      as: otherAgent,
    });

    const list = await call(notes.getAllActive, {
      query: {
        order_id: String(orderId),
        populate: "created_by,order_id",
        sortBy: "createdAt",
        sortOrder: "desc",
        limit: "100",
      },
    });
    assert.equal(list.code, 200, JSON.stringify(list.body));
    const rows = list.body.data;
    assert.deepEqual(
      rows.map((row) => row.note),
      ["[COURIER] Late", "Call not attended"],
    );
    assert.equal(rows[0].type, "courier");
    assert.equal(rows[1].type, "notes");
    assert.equal(rows[1].created_by.name, "Sara");
    assert.ok(rows.every((row) => row.createdAt));
  });
});

describe("order_notes latest", () => {
  it("returns only the newest note per order, scoped to the company", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const { getLatestOrderNotes } = require("../controllers/order_notes");
    const secondOrder = new mongoose.Types.ObjectId();
    const emptyOrder = new mongoose.Types.ObjectId();

    await call(notes.create, { body: { order_id: String(secondOrder), note: "Old" } });
    await new Promise((resolve) => setTimeout(resolve, 15));
    await call(notes.create, { body: { order_id: String(secondOrder), note: "Not available" } });
    await call(notes.create, {
      body: { order_id: String(secondOrder), note: "Other company newer" },
      as: otherAgent,
    });

    const res = await call(getLatestOrderNotes, {
      query: { order_ids: [orderId, secondOrder, emptyOrder, "bad-id"].join(",") },
    });
    assert.equal(res.code, 200, JSON.stringify(res.body));
    const byOrder = Object.fromEntries(
      res.body.data.map((row) => [String(row.order_id), row]),
    );
    assert.equal(Object.keys(byOrder).length, 2);
    assert.equal(byOrder[String(orderId)].note, "[COURIER] Late");
    assert.equal(byOrder[String(secondOrder)].note, "Not available");
    assert.equal(byOrder[String(secondOrder)].created_by.name, "Sara");
    assert.ok(byOrder[String(secondOrder)].createdAt);
  });
});

describe("order_note_shortcuts", () => {
  it("adds, lists in sort order and removes a company's shortcuts", async (t) => {
    if (!available) return t.skip("no local MongoDB");

    const created = await call(shortcuts.create, {
      body: { code: "rbc", text: "Requested call back", sort_order: 1 },
    });
    assert.equal(created.code, 201, JSON.stringify(created.body));
    await call(shortcuts.create, { body: { code: "CNA", text: "Call not attended", sort_order: 0 } });
    await call(shortcuts.create, { body: { code: "XYZ", sort_order: 0 }, as: otherAgent });

    const list = await call(shortcuts.getAllActive, {
      query: { sortBy: "sort_order", sortOrder: "asc", limit: "200" },
    });
    assert.deepEqual(
      list.body.data.map((row) => [row.code, row.text]),
      [
        ["CNA", "Call not attended"],
        ["RBC", "Requested call back"],
      ],
    );

    const rbc = list.body.data.find((row) => row.code === "RBC");
    const removed = await call(shortcuts.delete, { params: { id: String(rbc._id) } });
    assert.equal(removed.code, 200, JSON.stringify(removed.body));

    const after = await call(shortcuts.getAllActive, {
      query: { sortBy: "sort_order", sortOrder: "asc", limit: "200" },
    });
    assert.deepEqual(
      after.body.data.map((row) => row.code),
      ["CNA"],
    );
  });
});
