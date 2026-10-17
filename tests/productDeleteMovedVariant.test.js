/**
 * Deleting a Variable parent must not soft-delete a variant that was moved to another
 * parent (it keeps its old "Parent [Size]" name). Runs against a throwaway local MongoDB
 * database (dropped afterwards). Skipped when no MongoDB answers.
 */
const { after, before, describe, it } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const MONGO = process.env.PRODUCT_TEST_MONGO || "mongodb://127.0.0.1:27017";
const DB_NAME = `product_delete_it_${Date.now()}`;

let available = false;
let api;
let Product;
const companyId = new mongoose.Types.ObjectId();
const user = { _id: new mongoose.Types.ObjectId(), name: "Tester", company_id: { _id: companyId } };

async function call(fn, { body, params, query } = {}) {
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
  await fn(
    { body: body || {}, params: params || {}, query: query || {}, user, headers: {}, method: "TEST", originalUrl: "/test" },
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
  api = require("../controllers/product");
  Product = require("../models/product");
});

after(async () => {
  if (!available) return;
  await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init().catch(() => {})));
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
});

const product = (fields) => ({
  _id: new mongoose.Types.ObjectId(),
  company_id: companyId,
  product_price: 100,
  status: "active",
  deletedAt: null,
  ...fields,
});

describe("Product delete after moving a variant", () => {
  it("keeps the moved variant, deletes the real and orphan children", async (t) => {
    if (!available) return t.skip("no local MongoDB");

    const oldParent = product({ product_name: "Girls Winter Button Coat", product_type: "Variable" });
    const newParent = product({ product_name: "Girls Winter Button Coat - Dark Green", product_type: "Variable" });
    const moved = product({
      product_name: "Girls Winter Button Coat [Dark Green - Large]",
      product_type: "Single",
      barcode: "8455285725223",
      parent_product_id: oldParent._id,
    });
    const stayed = product({
      product_name: "Girls Winter Button Coat [Black - Small]",
      product_type: "Single",
      parent_product_id: oldParent._id,
    });
    const orphan = product({ product_name: "Girls Winter Button Coat [Lime - Small]", product_type: "Single" });
    await Product.collection.insertMany([oldParent, newParent, moved, stayed, orphan]);

    const move = await call(api.productMoveVariant, {
      body: { variant_ids: [String(moved._id)], parent_id: String(newParent._id) },
    });
    assert.equal(move.code, 200, JSON.stringify(move.body));

    const del = await call(api.productDelete, { params: { id: String(oldParent._id) } });
    assert.equal(del.code, 200, JSON.stringify(del.body));

    const rows = await Product.collection
      .find({ _id: { $in: [oldParent._id, newParent._id, moved._id, stayed._id, orphan._id] } })
      .toArray();
    const byId = new Map(rows.map((r) => [String(r._id), r]));

    assert.ok(byId.get(String(oldParent._id)).deletedAt, "old parent deleted");
    assert.ok(byId.get(String(stayed._id)).deletedAt, "child still under the old parent deleted");
    assert.ok(byId.get(String(orphan._id)).deletedAt, "orphan with the parent's name deleted");

    const movedRow = byId.get(String(moved._id));
    assert.equal(movedRow.deletedAt, null, "moved variant must stay");
    assert.equal(movedRow.status, "active");
    assert.equal(String(movedRow.parent_product_id), String(newParent._id));
    assert.equal(byId.get(String(newParent._id)).deletedAt, null);
  });
});

describe("Product restore", () => {
  it("restores a deleted variant on its own", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const parent = product({ product_name: "Coat - Lime", product_type: "Variable" });
    const variant = product({
      product_name: "Coat [Lime - Small]",
      product_type: "Single",
      parent_product_id: parent._id,
      deletedAt: new Date("2026-10-16T09:32:26.200Z"),
      status: "inactive",
    });
    await Product.collection.insertMany([parent, variant]);

    const res = await call(api.productRestore, { params: { id: String(variant._id) } });
    assert.equal(res.code, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.variants_restored, 0);

    const row = await Product.collection.findOne({ _id: variant._id });
    assert.equal(row.deletedAt, null);
    assert.equal(row.status, "active");
    assert.equal(String(row.parent_product_id), String(parent._id));

    const again = await call(api.productRestore, { params: { id: String(variant._id) } });
    assert.equal(again.code, 404, "an active product is not restorable");
  });

  it("restores a parent with the variants its delete removed, not older ones", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const parent = product({ product_name: "Pajama Set", product_type: "Variable" });
    const small = product({ product_name: "Pajama Set [Small]", product_type: "Single", parent_product_id: parent._id });
    const large = product({ product_name: "Pajama Set [Large]", product_type: "Single", parent_product_id: parent._id });
    const removedEarlier = product({
      product_name: "Pajama Set [XL]",
      product_type: "Single",
      parent_product_id: parent._id,
      deletedAt: new Date("2026-09-01T00:00:00.000Z"),
      status: "inactive",
    });
    await Product.collection.insertMany([parent, small, large, removedEarlier]);

    const del = await call(api.productDelete, { params: { id: String(parent._id) } });
    assert.equal(del.code, 200, JSON.stringify(del.body));
    assert.equal(del.body.variants_deleted, 2);

    const res = await call(api.productRestore, { params: { id: String(parent._id) } });
    assert.equal(res.code, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.variants_restored, 2);

    const rows = await Product.collection
      .find({ _id: { $in: [parent._id, small._id, large._id, removedEarlier._id] } })
      .toArray();
    const byId = new Map(rows.map((r) => [String(r._id), r]));
    for (const p of [parent, small, large]) {
      assert.equal(byId.get(String(p._id)).deletedAt, null, p.product_name);
      assert.equal(byId.get(String(p._id)).status, "active", p.product_name);
    }
    assert.ok(byId.get(String(removedEarlier._id)).deletedAt, "variant deleted earlier stays deleted");
  });

  it("does not restore another company's product", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const foreign = product({
      company_id: new mongoose.Types.ObjectId(),
      product_name: "Other shop item",
      product_type: "Single",
      deletedAt: new Date(),
    });
    await Product.collection.insertOne(foreign);
    const res = await call(api.productRestore, { params: { id: String(foreign._id) } });
    assert.equal(res.code, 404);
    const row = await Product.collection.findOne({ _id: foreign._id });
    assert.ok(row.deletedAt);
  });
});
