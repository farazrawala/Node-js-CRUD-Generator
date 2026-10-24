const crypto = require("crypto");
const Integration = require("../models/integration");
const User = require("../models/user");
const { coalesceObjectId } = require("../utils/modelHelper");
const { createFetchOrderStats } = require("../utils/processHelpers");
const {
  buildShopifyClient,
  importShopifyOrderToPos,
} = require("./shopifyProcess");

const ORDER_TOPICS = new Set([
  "orders/create",
  "orders/updated",
  "orders/edited",
  "orders/paid",
  "orders/fulfilled",
  "orders/partially_fulfilled",
]);

function headerValue(req, name) {
  const key = String(name || "").toLowerCase();
  for (const [k, v] of Object.entries(req.headers || {})) {
    if (String(k).toLowerCase() === key) {
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return "";
}

function normalizeShopDomain(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .replace(/\/.*/, "");
}

function timingSafeEqualBase64(a, b) {
  try {
    const bufA = Buffer.from(String(a || ""), "utf8");
    const bufB = Buffer.from(String(b || ""), "utf8");
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch (_) {
    return false;
  }
}

function verifyShopifyHmac(req, secret) {
  const hmac = headerValue(req, "x-shopify-hmac-sha256");
  const secretKey = String(secret || "").trim();
  if (!hmac || !secretKey) {
    return { ok: false, reason: "missing_hmac_or_secret" };
  }

  const raw =
    Buffer.isBuffer(req.rawBody) ? req.rawBody
    : typeof req.rawBody === "string" ? Buffer.from(req.rawBody, "utf8")
    : null;

  if (!raw || !raw.length) {
    // Fallback: re-serialize parsed JSON (less reliable than raw bytes).
    if (!req.body || typeof req.body !== "object") {
      return { ok: false, reason: "missing_raw_body" };
    }
    const digest = crypto
      .createHmac("sha256", secretKey)
      .update(Buffer.from(JSON.stringify(req.body), "utf8"))
      .digest("base64");
    return {
      ok: timingSafeEqualBase64(digest, hmac),
      reason: timingSafeEqualBase64(digest, hmac) ? "" : "hmac_mismatch",
      mode: "json_stringify",
    };
  }

  const digest = crypto
    .createHmac("sha256", secretKey)
    .update(raw)
    .digest("base64");
  return {
    ok: timingSafeEqualBase64(digest, hmac),
    reason: timingSafeEqualBase64(digest, hmac) ? "" : "hmac_mismatch",
    mode: "raw",
  };
}

async function findShopifyIntegration(req) {
  const paramId = coalesceObjectId(req.params?.integrationId || req.params?.id);
  if (paramId) {
    const byId = await Integration.findOne({
      _id: paramId,
      store_type: "shopify",
      status: "active",
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    }).lean();
    if (byId) return byId;
  }

  const shopDomain = normalizeShopDomain(
    headerValue(req, "x-shopify-shop-domain") ||
      req.query?.shop ||
      req.body?.shop_domain,
  );
  if (!shopDomain) return null;

  const candidates = await Integration.find({
    store_type: "shopify",
    status: "active",
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  })
    .select("+secret")
    .lean();

  return (
    candidates.find((row) => {
      const urlDomain = normalizeShopDomain(row.url);
      return (
        urlDomain === shopDomain ||
        urlDomain.endsWith(`.${shopDomain}`) ||
        shopDomain.endsWith(urlDomain) ||
        String(row.url || "").toLowerCase().includes(shopDomain)
      );
    }) || null
  );
}

async function resolveWebhookActor(integration) {
  const createdBy = coalesceObjectId(integration?.created_by);
  if (createdBy) return createdBy;

  const companyId = coalesceObjectId(integration?.company_id);
  if (!companyId) return null;

  const admin = await User.findOne({
    company_id: companyId,
    deletedAt: null,
    status: { $ne: "inactive" },
    role: { $in: ["ADMIN", "USER"] },
  })
    .sort({ updatedAt: -1 })
    .select("_id")
    .lean();
  return coalesceObjectId(admin?._id);
}

function extractOrderPayload(body) {
  if (!body || typeof body !== "object") return null;
  // Direct Shopify webhook body
  if (body.id && (body.line_items || body.order_number != null)) {
    return body;
  }
  // Wrapper used by pos_webhook/webhook.php sample dump
  if (body.json && typeof body.json === "object" && body.json.id) {
    return body.json;
  }
  if (body.order && typeof body.order === "object" && body.order.id) {
    return body.order;
  }
  return null;
}

/**
 * POST /api/shopify/webhook/orders
 * POST /api/shopify/webhook/orders/:integrationId
 *
 * Receives Shopify orders/* webhooks and imports/updates the POS order
 * via importShopifyOrderToPos (same path as fetch_order).
 */
async function shopifyOrdersWebhook(req, res) {
  try {
    const topic = String(headerValue(req, "x-shopify-topic") || "").trim();
    if (topic && !ORDER_TOPICS.has(topic)) {
      return res.status(200).json({
        success: true,
        status: 200,
        message: `Ignored Shopify topic ${topic}`,
        data: null,
      });
    }

    const integration = await findShopifyIntegration(req);
    if (!integration) {
      return res.status(404).json({
        success: false,
        status: 404,
        message:
          "No active Shopify integration found for this shop domain / integration id",
      });
    }

    const hmac = verifyShopifyHmac(req, integration.secret);
    if (!hmac.ok) {
      console.warn(
        "[shopify webhook] HMAC failed:",
        hmac.reason,
        "shop:",
        headerValue(req, "x-shopify-shop-domain"),
      );
      return res.status(401).json({
        success: false,
        status: 401,
        message: "Invalid Shopify webhook signature",
        reason: hmac.reason,
      });
    }

    const remoteOrder = extractOrderPayload(req.body);
    if (!remoteOrder?.id) {
      return res.status(400).json({
        success: false,
        status: 400,
        message: "Shopify order payload is required",
      });
    }

    const companyId = coalesceObjectId(integration.company_id);
    if (!companyId) {
      return res.status(400).json({
        success: false,
        status: 400,
        message: "Integration is missing company_id",
      });
    }

    const actorId = await resolveWebhookActor(integration);
    const process = {
      _id: null,
      company_id: companyId,
      integration_id: integration._id,
      created_by: actorId,
      type: "shopify_webhook",
    };

    // Default: import from the webhook payload only (SKU / sync_product mapping).
    // Pass ?enrich=1 to also call Shopify Admin API for missing products / notes.
    const wantEnrich =
      req.query?.enrich === "1" ||
      req.query?.enrich === "true" ||
      String(req.headers["x-pos-shopify-enrich"] || "").trim() === "1";

    let client = null;
    let graphql = null;
    if (wantEnrich) {
      try {
        const built = buildShopifyClient(integration, { requireToken: true });
        if (!built.error) {
          client = built.client;
          graphql = built.graphql;
        } else {
          console.warn("[shopify webhook] enrich skipped:", built.error);
        }
      } catch (err) {
        console.warn(
          "[shopify webhook] client init skipped:",
          err?.message || err,
        );
      }
    }

    const stats = {
      ...createFetchOrderStats(),
      updated: 0,
    };

    await importShopifyOrderToPos(remoteOrder, {
      companyId,
      process,
      stats,
      req,
      client,
      graphql,
      integration,
      // Webhook payload import: match existing POS products only unless enrich=1.
      allowRemoteProductCreate: wantEnrich && !!client,
    });

    const skipped = stats.skipped_orders?.[0] || null;
    const outcome =
      stats.inserted > 0 ? "created"
      : stats.updated > 0 ? "updated"
      : skipped?.reason === "already_imported" ? "duplicate"
      : skipped ? "skipped"
      : "processed";

    return res.status(200).json({
      success: true,
      status: 200,
      message: `Shopify order webhook ${outcome}`,
      data: {
        outcome,
        topic: topic || null,
        shop: headerValue(req, "x-shopify-shop-domain") || null,
        shopify_order_id: remoteOrder.id,
        shopify_order_number: remoteOrder.order_number ?? null,
        integration_id: String(integration._id),
        company_id: String(companyId),
        inserted: stats.inserted,
        updated: stats.updated || 0,
        lines_inserted: stats.lines_inserted,
        lines_skipped: stats.lines_skipped,
        skipped,
      },
    });
  } catch (error) {
    console.error("❌ shopifyOrdersWebhook:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      message: error.message || "Failed to process Shopify order webhook",
    });
  }
}

module.exports = {
  shopifyOrdersWebhook,
  verifyShopifyHmac,
  normalizeShopDomain,
  extractOrderPayload,
};
