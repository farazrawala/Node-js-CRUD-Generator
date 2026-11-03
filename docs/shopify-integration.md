# Shopify integration

OrdersHub connects many Shopify stores to one app. Each store is tied to the signed-in company. Product, order, and stock records stay in the existing POS collections. The `shopify_*` collections store the Shopify ids, sync settings, and history.

Custom-app integrations (`integration.auth_mode = custom_app`) keep working. New installs use OAuth (`auth_mode = oauth`). OAuth tokens are encrypted with AES-256-GCM and are not returned by the API.

## API version

Default Admin API version: `2026-10` (`SHOPIFY_API_VERSION`).

Upgrade both of these together, then reinstall or re-register webhooks:

- `SHOPIFY_API_VERSION`
- `shopify_plugin/shopify.app.toml` `[webhooks].api_version`

The installed `@shopify/shopify-api` package is used for shop-domain checks, OAuth HMAC, sessions, and the GraphQL client.

## Scopes

Core: `read_products`, `write_products`, `read_inventory`, `write_inventory`, `read_locations`, `read_orders`, `write_orders`, `read_merchant_managed_fulfillment_orders`, `write_merchant_managed_fulfillment_orders`.

Optional, on by default because the module uses them:

- `read_third_party_fulfillment_orders`, `write_third_party_fulfillment_orders` (`SHOPIFY_SCOPE_THIRD_PARTY_FULFILLMENT`)
- `read_reports` for ShopifyQL sales reports (`SHOPIFY_SCOPE_READ_REPORTS`)

`read_all_orders` is off until Shopify approves it (`SHOPIFY_SCOPE_READ_ALL_ORDERS=true`). Without it, order import covers the last 60 days.

`read_analytics` is not requested. If ShopifyQL is unavailable, the analytics screen shows OrdersHub totals and says they were calculated here.

Keep `shopify.app.toml` `[access_scopes]` aligned with the flags above before `shopify app deploy`.

## Environment

Development and production use different Shopify apps (different `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET`).

| Variable | Purpose |
| --- | --- |
| `SHOPIFY_API_KEY` | App client id |
| `SHOPIFY_API_SECRET` | App secret. Webhook HMAC and OAuth only. Never stored per company. |
| `SHOPIFY_APP_URL` | Public API origin plus base path, no `/api`. Example: `https://host/pos_admin` |
| `SHOPIFY_OAUTH_CALLBACK_URL` | Exact redirect URL. Default `{SHOPIFY_APP_URL}/api/shopify/oauth/callback` |
| `SHOPIFY_WEBHOOK_URL` | Default `{SHOPIFY_APP_URL}/api/shopify/webhooks` |
| `ORDERS_HUB_APP_URL` | Frontend URL after OAuth. Falls back to `POS_FRONTEND_URL`. |
| `SHOPIFY_TOKEN_ENCRYPTION_KEY` | Required when `NODE_ENV=production` or `APP_ENV=live` |
| `SHOPIFY_API_VERSION` | Default `2026-10` |
| `SHOPIFY_WORKER_ENABLED` | Default `true`. Set `false` on the API if a separate worker process is used. |
| `REDIS_URL` | BullMQ. If Redis is disabled, jobs run in the API process. |

## HTTP API

All routes except health, the OAuth callback, and webhooks require the OrdersHub bearer token. Every query is filtered by that token's `company_id`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/shopify/health` | API version, worker flag, Redis configuration. No secrets. |
| POST | `/api/shopify/connect` | Body `{ "shop": "store.myshopify.com" }`. Returns `authorizeUrl`. |
| GET | `/api/shopify/oauth/callback` | Shopify redirect. Verifies HMAC and single-use state, stores the encrypted offline token, redirects to the frontend. |
| GET | `/api/shopify/connections` | Connected stores. Tokens are removed. |
| PATCH | `/api/shopify/connections/:id/settings` | Product sync, inventory direction, order import, fulfillment sync, interval minutes. |
| POST | `/api/shopify/connections/:id/sync` | Body `{ "scope": "all" \| "products" \| "orders" \| "inventory" \| "fulfillments" }`. Queues a job. |
| POST | `/api/shopify/connections/:id/disconnect` | Revokes the token and marks the integration inactive. |
| POST | `/api/shopify/connections/:id/products/:productId/push` | Creates or updates that POS product on Shopify. |
| GET | `/api/shopify/connections/:id/logs` | Sync history. Query `status`, `page`, `limit`. |
| GET | `/api/shopify/connections/:id/analytics` | ShopifyQL when `read_reports` is granted, plus OrdersHub totals. Query `from`, `to`. |
| GET | `/api/shopify/connections/:id/locations` | Mapped locations. |
| POST | `/api/shopify/connections/:id/locations/sync` | Pull locations and create a warehouse when one is not mapped. |
| POST | `/api/shopify/connections/:id/locations/:locationId/warehouse` | Body `{ "warehouse_id" }`. The warehouse must belong to the same company. |
| POST | `/api/shopify/connections/:id/fulfillments` | Create a fulfillment when Shopify allows `CREATE_FULFILLMENT`. Body: `order_id`, `tracking_number`, `tracking_company`, `tracking_url`, optional `line_items`. |
| POST | `/api/shopify/connections/:id/fulfillments/:fulfillmentId/cancel` | Cancel a fulfillment. |
| POST | `/api/shopify/webhooks` | App webhooks. HMAC is checked with `SHOPIFY_API_SECRET` before any write. |

## Sync behavior

- Products and variants are written to `product` and `sync_product`. `shopify_products` keeps the Shopify ids. Archived or deleted Shopify products are marked inactive in POS. They are not hard-deleted.
- Inventory direction `pos_to_shopify` (default) pushes warehouse quantity to Shopify and does not apply Shopify quantities back. `shopify_to_pos` imports Shopify quantities. `bidirectional` does both, and ignores a webhook that repeats a quantity pushed in the last three minutes.
- Orders go through the existing `importShopifyOrderToPos` importer, so duplicates follow the current POS order key. Line items, discounts, shipping, tax, payment gateways, and addresses are stored. Tax and gateways are also kept on `shopify_orders`.
- Fulfillment is created only when the fulfillment order lists `CREATE_FULFILLMENT`. Courier tracking already saved on the POS order is pushed. Shopify tracking is copied onto the POS order only when the POS tracking field is empty.
- Each run writes `shopify_sync_logs` with `pending`, `success`, or `failed`.

## Webhooks

`products/create`, `products/update`, `products/delete`, `orders/create`, `orders/updated`, `orders/cancelled`, `inventory_levels/update`, `locations/create`, `locations/update`, `app/uninstalled`.

Compliance topics `customers/data_request`, `customers/redact`, and `shop/redact` are acknowledged. `shop/redact` and uninstall clear the Shopify mapping collections and the stored token. POS orders and products remain, because they belong to the OrdersHub company.

Webhook ids are unique per company. A repeated delivery is acknowledged and not processed twice. Failures retry through BullMQ (5 attempts, exponential backoff).

## Background work

The API starts a BullMQ worker on queue `shopify-sync` when Redis is configured. Otherwise the same jobs run in memory inside the API process.

Scheduled reconciliation runs for each connected store on `sync_settings.auto_sync_interval_minutes` (`0` disables it).

Separate PM2 process:

```bash
# API
SHOPIFY_WORKER_ENABLED=false pm2 start index.js --name pos-api

# Worker
pm2 start src/shopify/worker.js --name shopify-worker
```

One process is enough for a single server: leave `SHOPIFY_WORKER_ENABLED` at its default and run `pm2 start index.js --name pos-api`.

## Health

`GET /api/health` is the process health check. `GET /api/shopify/health` reports the Shopify API version and whether Redis is configured.

## Collections

`shopify_connections`, `shopify_products`, `shopify_orders`, `shopify_inventory`, `shopify_locations`, `shopify_fulfillments`, `shopify_sync_logs`, `shopify_webhook_events`, plus `shopify_oauth_states` for the 15-minute OAuth nonce. Indexes enforce one connected shop domain and one row per company plus Shopify id.
