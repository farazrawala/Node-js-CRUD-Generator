// --- Shopify credentials ---
const SHOPIFY_API_KEY = "db6d898fa3ccf29f527347eb5a1ac587";
const SHOPIFY_SECRET = "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";
const SHOPIFY_ADMIN_TOKEN = "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";

// --- Your store URL ---
const SHOP_NAME = "nodejs-2.myshopify.com";

// --- API version (you can update this when needed) ---
const API_VERSION = "2024-10";

async function getFetch() {
  const module = await import("node-fetch");
  return module.default;
}

async function testShopifyAuth() {
  const fetch = await getFetch();
  const url = `https://${SHOP_NAME}/admin/api/${API_VERSION}/shop.json`;

  console.log("🔍 Testing Shopify credentials...");
  console.log("URL:", url);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
      },
    });

    const data = await response.text();

    if (response.ok) {
      console.log("✅ Shopify credentials are valid!");
      console.log("Shop Info:");
      console.log(JSON.parse(data));
    } else {
      console.error(`❌ Authentication failed (HTTP ${response.status})`);
      console.error("Response:", data);
    }
  } catch (error) {
    console.error("⚠️ Error connecting to Shopify:", error);
  }
}

testShopifyAuth().catch((error) => {
  console.error("⚠️ Unexpected error:", error);
});

