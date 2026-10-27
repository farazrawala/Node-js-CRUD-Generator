const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { parseOrderQuantity, splitSearchQuantity, classifyBrowseReply, cartState, addCartLine, optionalOrderEmail } = require("../utils/waAutomation/lookups");

describe("cart quantity", () => {
  it("reads a number out of a quantity reply", () => {
    assert.equal(parseOrderQuantity("1"), 1);
    assert.equal(parseOrderQuantity("5 kg"), 5);
    assert.equal(parseOrderQuantity("5kg"), 5);
    assert.equal(parseOrderQuantity("kg"), null);
    assert.equal(parseOrderQuantity("0"), null);
  });

  it("reads a quantity off a product search", () => {
    assert.deepEqual(splitSearchQuantity("Sugar 2 kg"), { query: "Sugar", quantity: "2" });
    assert.deepEqual(splitSearchQuantity("2kg Sugar"), { query: "Sugar", quantity: "2" });
    assert.deepEqual(splitSearchQuantity("Sugar"), { query: "Sugar", quantity: "" });
    assert.deepEqual(splitSearchQuantity("2 color"), { query: "2 color", quantity: "" });
  });

  it("treats a category number, more, and a product name differently", () => {
    const rows = [
      { id: "c1", name: "Clothes" },
      { id: "c2", name: "Toys" },
    ];
    assert.equal(classifyBrowseReply("1", { rows, hasMore: true }).kind, "category");
    assert.equal(classifyBrowseReply("3", { rows, hasMore: true }).kind, "more_categories");
    assert.equal(classifyBrowseReply("more", { rows, hasMore: true }).kind, "more_categories");
    assert.deepEqual(classifyBrowseReply("Sugar 2 kg", { rows, hasMore: true }), { kind: "name", query: "Sugar 2 kg" });
    assert.equal(classifyBrowseReply("toys", { rows, hasMore: false }).index, 1);
  });

  it("adds the line and totals it", () => {
    const lines = addCartLine([], {
      product_id: "p1",
      name: "Sugar",
      variant_name: "",
      qty: 5,
      unit: 19.98,
    });
    const again = addCartLine(lines, {
      product_id: "p1",
      name: "Sugar",
      variant_name: "",
      qty: 1,
      unit: 19.98,
    });
    const cart = cartState(again);
    assert.equal(cart.cart_count, "6");
    assert.equal(cart.cart_items, "6× Sugar");
    assert.equal(cart.cart_total, "Rs. 120.00");
  });

  it("writes the product unit on the line", () => {
    const cart = cartState([
      { product_id: "p1", name: "Sugar", qty: 3, unit: 19.98, measure: "Kg" },
    ]);
    assert.equal(cart.cart_items, "3 kg Sugar");
  });

  it("treats skip as no email and rejects a bad address", () => {
    assert.equal(optionalOrderEmail("skip"), "");
    assert.equal(optionalOrderEmail(""), "");
    assert.equal(optionalOrderEmail("a@b.com"), "a@b.com");
    assert.equal(optionalOrderEmail("not an email"), null);
  });
});
