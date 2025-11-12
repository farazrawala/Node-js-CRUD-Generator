# WooCommerce → Local Product Sync

This doc explains how to take a product from a connected WooCommerce store, persist it in the local database, and keep media files in `uploads/product/<productId>/`.

## High-Level Flow

1. **Fetch remote products**  
   `syncWordpressProduct` calls WooCommerce's REST API (`/wc/v3/products`), supporting `limit` and `offset` query params for pagination.

2. **Ensure related data exists**  
   - Categories: `handleGenericFindOne` + `handleGenericCreate` ensure each Woo category exists locally (`category` collection).  
   - Base product: `handleGenericFindOne` checks whether the product already exists. If not, it creates one via `handleGenericCreate`.

3. **Store images locally**  
   - `saveProductImagesLocally` downloads remote images to `uploads/product/<productId>/`.  
   - Before downloading, `resetProductImageDirectory` clears any old images to avoid stale files.  
   - After download, `handleGenericUpdate` updates `product_image` + `multi_images` fields to the new local paths.

4. **Variants**  
   - `generateAttributeCombinations` builds variant combinations.  
   - Each variant is created with `handleGenericCreate` and linked to the base product (`parent_product_id`).

5. **Sync summary**  
   - API response includes `synced_products` with base product IDs + image paths + status (created / existing).

## Example: Running the Sync

```http
GET /api/integration/sync-store-product/<integrationId>?limit=25&offset=0
```

**Response (simplified)**

```json
{
  "success": true,
  "synced_count": 3,
  "existing_count": 1,
  "pagination": {
    "limit": 25,
    "offset": 0,
    "total": 96
  },
  "synced_products": [
    {
      "remote_product_id": 1234,
      "product_id": "690bba7cfda078ee11f38fcd",
      "product_image": "uploads/product/690bba7cfda078ee11f38fcd/featured.jpg",
      "multi_images": [
        "uploads/product/690bba7cfda078ee11f38fcd/gallery-1.jpg"
      ],
      "created": true,
      "existing": false
    }
  ]
}
```

## File Reference

- `controllers/integration.js`
  - `syncWordpressProduct`
  - `saveProductImagesLocally`
  - `resetProductImageDirectory`
  - `generateAttributeCombinations`
- `utils/modelHelper.js`
  - `handleGenericCreate`
  - `handleGenericUpdate`
  - `handleGenericFindOne`

## Local Storage Layout

```
uploads/
└─ product/
   └─ <productId>/
      ├─ featured.jpg
      ├─ gallery-1.jpg
      └─ ...
```

All locally stored paths are relative (`uploads/product/...`) so they work with the Express static middleware defined in `index.js`:

```js
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
```

## Notes

- Variants reuse the parent gallery if WooCommerce variant images are missing.
- `synced_products` array helps the frontend link back local IDs and image paths.
- Ensure integration records include valid WooCommerce credentials (`url`, `key`, `secret`).

