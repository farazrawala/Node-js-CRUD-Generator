const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const fmt = require("../utils/waAutomation/messageFormat");
const engine = require("../utils/waAutomation/engine");
const { isPrivateAddress, getPath, httpRequest } = require("../utils/waAutomation/lookups");

const opt = (id, title, value, next) => ({ id, title, value, next });
const node = (id, type, data, name) => ({ id, type, name: name || id, x: 0, y: 0, data });

/** Small support bot: menu → order lookup → result menu / handover. */
function supportBot() {
  return [
    node("start", "start", { keywords: "hi, hello, menu", next: "welcome" }),
    node("welcome", "menu", {
      text: "Welcome to {{store_name}}!\n\n{{options}}\n\nReply with a number.",
      options: [
        opt("o_status", "Order Status", "1", "ask"),
        opt("o_live", "Live Support", "2", "agent"),
        opt("o_dead", "Nothing here", "3", ""),
      ],
    }),
    node("ask", "collect_order", {
      text: "Please send your order number.",
      variable: "order_number",
      retryText: "That doesn't look like an order number.",
      next: "api",
    }),
    node("api", "api", { name: "Order lookup", source: "pos_order", successNext: "result", failureNext: "notfound" }),
    node("result", "message", { text: "Order {{order_number}} is {{order_status}}.", next: "end" }),
    node("notfound", "message", { text: "Sorry, order {{order_number}} was not found.", next: "end" }),
    node("agent", "agent", { queueMessage: "An agent will reply shortly.", fallback: "We are closed now.", next: "" }),
    node("end", "end", { text: "Thanks! Reply *menu* anytime." }),
  ];
}

function testCtx(overrides = {}) {
  return {
    test: true,
    settings: { fallback_message: "Please pick a number." },
    templates: [],
    isOpen: () => true,
    runApi: async (source, data, vars) =>
      vars.order_number === "ORD-1001"
        ? { ok: true, vars: { order_status: "Delivered" }, summary: "found ORD-1001" }
        : { ok: false, vars: {}, summary: "not found" },
    ...overrides,
  };
}

const sends = (items) => items.filter((i) => i.type === "send").map((i) => i.text);

describe("messageFormat", () => {
  it("normalizes replies: keycaps, Urdu digits, punctuation, case", () => {
    assert.equal(fmt.normalizeReply("1️⃣"), "1");
    assert.equal(fmt.normalizeReply("۲"), "2");
    assert.equal(fmt.normalizeReply(" Order Status!! "), "order status");
    assert.equal(fmt.normalizeReply("🔟"), "10");
  });

  it("matches options by number, title and unambiguous wording", () => {
    const options = [opt("a", "Order Status", "1"), opt("b", "Delivery Status", "2"), opt("c", "Live Support", "3")];
    assert.equal(fmt.matchOption(options, "2").id, "b");
    assert.equal(fmt.matchOption(options, "2.").id, "b");
    assert.equal(fmt.matchOption(options, "3️⃣").id, "c");
    assert.equal(fmt.matchOption(options, "order status").id, "a");
    assert.equal(fmt.matchOption(options, "I want live support please").id, "c");
    assert.equal(fmt.matchOption(options, "2 please").id, "b");
    assert.equal(fmt.matchOption(options, "status"), null, "ambiguous between two options");
    assert.equal(fmt.matchOption(options, "7"), null);
    assert.equal(fmt.matchOption(options, ""), null);
  });

  it("uses the option position when an option has no value", () => {
    const options = [opt("a", "Yes", ""), opt("b", "No", "")];
    assert.equal(fmt.matchOption(options, "2").id, "b");
  });

  it("interpolates, drops empty variables and supports fallbacks", () => {
    assert.equal(fmt.interpolate("Hi {{customer_name}}!", {}), "Hi!");
    assert.equal(fmt.interpolate("Hi {{customer_name|there}}!", {}), "Hi there!");
    assert.equal(fmt.interpolate("Hi {{customer_name}}!", { customer_name: "Ayesha" }), "Hi Ayesha!");
    assert.equal(fmt.interpolate("Hi {{missing}}", {}, { keepUnknown: true }), "Hi {{missing}}");
  });

  it("composes menus with the option list where {{options}} is, or appended", () => {
    const data = {
      text: "How can we help?\n\n{{options}}\n\nReply with a number.",
      options: [opt("a", "Order Status", "1"), opt("b", "Talk to us", "2")],
    };
    assert.equal(fmt.composeMenuText(data), "How can we help?\n\n1️⃣ Order Status\n2️⃣ Talk to us\n\nReply with a number.");
    assert.equal(
      fmt.composeMenuText({ text: "Pick one:", options: data.options, listStyle: "plain" }),
      "Pick one:\n\n1. Order Status\n2. Talk to us",
    );
    assert.equal(fmt.composeMenuText({ text: "Hello", options: data.options, appendOptions: false }), "Hello");
  });

  it("lists products as text before the options", () => {
    const text = fmt.composeMenuText(
      { text: "Results:", showProducts: true, options: [opt("a", "Search again", "1")] },
      {},
      [{ name: "Hoodie", price: "PKR 1,850", stock: "In stock (15)", sku: "KH-1" }],
    );
    assert.equal(text, "Results:\n\n*Hoodie*\nPKR 1,850 · In stock (15)\nSKU KH-1\n\n1️⃣ Search again");
  });

  it("normalizes order numbers and phone numbers", () => {
    assert.equal(fmt.normalizeOrderNumber("1001"), "ORD-1001");
    assert.equal(fmt.normalizeOrderNumber(" #ord1002 "), "ORD-1002");
    assert.equal(fmt.normalizeOrderNumber("SHOP-77A"), "SHOP-77A");
    assert.equal(fmt.normalizeOrderNumber("hello"), null);
    assert.deepEqual(fmt.orderNumberCandidates("ORD-1001"), ["ORD-1001", "1001", "#1001"]);
    // The POS pads to 4 digits: customers type "270" for ORD-0270
    assert.equal(fmt.normalizeOrderNumber("270"), "ORD-0270");
    assert.equal(fmt.normalizeOrderNumber("Ord-0270"), "ORD-0270");
    assert.deepEqual(fmt.orderNumberCandidates("ORD-0270"), ["ORD-0270", "0270", "#0270", "ORD-270", "270", "#270"]);
    assert.equal(fmt.normalizePhoneInput("0300 1234567"), "923001234567");
    assert.equal(fmt.normalizePhoneInput("12345"), null);
    assert.equal(fmt.isLikelyPhone("unknown"), false);
    assert.equal(fmt.isLikelyPhone("120363012345678901"), false, "group ids are too long");
  });

  it("checks business hours in Pakistan time", () => {
    const hours = [{ day: "Friday", open: true, from: "10:00", to: "19:00" }];
    // Fri 16 Oct 2026 06:00 UTC = 11:00 PKT
    assert.equal(fmt.isWithinBusinessHours(new Date("2026-10-16T06:00:00Z"), hours), true);
    // 14:30 UTC = 19:30 PKT
    assert.equal(fmt.isWithinBusinessHours(new Date("2026-10-16T14:30:00Z"), hours), false);
    // Saturday not listed → closed
    assert.equal(fmt.isWithinBusinessHours(new Date("2026-10-17T06:00:00Z"), hours), false);
    assert.equal(fmt.isWithinBusinessHours(new Date(), []), true);
  });

  it("swaps back US dates the extension read day-first", () => {
    const now = Date.parse("2026-10-17T02:42:00Z"); // 17 Oct, 07:42 PKT
    const at = (value, when = now) => fmt.whatsappTime(value, when)?.toISOString() ?? null;
    // 12 Oct 21:15 PKT arrives as 10 December
    assert.equal(at("2026-12-10T16:15:00.000Z"), "2026-10-12T16:15:00.000Z");
    // …and a message written right now on 12 Oct does too
    assert.equal(at("2026-12-10T04:00:00.000Z", Date.parse("2026-10-12T04:00:30Z")), "2026-10-12T04:00:00.000Z");
    // Normal times, and a few minutes of clock drift, are kept
    assert.equal(at("2026-10-17T02:41:00.000Z"), "2026-10-17T02:41:00.000Z");
    assert.equal(at("2026-10-17T02:45:00.000Z"), "2026-10-17T02:45:00.000Z");
    // Future dates that can't be a swap, or whose swap is still ahead, stay as they are
    assert.equal(at("2026-12-20T10:00:00.000Z"), "2026-12-20T10:00:00.000Z");
    assert.equal(at("2026-12-11T05:00:00.000Z"), "2026-12-11T05:00:00.000Z");
    assert.equal(at(""), null);
    assert.equal(at("not a date"), null);
  });

  it("combines a turn's messages and keeps notes after them", () => {
    const items = [
      { type: "note", text: "lookup", kind: "api" },
      { type: "send", text: "A", delaySeconds: 0 },
      { type: "note", text: "handover", kind: "agent" },
      { type: "send", text: "B", delaySeconds: 0 },
      { type: "send", text: "C", delaySeconds: 60 },
    ];
    assert.deepEqual(fmt.planMessages(items, { combine: true }), [
      { type: "note", text: "lookup", kind: "api" },
      { type: "bubble", text: "A\n\nB", delaySeconds: 0 },
      { type: "note", text: "handover", kind: "agent" },
      { type: "bubble", text: "C", delaySeconds: 60 },
    ]);
    assert.equal(fmt.planMessages(items, { combine: false }).filter((p) => p.type === "bubble").length, 3);
  });

  it("never combines past WhatsApp's 4096 character limit", () => {
    const long = "x".repeat(3000);
    const planned = fmt.planMessages(
      [
        { type: "send", text: long },
        { type: "send", text: long },
      ],
      { combine: true },
    );
    assert.equal(planned.length, 2);
  });
});

describe("flow engine", () => {
  it("starts at the welcome menu and waits for an option", async () => {
    const r = await engine.startConversation(supportBot(), { store_name: "OrdersHub" }, testCtx());
    assert.equal(r.status, "waiting");
    assert.deepEqual(r.session.waiting, { type: "options", node_id: "welcome" });
    assert.match(sends(r.items)[0], /^Welcome to OrdersHub!\n\n1️⃣ Order Status\n2️⃣ Live Support/);
  });

  it("runs an order lookup and ends", async () => {
    const ctx = testCtx();
    let r = await engine.startConversation(supportBot(), {}, ctx);
    r = await engine.reply(supportBot(), r.session, "1", ctx);
    assert.deepEqual(r.session.waiting, { type: "input", node_id: "ask" });
    r = await engine.reply(supportBot(), r.session, "1001", ctx);
    assert.equal(r.status, "completed");
    assert.deepEqual(sends(r.items), ["Order ORD-1001 is Delivered.", "Thanks! Reply *menu* anytime."]);
    assert.ok(r.items.some((i) => i.type === "note" && /found ORD-1001/.test(i.text)));
  });

  it("says goodbye and closes when the customer says thanks instead of answering", async () => {
    const ctx = testCtx({ settings: { fallback_message: "Please pick a number.", thanks_message: "Shukriya {{customer_name}}!" } });
    let r = await engine.startConversation(supportBot(), { customer_name: "Ayesha" }, ctx);
    const atMenu = await engine.reply(supportBot(), r.session, "ok thanks bhai", ctx);
    assert.equal(atMenu.status, "completed");
    assert.deepEqual(sends(atMenu.items), ["Shukriya Ayesha!"]);
    assert.equal(atMenu.session.waiting, null);

    r = await engine.reply(supportBot(), r.session, "1", ctx);
    const atOrderNumber = await engine.reply(supportBot(), r.session, "👍", ctx);
    assert.equal(atOrderNumber.status, "completed", "not taken as a wrong order number");

    const ack = await engine.reply(supportBot(), (await engine.startConversation(supportBot(), {}, ctx)).session, "ok", ctx);
    assert.equal(ack.status, "waiting", "'ok' alone can mean yes, so it isn't a goodbye");
    assert.match(sends(ack.items)[0], /^Please pick a number\./);
  });

  it("recognises thanks and goodbyes, not answers that happen to contain them", () => {
    for (const text of ["Thanks", "thank you so much", "Shukriya", "JazakAllah", "Allah hafiz", "theek hai shukriya", "👍", "🙏"]) {
      assert.equal(fmt.isClosingReply(text), true, text);
    }
    for (const text of ["ok", "ji", "acha", "1", "where is my order", "thanks but where is my order", "no thanks I want to cancel"]) {
      assert.equal(fmt.isClosingReply(text), false, text);
    }
  });

  it("takes the failure branch for unknown orders", async () => {
    const ctx = testCtx();
    let r = await engine.startConversation(supportBot(), {}, ctx);
    r = await engine.reply(supportBot(), r.session, "Order Status", ctx);
    r = await engine.reply(supportBot(), r.session, "ORD-9999", ctx);
    assert.equal(sends(r.items)[0], "Sorry, order ORD-9999 was not found.");
  });

  it("re-asks on invalid answers and gives up after three", async () => {
    const ctx = testCtx();
    let r = await engine.startConversation(supportBot(), {}, ctx);
    r = await engine.reply(supportBot(), r.session, "blah", ctx);
    assert.equal(r.status, "waiting");
    assert.match(sends(r.items)[0], /^Please pick a number\.\n\n1️⃣ Order Status/);
    r = await engine.reply(supportBot(), r.session, "blah", ctx);
    assert.equal(r.status, "waiting");
    r = await engine.reply(supportBot(), r.session, "blah", ctx);
    assert.equal(r.status, "dropped");
    assert.equal(sends(r.items).length, 0);
  });

  it("re-asks for an invalid order number", async () => {
    const ctx = testCtx();
    let r = await engine.startConversation(supportBot(), {}, ctx);
    r = await engine.reply(supportBot(), r.session, "1", ctx);
    r = await engine.reply(supportBot(), r.session, "where is it", ctx);
    assert.equal(r.status, "waiting");
    assert.deepEqual(sends(r.items), ["That doesn't look like an order number."]);
  });

  it("hands over to the team, using the fallback outside business hours", async () => {
    const open = await engine.reply(supportBot(), (await engine.startConversation(supportBot(), {}, testCtx())).session, "2", testCtx());
    assert.equal(open.status, "handed_over");
    assert.deepEqual(sends(open.items), ["An agent will reply shortly."]);

    const closedCtx = testCtx({ isOpen: () => false });
    const closed = await engine.reply(supportBot(), (await engine.startConversation(supportBot(), {}, closedCtx)).session, "2", closedCtx);
    assert.deepEqual(sends(closed.items), ["We are closed now."]);
  });

  it("ends when an option is not connected", async () => {
    const ctx = testCtx();
    const r = await engine.reply(supportBot(), (await engine.startConversation(supportBot(), {}, ctx)).session, "3", ctx);
    assert.equal(r.status, "completed");
  });

  it("delays later messages and stops on loops", async () => {
    const nodes = [
      node("start", "start", { keywords: "hi", next: "a" }),
      node("a", "message", { text: "now", next: "d" }),
      node("d", "delay", { seconds: 3600, next: "b" }),
      node("b", "message", { text: "later", next: "" }),
    ];
    const r = await engine.startConversation(nodes, {}, testCtx());
    assert.deepEqual(
      r.items.filter((i) => i.type === "send").map((i) => [i.text, i.delaySeconds]),
      [
        ["now", 0],
        ["later", 3600],
      ],
    );

    const loop = [node("start", "start", { next: "x" }), node("x", "condition", { variable: "v", operator: "is_empty", trueNext: "x" })];
    const looped = await engine.startConversation(loop, {}, testCtx());
    assert.equal(looped.status, "error");
  });

  it("maps old prototype mock behaviours to data sources", () => {
    assert.equal(engine.apiSource({ mock: "order_lookup" }), "pos_order");
    assert.equal(engine.apiSource({ mock: "always_success" }), "http");
    assert.equal(engine.apiSource({ source: "pos_products", mock: "order_lookup" }), "pos_products");
  });
});

describe("AI flow generator", () => {
  const { generateFlow, normalizeGeneratedFlow } = require("../utils/waAutomation/flowGenerator");

  /** What a model might send back, warts and all. */
  const messyDraft = () => ({
    name: "Order help",
    description: "Order status and live support",
    nodes: [
      { id: "welcome", type: "menu", name: "Welcome", data: { text: "Hi!\n\n{{options}}", options: [{ title: "Order Status", next: "ask" }, { title: "Live Support", next: "agent" }, { title: "" }] } },
      { id: "ask", type: "collect_order", name: "Ask", data: { text: "Order number?", next: "find order" } },
      { id: "find order", type: "api", name: "Find", data: { source: "shopify", successNext: "result", failureNext: "nowhere" } },
      { id: "result", type: "menu", data: { text: "{{order_status}}\n\n{{options}}", options: [{ title: "Main Menu", next: "welcome" }] } },
      { id: "agent", type: "agent", data: {} },
      { id: "x", type: "send_image", data: {} },
      { id: "ask", type: "message", data: { text: "duplicate id" } },
    ],
  });

  it("turns the AI's draft into a flow the builder and engine can run", async () => {
    const flow = normalizeGeneratedFlow(messyDraft());
    const byId = Object.fromEntries(flow.nodes.map((n) => [n.id, n]));
    assert.equal(flow.name, "Order help");
    assert.equal(flow.nodes.filter((n) => n.type === "start").length, 1, "a Start step is added");
    assert.equal(byId.start.data.next, "welcome");
    assert.equal(byId.x, undefined, "unknown step types are dropped");
    assert.deepEqual(byId.welcome.data.options.map((o) => [o.title, o.value, o.next]), [["Order Status", "1", "ask"], ["Live Support", "2", "agent"]]);
    assert.equal(byId.ask.data.next, "find_order", "ids are tidied and links follow them");
    assert.equal(byId.find_order.data.source, "pos_order", "unknown sources fall back to the order lookup");
    assert.equal(byId.find_order.data.failureNext, "", "links to missing steps are cleared");
    const duplicate = flow.nodes.find((n) => n.data.text === "duplicate id");
    assert.ok(duplicate && duplicate.id !== "ask", "a repeated id gets a new one");
    assert.equal(new Set(flow.nodes.map((n) => n.id)).size, flow.nodes.length);
    assert.equal(byId.start.x, 40);
    assert.equal(byId.welcome.x, 340, "laid out left → right by distance from Start");

    const ctx = testCtx();
    let r = await engine.startConversation(flow.nodes, {}, ctx);
    assert.deepEqual(r.session.waiting, { type: "options", node_id: "welcome" });
    r = await engine.reply(flow.nodes, r.session, "1", ctx);
    assert.deepEqual(r.session.waiting, { type: "input", node_id: "ask" });
  });

  it("asks the AI, retries a bad answer once and gives up clearly", async () => {
    const answers = ["not json at all", JSON.stringify(messyDraft())];
    const calls = [];
    const complete = async (req) => {
      calls.push(req);
      return { content: answers.shift() };
    };
    const flow = await generateFlow({ prompt: "Order status and live support" }, { complete, retryDelayMs: 0 });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].json, true);
    assert.match(calls[0].messages[1].content, /^Build this flow\./);
    assert.ok(flow.nodes.length > 3);

    const editCalls = [];
    await generateFlow(
      { prompt: "add a product search", nodes: flow.nodes },
      { complete: async (req) => (editCalls.push(req), { content: JSON.stringify(messyDraft()) }) },
    );
    assert.match(editCalls[0].messages[1].content, /^Change this flow as asked\.[\s\S]*"id":"welcome"/);

    await assert.rejects(generateFlow({ prompt: "hi" }, { complete }), (err) => err.status === 400);
    await assert.rejects(
      generateFlow({ prompt: "Order status bot" }, { complete: async () => ({ content: "{}" }) }),
      (err) => err.status === 502 && /couldn't build a flow/.test(err.message),
    );
  });
});

describe("custom HTTP requests", () => {
  it("recognises private and local addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "::1", "::ffff:127.0.0.1", "fd00::1"]) {
      assert.equal(isPrivateAddress(ip), true, ip);
    }
    for (const ip of ["8.8.8.8", "104.16.0.1", "2606:4700::1"]) {
      assert.equal(isPrivateAddress(ip), false, ip);
    }
  });

  it("refuses requests to the server's own network", async () => {
    const r = await httpRequest({ data: { method: "GET", url: "http://localhost:8000/api/health" }, vars: {}, test: false });
    assert.equal(r.ok, false);
    assert.match(r.summary, /blocked/);
    const ip = await httpRequest({ data: { method: "GET", url: "http://169.254.169.254/latest" }, vars: {}, test: false });
    assert.match(ip.summary, /blocked/);
  });

  it("does not send non-GET requests from the test chat", async () => {
    const r = await httpRequest({ data: { method: "POST", url: "https://example.com/cancel" }, vars: {}, test: true });
    assert.equal(r.ok, true);
    assert.match(r.summary, /not sent from the test chat/);
  });

  it("reads response fields by path", () => {
    const json = { data: { status: "Shipped", items: [{ name: "Hoodie" }] } };
    assert.equal(getPath(json, "data.status"), "Shipped");
    assert.equal(getPath(json, "data.items[].name"), "Hoodie");
    assert.equal(getPath(json, "data.items.0.name"), "Hoodie");
    assert.equal(getPath(json, "data.missing.x"), undefined);
  });
});
