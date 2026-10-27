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
  parsePosVariationParts,
  migrateDarazImages,
  createDarazListing,
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

  it("does not map Kids Pajama Set onto an eyewear leaf named Kids", () => {
    const nodes = flattenDarazCategoryTree([
      {
        category_id: 10001252,
        name: "Kids",
        leaf: true,
      },
      {
        category_id: 9043,
        name: "Pyjama sets",
        leaf: true,
      },
    ]);
    const leaf = findDarazLeafForName(nodes, "Kids Pajama Set");
    assert.equal(leaf.category_id, "9043");
    assert.equal(leaf.name, "Pyjama sets");
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

  it("sends only one color sale prop on a SKU", () => {
    const xml = buildDarazAttributeXml(
      [
        {
          name: "frame_color",
          label: "Frame Color",
          is_sale_prop: 1,
          attribute_type: "sku",
          input_type: "singleSelect",
          options: [{ name: "Red" }, { name: "Blue" }],
        },
        {
          name: "lens_color",
          label: "Lens Color",
          is_sale_prop: 1,
          attribute_type: "sku",
          input_type: "singleSelect",
          options: [{ name: "Red" }, { name: "Yellow" }],
        },
      ],
      { known: {}, name: "Kids Matching Set | Polo - Yellow" },
      true,
    );
    assert.match(xml, /<lens_color>Yellow<\/lens_color>/);
    assert.doesNotMatch(xml, /frame_color/);
  });

  it("keeps color and size as separate sale props", () => {
    const xml = buildDarazAttributeXml(
      [
        {
          name: "color_family",
          is_sale_prop: 1,
          attribute_type: "sku",
          input_type: "singleSelect",
          options: [{ name: "Red" }, { name: "Yellow" }],
        },
        {
          name: "size",
          is_sale_prop: 1,
          attribute_type: "sku",
          input_type: "singleSelect",
          options: [{ name: "M" }, { name: "L" }],
        },
        {
          name: "frame_color",
          label: "Frame Color",
          is_sale_prop: 1,
          attribute_type: "sku",
          input_type: "singleSelect",
          options: [{ name: "Red" }],
        },
      ],
      { known: {}, name: "Kids Matching Set | Polo - Yellow" },
      true,
    );
    assert.match(xml, /<color_family>Yellow<\/color_family>/);
    assert.match(xml, /<size>M<\/size>/);
    assert.doesNotMatch(xml, /frame_color/);
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

describe("darazProcess variable product create", () => {
  const product = {
    _id: "p1",
    product_name: "Kids Matching Set | Polo - Yellow",
    sku: "KMS-POLO-YELLOW",
  };
  const variationSkus = [
    {
      sellerSku: "C007",
      price: 1500,
      quantity: 2,
      variationName: "Kids Matching Set | Polo - Yellow [Size: S]",
    },
    {
      sellerSku: "C008",
      price: 1500,
      quantity: 3,
      variationName: "Kids Matching Set | Polo - Yellow [Size: M]",
    },
  ];

  function fakeDarazClient(attributes) {
    const calls = [];
    return {
      calls,
      call: async (path, params) => {
        calls.push({ path, params });
        if (path === "/brands/get") return { brands: [{ name: "No Brand" }] };
        if (path === "/category/attributes/get") return attributes;
        if (path === "/product/create") return { item_id: "900", sku_list: [] };
        throw new Error(`unexpected Daraz call ${path}`);
      },
    };
  }

  function createListing(client, overrides = {}) {
    return createDarazListing({
      client,
      integration: {},
      product,
      companyId: "c1",
      integrationId: "i1",
      process: null,
      primaryCategoryId: "123",
      skus: variationSkus,
      ...overrides,
    });
  }

  it("reads attribute values from a POS variation name", () => {
    assert.deepEqual(parsePosVariationParts("Shirt [Size: 2 - 3Y - Color: Red]"), [
      { name: "Size", value: "2 - 3Y" },
      { name: "Color", value: "Red" },
    ]);
    assert.deepEqual(parsePosVariationParts("Shirt [Red - XL]"), [
      { name: "", value: "Red" },
      { name: "", value: "XL" },
    ]);
    assert.deepEqual(parsePosVariationParts("Kids Matching Set | Polo - Yellow"), []);
    assert.deepEqual(
      parsePosVariationParts("Kids Matching Set | Polo - Yellow [1 - 2 Years]"),
      [{ name: "", value: "1 - 2 Years" }],
    );
  });

  it("gives each variation SKU its own sale prop values", async () => {
    const client = fakeDarazClient([
      {
        name: "color_family",
        label: "Color Family",
        is_sale_prop: 1,
        attribute_type: "sku",
        input_type: "singleSelect",
        options: [{ name: "Black" }, { name: "Yellow" }],
      },
      {
        name: "size",
        label: "Size",
        is_sale_prop: 1,
        attribute_type: "sku",
        input_type: "singleSelect",
        options: [{ name: "S" }, { name: "M" }, { name: "L" }],
      },
    ]);
    await createListing(client);
    const create = client.calls.find((row) => row.path === "/product/create");
    const skuBlocks = create.params.payload.split("<Sku>").slice(1);
    assert.equal(skuBlocks.length, 2);
    assert.match(skuBlocks[0], /<SellerSku>C007<\/SellerSku>/);
    assert.match(skuBlocks[0], /<size>S<\/size>/);
    assert.match(skuBlocks[1], /<SellerSku>C008<\/SellerSku>/);
    assert.match(skuBlocks[1], /<size>M<\/size>/);
    for (const block of skuBlocks) {
      assert.match(block, /<color_family>Yellow<\/color_family>/);
    }
  });

  it("sends each age range as its own size", async () => {
    const client = fakeDarazClient([
      {
        name: "color_family",
        label: "Color Family",
        is_sale_prop: 1,
        attribute_type: "sku",
        input_type: "singleSelect",
        options: [{ name: "Yellow" }, { name: "Red" }],
      },
      {
        name: "size_baby_clothing",
        label: "Size Baby Clothing",
        is_sale_prop: 1,
        attribute_type: "sku",
        input_type: "singleSelect",
        options: [{ name: "1-2 Years" }, { name: "3-4 Years" }, { name: "5-6 Years" }],
      },
    ]);
    await createListing(client, {
      skus: [
        {
          sellerSku: "10759091",
          price: 1500,
          quantity: 2,
          variationName: "Kids Matching Set | Polo - Yellow [1 - 2 Years]",
        },
        {
          sellerSku: "10759093",
          price: 1500,
          quantity: 1,
          variationName: "Kids Matching Set | Polo - Yellow [5-6-years-1]",
        },
        {
          sellerSku: "10759092",
          price: 1500,
          quantity: 3,
          variationName: "Kids Matching Set | Polo - Yellow [3 - 4 Years]",
        },
      ],
    });
    const create = client.calls.find((row) => row.path === "/product/create");
    assert.match(create.params.payload, /<size_baby_clothing>1-2 Years<\/size_baby_clothing>/);
    assert.match(create.params.payload, /<size_baby_clothing>3-4 Years<\/size_baby_clothing>/);
    assert.match(create.params.payload, /<size_baby_clothing>5-6 Years<\/size_baby_clothing>/);
    assert.match(create.params.payload, /<color_family>Yellow<\/color_family>/);
  });

  it("leaves the eyewear Kids category when the sizes would collide", async () => {
    const calls = [];
    const client = {
      calls,
      call: async (path, params) => {
        calls.push({ path, params });
        if (path === "/brands/get") return { brands: [{ name: "No Brand" }] };
        if (path === "/category/tree/get") {
          return {
            category_list: [
              { category_id: 10001252, name: "Kids", leaf: true },
              { category_id: 9043, name: "Pyjama sets", leaf: true },
            ],
          };
        }
        if (path === "/category/attributes/get" && params.primary_category_id === "10001252") {
          return [{
            name: "lens_color",
            label: "Lens Color",
            is_sale_prop: 1,
            attribute_type: "sku",
            input_type: "singleSelect",
            options: [{ name: "Yellow" }, { name: "Red" }],
          }];
        }
        if (path === "/category/attributes/get" && params.primary_category_id === "9043") {
          return [
            {
              name: "color_family",
              label: "Color Family",
              is_sale_prop: 1,
              attribute_type: "sku",
              input_type: "singleSelect",
              options: [{ name: "Yellow" }, { name: "Red" }],
            },
            {
              name: "size_baby_clothing",
              label: "Size Baby Clothing",
              is_sale_prop: 1,
              attribute_type: "sku",
              input_type: "singleSelect",
              options: [{ name: "1-2 Years" }, { name: "3-4 Years" }],
            },
          ];
        }
        if (path === "/product/create") return { item_id: "900", sku_list: [] };
        throw new Error(`unexpected Daraz call ${path}`);
      },
    };
    await createListing(client, {
      primaryCategoryId: "10001252",
      product: {
        ...product,
        category_id: [{ _id: "cat1", name: "Kids Pajama Set" }],
      },
      skus: [
        {
          sellerSku: "10759091",
          price: 1500,
          quantity: 2,
          variationName: "Kids Matching Set | Polo - Yellow [1 - 2 Years]",
        },
        {
          sellerSku: "10759092",
          price: 1500,
          quantity: 3,
          variationName: "Kids Matching Set | Polo - Yellow [3 - 4 Years]",
        },
      ],
    });
    const create = calls.find((row) => row.path === "/product/create");
    assert.match(create.params.payload, /<PrimaryCategory>9043<\/PrimaryCategory>/);
    assert.match(create.params.payload, /<size_baby_clothing>1-2 Years<\/size_baby_clothing>/);
    assert.match(create.params.payload, /<size_baby_clothing>3-4 Years<\/size_baby_clothing>/);
  });

  it("leaves eyewear Kids when the POS category is named Kids", async () => {
    const calls = [];
    const client = {
      calls,
      call: async (path, params) => {
        calls.push({ path, params });
        if (path === "/brands/get") return { brands: [{ name: "No Brand" }] };
        if (path === "/category/tree/get") {
          return {
            category_list: [
              { category_id: 10001252, name: "Kids", leaf: true },
              { category_id: 9043, name: "Pyjama sets", leaf: true },
            ],
          };
        }
        if (path === "/category/attributes/get" && params.primary_category_id === "10001252") {
          return [{
            name: "lens_color",
            label: "Lens Color",
            is_sale_prop: 1,
            attribute_type: "sku",
            input_type: "singleSelect",
            options: [{ name: "Yellow" }, { name: "Red" }],
          }];
        }
        if (path === "/category/attributes/get" && params.primary_category_id === "9043") {
          return [
            {
              name: "color_family",
              label: "Color Family",
              is_sale_prop: 1,
              attribute_type: "sku",
              input_type: "singleSelect",
              options: [{ name: "Yellow" }],
            },
            {
              name: "size_baby_clothing",
              label: "Size Baby Clothing",
              is_sale_prop: 1,
              attribute_type: "sku",
              input_type: "singleSelect",
              options: [{ name: "1-2 Years" }, { name: "3-4 Years" }],
            },
          ];
        }
        if (path === "/product/create") return { item_id: "900", sku_list: [] };
        throw new Error(`unexpected Daraz call ${path}`);
      },
    };
    await createListing(client, {
      primaryCategoryId: "10001252",
      product: {
        ...product,
        category_id: [{ _id: "cat1", name: "Kids" }],
      },
      skus: [
        {
          sellerSku: "10759091",
          price: 1500,
          quantity: 2,
          variationName: "Kids Matching Set | Polo - Yellow [1 - 2 Years]",
        },
        {
          sellerSku: "6ae0684d03a89dc4b2ddd89d",
          price: 1500,
          quantity: 1,
          variationName: "Kids Matching Set | Polo - Yellow [3 - 4 Years]",
        },
      ],
    });
    const create = calls.find((row) => row.path === "/product/create");
    assert.match(create.params.payload, /<PrimaryCategory>9043<\/PrimaryCategory>/);
    assert.match(create.params.payload, /<size_baby_clothing>1-2 Years<\/size_baby_clothing>/);
    assert.match(create.params.payload, /<size_baby_clothing>3-4 Years<\/size_baby_clothing>/);
    assert.doesNotMatch(create.params.payload, /lens_color/);
  });

  it("stops before Daraz when two variations would carry the same sale props", async () => {
    const client = fakeDarazClient([
      {
        name: "lens_color",
        label: "Lens Color",
        is_sale_prop: 1,
        attribute_type: "sku",
        input_type: "singleSelect",
        options: [{ name: "Red" }, { name: "Yellow" }],
      },
    ]);
    await assert.rejects(createListing(client), (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /C007 and C008/);
      assert.match(err.message, /Lens Color: Yellow/);
      return true;
    });
    assert.ok(!client.calls.some((row) => row.path === "/product/create"));
  });

  it("does not borrow another category's mapping for an uncategorized product", async () => {
    const client = fakeDarazClient([]);
    await assert.rejects(
      createListing(client, { primaryCategoryId: undefined }),
      /without a category/,
    );
    assert.deepEqual(client.calls, []);
  });
});
