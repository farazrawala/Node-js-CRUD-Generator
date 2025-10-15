# Troubleshooting: Warehouse Inventory "Add Warehouse" Button

## Quick Fix Steps

If the "Add Warehouse" button is not working, follow these steps:

### Step 1: Check Browser Console

1. Open the product create/edit page in admin: `/admin/products/create`
2. Open browser Developer Tools (F12)
3. Go to Console tab
4. Look for these messages:

**✅ Expected Output (Working):**
```
🏪 Warehouse Inventory Script Loaded
📦 Available warehouses: (array with warehouses)
📊 Current inventory counter: 0
📄 DOM Content Loaded
🔍 Checking warehouse inventory setup...
📦 Warehouses available: 2
🏪 Current items: 0
✅ Add Warehouse button found
```

**❌ Problem Output (Not Working):**
```
🏪 Warehouse Inventory Script Loaded
📦 Available warehouses: []
❌ No warehouses available
```

### Step 2: Ensure Warehouses Exist

If you see "Available warehouses: []", you need to create warehouses first:

1. Go to `/admin/warehouse`
2. Click "Create Warehouse"
3. Fill in:
   - Warehouse Name: "Main Warehouse"
   - Warehouse Address: "123 Main St"
   - Status: "active"
4. Click "Create"
5. Return to product creation page

### Step 3: Click the Button

1. Click the green "+ Add Warehouse" button
2. Watch the console for:
   ```
   ➕ Adding new warehouse inventory item...
   ✅ Container found, creating new item...
   ✅ Warehouse inventory item added successfully
   📊 New counter value: 1
   ```

### Step 4: Check if Item Appears

After clicking, you should see a new warehouse inventory entry with:
- Warehouse dropdown (showing available warehouses)
- Quantity input field (default: 0)
- Red trash icon to remove

## Common Issues & Solutions

### Issue 1: "No warehouses available" Alert

**Symptom**: Alert pops up saying "No warehouses available. Please create a warehouse first."

**Solution**:
1. Navigate to `/admin/warehouse`
2. Create at least one warehouse with `status: "active"`
3. Ensure `deletedAt` is `null` (not soft-deleted)
4. Refresh the product page

### Issue 2: Button Does Nothing (No Console Logs)

**Symptom**: Button clicks don't show any console logs

**Possible Causes**:
1. JavaScript error preventing script execution
2. Function not defined
3. Button onclick not properly set

**Solution**:
1. Check browser console for any red error messages
2. Look for syntax errors in JavaScript
3. Clear browser cache (Ctrl + Shift + Delete)
4. Hard reload page (Ctrl + F5)

### Issue 3: Container Not Found Error

**Symptom**: Console shows "❌ Container not found"

**Solution**:
This means the HTML structure is wrong. Check that:
1. You're on the correct page (`/admin/products/create` or `/admin/products/edit/:id`)
2. The custom field is properly included in the form
3. The `warehouse-inventory-field.ejs` is properly rendered

### Issue 4: Warehouses Not Loading in Dropdown

**Symptom**: Dropdown shows only "Select Warehouse" with no options

**Causes**:
1. `warehouses` array is empty
2. Middleware not running
3. Warehouses not passed to view

**Solution**:

Check admin route configuration in `routes/admin.js`:

```javascript
middleware: {
  beforeCreateForm: async (req, res) => {
    // This should fetch warehouses
    const warehouses = await Warehouse.find({ 
      status: 'active',
      deletedAt: null 
    });
    req.warehouses = warehouses;
  }
}
```

Make sure:
1. Middleware is properly configured
2. `Warehouse` model is imported: `const Warehouse = require("../models/warehouse");`
3. Warehouses exist in database with correct status

## Testing Steps

### Manual Test

1. **Create a Warehouse**:
   ```
   POST /admin/warehouse
   {
     "warehouse_name": "Test Warehouse",
     "warehouse_address": "123 Test St",
     "status": "active"
   }
   ```

2. **Go to Product Create Page**:
   ```
   GET /admin/products/create
   ```

3. **Open Console** (F12)

4. **Check Initial Logs**:
   - Should see "Warehouse Inventory Script Loaded"
   - Should see "Available warehouses: 1" (or more)
   - Should see "Add Warehouse button found"

5. **Click "+ Add Warehouse" Button**

6. **Verify in Console**:
   - Should see "Adding new warehouse inventory item..."
   - Should see "Item added successfully"

7. **Visual Check**:
   - New row should appear with warehouse dropdown and quantity field

### Test Remove Functionality

1. Click the red trash icon on an inventory item
2. Should see confirmation dialog
3. Click OK
4. Item should disappear
5. Console should show re-indexing messages

## Server-Side Checks

### Check if Middleware is Running

Add debug logging to `routes/admin.js`:

```javascript
beforeCreateForm: async (req, res) => {
  console.log('🏪 beforeCreateForm middleware running...');
  const warehouses = await Warehouse.find({ 
    status: 'active',
    deletedAt: null 
  });
  console.log('🏪 Found warehouses:', warehouses.length);
  req.warehouses = warehouses;
  console.log('🏪 Added to req.warehouses');
}
```

Restart server and check terminal logs when loading create page.

### Check Database

Run in MongoDB shell or Compass:

```javascript
db.warehouses.find({ 
  status: 'active',
  deletedAt: null 
})
```

Should return at least one warehouse.

## Quick Fixes

### Fix 1: Clear Browser Cache

```
Ctrl + Shift + Delete (Windows/Linux)
Cmd + Shift + Delete (Mac)
```

Select "Cached images and files" and clear.

### Fix 2: Restart Server

Sometimes changes don't hot-reload properly:

```bash
# Stop server (Ctrl + C)
# Restart
npm start
# or
nodemon
```

### Fix 3: Check for Typos

Common typos to check:
- `warehouses` vs `warehouse`
- `warehouse_inventory` vs `warehouseInventory`
- Function name: `addWarehouseInventoryItem` (exact case)

## Still Not Working?

If button still doesn't work after all checks:

1. **Copy these debug outputs**:
   - Browser console logs (screenshot)
   - Server terminal logs
   - Network tab (F12 → Network) showing page load

2. **Check these files**:
   - `views/admin/warehouse-inventory-field.ejs` - Custom field component
   - `routes/admin.js` - Product admin configuration
   - `models/warehouse.js` - Warehouse model

3. **Verify versions**:
   - Node.js version: `node --version`
   - MongoDB connection working
   - All dependencies installed: `npm install`

## Success Indicators

✅ Console shows "Warehouse Inventory Script Loaded"  
✅ Console shows warehouse count > 0  
✅ Button shows as clickable (hover changes color)  
✅ Clicking button adds new row  
✅ Dropdown shows warehouse options  
✅ Quantity field is editable  
✅ Remove button works  

If all above work, the feature is functioning correctly!

## Additional Help

- Check: `docs/admin-warehouse-inventory-guide.md` for usage guide
- Check: `docs/warehouse-inventory-usage.md` for code examples
- Check: `docs/warehouse-inventory-api-reference.md` for API details

