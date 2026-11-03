/**
 * Shopify integration HTTP API.
 * Mounted at /api/shopify.
 * @module src/shopify/routes
 */

const express = require("express");
const { API_VERSION } = require("./constants");
const { verifyOauthHmac } = require("./oauthHmac");
const { frontendUrl } = require("./client");
const { companyIdFromRequest } = require("./tenancy");
const {
  listConnections,
  beginConnect,
  completeCallback,
  disconnect,
  updateSettings,
  loadActiveConnection,
  getConnection,
  presentRecord,
} = require("./connectionService");
const { ShopifyConnection, ShopifySyncLog, ShopifyLocation } = require("./models");
const { registerWebhooks, receiveWebhook } = require("./webhooks");
const { enqueue } = require("./queue");
const { analytics } = require("./analytics");
const {
  createFulfillment,
  cancelFulfillment,
} = require("./syncFulfillment");
const { importLocations, mapLocationWarehouse } = require("./syncInventory");
const { pushPosProduct } = require("./syncProducts");

const router = express.Router();

function sendError(res, error) {
  const status = error.status || 500;
  if (status >= 500) console.error("[shopify]", error);
  res.status(status).json({
    success: false,
    message: error.message || "Shopify request failed.",
  });
}

function redirectResult(res, params) {
  const target = new URL(`${frontendUrl()}/settings/integrations/shopify`);
  Object.entries(params).forEach(([key, value]) => {
    if (value) target.searchParams.set(key, String(value).slice(0, 300));
  });
  return res.redirect(target.toString());
}

router.get("/health", (_req, res) => {
  let redis = "not_configured";
  const enabled = String(process.env.REDIS_ENABLED ?? "true").toLowerCase();
  if (process.env.REDIS_URL && enabled !== "false" && enabled !== "0") {
    redis = "configured";
  }
  res.status(200).json({
    success: true,
    service: "shopify",
    apiVersion: API_VERSION,
    worker: String(process.env.SHOPIFY_WORKER_ENABLED || "true"),
    redis,
  });
});

router.get("/oauth/callback", async (req, res) => {
  try {
    if (!verifyOauthHmac(req.query, process.env.SHOPIFY_API_SECRET)) {
      return redirectResult(res, {
        shopify: "error",
        message: "Shopify authorization could not be verified.",
      });
    }
    const connection = await completeCallback({
      shop: req.query.shop,
      code: req.query.code,
      state: req.query.state,
    });
    const fresh = await ShopifyConnection.findById(connection._id).select(
      "+access_token_enc +refresh_token_enc",
    );
    try {
      await registerWebhooks(fresh);
    } catch (error) {
      console.warn("[shopify] webhook registration:", error?.message || error);
    }
    await enqueue("reconcile", {
      connectionId: String(connection._id),
      companyId: String(connection.company_id),
    });
    return redirectResult(res, {
      shopify: "connected",
      shop: connection.shop_domain,
    });
  } catch (error) {
    return redirectResult(res, {
      shopify: "error",
      message: error.message,
    });
  }
});

router.post("/webhooks", async (req, res) => {
  try {
    const result = await receiveWebhook(req);
    res.status(200).json(result);
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/connections", async (req, res) => {
  try {
    const companyId = companyIdFromRequest(req);
    const connections = await listConnections(companyId);
    res.json({ success: true, connections });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/connect", async (req, res) => {
  try {
    const companyId = companyIdFromRequest(req);
    const result = await beginConnect({
      companyId,
      userId: req.user?._id,
      shopInput: req.body?.shop || req.body?.url,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/connections/:id/disconnect", async (req, res) => {
  try {
    const companyId = companyIdFromRequest(req);
    const connection = await disconnect(companyId, req.params.id);
    res.json({ success: true, connection });
  } catch (error) {
    sendError(res, error);
  }
});

router.patch("/connections/:id/settings", async (req, res) => {
  try {
    const companyId = companyIdFromRequest(req);
    const connection = await updateSettings(
      companyId,
      req.params.id,
      req.body || {},
    );
    res.json({ success: true, connection });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/connections/:id/sync", async (req, res) => {
  try {
    const companyId = companyIdFromRequest(req);
    const connection = await loadActiveConnection(companyId, req.params.id);
    const scope = String(req.body?.scope || "all");
    const data = {
      connectionId: String(connection._id),
      companyId: String(companyId),
      userId: req.user?._id ? String(req.user._id) : undefined,
    };
    const name =
      scope === "products" ? "import_products"
      : scope === "orders" ? "import_orders"
      : scope === "inventory" ? "sync_inventory"
      : scope === "fulfillments" ? "sync_fulfillments"
      : "reconcile";
    if (name === "reconcile") {
      data.products = scope === "all" || scope === "products";
      data.orders = scope === "all" || scope === "orders";
      data.inventory = scope === "all" || scope === "inventory";
      data.fulfillments = scope === "all" || scope === "fulfillments";
    }
    const queued = await enqueue(name, data);
    res.status(202).json({ success: true, ...queued, connection: presentRecord(connection) });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/connections/:id/products/:productId/push", async (req, res) => {
  try {
    const companyId = companyIdFromRequest(req);
    const connection = await loadActiveConnection(companyId, req.params.id);
    const result = await pushPosProduct(connection, req.params.productId);
    res.json({ success: true, result });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/connections/:id/logs", async (req, res) => {
  try {
    const companyId = companyIdFromRequest(req);
    const connection = await getConnection(companyId, req.params.id);
    const status = String(req.query.status || "");
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const filter = {
      company_id: companyId,
      shop_domain: connection.shop_domain,
    };
    if (["pending", "success", "failed"].includes(status)) filter.status = status;
    const [logs, total] = await Promise.all([
      ShopifySyncLog.find(filter)
        .sort({ created_at: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      ShopifySyncLog.countDocuments(filter),
    ]);
    res.json({
      success: true,
      logs: logs.map(presentRecord),
      page,
      limit,
      total,
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/connections/:id/analytics", async (req, res) => {
  try {
    const companyId = companyIdFromRequest(req);
    const connection = await loadActiveConnection(companyId, req.params.id);
    const report = await analytics(connection, {
      from: req.query.from,
      to: req.query.to,
    });
    res.json({ success: true, report });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/connections/:id/locations", async (req, res) => {
  try {
    const companyId = companyIdFromRequest(req);
    const connection = await getConnection(companyId, req.params.id);
    const locations = await ShopifyLocation.find({
      company_id: companyId,
      shop_domain: connection.shop_domain,
    }).lean();
    res.json({ success: true, locations });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/connections/:id/locations/sync", async (req, res) => {
  try {
    const companyId = companyIdFromRequest(req);
    const connection = await loadActiveConnection(companyId, req.params.id);
    const locations = await importLocations(connection);
    res.json({ success: true, locations: locations.map(presentRecord) });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/connections/:id/locations/:locationId/warehouse", async (req, res) => {
  try {
    const companyId = companyIdFromRequest(req);
    const connection = await getConnection(companyId, req.params.id);
    const location = await mapLocationWarehouse(
      connection,
      req.params.locationId,
      req.body?.warehouse_id,
    );
    res.json({ success: true, location: presentRecord(location) });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/connections/:id/fulfillments", async (req, res) => {
  try {
    const companyId = companyIdFromRequest(req);
    const connection = await loadActiveConnection(companyId, req.params.id);
    const fulfillment = await createFulfillment(connection, {
      orderShopifyId: req.body?.order_id || req.body?.shopify_order_id,
      trackingNumber: req.body?.tracking_number,
      trackingCompany: req.body?.tracking_company,
      trackingUrl: req.body?.tracking_url,
      lineItems: req.body?.line_items,
      notifyCustomer: req.body?.notify_customer,
    });
    res.json({ success: true, fulfillment: presentRecord(fulfillment) });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/connections/:id/fulfillments/:fulfillmentId/cancel", async (req, res) => {
  try {
    const companyId = companyIdFromRequest(req);
    const connection = await loadActiveConnection(companyId, req.params.id);
    const fulfillment = await cancelFulfillment(connection, req.params.fulfillmentId);
    res.json({ success: true, fulfillment });
  } catch (error) {
    sendError(res, error);
  }
});

module.exports = router;
