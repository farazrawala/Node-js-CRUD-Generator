## Product Sync To Shopify

This document explains how a queued `process` job synchronises products with a Shopify store using `controllers/process.js`.

### Prerequisites
- A `process` model entry with `action: "sync_product"` and populated `integration_id` (Shopify store credentials) and `product_id` (local product document).
- Shopify integration record containing:
  - `url` (shop's `.myshopify.com` domain or shop name)
  - `key` / `secret` (app credentials) or compatible aliases
  - `token` (Admin API access token with `write_products`)
- Product record must include `product_name`, `product_price`, and one of `sku`, `product_code`, or `_id`.

### Sync Flow (`sync_product_shopify`)
1. Endpoint `GET /process/execute-process` fetches the next active process and routes Shopify jobs here.
2. The helper normalises the shop domain, validates credentials, and instantiates the Shopify Admin REST client.
3. Variants are retrieved by SKU:
   - If a variant/product exists, the process status becomes `completed` with a remark noting the skip.
   - If missing, a new product payload is built (title, description, variant with price/SKU/weight) and created.
4. Success responses include the Shopify product payload; failures update the process as `failed` with detailed remarks.

### Field Mapping
- `product_name` → Shopify `title`
- `product_description` → `body_html`
- `product_price` → variant `price`
- `sku`/`product_code`/`_id` → variant `sku`
- `weight` (if numeric) → variant `weight` (grams)

### Responses
- **200**: Product already exists in Shopify.
- **201**: Product created in Shopify.
- **400/500**: Validation errors or Shopify API failures include diagnostic data in the response.

### Extending
- Add more variant attributes (inventory, barcode, options) before creation.
- Map categories/collections by augmenting the payload with `product_type`, tags, or metafields.
- Handle images by uploading to Shopify's `images` endpoint prior to product creation.

