const assert = require("node:assert/strict");
const test = require("node:test");

const { normalizeDealProductsInBody } = require("../utils/productDealFields");

test("normalizeDealProductsInBody parses multipart deal products", () => {
  const body = {
    deal_products: JSON.stringify([{ product_id: "product-1", attributes: [] }]),
  };

  normalizeDealProductsInBody(body);

  assert.deepEqual(body.deal_products, [
    { product_id: "product-1", attributes: [] },
  ]);
});

test("normalizeDealProductsInBody rejects invalid JSON and non-array data", () => {
  for (const value of ["not-json", JSON.stringify({ product_id: "product-1" })]) {
    assert.throws(
      () => normalizeDealProductsInBody({ deal_products: value }),
      { message: "deal_products must be a valid JSON array.", statusCode: 400 },
    );
  }
});
