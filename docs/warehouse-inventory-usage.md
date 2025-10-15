# Warehouse Inventory Management

## Overview

The Product model now supports tracking quantities across multiple warehouses. Each product can have different quantities in different warehouse locations.

## Database Schema

```javascript
warehouse_inventory: [
  {
    warehouse_id: ObjectId,    // Reference to warehouse
    quantity: Number,          // Stock quantity (min: 0)
    last_updated: Date         // Last update timestamp
  }
]
```

## Usage Examples

### 1. Creating a Product with Warehouse Inventory

```javascript
const product = await Product.create({
  product_name: "Gaming Laptop",
  product_price: "1299.99",
  product_description: "High-performance gaming laptop",
  warehouse_inventory: [
    {
      warehouse_id: "507f1f77bcf86cd799439011", // Warehouse A ID
      quantity: 50
    },
    {
      warehouse_id: "507f1f77bcf86cd799439012", // Warehouse B ID
      quantity: 30
    }
  ]
});
```

### 2. Adding/Updating Quantity for a Warehouse

```javascript
const product = await Product.findById(productId);

// Set quantity for a specific warehouse
product.setWarehouseQuantity(warehouseId, 100);
await product.save();
```

### 3. Getting Quantity from a Specific Warehouse

```javascript
const product = await Product.findById(productId);

// Get quantity from specific warehouse
const quantity = product.getWarehouseQuantity(warehouseId);
console.log(`Available quantity: ${quantity}`);
```

### 4. Getting Total Quantity Across All Warehouses

```javascript
const product = await Product.findById(productId);

// Get total quantity across all warehouses
const totalQty = product.getTotalQuantity();
console.log(`Total stock: ${totalQty}`);
```

### 5. Checking Stock Availability

```javascript
const product = await Product.findById(productId);

// Check if product is in stock at specific warehouse
if (product.isInStock(warehouseId, 5)) {
  console.log("Product is available!");
} else {
  console.log("Insufficient stock");
}
```

### 6. Decreasing Quantity (For Orders)

```javascript
const product = await Product.findById(productId);

try {
  // Decrease quantity when order is placed
  product.decreaseWarehouseQuantity(warehouseId, 5);
  await product.save();
  console.log("Order processed successfully");
} catch (error) {
  console.error("Error:", error.message);
  // Handle insufficient quantity or warehouse not found
}
```

### 7. Increasing Quantity (For Restocking)

```javascript
const product = await Product.findById(productId);

// Add stock when restocking
product.increaseWarehouseQuantity(warehouseId, 25);
await product.save();
console.log("Inventory restocked");
```

### 8. Querying Products by Warehouse

```javascript
// Find all products available in a specific warehouse
const products = await Product.find({
  "warehouse_inventory.warehouse_id": warehouseId,
  "warehouse_inventory.quantity": { $gt: 0 }
}).populate("warehouse_inventory.warehouse_id");
```

### 9. Querying Products with Low Stock

```javascript
// Find products with low stock in any warehouse
const lowStockProducts = await Product.find({
  "warehouse_inventory.quantity": { $lt: 10, $gt: 0 }
});
```

### 10. Populate Warehouse Details

```javascript
const product = await Product.findById(productId)
  .populate("warehouse_inventory.warehouse_id", "warehouse_name warehouse_address");

console.log(product.warehouse_inventory);
// Output: [
//   {
//     warehouse_id: { warehouse_name: "Main Warehouse", warehouse_address: "..." },
//     quantity: 50,
//     last_updated: "2024-01-01T00:00:00.000Z"
//   }
// ]
```

## API Endpoint Examples

### Create Product with Multiple Warehouses

```javascript
POST /api/product/create
{
  "product_name": "Wireless Mouse",
  "product_price": "29.99",
  "product_description": "Ergonomic wireless mouse",
  "warehouse_inventory": [
    {
      "warehouse_id": "65abc123def456789012",
      "quantity": 100
    },
    {
      "warehouse_id": "65abc123def456789013",
      "quantity": 75
    }
  ]
}
```

### Update Warehouse Quantity

```javascript
PATCH /api/product/update-warehouse-quantity/:productId
{
  "warehouse_id": "65abc123def456789012",
  "quantity": 150,
  "operation": "set" // or "increase" or "decrease"
}
```

## Controller Implementation Example

```javascript
async function updateWarehouseQuantity(req, res) {
  try {
    const { productId } = req.params;
    const { warehouse_id, quantity, operation } = req.body;

    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found"
      });
    }

    switch (operation) {
      case "set":
        product.setWarehouseQuantity(warehouse_id, quantity);
        break;
      case "increase":
        product.increaseWarehouseQuantity(warehouse_id, quantity);
        break;
      case "decrease":
        product.decreaseWarehouseQuantity(warehouse_id, quantity);
        break;
      default:
        return res.status(400).json({
          success: false,
          message: "Invalid operation. Use 'set', 'increase', or 'decrease'"
        });
    }

    await product.save();

    return res.status(200).json({
      success: true,
      message: "Warehouse quantity updated successfully",
      data: product
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
}
```

## Best Practices

1. **Always validate warehouse_id exists** before updating quantities
2. **Use transactions** for operations that affect multiple warehouses
3. **Track inventory changes** using the `last_updated` field
4. **Implement stock alerts** for low inventory levels
5. **Use the helper methods** instead of direct array manipulation
6. **Handle insufficient stock errors** gracefully in order processing
7. **Consider using atomic operations** for concurrent updates

## Error Handling

```javascript
try {
  product.decreaseWarehouseQuantity(warehouseId, quantity);
  await product.save();
} catch (error) {
  if (error.message.includes("Insufficient quantity")) {
    // Handle out of stock scenario
    return res.status(400).json({
      success: false,
      message: "Not enough stock available",
      available: product.getWarehouseQuantity(warehouseId),
      requested: quantity
    });
  } else if (error.message.includes("Warehouse not found")) {
    // Handle invalid warehouse
    return res.status(404).json({
      success: false,
      message: "Warehouse not found in product inventory"
    });
  }
}
```

## Notes

- The `warehouse_inventory` field is an array of objects, not a simple array
- Each warehouse can only appear once in the inventory array
- Quantities cannot be negative (enforced by schema validation)
- The `last_updated` timestamp is automatically set when quantities change
- Use the provided helper methods for consistency and error handling

