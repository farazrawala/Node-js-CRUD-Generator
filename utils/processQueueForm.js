/**
 * Normalize JSON, urlencoded, or multipart FormData bodies for process queue creation.
 *
 * Frontend example:
 * ```js
 * const form = new FormData();
 * form.append("integration_id", "6789...");
 * form.append("action", "fetch_category");
 * form.append("status", "active");
 * form.append("priority", "50");
 * form.append("limit", "5");
 * await fetch("/pos_admin/api/process/queue-create", {
 *   method: "POST",
 *   headers: { Authorization: `Bearer ${token}` },
 *   body: form,
 * });
 * ```
 */

const PROCESS_QUEUE_FORM_FIELDS = {
  integration_id: { type: "string", required: "fetch/sync actions" },
  action: {
    type: "string",
    required: true,
    enum: [
      "fetch_products",
      "fetch_product",
      "sync_product",
      "delete_product",
      "fetch_category",
      "sync_category",
      "delete_category",
      "fetch_brand",
      "sync_brand",
      "delete_brand",
      "fetch_order",
      "fetch_latest_order",
    ],
  },
  status: { type: "string", default: "active" },
  progress: { type: "string", default: "not_started" },
  priority: { type: "number", default: 100 },
  limit: { type: "number", default: 1 },
  page: { type: "number", default: 1 },
  offset: { type: "number", default: 0 },
  count: { type: "number", default: 0 },
  hits: { type: "number", default: 0 },
  remarks: { type: "string", default: "" },
  company_id: { type: "string", required: "if not in auth token" },
  category_id: { type: "string", note: "single sync_category job" },
  brand_id: { type: "string", note: "single sync_brand job" },
  product_id: { type: "string", note: "single sync_product job" },
  category_ids: {
    type: "string|string[]",
    note: "comma-separated, JSON array, or repeat field",
  },
  brand_ids: { type: "string|string[]" },
  product_ids: { type: "string|string[]" },
  items: { type: "json string", note: "advanced bulk rows" },
};

function trimString(value) {
  if (value == null) return undefined;
  const s = String(value).trim();
  return s === "" ? undefined : s;
}

function parseJsonValue(value) {
  if (value == null) return undefined;
  if (typeof value === "object") return value;
  const raw = String(value).trim();
  if (!raw) return undefined;
  if (raw.startsWith("{") || raw.startsWith("[")) {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function parseIdList(value) {
  if (value == null || value === "") return [];

  if (Array.isArray(value)) {
    return value.map((v) => trimString(v)).filter(Boolean);
  }

  const parsed = parseJsonValue(value);
  if (Array.isArray(parsed)) {
    return parsed.map((v) => trimString(v)).filter(Boolean);
  }

  const raw = String(value).trim();
  if (!raw) return [];

  return raw
    .split(/[,;\n\r]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function pickBodyField(body, ...keys) {
  if (!body || typeof body !== "object") return undefined;
  for (const key of keys) {
    if (body[key] != null && body[key] !== "") return body[key];
  }
  return undefined;
}

function normalizeProcessQueueBody(rawBody = {}) {
  const body =
    rawBody && typeof rawBody === "object" ? { ...rawBody } : {};

  const itemsParsed = parseJsonValue(body.items);
  if (Array.isArray(itemsParsed)) {
    body.items = itemsParsed;
  }

  body.category_ids = parseIdList(
    pickBodyField(body, "category_ids", "category_ids[]", "categoryIds"),
  );
  body.brand_ids = parseIdList(
    pickBodyField(body, "brand_ids", "brand_ids[]", "brandIds"),
  );
  body.product_ids = parseIdList(
    pickBodyField(body, "product_ids", "product_ids[]", "productIds"),
  );

  const scalarFields = [
    "integration_id",
    "action",
    "status",
    "progress",
    "remarks",
    "company_id",
    "category_id",
    "brand_id",
    "product_id",
  ];

  for (const field of scalarFields) {
    const value = trimString(body[field]);
    if (value !== undefined) body[field] = value;
    else delete body[field];
  }

  const numberFields = [
    "priority",
    "limit",
    "page",
    "offset",
    "count",
    "hits",
  ];
  for (const field of numberFields) {
    if (body[field] == null || body[field] === "") continue;
    const num = Number(body[field]);
    if (Number.isFinite(num)) body[field] = num;
  }

  if (!body.status) body.status = "active";
  if (!body.progress) body.progress = "not_started";

  return body;
}

function buildProcessSourceRows(body) {
  const normalized = normalizeProcessQueueBody(body);

  if (Array.isArray(normalized.items) && normalized.items.length) {
    return normalized.items;
  }

  const template = {
    integration_id: normalized.integration_id,
    product_id: normalized.product_id,
    status: normalized.status,
    progress: normalized.progress,
    priority: normalized.priority,
    limit: normalized.limit,
    page: normalized.page,
    offset: normalized.offset,
    count: normalized.count,
    hits: normalized.hits,
    remarks: normalized.remarks,
  };

  if (normalized.category_ids.length) {
    const action = String(normalized.action || "sync_category").trim();
    return normalized.category_ids.map((categoryId) => ({
      ...template,
      action,
      category_id: categoryId,
    }));
  }

  if (normalized.brand_ids.length) {
    const action = String(normalized.action || "sync_brand").trim();
    return normalized.brand_ids.map((brandId) => ({
      ...template,
      action,
      brand_id: brandId,
    }));
  }

  if (normalized.product_ids.length) {
    const action = String(normalized.action || "sync_product").trim();
    return normalized.product_ids.map((productId) => ({
      ...template,
      action,
      product_id: productId,
    }));
  }

  if (normalized.action) {
    return [
      {
        ...template,
        action: normalized.action,
        category_id: normalized.category_id,
        brand_id: normalized.brand_id,
        product_id: normalized.product_id,
      },
    ];
  }

  return [];
}

module.exports = {
  PROCESS_QUEUE_FORM_FIELDS,
  normalizeProcessQueueBody,
  buildProcessSourceRows,
  parseIdList,
};
