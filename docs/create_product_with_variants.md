# Creating Products with Variants (API Workflow)

This guide walks through creating a base product and its variants in the database using the existing API controllers.

## Prerequisites

- Valid `company_id`
- Authenticated session with permissions to call the product endpoints
- Category IDs for any categories you want to attach
- (Optional) Brand ID and warehouse information

## 1. Create the Base (Parent) Product

Use the `POST /api/product/create` endpoint (`productCreate` in `controllers/product.js`).

### Required Fields

| Field | Notes |
| --- | --- |
| `product_name` | Display name |
| `product_code` | Unique code/SKU |
| `company_id` | Owning company |
| `product_price` | Base price as string |
| `quantity` | Starting quantity |
| `category_id` | Array of category IDs |
| `product_type` | `"Variable"` if it will have variants, otherwise `"Single"` |

### Example Payload

```json
{
  "product_name": "Performance Hoodie",
  "product_code": "PERF-HOODIE",
  "company_id": "64ff6cab48a7fab91c571234",
  "brand_id": "6510dca0b5f5b21548561234",
  "product_price": "0",
  "quantity": 0,
  "product_description": "Moisture-wicking hoodie with contrast trim.",
  "product_type": "Variable",
  "category_id": [
    "64f8db8f1ff2f21e18a81234"
  ],
  "status": "active"
}
```

On success, the response contains the `_id` of the parent product. Save this ID; variants will reference it via `parent_product_id`.

## 2. Prepare Variations

Variants are generated via the `POST /api/product/create-product-variation` endpoint (`productCreateVariation`). The controller expects:

- `variations[index][field]` style inputs (mirroring how the admin form posts field groups)
- Base product info in the request body (it internally creates the parent if needed and then loops over the variations)

If you already created the parent product in step 1, you can:

1. Reuse `productCreateVariation` but pass only the variant definitions (it will create a new parent though)
2. OR manually call `handleGenericCreate` for each variant via the standard create endpoint and supply `parent_product_id`

### Recommended API Body for Variants (Manual REST Call)

To create variants for an existing parent product, call `POST /api/product/create` for each variant with:

```json
{
  "product_name": "Performance Hoodie - Black / Small",
  "product_code": "PERF-HOODIE-BLK-S",
  "company_id": "64ff6cab48a7fab91c571234",
  "product_price": "4.50",
  "quantity": 25,
  "product_description": "Black, size Small",
  "product_type": "Single",
  "category_id": [
    "64f8db8f1ff2f21e18a81234"
  ],
  "parent_product_id": "6520abe1234567890fedcba0",
  "status": "active",
  "sku": "PERF-HOODIE-BLK-S"
}
```

Repeat for each option combination. The controller sets `parent_product_id` and maintains inherited media fields if you include them.

### Using `productCreateVariation` Helper

If you prefer to let the helper create the parent and variants in one call, structure the body like this:

```json
{
  "product_name": "Performance Hoodie",
  "product_code": "PERF-HOODIE",
  "company_id": "64ff6cab48a7fab91c571234",
  "product_price": "0",
  "quantity": 0,
  "product_type": "Variable",
  "category_id": ["64f8db8f1ff2f21e18a81234"],
  "variations[0][product_name]": "Performance Hoodie - Black / Small",
  "variations[0][product_code]": "PERF-HOODIE-BLK-S",
  "variations[0][product_price]": "4.50",
  "variations[0][quantity]": 25,
  "variations[0][sku]": "PERF-HOODIE-BLK-S",
  "variations[1][product_name]": "Performance Hoodie - Black / Medium",
  "variations[1][product_code]": "PERF-HOODIE-BLK-M",
  "variations[1][product_price]": "4.75",
  "variations[1][quantity]": 30,
  "variations[1][sku]": "PERF-HOODIE-BLK-M"
}
```

The controller will:

1. Create the parent product
2. Loop `variations[n]` and create variant records with the parent ID
3. Initialize warehouse inventory entries using the company’s default warehouse

## 3. Upload Images (Optional)

- For direct API uploads, use the admin form or implement a multipart endpoint mirroring the existing admin upload flow.
- To tie into the WooCommerce sync flow, reuse `saveProductImagesLocally` logic (see `controllers/integration.js`).

## 4. Verify in Database

Products are stored in the `product` collection. Parent products have:

- `product_type: "Variable"`
- `parent_product_id` referencing themselves (set in model hooks)

Variants have:

- `product_type: "Single"`
- `parent_product_id` pointing to the base product

Use MongoDB Compass or `db.product.find({ parent_product_id: ObjectId("<parentId>") })` to confirm.

## Troubleshooting

- Make sure every variant `product_code` (SKU) is unique.
- If categories fail to attach, ensure the IDs exist and the integration user has access.
- When using the helper controller, check server logs for hints—verbose logging shows request parsing steps.

## Related Files

- `controllers/product.js`
  - `productCreate`
  - `productCreateVariation`
- `models/product.js`
  - Schema, hooks that manage `parent_product_id`
- `utils/modelHelper.js`
  - `handleGenericCreate`, `handleGenericUpdate`
- `routes/api.js`
  - Registers `/api/product/create` and `/api/product/create-product-variation`

## Next Steps

1. Implement UI or CLI tooling that posts to these endpoints.
2. Expand variant support to capture more attributes (color, size, etc.).
3. Add tests covering parent/child relationships and inventory adjustments.

