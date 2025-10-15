# Warehouse Inventory API Reference

## Quick Start

The Product model now supports tracking quantities across multiple warehouses!

## API Endpoints

### 1. Create Product with Warehouse Inventory

```http
POST /api/product/create
Content-Type: application/json

{
  "product_name": "Gaming Laptop",
  "product_price": "1299.99",
  "product_description": "High-performance gaming laptop",
  "warehouse_inventory": [
    {
      "warehouse_id": "65abc123def456789012",
      "quantity": 50
    },
    {
      "warehouse_id": "65abc123def456789013",
      "quantity": 30
    }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "status": 201,
  "data": {
    "_id": "65abc123def456789014",
    "product_name": "Gaming Laptop",
    "warehouse_inventory": [
      {
        "warehouse_id": "65abc123def456789012",
        "quantity": 50,
        "last_updated": "2024-01-01T00:00:00.000Z"
      },
      {
        "warehouse_id": "65abc123def456789013",
        "quantity": 30,
        "last_updated": "2024-01-01T00:00:00.000Z"
      }
    ]
  }
}
```

---

### 2. Update Warehouse Quantity

```http
PATCH /api/product/:productId/warehouse-quantity
Content-Type: application/json

{
  "warehouse_id": "65abc123def456789012",
  "quantity": 20,
  "operation": "increase"
}
```

**Operations:**
- `"set"` - Set quantity to exact value
- `"increase"` - Add to existing quantity
- `"decrease"` - Subtract from existing quantity

**Examples:**

**Set Quantity:**
```json
{
  "warehouse_id": "65abc123def456789012",
  "quantity": 100,
  "operation": "set"
}
```

**Increase Stock (Restocking):**
```json
{
  "warehouse_id": "65abc123def456789012",
  "quantity": 25,
  "operation": "increase"
}
```

**Decrease Stock (Order Fulfillment):**
```json
{
  "warehouse_id": "65abc123def456789012",
  "quantity": 5,
  "operation": "decrease"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Warehouse quantity updated successfully",
  "data": {
    "_id": "65abc123def456789014",
    "product_name": "Gaming Laptop",
    "warehouse_inventory": [...]
  }
}
```

**Error Responses:**

Insufficient Stock:
```json
{
  "success": false,
  "message": "Insufficient quantity. Available: 10, Requested: 15"
}
```

Warehouse Not Found:
```json
{
  "success": false,
  "message": "Warehouse not found in inventory"
}
```

---

### 3. Get Product Warehouse Inventory

```http
GET /api/product/:productId/warehouse-inventory
```

**Response:**
```json
{
  "success": true,
  "data": {
    "product_id": "65abc123def456789014",
    "product_name": "Gaming Laptop",
    "warehouse_inventory": [
      {
        "warehouse_id": {
          "_id": "65abc123def456789012",
          "warehouse_name": "Main Warehouse",
          "warehouse_address": "123 Storage St",
          "status": "active"
        },
        "quantity": 50,
        "last_updated": "2024-01-01T00:00:00.000Z"
      },
      {
        "warehouse_id": {
          "_id": "65abc123def456789013",
          "warehouse_name": "Secondary Warehouse",
          "warehouse_address": "456 Storage Ave",
          "status": "active"
        },
        "quantity": 30,
        "last_updated": "2024-01-01T00:00:00.000Z"
      }
    ],
    "total_quantity": 80
  }
}
```

---

### 4. Check Stock Availability

```http
GET /api/product/:productId/check-stock?warehouse_id=65abc123def456789012&quantity=5
```

**Query Parameters:**
- `warehouse_id` (required) - Warehouse ID to check
- `quantity` (optional, default: 1) - Required quantity

**Response:**
```json
{
  "success": true,
  "data": {
    "product_id": "65abc123def456789014",
    "product_name": "Gaming Laptop",
    "warehouse_id": "65abc123def456789012",
    "available_quantity": 50,
    "requested_quantity": 5,
    "is_available": true
  }
}
```

---

### 5. Get Products by Warehouse

```http
GET /api/warehouse/:warehouseId/products
```

**Response:**
```json
{
  "success": true,
  "count": 2,
  "data": [
    {
      "_id": "65abc123def456789014",
      "product_name": "Gaming Laptop",
      "product_price": "1299.99",
      "warehouse_quantity": 50,
      "total_quantity": 80
    },
    {
      "_id": "65abc123def456789015",
      "product_name": "Wireless Mouse",
      "product_price": "29.99",
      "warehouse_quantity": 100,
      "total_quantity": 150
    }
  ]
}
```

---

## Common Use Cases

### Creating a Product with Multiple Warehouses

```bash
curl -X POST http://localhost:3000/api/product/create \
  -H "Content-Type: application/json" \
  -d '{
    "product_name": "Wireless Keyboard",
    "product_price": "79.99",
    "warehouse_inventory": [
      { "warehouse_id": "warehouse1_id", "quantity": 100 },
      { "warehouse_id": "warehouse2_id", "quantity": 75 }
    ]
  }'
```

### Restocking a Warehouse

```bash
curl -X PATCH http://localhost:3000/api/product/PRODUCT_ID/warehouse-quantity \
  -H "Content-Type: application/json" \
  -d '{
    "warehouse_id": "warehouse1_id",
    "quantity": 50,
    "operation": "increase"
  }'
```

### Processing an Order (Decreasing Stock)

```bash
curl -X PATCH http://localhost:3000/api/product/PRODUCT_ID/warehouse-quantity \
  -H "Content-Type: application/json" \
  -d '{
    "warehouse_id": "warehouse1_id",
    "quantity": 3,
    "operation": "decrease"
  }'
```

### Checking if Product is Available

```bash
curl -X GET "http://localhost:3000/api/product/PRODUCT_ID/check-stock?warehouse_id=warehouse1_id&quantity=5"
```

### Getting All Products in a Warehouse

```bash
curl -X GET http://localhost:3000/api/warehouse/WAREHOUSE_ID/products
```

---

## Model Methods

The Product model includes helpful instance methods:

```javascript
// Get product
const product = await Product.findById(productId);

// Set quantity
product.setWarehouseQuantity(warehouseId, 100);

// Get quantity
const qty = product.getWarehouseQuantity(warehouseId); // Returns: 100

// Get total across all warehouses
const total = product.getTotalQuantity(); // Returns: sum of all quantities

// Check availability
const available = product.isInStock(warehouseId, 5); // Returns: true/false

// Increase quantity (restocking)
product.increaseWarehouseQuantity(warehouseId, 25);

// Decrease quantity (orders)
product.decreaseWarehouseQuantity(warehouseId, 5);

// Save changes
await product.save();
```

---

## Schema Structure

```javascript
warehouse_inventory: [
  {
    warehouse_id: ObjectId (ref: "warehouse"),
    quantity: Number (min: 0, default: 0),
    last_updated: Date (default: Date.now)
  }
]
```

---

## Error Handling

All endpoints return consistent error responses:

```json
{
  "success": false,
  "message": "Error description"
}
```

Common errors:
- `400` - Bad request (invalid data, negative quantity)
- `404` - Resource not found (product or warehouse)
- `500` - Server error

---

## Notes

- Each warehouse can only appear once in a product's inventory
- Quantities cannot be negative (validated at schema level)
- `last_updated` timestamp is automatically updated on quantity changes
- Use `populate` to get full warehouse details
- The system prevents overselling (decreasing below 0)

