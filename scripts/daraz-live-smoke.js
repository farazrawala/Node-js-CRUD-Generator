/**
 * Live Daraz Pakistan smoke test.
 * Loads the active Daraz integration from Mongo and calls api.daraz.pk.
 *
 *   node scripts/daraz-live-smoke.js
 *   DARAZ_LIVE_CREATE=1 node scripts/daraz-live-smoke.js   # also POST /product/create
 */
require("dotenv").config();

const mongoose = require("mongoose");
const { connectMonogodb } = require("../connection");
const Integration = require("../models/integration");
const Product = require("../models/product");
const {
  buildDarazClient,
  flattenDarazCategoryTree,
  findDarazLeafForName,
  migrateDarazImages,
  sanitizeDarazSellerSku,
  createDarazListing,
} = require("../controllers/darazProcess");
const {
  resolvePosProductSku,
  resolveUploadFileOnDisk,
  resolveSyncProductPrice,
} = require("../utils/integrationProductSync");
const {
  refreshDarazAccessToken,
  trimCredential,
  maskToken,
} = require("../utils/darazTokenRefresh");
const { coalesceObjectId } = require("../utils/modelHelper");

function findLocalProductImage(dir, depth = 0) {
  const fs = require("fs");
  const path = require("path");
  if (depth > 4) return null;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isFile() && /\.(png|jpe?g|gif|webp)$/i.test(entry.name)) {
      return abs;
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const hit = findLocalProductImage(path.join(dir, entry.name), depth + 1);
    if (hit) return hit;
  }
  return null;
}

async function step(name, fn) {
  const started = Date.now();
  try {
    const result = await fn();
    const ms = Date.now() - started;
    console.log(`PASS  ${name}  (${ms}ms)`);
    if (result?.summary) console.log(`      ${result.summary}`);
    return { ok: true, name, ms, result };
  } catch (err) {
    const ms = Date.now() - started;
    console.error(`FAIL  ${name}  (${ms}ms)`);
    console.error(`      ${err?.message || err}`);
    return { ok: false, name, ms, error: err?.message || String(err) };
  }
}

async function loadClient(integration) {
  let { client, error } = buildDarazClient(integration);
  if (!error) return { client, integration };

  if (!trimCredential(integration.refresh_token)) {
    throw new Error(error);
  }

  console.log("      access token missing/invalid — refreshing…");
  const refreshed = await refreshDarazAccessToken({
    appKey: integration.key,
    appSecret: integration.secret,
    refreshToken: integration.refresh_token,
    integrationId: integration._id,
  });
  const next = {
    ...integration,
    token: refreshed.access_token,
    refresh_token: refreshed.refresh_token || integration.refresh_token,
  };
  const rebuilt = buildDarazClient(next);
  if (rebuilt.error) throw new Error(rebuilt.error);
  return { client: rebuilt.client, integration: next };
}

async function runDarazLiveSmoke(options = {}) {
  const wantCreate =
    options.create === true ||
    String(process.env.DARAZ_LIVE_CREATE || "").trim() === "1";

  await connectMonogodb();

  const integration = await Integration.findOne({
    store_type: "daraz",
    deletedAt: null,
    status: "active",
  })
    .sort({ updatedAt: -1 })
    .lean();

  if (!integration) {
    throw new Error("No active Daraz integration found in Mongo.");
  }

  console.log(
    `Using integration ${integration.name} (${integration._id}) token=${maskToken(integration.token)}`,
  );

  const { client, integration: active } = await loadClient(integration);
  const results = [];

  results.push(
    await step("GET /products/get", async () => {
      const data = await client.call("/products/get", {
        filter: "all",
        limit: "2",
        offset: "0",
      });
      const products = [].concat(data?.products || data?.product || []);
      return {
        summary: `products=${products.length} total=${data?.total_products ?? data?.total ?? "?"}`,
        data: { count: products.length },
      };
    }),
  );

  results.push(
    await step("GET /brands/get", async () => {
      try {
        const data = await client.call("/brands/get", {
          offset: "0",
          limit: "5",
        });
        const brands = [].concat(
          data?.brands || data?.brand || (Array.isArray(data) ? data : []),
        );
        return {
          summary: `brands=${brands.length} first=${brands[0]?.name || "n/a"}`,
          data: { count: brands.length, first: brands[0]?.name || null },
        };
      } catch (err) {
        if (!String(err?.message || "").includes("InvalidApiPath")) throw err;
        return {
          summary:
            "/brands/get is not enabled on this Daraz app (InvalidApiPath). Create will use No Brand.",
          data: { count: 0, fallback: true },
        };
      }
    }),
  );

  let tree = [];
  results.push(
    await step("GET /category/tree/get", async () => {
      const data = await client.call("/category/tree/get", {});
      tree = flattenDarazCategoryTree(
        data?.category_list || data?.data || data,
      );
      const leaves = tree.filter((row) => row.leaf);
      return {
        summary: `nodes=${tree.length} leaves=${leaves.length}`,
        data: { nodes: tree.length, leaves: leaves.length },
      };
    }),
  );

  const product = await Product.findOne({
    product_name: /moana petty/i,
    deletedAt: null,
  }).lean();

  results.push(
    await step("Load POS product Moana Petty", async () => {
      if (!product) throw new Error("Product Moana Petty was not found.");
      return {
        summary: `id=${product._id} sku=${resolvePosProductSku(product)} cats=${(product.category_id || []).length} image=${product.product_image ? "yes" : "no"}`,
        data: { id: String(product._id) },
      };
    }),
  );

  let leafId = "";
  if (product && tree.length) {
    const cats = Array.isArray(product.category_id)
      ? product.category_id
      : product.category_id
        ? [product.category_id]
        : [];
    const Category = require("../models/category");
    const posCats = cats.length
      ? await Category.find({ _id: { $in: cats } }).select("name").lean()
      : [];
    const matchName = posCats[0]?.name || "Pet Supplies";
    const leaf = findDarazLeafForName(tree, matchName);
    leafId = String(leaf?.category_id || "").trim();
    results.push(
      await step("Match Daraz leaf category", async () => {
        if (!leafId) {
          throw new Error(`No Daraz leaf matched POS category "${matchName}".`);
        }
        return {
          summary: `"${matchName}" → ${leaf.name} (${leafId})`,
          data: { leafId, leafName: leaf.name },
        };
      }),
    );
  }

  if (leafId) {
    results.push(
      await step("GET /category/attributes/get", async () => {
        const data = await client.call("/category/attributes/get", {
          primary_category_id: leafId,
        });
        const attrs = [].concat(
          Array.isArray(data) ? data : data?.attributes || data?.attribute || [],
        );
        const mandatory = attrs.filter(
          (row) => row?.is_mandatory === 1 || row?.isMandatory === 1,
        );
        const color = attrs.find((row) =>
          /color_family/i.test(String(row?.name || "")),
        );
        const nameEn = attrs.find((row) =>
          /name_en/i.test(String(row?.name || "")),
        );
        return {
          summary: `attrs=${attrs.length} mandatory=${mandatory.length} ${mandatory.map((row) => row.name).slice(0, 13).join(",")} name_en=${nameEn?.input_type || nameEn?.label || "no"} color=${color?.input_type || "no"}:${(color?.options || color?.options_list || []).slice(0, 3).map((opt) => opt?.name || opt).join("|")}`,
          data: {
            count: attrs.length,
            mandatory: mandatory.map((row) => row.name).slice(0, 12),
          },
        };
      }),
    );
  }

  let hostedImages = [];
  if (product) {
    results.push(
      await step("POST /image/upload or /image/migrate", async () => {
        const path = require("path");
        const sources = [];
        const addSource = (value) => {
          const trimmed = String(value || "").trim();
          if (trimmed && !sources.includes(trimmed)) sources.push(trimmed);
        };
        addSource(product.product_image);
        if (Array.isArray(product.multi_images)) {
          product.multi_images.forEach(addSource);
        }
        const catalog = await Product.findOne({
          company_id: product.company_id,
          deletedAt: null,
          product_image: { $nin: [null, ""] },
        })
          .select("product_image")
          .lean();
        addSource(catalog?.product_image);

        if (!sources.some((asset) => resolveUploadFileOnDisk(asset))) {
          const uploadsDir = path.join(__dirname, "..", "uploads", "products");
          const abs = findLocalProductImage(uploadsDir);
          if (abs) {
            const marker = abs.replace(/\\/g, "/").toLowerCase().indexOf("/uploads/");
            addSource(
              marker >= 0
                ? abs.replace(/\\/g, "/").slice(marker + 1)
                : abs,
            );
          }
        }

        hostedImages = await migrateDarazImages(client, sources);
        if (!hostedImages.length) {
          throw new Error(
            `No Daraz CDN image. Tried local /image/upload then migrate. source=${sources[0] || "none"} disk=${sources.map((asset) => resolveUploadFileOnDisk(asset) || "").filter(Boolean)[0] || "none"}`,
          );
        }
        return {
          summary: `hosted=${hostedImages.length} sample=${hostedImages[0]}`,
          data: {
            hosted: hostedImages.length,
            sample: hostedImages[0],
            source: sources[0] || null,
          },
        };
      }),
    );
  }

  if (wantCreate && product && leafId && hostedImages.length) {
    results.push(
      await step("POST /product/create", async () => {
        const sku = sanitizeDarazSellerSku(resolvePosProductSku(product));
        const productForCreate = {
          ...product,
          product_image: hostedImages[0],
          multi_images: hostedImages,
          product_name: product.product_name || "Moana Petty",
        };
        const created = await createDarazListing({
          client,
          integration: active,
          product: productForCreate,
          companyId: coalesceObjectId(product.company_id),
          integrationId: coalesceObjectId(active._id),
          primaryCategoryId: leafId,
          process: {
            _id: null,
            created_by: null,
            integration_id: active._id,
            company_id: product.company_id,
          },
          skus: [
            {
              sellerSku: sku,
              price: Number(resolveSyncProductPrice(product)) || 1,
              quantity: Number(product.origin_qty) || 1,
              packageContent: product.product_name,
            },
          ],
        });
        const itemId = created?.item_id || created?.itemId || "";
        return {
          summary: `item_id=${itemId || JSON.stringify(created).slice(0, 180)}`,
          data: created,
        };
      }),
    );
  } else if (!wantCreate) {
    console.log(
      "SKIP  POST /product/create  (set DARAZ_LIVE_CREATE=1 to create Moana Petty on Daraz)",
    );
  }

  const failed = results.filter((row) => !row.ok);
  console.log(
    `\nLive Daraz smoke: ${results.length - failed.length}/${results.length} passed`,
  );
  return { results, failed };
}

async function main() {
  try {
    const { failed } = await runDarazLiveSmoke();
    process.exitCode = failed.length ? 1 : 0;
  } catch (err) {
    console.error("Live Daraz smoke aborted:", err?.message || err);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

if (require.main === module) {
  main();
}

module.exports = { runDarazLiveSmoke };
