const fs = require("fs");
const https = require("https");
const { parseCsv } = require("./build-shopify-image-import-csv");

function alternates(handle) {
  const out = new Set();
  if (/-s-/.test(handle)) out.add(handle.replace(/-s-/g, "s-"));
  if (/s-/.test(handle) && !/-s-/.test(handle)) out.add(handle.replace(/s-/g, "-s-"));
  out.delete(handle);
  return [...out];
}

function get(url) {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": "Mozilla/5.0" } },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          if (body.length < 20000) body += chunk;
        });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            resolve({ status: res.statusCode || 0, images: null });
            return;
          }
          try {
            const data = JSON.parse(body);
            resolve({
              status: 200,
              images: Array.isArray(data.images) ? data.images.length : 0,
              title: data.title || "",
            });
          } catch (_) {
            resolve({ status: 200, images: null, title: "" });
          }
        });
      },
    );
    req.setTimeout(15000, () => {
      req.destroy();
      resolve({ status: 0, images: null });
    });
    req.on("error", () => resolve({ status: 0, images: null }));
  });
}

async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: limit }, run));
  return results;
}

(async () => {
  const rows = parseCsv(fs.readFileSync("E:/Desktop/bbg_shopify_image_import.csv", "utf8"));
  const byHandle = new Map();
  for (let i = 1; i < rows.length; i += 1) {
    const handle = rows[i][0];
    const title = rows[i][1];
    if (!handle) continue;
    if (!byHandle.has(handle)) byHandle.set(handle, { handle, title: title || "", images: 0 });
    if (rows[i][8]) byHandle.get(handle).images += 1;
    if (title && !byHandle.get(handle).title) byHandle.get(handle).title = title;
  }
  const products = [...byHandle.values()];
  console.log("checking", products.length);
  let done = 0;
  const checked = await pool(products, 8, async (product) => {
    const primary = await get(`https://www.nightsuit.pk/products/${product.handle}.js`);
    let liveHandle = product.handle;
    let live = primary;
    if (primary.status !== 200) {
      for (const alt of alternates(product.handle)) {
        const attempt = await get(`https://www.nightsuit.pk/products/${alt}.js`);
        if (attempt.status === 200) {
          liveHandle = alt;
          live = attempt;
          break;
        }
      }
    }
    done += 1;
    if (done % 200 === 0) console.log("progress", done);
    return { ...product, liveHandle, liveStatus: live.status, liveImages: live.images };
  });

  const matchedWithImages = checked.filter((row) => row.liveHandle === row.handle && row.liveImages > 0);
  const matchedNoImages = checked.filter((row) => row.liveHandle === row.handle && row.liveStatus === 200 && !row.liveImages);
  const renamed = checked.filter((row) => row.liveStatus === 200 && row.liveHandle !== row.handle);
  const missing = checked.filter((row) => row.liveStatus !== 200);

  const summary = {
    products: checked.length,
    alreadyHaveImages: matchedWithImages.length,
    rightHandleNoImages: matchedNoImages.length,
    differentLiveHandle: renamed.length,
    notOnStore: missing.length,
  };
  console.log(JSON.stringify(summary, null, 2));
  fs.writeFileSync(
    process.env.TEMP + "/bbg_handle_check.json",
    JSON.stringify({ summary, renamed, matchedNoImages: matchedNoImages.map((row) => row.handle), missing: missing.map((row) => row.handle) }, null, 2),
  );
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
