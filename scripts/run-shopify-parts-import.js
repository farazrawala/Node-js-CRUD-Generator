/**
 * Import Shopify CSV parts one-by-one (waits for each part to finish).
 *
 * Local (recommended — no HTTP, server not required):
 *   node scripts/run-shopify-parts-import.js --local --no-images
 *   node scripts/run-shopify-parts-import.js --local --company-id YOUR_COMPANY_ID
 *
 * Via API (server must be running + JWT):
 *   node scripts/run-shopify-parts-import.js --no-images
 *
 * Resume from part 10:
 *   node scripts/run-shopify-parts-import.js --local --from 10 --no-images
 *
 * Env (.env):
 *   SHOPIFY_IMPORT_COMPANY_ID  required for --local
 *   SHOPIFY_IMPORT_URL         optional API URL override
 *   SHOPIFY_IMPORT_TOKEN       Bearer JWT for API mode
 *   SHOPIFY_IMPORT_TIMEOUT_MS  default 3600000
 */

const fs = require("fs");
const path = require("path");

require("dotenv").config();

const { getBasePath } = require("../utils/basePath");
const { connectMonogodb } = require("../connection");

const PARTS_DIR = path.resolve(
  process.cwd(),
  process.argv.includes("--dir") ?
    process.argv[process.argv.indexOf("--dir") + 1]
  : "bbg_shopify_parts",
);

const DEFAULT_TIMEOUT_MS =
  Number(process.env.SHOPIFY_IMPORT_TIMEOUT_MS) || 60 * 60 * 1000;

function readArg(flag, fallback = null) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function buildImportOptions() {
  return {
    updateExisting: !hasFlag("--no-update"),
    dryRun: hasFlag("--dry-run"),
    addStockViaPurchase: !hasFlag("--no-stock"),
    importArchived: hasFlag("--import-archived"),
    downloadImages: !hasFlag("--no-images"),
    updateExistingImages: hasFlag("--update-existing-images"),
    defaultQty: Number(readArg("--default-qty", "0")) || 0,
  };
}

function buildImportUrl() {
  if (process.env.SHOPIFY_IMPORT_URL) {
    return process.env.SHOPIFY_IMPORT_URL;
  }

  const fromArg = readArg("--url");
  if (fromArg) return fromArg;

  const baseUrl = String(process.env.BASE_URL || "http://localhost:8000/api")
    .trim()
    .replace(/\/$/, "");
  const root = baseUrl.replace(/\/api$/i, "");
  const basePath = getBasePath();
  const prefix = basePath ? `${root}${basePath}` : root;

  const url = new URL(`${prefix}/api/product/shopify-product-import`);
  const options = buildImportOptions();
  const params = url.searchParams;

  if (options.dryRun) params.set("dry_run", "true");
  params.set("download_images", options.downloadImages ? "true" : "false");
  params.set("update_existing", options.updateExisting ? "true" : "false");
  params.set(
    "add_stock_via_purchase",
    options.addStockViaPurchase ? "true" : "false",
  );
  if (options.importArchived) params.set("import_archived", "true");
  if (options.updateExistingImages) {
    params.set("update_existing_images", "true");
  }
  if (options.defaultQty > 0) {
    params.set("default_qty", String(options.defaultQty));
  }

  return url.toString();
}

function listPartFiles() {
  if (!fs.existsSync(PARTS_DIR)) {
    throw new Error(`Parts folder not found: ${PARTS_DIR}`);
  }

  return fs
    .readdirSync(PARTS_DIR)
    .filter((name) => /^bbg_shopify_part_\d+\.csv$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatFetchError(error) {
  const cause = error?.cause;
  if (cause?.code === "ECONNREFUSED") {
    return [
      "Cannot connect to API server (ECONNREFUSED).",
      "Start the server: npm run dev",
      "Or use: node scripts/run-shopify-parts-import.js --local --no-images",
    ].join("\n  ");
  }
  if (cause?.code) {
    return `${error.message} (${cause.code})`;
  }
  return error.message || String(error);
}

async function checkApiReachable(importUrl) {
  const healthUrl = importUrl.replace(
    /\/product\/shopify-product-import.*$/,
    "/health",
  );

  try {
    const response = await fetch(healthUrl, {
      signal: AbortSignal.timeout(10000),
    });
    return response.ok;
  } catch (_) {
    return false;
  }
}

async function postPartFile(importUrl, token, filePath) {
  const fileName = path.basename(filePath);
  const fileBuffer = fs.readFileSync(filePath);
  const form = new FormData();
  form.append("file", new Blob([fileBuffer], { type: "text/csv" }), fileName);

  const headers = {};
  if (token) {
    headers.Authorization = token.startsWith("Bearer ") ?
        token
      : `Bearer ${token}`;
  }

  const response = await fetch(importUrl, {
    method: "POST",
    headers,
    body: form,
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (_) {
    json = { raw: text.slice(0, 500) };
  }

  return { ok: response.ok, status: response.status, json };
}

async function importPartLocal(filePath, { companyId, createdBy, options }) {
  const {
    importShopifyProductsFromText,
    parseShopifyProductCsv,
  } = require("../utils/shopifyProductCsvImport");
  const text = fs.readFileSync(filePath, "utf8");

  if (options.dryRun) {
    const parsed = parseShopifyProductCsv(text, {
      defaultQty: options.defaultQty,
      importArchived: options.importArchived,
    });
    return {
      ok: true,
      message: `Dry run: ${parsed.rows.length} variant row(s)`,
      data: { shopify_parse_stats: parsed.stats },
    };
  }

  const result = await importShopifyProductsFromText(text, {
    companyId,
    createdBy,
    req: null,
    options: {
      updateExisting: options.updateExisting,
      dryRun: false,
      addStockViaPurchase: options.addStockViaPurchase,
      defaultQty: options.defaultQty,
      importArchived: options.importArchived,
      downloadImages: options.downloadImages,
      updateExistingImages: options.updateExistingImages,
      purchaseDescription: "Shopify product import stock",
    },
  });

  const summary = result.summary || {};
  return {
    ok: summary.failed === 0,
    message: `created ${summary.created}, updated ${summary.updated}, skipped ${summary.skipped}, failed ${summary.failed}`,
    data: result,
  };
}

async function runHttpMode({ importUrl, token, fromPart, delayMs, files }) {
  if (!token) {
    throw new Error(
      "SHOPIFY_IMPORT_TOKEN is required for API mode. Use --local or set JWT in .env.",
    );
  }

  const reachable = await checkApiReachable(importUrl);
  if (!reachable) {
    throw new Error(
      [
        `API not reachable at ${importUrl}`,
        "Start server: npm run dev",
        "Or use: node scripts/run-shopify-parts-import.js --local --no-images",
      ].join("\n"),
    );
  }

  for (let i = 0; i < files.length; i += 1) {
    const partNo = i + 1;
    if (partNo < fromPart) continue;

    const filePath = path.join(PARTS_DIR, files[i]);
    const started = Date.now();
    console.log(`[${partNo}/${files.length}] Uploading ${files[i]} ...`);

    try {
      const result = await postPartFile(importUrl, token, filePath);
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);

      if (!result.ok) {
        console.error(`  FAILED (${result.status}) in ${elapsed}s`);
        console.error(JSON.stringify(result.json, null, 2));
        console.error(`\nRe-run: node scripts/run-shopify-parts-import.js --from ${partNo}`);
        process.exit(1);
      }

      console.log(`  OK in ${elapsed}s —`, result.json?.message || "");
      if (i < files.length - 1 && delayMs > 0) await sleep(delayMs);
    } catch (error) {
      console.error(`  ERROR on part ${partNo}:`);
      console.error(`  ${formatFetchError(error)}`);
      console.error(`\nRe-run: node scripts/run-shopify-parts-import.js --from ${partNo}`);
      process.exit(1);
    }
  }
}

async function runLocalMode({ companyId, createdBy, fromPart, delayMs, files }) {
  const options = buildImportOptions();
  await connectMonogodb();
  console.log("MongoDB connected (local import mode)");

  for (let i = 0; i < files.length; i += 1) {
    const partNo = i + 1;
    if (partNo < fromPart) continue;

    const filePath = path.join(PARTS_DIR, files[i]);
    const started = Date.now();
    console.log(`[${partNo}/${files.length}] Importing ${files[i]} ...`);

    try {
      const result = await importPartLocal(filePath, {
        companyId,
        createdBy,
        options,
      });
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);

      if (!result.ok) {
        console.error(`  FAILED in ${elapsed}s —`, result.message);
        console.error(
          `\nRe-run: node scripts/run-shopify-parts-import.js --local --from ${partNo}`,
        );
        process.exit(1);
      }

      console.log(`  OK in ${elapsed}s —`, result.message);
      if (i < files.length - 1 && delayMs > 0) await sleep(delayMs);
    } catch (error) {
      console.error(`  ERROR on part ${partNo}:`, error.message);
      console.error(
        `\nRe-run: node scripts/run-shopify-parts-import.js --local --from ${partNo}`,
      );
      process.exit(1);
    }
  }
}

async function main() {
  const localMode = hasFlag("--local");
  const fromPart = Number(readArg("--from", "1")) || 1;
  const delayMs = Number(readArg("--delay", "2000")) || 2000;
  const files = listPartFiles();
  const options = buildImportOptions();

  console.log("Mode:", localMode ? "local (direct DB)" : "HTTP API");
  console.log("Parts dir:", PARTS_DIR);
  console.log("Total parts:", files.length);
  console.log("Starting from part:", fromPart);
  console.log("Options:", options);
  console.log("");

  if (localMode) {
    const companyId =
      readArg("--company-id") ||
      process.env.SHOPIFY_IMPORT_COMPANY_ID ||
      process.env.COMPANY_ID;
    if (!companyId) {
      throw new Error(
        "Set SHOPIFY_IMPORT_COMPANY_ID in .env or pass --company-id for --local mode.",
      );
    }
    const createdBy =
      readArg("--user-id") || process.env.SHOPIFY_IMPORT_USER_ID || null;
    await runLocalMode({
      companyId,
      createdBy,
      fromPart,
      delayMs,
      files,
    });
  } else {
    const importUrl = buildImportUrl();
    const token =
      process.env.SHOPIFY_IMPORT_TOKEN ||
      readArg("--token") ||
      process.env.API_TOKEN ||
      "";
    console.log("Import URL:", importUrl);
    console.log("Request timeout (ms):", DEFAULT_TIMEOUT_MS);
    console.log("");
    await runHttpMode({
      importUrl,
      token,
      fromPart,
      delayMs,
      files,
    });
  }

  console.log("\nAll parts finished.");
  process.exit(0);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
