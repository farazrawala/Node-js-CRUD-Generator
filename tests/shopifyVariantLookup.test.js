const test = require("node:test");
const assert = require("node:assert/strict");
const { matchProduct, remainderAfterTitle, storefrontBaseFromUrl } = require("../utils/shopifyVariantLookup");

test("line name splits into product title and size", () => {
  assert.equal(
    remainderAfterTitle("Women Chocolate Brown Long Fleece Winter Coat - xl", "Women Chocolate Brown Long Fleece Winter Coat"),
    "xl"
  );
});

test("matching title and size returns the variant id", () => {
  const matched = matchProduct(
    "Women Chocolate Brown Long Fleece Winter Coat - xl",
    "",
    {
      id: 8023691165747,
      title: "Women Chocolate Brown Long Fleece Winter Coat",
      variants: [{ id: 45130766811187, sku: "10707181", title: "xl", option1: "xl" }],
    },
    ""
  );
  assert.equal(matched.product_id, "8023691165747");
  assert.equal(matched.variant_id, "45130766811187");
});

test("integration url becomes the storefront address", () => {
  assert.equal(storefrontBaseFromUrl("nightsuit.pk"), "https://nightsuit.pk");
  assert.equal(storefrontBaseFromUrl("https://nightsuit-pk.myshopify.com/admin"), "https://nightsuit-pk.myshopify.com");
  assert.equal(storefrontBaseFromUrl("nightsuit-pk"), "https://nightsuit-pk.myshopify.com");
});
