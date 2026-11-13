const assert = require("node:assert/strict");
const test = require("node:test");

const Product = require("../models/product");

test("product schema persists deal products and selected attribute or variant values", () => {
  const dealPath = Product.schema.path("is_deal");
  const dealProductsPath = Product.schema.path("deal_product_ids");
  const dealProductPairsPath = Product.schema.path("deal_products");

  assert.equal(dealPath.instance, "Boolean");
  assert.equal(dealPath.defaultValue, false);
  assert.equal(new Product({ is_deal: "true" }).is_deal, true);
  assert.equal(new Product({ is_deal: "false" }).is_deal, false);
  assert.equal(dealProductsPath.instance, "Array");
  assert.equal(dealProductsPath.caster.instance, "ObjectId");
  assert.equal(dealProductsPath.caster.options.ref, "product");
  assert.equal(dealProductPairsPath.instance, "Array");
  assert.equal(dealProductPairsPath.schema.path("product_id").options.ref, "product");
  assert.equal(dealProductPairsPath.schema.path("variant_id").options.ref, "product");
  assert.equal(dealProductPairsPath.schema.path("attributes").instance, "Array");
  assert.equal(dealProductPairsPath.schema.path("attributes").schema.path("name").instance, "String");
  assert.equal(dealProductPairsPath.schema.path("attributes").schema.path("value").instance, "String");
});
