# Admin Panel - Warehouse Inventory Management Guide

## Overview

The admin panel now includes a full warehouse inventory management system for products. You can track product quantities across multiple warehouse locations directly from the admin interface.

## Features

✅ **Multi-Warehouse Support** - Track products across unlimited warehouse locations  
✅ **Dynamic Add/Remove** - Add or remove warehouses for each product on the fly  
✅ **Real-time Quantity Management** - Update quantities instantly  
✅ **Warehouse Dropdown** - Select from active warehouses in your system  
✅ **Automatic Timestamps** - Last updated time tracked automatically  
✅ **Visual Interface** - Clean, modern UI with smooth animations  

## How to Use

### Creating a Product with Warehouse Inventory

1. **Navigate to Products**
   - Go to `/admin/products` in your browser
   - Click "Create Product" button

2. **Fill in Product Details**
   - Enter product name, price, description, etc.

3. **Add Warehouse Inventory**
   - Scroll to the "Warehouse Inventory" section
   - Click the green "+ Add Warehouse" button
   - Select a warehouse from the dropdown
   - Enter the quantity
   - Click "+ Add Warehouse" again to add more locations

4. **Save Product**
   - Click "Create Product" button
   - Product will be saved with inventory across all selected warehouses

### Editing Product Warehouse Inventory

1. **Navigate to Product List**
   - Go to `/admin/products`
   - Click the edit icon on any product

2. **Manage Warehouse Inventory**
   - Existing warehouses will be displayed with their current quantities
   - **To Add New Warehouse**: Click "+ Add Warehouse"
   - **To Update Quantity**: Change the number in the quantity field
   - **To Remove Warehouse**: Click the red trash icon

3. **Save Changes**
   - Click "Update Product" button
   - Inventory will be updated immediately

## UI Components

### Warehouse Inventory Field

```
┌─────────────────────────────────────────────────┐
│ Warehouse Inventory                             │
│ (Manage stock across warehouses)                │
├─────────────────────────────────────────────────┤
│ ┌───────────────────────────────────────────┐   │
│ │ Warehouse: [Main Warehouse ▼]   Qty: 100 │ 🗑️│
│ └───────────────────────────────────────────┘   │
│ ┌───────────────────────────────────────────┐   │
│ │ Warehouse: [Secondary ▼]         Qty: 50  │ 🗑️│
│ └───────────────────────────────────────────┘   │
│                                                 │
│ [➕ Add Warehouse]                              │
└─────────────────────────────────────────────────┘
```

### Features of Each Entry:

- **Warehouse Dropdown**: Shows all active warehouses
  - Displays warehouse name and address for easy identification
  - Only shows warehouses with `status: "active"` and not deleted
  
- **Quantity Input**: Number field with:
  - Minimum value: 0 (no negative quantities)
  - Step: 1 (whole numbers only)
  - Required validation

- **Remove Button**: Red trash icon
  - Shows confirmation before removal
  - Removes warehouse entry instantly
  
- **Add Warehouse Button**: Green button
  - Adds new warehouse entry with empty values
  - Smooth slide-in animation

## Data Structure

### Database Schema

```javascript
warehouse_inventory: [
  {
    warehouse_id: ObjectId,    // Reference to warehouse
    quantity: Number,          // Stock quantity
    last_updated: Date         // Auto-updated timestamp
  }
]
```

### Example Product Data

```json
{
  "_id": "60d5ec49e8d5b32abc123456",
  "product_name": "Gaming Laptop",
  "product_price": "1299.99",
  "warehouse_inventory": [
    {
      "warehouse_id": "60d5ec49e8d5b32abc111111",
      "quantity": 50,
      "last_updated": "2024-01-15T10:30:00.000Z"
    },
    {
      "warehouse_id": "60d5ec49e8d5b32abc222222",
      "quantity": 30,
      "last_updated": "2024-01-15T10:30:00.000Z"
    }
  ]
}
```

## Admin List View

In the product list view (`/admin/products`), warehouse inventory is displayed as:

- **Total Quantity Column**: Shows sum of all warehouse quantities
- **Warehouse Count**: Number of warehouses where product is stocked
- **Quick View**: Hover over to see breakdown by warehouse

## API Integration

The admin interface automatically handles:

1. **Form Data Parsing**: Converts form inputs to proper MongoDB format
2. **Validation**: Ensures warehouse_id and quantity are valid
3. **Type Conversion**: Converts quantity strings to numbers
4. **Timestamp Updates**: Automatically sets `last_updated` field
5. **Population**: Loads warehouse names for display

### Backend Processing

#### Before Insert/Update
```javascript
beforeInsert: async (req, res) => {
  // Parses warehouse_inventory from form data
  // Converts to proper array format
  // Validates and sanitizes input
}
```

#### After Query
```javascript
afterQuery: async (records, req) => {
  // Populates warehouse details
  // Shows warehouse names and addresses
}
```

## Tips & Best Practices

### ✅ Do's

- **Keep Warehouses Active**: Only active warehouses appear in dropdown
- **Use Descriptive Names**: Name warehouses clearly (e.g., "Main Store - NYC")
- **Regular Updates**: Update quantities when stock changes
- **Remove Empty**: Remove warehouses with 0 quantity if no longer needed

### ❌ Don'ts

- **Don't Use Negative Quantities**: System validates minimum is 0
- **Don't Duplicate Warehouses**: System allows one entry per warehouse per product
- **Don't Leave Empty Fields**: Both warehouse and quantity are required

## Troubleshooting

### Issue: Warehouse doesn't appear in dropdown
**Solution**: Check that:
- Warehouse `status` is set to `"active"`
- Warehouse `deletedAt` field is `null`
- Warehouse exists in database

### Issue: Quantities not saving
**Solution**: Ensure:
- Quantity is a valid number
- Quantity is >= 0
- Form is submitted properly
- No JavaScript errors in console

### Issue: Can't remove warehouse entry
**Solution**: 
- Confirm deletion when prompted
- Check browser console for errors
- Refresh page and try again

## Related API Endpoints

While the admin panel handles everything automatically, you can also use these API endpoints directly:

- `PATCH /api/product/:id/warehouse-quantity` - Update specific warehouse quantity
- `GET /api/product/:id/warehouse-inventory` - Get full inventory details
- `GET /api/product/:id/check-stock` - Check availability
- `GET /api/warehouse/:warehouseId/products` - Get all products in warehouse

See `docs/warehouse-inventory-api-reference.md` for full API documentation.

## Screenshots

### Create Product Form
The warehouse inventory section appears below the standard product fields with a clean, organized interface.

### Edit Product Form
Existing warehouse inventory is pre-populated, making updates quick and easy.

### Warehouse Dropdown
Shows warehouse name and address for easy identification:
```
Main Warehouse - 123 Storage St
Secondary Warehouse - 456 Backup Ave
Distribution Center - 789 Ship Road
```

## Technical Details

### Files Modified

1. **Models**
   - `models/product.js` - Added warehouse_inventory schema with helper methods

2. **Views**
   - `views/admin/warehouse-inventory-field.ejs` - Custom field component
   - `views/admin/create.ejs` - Added custom field type support
   - `views/admin/edit.ejs` - Added custom field type support

3. **Routes**
   - `routes/admin.js` - Added warehouse fetching and data processing middleware

4. **Utils**
   - `utils/adminCrudGenerator.js` - Added warehouses parameter to view rendering

### JavaScript Functions

- `addWarehouseInventoryItem()` - Adds new warehouse entry dynamically
- `removeWarehouseInventoryItem()` - Removes warehouse entry with confirmation
- `reindexWarehouseInventoryItems()` - Maintains proper array indices after removal

## Future Enhancements

Potential features for future development:

- **Bulk Import**: Upload CSV to set quantities for multiple warehouses
- **Stock Alerts**: Low stock warnings per warehouse
- **Transfer History**: Track inventory transfers between warehouses
- **Quick Actions**: Increase/decrease buttons for faster updates
- **Warehouse Map**: Visual representation of stock distribution

## Support

For issues or questions:
1. Check this documentation
2. Review `docs/warehouse-inventory-usage.md` for model methods
3. Check `docs/warehouse-inventory-api-reference.md` for API details
4. Check browser console for JavaScript errors
5. Check server logs for backend errors

## Summary

The warehouse inventory management feature is fully integrated into the admin panel, providing a seamless experience for managing product stock across multiple locations. The interface is intuitive, validated, and handles all data processing automatically.

**Ready to use!** Simply navigate to `/admin/products` and start managing your inventory. 📦

