function storefrontBaseFromUrl(rawUrl) {
  let raw = String(rawUrl || "").trim();
  if (!raw) return "";
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  let host = "";
  try {
    host = new URL(raw).host;
  } catch {
    return "";
  }
  host = host.replace(/\/$/, "");
  if (!host.includes(".")) host = `${host}.myshopify.com`;
  return `https://${host}`;
}

function norm(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function compactKey(value) {
  return norm(value).replace(/[^a-z0-9]+/g, "");
}

function remainderAfterTitle(lineName, productTitle) {
  const line = norm(lineName);
  const title = norm(productTitle);
  if (!title || !line.startsWith(title)) return null;
  const rest = line.slice(title.length).trim();
  if (!rest) return "";
  if (rest.startsWith("- ")) return rest.slice(2).trim();
  if (rest.startsWith("| ")) return rest.slice(2).trim();
  return null;
}

function variantValues(variant) {
  return ["title", "option1", "option2", "option3"]
    .map((key) => variant?.[key])
    .filter((value) => value != null && String(value) !== "")
    .map(String);
}

function optionFits(variant, remainder) {
  const rem = compactKey(remainder);
  if (!rem) return false;
  return variantValues(variant).some((value) => {
    const token = compactKey(value);
    return token && (rem === token || rem.startsWith(token) || token.startsWith(rem));
  });
}

function variantFromUrl(url) {
  const match = String(url || "").match(/[?&]variant=(\d+)/);
  return match ? match[1] : "";
}

function pickVariant(product, sku, remainder, hintedId) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  if (hintedId) {
    const hinted = variants.find((variant) => String(variant.id) === String(hintedId));
    if (hinted && (!sku || String(hinted.sku || "") === sku)) return hinted;
  }
  if (sku) {
    const bySku = variants.filter((variant) => String(variant.sku || "") === sku);
    if (bySku.length === 1) return bySku[0];
    if (bySku.length > 1) {
      const narrowed = bySku.filter((variant) => optionFits(variant, remainder));
      if (narrowed.length === 1) return narrowed[0];
    }
  }
  const byOption = variants.filter((variant) => optionFits(variant, remainder));
  return byOption.length === 1 ? byOption[0] : null;
}

function matchProduct(lineName, sku, product, hintedId) {
  if (!product?.title || product.id == null) return null;
  const remainder = remainderAfterTitle(lineName, product.title);
  if (remainder == null) return null;
  const variant = pickVariant(product, sku, remainder, hintedId);
  if (!variant?.id) return null;
  if (sku && String(variant.sku || "") !== sku) {
    const skuStillThere = (product.variants || []).some((item) => String(item.sku || "") === sku);
    if (skuStillThere || !optionFits(variant, remainder)) return null;
  }
  return {
    found: true,
    name: lineName,
    sku,
    product_id: String(product.id),
    variant_id: String(variant.id),
    title: String(product.title),
    variant_title: String(variant.title || ""),
  };
}

async function httpJson(url) {
  let wait = 400;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
      redirect: "follow",
    });
    if (response.status === 429) {
      await new Promise((resolve) => setTimeout(resolve, wait));
      wait *= 2;
      continue;
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      await new Promise((resolve) => setTimeout(resolve, wait));
      continue;
    }
    return response.json();
  }
  return null;
}

async function searchProducts(store, query) {
  const trimmed = String(query || "").trim();
  if (!trimmed) return [];
  const url = `${store}/search/suggest.json?q=${encodeURIComponent(trimmed)}&resources[type]=product&resources[limit]=10`;
  const json = await httpJson(url);
  const products = json?.resources?.results?.products;
  return Array.isArray(products) ? products : [];
}

async function loadProduct(store, handle) {
  const trimmed = String(handle || "").trim();
  if (!trimmed) return null;
  const product = await httpJson(`${store}/products/${encodeURIComponent(trimmed)}.js`);
  return product?.id ? product : null;
}

async function tryHits(lineName, sku, hits, store, seen) {
  const candidates = [];
  for (const hit of hits) {
    const handle = String(hit?.handle || "");
    if (!handle || seen.has(handle)) continue;
    if (remainderAfterTitle(lineName, hit?.title || "") == null) continue;
    seen.add(handle);
    candidates.push(hit);
  }
  candidates.sort((a, b) => norm(b.title || "").length - norm(a.title || "").length);
  for (const hit of candidates) {
    const matched = matchProduct(
      lineName,
      sku,
      await loadProduct(store, hit.handle),
      variantFromUrl(hit.url)
    );
    if (matched) return matched;
  }
  return null;
}

async function lookupShopifyVariant({ name, sku = "", store = DEFAULT_STORE } = {}) {
  const lineName = String(name || "").trim();
  const variantSku = String(sku || "").trim();
  if (!lineName) {
    return { found: false, name: "", sku: variantSku, product_id: "", variant_id: "" };
  }
  const seen = new Set();
  if (variantSku) {
    const matched = await tryHits(lineName, variantSku, await searchProducts(store, variantSku), store, seen);
    if (matched) return matched;
  }
  let shortened = lineName;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const matched = await tryHits(lineName, variantSku, await searchProducts(store, shortened), store, seen);
    if (matched) return matched;
    const cut = shortened.lastIndexOf(" - ");
    if (cut <= 0) break;
    shortened = shortened.slice(0, cut).trim();
  }
  return { found: false, name: lineName, sku: variantSku, product_id: "", variant_id: "" };
}

module.exports = {
  lookupShopifyVariant,
  matchProduct,
  remainderAfterTitle,
  storefrontBaseFromUrl,
};
