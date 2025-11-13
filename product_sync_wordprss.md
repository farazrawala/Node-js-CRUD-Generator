## Product Sync To WordPress

This document describes the WooCommerce and Shopify product synchronisation handled by `controllers/process.js`. The process takes a queued sync job, validates the integration credentials, checks whether the product already exists on the target store, and creates it when required.

### Prerequisites
- A `process` record with `action` set to `sync_product` and populated `integration_id` and `product_id`.
- WooCommerce API credentials stored on the integration record (`url`, `key`/`secret` or their legacy aliases).
- The product record should contain at minimum `product_name`, `product_price`, and either `sku` or `product_code`.

### WooCommerce Sync Flow
1. `GET /process/execute-process` fetches the next active process and routes WooCommerce jobs to `sync_product_woocommerce`.
2. The helper instantiates `WooCommerceRestApi` using the integration credentials.
3. The product SKU (or code) is used to query WooCommerce:
   - If the product already exists, the job is marked as `completed` with a remark noting the skip.
   - If the product is missing, a new product is created with the mapped fields (`name`, `type`, `regular_price`, `sku`, descriptions, weight).
4. Failures update the process record with `status: failed` and an error remark so the job manager can retry or inspect.

### Shopify Sync Flow
1. The same entry route delegates Shopify jobs to `sync_product_shopify`.
2. A Shopify Admin REST client is created via `@shopify/shopify-api` using the integration's URL, key, secret, and access token.
3. Variants are queried by SKU to decide whether the product already exists:
   - Existing products mark the process as `completed` and skip creation.
   - Missing products are created with a single variant payload (price, SKU, optional weight) and activated.
4. Errors mark the process as `failed` alongside a descriptive remark.

### Field Mapping
- `product_name` → WooCommerce `name`
- `product_price` → `regular_price`
- `product_description` → `description` and `short_description`
- `weight` → `weight` (if present)
- `sku`/`product_code`/`_id` → `sku`

### Response
- **200**: Product already exists on the target store.
- **201**: Product created on the target store.
- **400/500**: Validation or API errors include diagnostic details in the `error` payload.

### Extending
- Add additional mappings (categories, inventory, images) by enriching `productPayload` within `sync_product_woocommerce`.
- Update process retry logic or notifications by extending the status updates on `ProcessModel`.

