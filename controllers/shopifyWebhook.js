const crypto = require("crypto");
const Integration = require("../models/integration");
const User = require("../models/user");
const { coalesceObjectId } = require("../utils/modelHelper");
const { createApplicationLog } = require("../utils/applicationLogs");
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

const WEBHOOK_LOG_TAGS = ["webhook", "shopify"];

function webhookConsole(level, message, extra) {
  const prefix = "[webhook]";
  const payload = extra != null ? extra : "";
  if (level === "error") console.error(prefix, message, payload);
  else if (level === "warn") console.warn(prefix, message, payload);
  else console.log(prefix, message, payload);
}

/**
 * Persist a POS `logs` row tagged `webhook` (filterable via ?tag=webhook).
 * Skips silently when company_id is missing (early reject before integration resolve).
 */
function logWebhookEvent(req, {
  action,
  description,
  company_id,
  created_by,
  reference_id,
  extraTags = [],
}) {
  const companyId = coalesceObjectId(company_id);
  if (!companyId) return;
  void createApplicationLog(
    req,
    {
      action: String(action || "Shopify webhook").trim(),
      url: req?.originalUrl || req?.url || "/api/shopify/webhook/orders",
      tags: [...WEBHOOK_LOG_TAGS, ...extraTags],
      description,
      company_id: companyId,
      created_by: coalesceObjectId(created_by) || undefined,
      reference_type: reference_id ? "order" : "shopify_webhook",
      reference_id: reference_id || undefined,
    },
    { silent: true },
  );
}

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

function verifyShopifyHmacWithSecret(req, secret) {
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

/**
 * Shopify Admin → Notifications webhooks sign with the shop "Signing secret".
 * Custom app webhooks sign with the app Client Secret (`integration.secret`).
 * Prefer `webhook_secret` when set so API credentials stay untouched.
 */
function verifyShopifyHmac(req, integrationOrSecret) {
  const secrets = [];
  if (integrationOrSecret && typeof integrationOrSecret === "object") {
    const webhookSecret = String(integrationOrSecret.webhook_secret || "").trim();
    const clientSecret = String(integrationOrSecret.secret || "").trim();
    if (webhookSecret) secrets.push({ source: "webhook_secret", value: webhookSecret });
    if (clientSecret && clientSecret !== webhookSecret) {
      secrets.push({ source: "secret", value: clientSecret });
    } else if (clientSecret && !webhookSecret) {
      secrets.push({ source: "secret", value: clientSecret });
    }
  } else if (integrationOrSecret) {
    secrets.push({ source: "secret", value: String(integrationOrSecret).trim() });
  }

  if (!headerValue(req, "x-shopify-hmac-sha256")) {
    return { ok: false, reason: "missing_hmac_or_secret" };
  }
  if (!secrets.length) {
    return { ok: false, reason: "missing_hmac_or_secret" };
  }

  let last = { ok: false, reason: "hmac_mismatch" };
  for (const entry of secrets) {
    const result = verifyShopifyHmacWithSecret(req, entry.value);
    last = { ...result, source: entry.source };
    if (result.ok) return last;
  }
  return last;
}

function integrationMatchesShop(row, shopDomain) {
  if (!shopDomain) return false;
  const urlDomain = normalizeShopDomain(row?.url);
  return (
    urlDomain === shopDomain ||
    urlDomain.endsWith(`.${shopDomain}`) ||
    shopDomain.endsWith(urlDomain) ||
    String(row?.url || "").toLowerCase().includes(shopDomain)
  );
}

/**
 * Return active Shopify integrations that could own this webhook.
 * Prefer explicit :integrationId, else all rows matching shop domain
 * (newest first — multiple POS companies can share one Shopify store URL).
 */
async function findShopifyIntegrations(req) {
  const paramId = coalesceObjectId(req.params?.integrationId || req.params?.id);
  if (paramId) {
    const byId = await Integration.findOne({
      _id: paramId,
      store_type: "shopify",
      status: "active",
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    }).lean();
    if (byId) return [byId];
  }

  const shopDomain = normalizeShopDomain(
    headerValue(req, "x-shopify-shop-domain") ||
      req.query?.shop ||
      req.body?.shop_domain,
  );
  if (!shopDomain) return [];

  const candidates = await Integration.find({
    store_type: "shopify",
    status: "active",
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  })
    .sort({ updatedAt: -1, createdAt: -1 })
    .lean();

  return candidates.filter((row) => integrationMatchesShop(row, shopDomain));
}

/**
 * Pick the integration whose webhook_secret / client secret verifies HMAC.
 */
function resolveIntegrationByHmac(req, candidates) {
  if (!Array.isArray(candidates) || !candidates.length) {
    return { integration: null, hmac: { ok: false, reason: "missing_integration" } };
  }

  let lastHmac = { ok: false, reason: "hmac_mismatch" };
  for (const row of candidates) {
    const hmac = verifyShopifyHmac(req, row);
    lastHmac = hmac;
    if (hmac.ok) {
      return { integration: row, hmac };
    }
  }
  return { integration: candidates[0], hmac: lastHmac };
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
  const shopHeader = headerValue(req, "x-shopify-shop-domain");
  const topic = String(headerValue(req, "x-shopify-topic") || "").trim();
  const paramIntegrationId = String(
    req.params?.integrationId || req.params?.id || "",
  ).trim();

  webhookConsole("log", "received", {
    topic: topic || null,
    shop: shopHeader || null,
    integrationId: paramIntegrationId || null,
    hasHmac: Boolean(headerValue(req, "x-shopify-hmac-sha256")),
    hasRawBody: Boolean(req.rawBody && req.rawBody.length),
  });

  try {
    if (topic && !ORDER_TOPICS.has(topic)) {
      webhookConsole("warn", "ignored topic", { topic, shop: shopHeader });
      return res.status(200).json({
        success: true,
        status: 200,
        message: `Ignored Shopify topic ${topic}`,
        data: null,
      });
    }

    const candidates = await findShopifyIntegrations(req);
    if (!candidates.length) {
      webhookConsole("warn", "integration not found", {
        topic,
        shop: shopHeader,
        integrationId: paramIntegrationId || null,
      });
      return res.status(404).json({
        success: false,
        status: 404,
        message:
          "No active Shopify integration found for this shop domain / integration id",
      });
    }

    const { integration, hmac } = resolveIntegrationByHmac(req, candidates);
    const companyId = coalesceObjectId(integration?.company_id);
    if (!hmac.ok || !integration) {
      webhookConsole("warn", "HMAC failed", {
        reason: hmac.reason,
        mode: hmac.mode || null,
        source: hmac.source || null,
        shop: shopHeader,
        tried: candidates.map((c) => String(c._id)),
        integration_id: integration ? String(integration._id) : null,
        has_webhook_secret: Boolean(
          String(integration?.webhook_secret || "").trim(),
        ),
      });
      logWebhookEvent(req, {
        action: "Shopify webhook HMAC failed",
        company_id: companyId,
        created_by: integration?.created_by,
        extraTags: ["hmac_failed"],
        description: {
          topic: topic || null,
          shop: shopHeader || null,
          integration_id: integration ? String(integration._id) : null,
          tried_integration_ids: candidates.map((c) => String(c._id)),
          reason: hmac.reason,
          mode: hmac.mode || null,
          hint:
            "Paste Shopify Admin → Notifications → Webhooks → Signing secret into this integration's webhook_secret field (do not overwrite Client Secret). Or set webhook URL to /shopify/webhook/orders/<integrationId>.",
        },
      });
      return res.status(401).json({
        success: false,
        status: 401,
        message: "Invalid Shopify webhook signature",
        reason: hmac.reason,
      });
    }

    webhookConsole("log", "HMAC ok", {
      integration_id: String(integration._id),
      company_id: String(companyId || ""),
      source: hmac.source || null,
      candidates: candidates.length,
    });

    const remoteOrder = extractOrderPayload(req.body);
    if (!remoteOrder?.id) {
      webhookConsole("warn", "missing order payload", {
        shop: shopHeader,
        integration_id: String(integration._id),
        bodyKeys: req.body && typeof req.body === "object" ? Object.keys(req.body).slice(0, 20) : [],
      });
      logWebhookEvent(req, {
        action: "Shopify webhook missing order payload",
        company_id: companyId,
        created_by: integration.created_by,
        extraTags: ["bad_payload"],
        description: {
          topic: topic || null,
          shop: shopHeader || null,
          integration_id: String(integration._id),
        },
      });
      return res.status(400).json({
        success: false,
        status: 400,
        message: "Shopify order payload is required",
      });
    }

    if (!companyId) {
      webhookConsole("warn", "integration missing company_id", {
        integration_id: String(integration._id),
      });
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
          webhookConsole("warn", "enrich skipped", built.error);
        }
      } catch (err) {
        webhookConsole("warn", "client init skipped", err?.message || err);
      }
    }

    webhookConsole("log", "importing order", {
      shopify_order_id: remoteOrder.id,
      order_number: remoteOrder.order_number ?? null,
      integration_id: String(integration._id),
      company_id: String(companyId),
      enrich: wantEnrich && !!client,
      line_items: Array.isArray(remoteOrder.line_items)
        ? remoteOrder.line_items.length
        : 0,
    });

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

    const resultData = {
      outcome,
      topic: topic || null,
      shop: shopHeader || null,
      shopify_order_id: remoteOrder.id,
      shopify_order_number: remoteOrder.order_number ?? null,
      integration_id: String(integration._id),
      company_id: String(companyId),
      inserted: stats.inserted,
      updated: stats.updated || 0,
      lines_inserted: stats.lines_inserted,
      lines_skipped: stats.lines_skipped,
      skipped,
    };

    webhookConsole("log", `outcome ${outcome}`, resultData);
    logWebhookEvent(req, {
      action: `Shopify webhook ${outcome} :: #${remoteOrder.order_number ?? remoteOrder.id}`,
      company_id: companyId,
      created_by: actorId || integration.created_by,
      extraTags: [outcome],
      description: resultData,
    });

    return res.status(200).json({
      success: true,
      status: 200,
      message: `Shopify order webhook ${outcome}`,
      data: resultData,
    });
  } catch (error) {
    webhookConsole("error", "failed", {
      message: error?.message || String(error),
      shop: shopHeader || null,
      topic: topic || null,
    });
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
