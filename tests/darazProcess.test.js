/**
 * Daraz process helpers (no live Daraz network).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  flattenDarazCategoryTree,
  findDarazLeafForName,
  isDarazCategoryId,
  isDarazHostedImage,
  pickDarazEnumValue,
  sanitizeDarazSellerSku,
  buildDarazProductCreatePayload,
  buildDarazProductCreateXml,
  buildDarazAttributeXml,
  migrateDarazImages,
  buildDarazProductUpdateXml,
  buildDarazPlaceholderImageBuffer,
} = require("../controllers/darazProcess");

describe("darazProcess category matching", () => {
  const tree = flattenDarazCategoryTree([
    {
      category_id: 10,
      name: "Pet Supplies",
      leaf: false,
      children: [
        {
          category_id: 11,
          name: "Dog Food",
          leaf: true,
        },
        {
          category_id: 12,
          name: "Cat Food",
          leaf: true,
        },
      ],
    },
  ]);

  it("flattens nested Daraz category trees", () => {
    assert.equal(tree.length, 3);
    assert.equal(tree[0].category_id, "10");
    assert.equal(tree[1].leaf, true);
    assert.equal(tree[1].parent_id, "10");
  });

  it("maps a parent name to the first Daraz leaf", () => {
    const leaf = findDarazLeafForName(tree, "Pet Supplies");
    assert.equal(leaf.category_id, "11");
    assert.equal(leaf.name, "Dog Food");
  });

  it("matches a leaf by exact name", () => {
    const leaf = findDarazLeafForName(tree, "cat food");
    assert.equal(leaf.category_id, "12");
  });

  it("accepts numeric Daraz category ids only", () => {
    assert.equal(isDarazCategoryId("12345"), true);
    assert.equal(isDarazCategoryId("pets"), false);
    assert.equal(isDarazCategoryId("daraz-123"), false);
  });
});

describe("darazProcess create payload", () => {
  it("treats slatic CDN urls as already hosted", () => {
    assert.equal(
      isDarazHostedImage(
        "https://pk-live.slatic.net/original/abc.jpg",
      ),
      true,
    );
    assert.equal(isDarazHostedImage("http://localhost:8000/uploads/a.jpg"), false);
  });

  it("picks a valid enum option, preferring No Brand", () => {
    const attr = {
      name: "brand",
      options: [{ name: "Nike" }, { name: "No Brand" }],
    };
    assert.equal(pickDarazEnumValue(attr, "No Brand"), "No Brand");
    assert.equal(pickDarazEnumValue(attr, "unknown"), "Nike");
  });

  it("fills mandatory warranty_type from category attributes", () => {
    const xml = buildDarazAttributeXml(
      [
        {
          name: "warranty_type",
          is_mandatory: 1,
          input_type: "singleSelect",
          options: [
            { name: "No Warranty" },
            { name: "Local manufacturer warranty" },
          ],
        },
        {
          name: "color_family",
          is_mandatory: 1,
          is_sale_prop: 1,
          attribute_type: "sku",
          input_type: "singleSelect",
          options: [{ name: "Black" }],
        },
      ],
      { known: { warranty_type: "No Warranty" }, name: "Moana Petty" },
      false,
    );
    assert.match(xml, /<warranty_type>No Warranty<\/warranty_type>/);
    assert.doesNotMatch(xml, /color_family/);
  });

  it("puts sale props on the SKU, not the product attributes", () => {
    const xml = buildDarazAttributeXml(
      [
        {
          name: "color_family",
          is_mandatory: 1,
          is_sale_prop: 1,
          attribute_type: "sku",
          input_type: "singleSelect",
          options: [{ name: "Black" }],
        },
      ],
      { known: {}, name: "Moana Petty" },
      true,
    );
    assert.match(xml, /<color_family>Black<\/color_family>/);
  });

  it("sanitizes SellerSku spaces for Daraz", () => {
    assert.equal(
      sanitizeDarazSellerSku("Est libero officia a"),
      "Est-libero-officia-a",
    );
  });

  it("builds JSON create payload with Image arrays and sanitized SKU", () => {
    const payload = buildDarazProductCreatePayload({
      primaryCategory: "11",
      name: "Moana Petty",
      description: "Pet toy",
      brand: "No Brand",
      extraAttributes: { warranty_type: "No Warranty" },
      extraSkuAttributes: { color_family: "Maroon" },
      images: ["https://pk-live.slatic.net/original/a.jpg"],
      skus: [{ sellerSku: "Est libero officia a", price: 1304.1, quantity: 2 }],
    });
    const product = payload.Request.Product;
    assert.equal(product.PrimaryCategory, "11");
    assert.deepEqual(product.Images.Image, [
      "https://pk-live.slatic.net/original/a.jpg",
    ]);
    assert.equal(product.Attributes.name, "Moana Petty");
    assert.equal(product.Attributes.title, "Moana Petty");
    assert.equal(product.Attributes.brand, "No Brand");
    assert.equal(product.Skus.Sku[0].SellerSku, "Est-libero-officia-a");
    assert.equal(product.Skus.Sku[0].price, "1304");
    assert.equal(product.Skus.Sku[0].color_family, "Maroon");
    assert.deepEqual(product.Skus.Sku[0].Images.Image, product.Images.Image);
  });

  it("builds create XML with leaf category, brand, SKU images, and payload fields", () => {
    const xml = buildDarazProductCreateXml({
      primaryCategory: "11",
      name: "Moana Petty",
      description: "Pet toy",
      brand: "No Brand",
      extraAttributeXml: "        <warranty_type>No Warranty</warranty_type>",
      extraSkuXml: "          <color_family>Black</color_family>",
      images: ["https://pk-live.slatic.net/original/a.jpg"],
      skus: [{ sellerSku: "MOANA-1", price: 100, quantity: 2 }],
    });
    assert.match(xml, /<PrimaryCategory>11<\/PrimaryCategory>/);
    assert.match(xml, /<name>Moana Petty<\/name>/);
    assert.match(xml, /<title>Moana Petty<\/title>/);
    assert.match(xml, /<brand>No Brand<\/brand>/);
    assert.match(xml, /<SellerSku>MOANA-1<\/SellerSku>/);
    assert.match(xml, /<color_family>Black<\/color_family>/);
    assert.match(xml, /<warranty_type>No Warranty<\/warranty_type>/);
    assert.match(xml, /slatic\.net\/original\/a\.jpg/);
    assert.doesNotMatch(xml, /<brand_id>/);
  });

  it("keeps already-hosted images and skips migrate for localhost URLs", async () => {
    const calls = [];
    const client = {
      call: async (path, params) => {
        calls.push({ path, params });
        throw new Error("migrate failed");
      },
    };
    const hosted = await migrateDarazImages(client, [
      "https://pk-live.slatic.net/original/keep.jpg",
      "http://localhost:8000/uploads/local.jpg",
    ]);
    assert.deepEqual(hosted, ["https://pk-live.slatic.net/original/keep.jpg"]);
    assert.equal(calls.length, 0);
  });

  it("migrates public non-Daraz image URLs", async () => {
    const client = {
      call: async () => ({
        image: { url: "https://pk-live.slatic.net/original/x.jpg" },
      }),
    };
    const hosted = await migrateDarazImages(client, [
      "https://cdn.example.com/photo.jpg",
    ]);
    assert.deepEqual(hosted, ["https://pk-live.slatic.net/original/x.jpg"]);
  });

  it("puts Skus on /product/update payloads", () => {
    const xml = buildDarazProductUpdateXml({
      itemId: "1975046199",
      name: "Moana Petty",
      description: "Pet toy",
      images: ["https://pk-live.slatic.net/original/a.jpg"],
      skus: [{ sellerSku: "Est libero officia a", skuId: "14064768771" }],
    });
    assert.match(xml, /<ItemId>1975046199<\/ItemId>/);
    assert.match(xml, /<SellerSku>Est-libero-officia-a<\/SellerSku>/);
    assert.match(xml, /<SkuId>14064768771<\/SkuId>/);
    assert.match(xml, /<quantity>1<\/quantity>/);
    assert.match(xml, /<price>1<\/price>/);
    assert.match(xml, /<name>Moana Petty<\/name>/);
    assert.match(xml, /<name_en>Moana Petty<\/name_en>/);
    assert.match(xml, /<Skus>/);
    assert.match(xml, /<Sku>/);
  });

  it("builds an 800x800 placeholder when the POS product has no image", async () => {
    const buffer = await buildDarazPlaceholderImageBuffer();
    const sharp = require("sharp");
    const meta = await sharp(buffer).metadata();
    assert.equal(meta.width, 800);
    assert.equal(meta.height, 800);
    assert.ok(buffer.length > 1000);
  });
});
