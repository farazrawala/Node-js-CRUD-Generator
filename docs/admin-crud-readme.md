# Admin CRUD Generator - Middleware Order & Dropdown Setup Guide

## Overview
This guide explains the correct order and usage of middleware functions in the Admin CRUD Generator, specifically for setting up dropdown options and handling form data.

## Middleware Functions & Their Purposes

### 1. `beforeCreateForm` Middleware
**Purpose**: Sets up dropdown options and form data for CREATE forms
**When Called**: Before rendering the create form
**Use Cases**:
- Set dropdown options for select fields
- Fetch reference data (e.g., parent products, warehouses)
- Initialize form field configurations

**Example**:
```javascript
beforeCreateForm: async (req, res) => {
  try {
    // Fetch all active products for parent_product_id dropdown
    const parent_products = await Product.find({ 
      deletedAt: { $exists: false } // Only non-deleted products
    }).select('product_name').sort({ product_name: 1 });
    
    // Set dropdown options
    if (req.fieldConfig?.parent_product_id) {
      req.fieldConfig.parent_product_id.options = parent_products.map(product => ({ 
        value: product._id.toString(), 
        label: product.product_name 
      }));
      req.fieldConfig.parent_product_id.placeholder = 'Select Parent Product';
      req.fieldConfig.parent_product_id.helpText = 'Choose the parent product';
    }
    
    // Fetch other reference data
    const warehouses = await Warehouse.find({ 
      status: 'active',
      deletedAt: null 
    }).select('warehouse_name warehouse_address').sort({ warehouse_name: 1 });
    
    req.warehouses = warehouses;
  } catch (error) {
    console.error('Error fetching data:', error);
    req.warehouses = [];
  }
}
```

### 2. `beforeEditForm` Middleware
**Purpose**: Sets up dropdown options and form data for EDIT forms
**When Called**: Before rendering the edit form
**Use Cases**:
- Set dropdown options for select fields
- Fetch reference data
- Pre-populate form with existing record data

**Example**:
```javascript
beforeEditForm: async (req, res) => {
  try {
    // Fetch all active products for parent_product_id dropdown
    const parent_products = await Product.find({ 
      deletedAt: null // Only non-deleted products
    }).select('product_name').sort({ product_name: 1 });
    
    // Set dropdown options
    req.fieldConfig.parent_product_id.options = parent_products.map(product => ({ 
      value: product._id.toString(), 
      label: product.product_name 
    }));
    req.fieldConfig.parent_product_id.placeholder = 'Select Parent Product';
    req.fieldConfig.parent_product_id.helpText = 'Choose the parent product';
    
    // Fetch warehouses
    const warehouses = await Warehouse.find({ 
      status: 'active',
      deletedAt: null 
    }).select('warehouse_name warehouse_address').sort({ warehouse_name: 1 });
    
    req.warehouses = warehouses;
  } catch (error) {
    console.error('Error fetching data:', error);
    req.warehouses = [];
  }
}
```

### 3. `afterQuery` Middleware
**Purpose**: Populates existing records with reference data for LIST views
**When Called**: After fetching records for list view
**Use Cases**:
- Populate ObjectId references with actual data
- Transform data for display
- **DO NOT** set dropdown options here (use beforeCreateForm/beforeEditForm instead)

**Example**:
```javascript
afterQuery: async (records, req) => {
  // Filter out records with empty references to avoid cast errors
  const validRecords = records.filter(record => 
    record.parent_product_id && 
    record.parent_product_id !== null &&
    record.parent_product_id !== ''
  );
  
  // Only populate if there are valid records
  let populatedRecords = records;
  if (validRecords.length > 0) {
    populatedRecords = await Product.populate(records, [
      { 
        path: 'parent_product_id', 
        select: 'product_name' 
      },
      { 
        path: 'warehouse_inventory.warehouse_id', 
        select: 'warehouse_name warehouse_address status' 
      }
    ]);
  }
  
  // Note: Dropdown options are set in beforeCreateForm/beforeEditForm middleware
  // This afterQuery middleware is only for populating existing records in list views
  
  return populatedRecords;
}
```

### 4. `beforeInsert` Middleware
**Purpose**: Process form data before creating new records
**When Called**: Before inserting new record into database
**Use Cases**:
- Parse complex form data (e.g., warehouse inventory arrays)
- Transform data formats
- Validate and sanitize input

**Example**:
```javascript
beforeInsert: async (req, res) => {
  // Parse warehouse_inventory from request
  if (req.body.warehouse_inventory) {
    const warehouseInventory = [];
    const inventoryData = req.body.warehouse_inventory;
    
    // Handle object format from form
    if (typeof inventoryData === 'object' && !Array.isArray(inventoryData)) {
      Object.keys(inventoryData).forEach(key => {
        const item = inventoryData[key];
        if (item.warehouse_id && item.quantity !== undefined) {
          warehouseInventory.push({
            warehouse_id: item.warehouse_id,
            quantity: parseInt(item.quantity) || 0,
            last_updated: new Date()
          });
        }
      });
    }
    
    req.body.warehouse_inventory = warehouseInventory;
  }
}
```

### 5. `beforeUpdate` Middleware
**Purpose**: Process form data before updating existing records
**When Called**: Before updating record in database
**Use Cases**:
- Parse complex form data
- Transform data formats
- Handle partial updates

**Example**:
```javascript
beforeUpdate: async (req, res) => {
  console.log('🔧 beforeUpdate middleware - Processing warehouse inventory');
  
  // Parse warehouse_inventory from request
  if (req.body.warehouse_inventory) {
    const warehouseInventory = [];
    const inventoryData = req.body.warehouse_inventory;
    
    // Handle object format from form
    if (typeof inventoryData === 'object' && !Array.isArray(inventoryData)) {
      Object.keys(inventoryData).forEach(key => {
        const item = inventoryData[key];
        if (item.warehouse_id && item.quantity !== undefined) {
          warehouseInventory.push({
            warehouse_id: item.warehouse_id,
            quantity: parseInt(item.quantity) || 0,
            last_updated: new Date()
          });
        }
      });
    }
    
    req.body.warehouse_inventory = warehouseInventory;
    console.log('✅ Processed warehouse inventory:', warehouseInventory);
  }
}
```

## Correct Middleware Order

### CREATE Form Flow:
```
1. adminCrudGenerator.createForm()
2. Sets req.fieldConfig = fieldConfig
3. Calls middleware.beforeCreateForm()
4. beforeCreateForm sets dropdown options
5. Template renders with options
```

### EDIT Form Flow:
```
1. adminCrudGenerator.editForm()
2. Sets req.fieldConfig = fieldConfig
3. Calls middleware.beforeEditForm()
4. beforeEditForm sets dropdown options
5. Template renders with options
```

### LIST View Flow:
```
1. adminCrudGenerator.list()
2. Calls middleware.afterQuery()
3. afterQuery populates existing records only
4. Template renders list
```

### INSERT Flow:
```
1. Form submission
2. Calls middleware.beforeInsert()
3. beforeInsert processes form data
4. Record inserted into database
```

### UPDATE Flow:
```
1. Form submission
2. Calls middleware.beforeUpdate()
3. beforeUpdate processes form data
4. Record updated in database
```

## Common Mistakes to Avoid

### ❌ Wrong: Setting dropdown options in afterQuery
```javascript
afterQuery: async (records, req) => {
  // DON'T DO THIS - This overwrites options set in beforeCreateForm
  req.fieldConfig.parent_product_id.options = [...];
}
```

### ✅ Correct: Setting dropdown options in beforeCreateForm
```javascript
beforeCreateForm: async (req, res) => {
  // DO THIS - Set options for create forms
  req.fieldConfig.parent_product_id.options = [...];
}
```

### ❌ Wrong: Calling afterQuery in createForm
```javascript
// DON'T DO THIS - afterQuery is for list views only
if (middleware.afterQuery) {
  await middleware.afterQuery([], req);
}
```

### ✅ Correct: Only call beforeCreateForm in createForm
```javascript
// DO THIS - Only call the appropriate middleware
if (middleware.beforeCreateForm) {
  await middleware.beforeCreateForm(req, res);
}
```

## Field Configuration Structure

### Select Field Configuration:
```javascript
fieldConfig: {
  parent_product_id: {
    name: 'parent_product_id',
    type: 'select',
    label: 'Parent Product',
    required: false,
    options: [], // Set by middleware
    placeholder: 'Select Parent Product', // Set by middleware
    helpText: 'Choose the parent product' // Set by middleware
  }
}
```

### Options Array Format:
```javascript
options: [
  { value: '507f1f77bcf86cd799439011', label: 'Product A' },
  { value: '507f1f77bcf86cd799439012', label: 'Product B' },
  { value: '507f1f77bcf86cd799439013', label: 'Product C' }
]
```

## Debugging Tips

### 1. Check Middleware Execution Order
Add console logs to verify middleware is called in correct order:
```javascript
console.log('🔍 beforeCreateForm - Setting dropdown options');
console.log('🔍 Options count:', req.fieldConfig.parent_product_id.options.length);
```

### 2. Verify FieldConfig in Template
Add debug comments in EJS templates:
```html
<!-- Debug: parent_product_id options: <%= JSON.stringify(fieldConfig.parent_product_id?.options) %> -->
```

### 3. Check Server Console
Look for these debug messages:
```
🔍 adminCrudGenerator - req.fieldConfig exists: true
🔍 adminCrudGenerator - parent_product_id options: 3
🔍 adminCrudGenerator - finalFieldConfig parent_product_id options: 3
```

## Best Practices

1. **Single Responsibility**: Each middleware should have one clear purpose
2. **No Duplication**: Don't set dropdown options in multiple places
3. **Error Handling**: Always wrap database queries in try-catch blocks
4. **Debugging**: Add console logs to track data flow
5. **Consistency**: Use the same data fetching logic across create/edit forms
6. **Performance**: Only fetch data that's actually needed
7. **Validation**: Validate data before setting options

## Troubleshooting

### Dropdown Shows "No options available"
- Check if `beforeCreateForm` is being called
- Verify `req.fieldConfig` exists
- Ensure options array is not empty
- Check console logs for errors

### Options are overwritten
- Remove dropdown option setting from `afterQuery`
- Ensure `afterQuery` is not called in `createForm`
- Check middleware execution order

### CastError for ObjectId
- Use proper ObjectId type in schema
- Filter out empty/null values in queries
- Use `$exists: false` instead of empty strings

This guide should help you understand the correct order and usage of middleware functions in the Admin CRUD Generator.

