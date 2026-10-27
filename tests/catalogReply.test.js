const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { catalogReplyForMessage } = require("../utils/waAutomation/catalogReply");

const sugar = {
  ok: true,
  products: [
    { name: "Sugar", price: "PKR 20", stock: "Out of stock", sku: "", url: "http://localhost:5173/shop/himalay/product/1" },
  ],
};

const asked = "Sure thing! What product are you looking for? Let me know the name or type and I’ll help you out.";

describe("catalog reply", () => {
  it("puts the matching products in the same message", async () => {
    const text = await catalogReplyForMessage({
      message: "Sugar",
      previousBotText: asked,
      search: async () => sugar,
    });
    assert.match(text, /Here is what we found for “Sugar”/);
    assert.match(text, /\*Sugar\*/);
    assert.match(text, /PKR 20/);
    assert.match(text, /Out of stock/);
    assert.doesNotMatch(text, /give me a sec|let me check/i);
  });

  it("answers a product name even when the bot did not ask", async () => {
    const text = await catalogReplyForMessage({
      message: "Sugar",
      previousBotText: "Wa Alaikum Salam! How can I help you today?",
      search: async () => sugar,
    });
    assert.match(text, /\*Sugar\*/);
  });

  it("says the product was not found when the bot just asked for one", async () => {
    const text = await catalogReplyForMessage({
      message: "Sugar",
      previousBotText: asked,
      search: async () => ({ ok: false, products: [] }),
    });
    assert.match(text, /could not find any product matching “Sugar”/);
  });

  it("leaves greetings, menu numbers and yes/no to the AI", async () => {
    const search = async () => {
      throw new Error("should not search");
    };
    assert.equal(await catalogReplyForMessage({ message: "1", previousBotText: asked, search }), null);
    assert.equal(await catalogReplyForMessage({ message: "Salam", previousBotText: "", search }), null);
    assert.equal(await catalogReplyForMessage({ message: "Yes", previousBotText: "Want me to add it?", search }), null);
    assert.equal(
      await catalogReplyForMessage({
        message: "Can I see my cart please now",
        previousBotText: "Sure thing!",
        search,
      }),
      null,
    );
  });

  it("does not invent a miss when nobody asked for a product", async () => {
    const text = await catalogReplyForMessage({
      message: "Sugar",
      previousBotText: "How can I help?",
      search: async () => ({ ok: false, products: [] }),
    });
    assert.equal(text, null);
  });
});
