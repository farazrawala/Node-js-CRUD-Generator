# Shopify → Local Product Sync

This guide covers how products are fetched from a connected Shopify store and saved in the local database, including category resolution and media handling.

## Overview

1. **Trigger**  
   Call `GET /api/integration/sync-store-product/:id`. The integration is inspected to determine the store type. If it’s Shopify, `syncShopifyProduct` handles the request.

2. **Session Setup**  
   - The integration record must contain `url`, `key`, `secret`, and `token`.  
   - `syncShopifyProduct` normalizes the shop domain (appends `.myshopify.com` where needed).  
   - Uses the official Shopify Admin REST SDK (`shopifyApi` with `ApiVersion.October24`) to create a session.

3. **Fetch Products**  
   - `client.get({ path: "products" })` retrieves Shopify products.  
   - Response is passed straight through today; you can modify to persist like WooCommerce (see below).

4. **Persist Locally (Extend)**  
   - For a full import, mirror the WooCommerce logic:  
     - Map Shopify product data to our `product` model  
     - Use `handleGenericFindOne`/`handleGenericCreate` to insert base products  
     - Loop over variants (`product.variants`) and create child records  
     - Download image URLs via `saveProductImagesLocally`

## Required Credentials

| Field | Description |
| --- | --- |
| `url` | Shopify shop URL (e.g., `my-store.myshopify.com`) |
| `key` | App API key |
| `secret` | App secret |
| `token` | Admin API access token |

These values live in the `integration` document in MongoDB. Missing credentials return `400`.

## Example Request

```http
GET /api/integration/sync-store-product/6520abe1234567890fedcba0
```

### Successful Response

```json
{
  "success": true,
  "message": "Products fetched successfully",
  "data": [
    {
      "id": 1234567890,
      "title": "Everyday Tee",
      "variants": [
        {
          "sku": "TEE-BLK-S",
          "price": "24.00"
        }
      ],
      "images": [
        {
          "src": "https://cdn.shopify.com/s/files/..."
        }
      ]
    }
  ],
  "meta": {
    "headers": {
      "x-shopify-shop-api-call-limit": "2/80",
      "content-type": "application/json; charset=utf-8"
    }
  }
}
```

## Mapping to Local Schema

| Shopify Field | Local Field | Notes |
| --- | --- | --- |
| `product.title` | `product_name` | |
| `product.body_html` | `product_description` | sanitize if needed |
| `product.variants[i].price` | `product_price` | stored as string |
| `product.variants[i].inventory_quantity` | `quantity` | optional |
| `product.product_type` | `product_type` | set to `"Variable"` if multiple variants |
| `product.images[0].src` | `product_image` | download and store locally |
| `product.vendor` | `brand_id` | requires mapping to brand collection |
| `product.tags` | custom fields | optional parsing |

## Suggested Persistence Flow

1. Upsert base product  
   ```js
   const existing = await handleGenericFindOne(req, "product", {
     searchCriteria: {
       product_name: product.title,
       company_id: store.company_id,
       deletedAt: null
     }
   });
   ```
2. If missing, create with `handleGenericCreate`.
3. Download images with `saveProductImagesLocally(baseProductId, imageEntries)` (same helper as WooCommerce).
4. Walk each variant (`product.variants`) and create/update child products with `parent_product_id`.

## Static Files

```
controllers/integration.js
├─ syncStoreProduct
│  ├─ syncShopifyProduct (Shopify handler)
│  └─ syncWordpressProduct (Woo handler)
└─ Helpers: saveProductImagesLocally, resetProductImageDirectory
```

## Tips & Caveats

- Shopify returns up to 250 products per call. Add `?limit=...&page_info=...` for pagination via the REST API.
- Some shops use metafields for extra data; extend the mapping as needed.
- Ensure the Express static middleware (`app.use('/uploads', express.static(...))`) is in place so local image paths resolve in the UI.

