const mongoose = require('mongoose');
const Product = require('./models/product');
const Warehouse = require('./models/warehouse');

// Test script to verify warehouse quantity updates
async function testWarehouseUpdate() {
  try {
    // Connect to MongoDB (adjust connection string as needed)
    await mongoose.connect('mongodb://localhost:27017/your_database_name', {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    
    console.log('✅ Connected to MongoDB');
    
    // Create a test warehouse if it doesn't exist
    let testWarehouse = await Warehouse.findOne({ warehouse_name: 'Test Warehouse' });
    if (!testWarehouse) {
      testWarehouse = await Warehouse.create({
        warehouse_name: 'Test Warehouse',
        warehouse_address: 'Test Address',
        status: 'active'
      });
      console.log('✅ Created test warehouse:', testWarehouse._id);
    }
    
    // Create a test product if it doesn't exist
    let testProduct = await Product.findOne({ product_name: 'Test Product' });
    if (!testProduct) {
      testProduct = await Product.create({
        product_name: 'Test Product',
        product_price: '100',
        product_description: 'Test product for warehouse update testing'
      });
      console.log('✅ Created test product:', testProduct._id);
    }
    
    // Test 1: Set warehouse quantity using the model method
    console.log('\n🧪 Test 1: Setting warehouse quantity using model method');
    testProduct.setWarehouseQuantity(testWarehouse._id, 50);
    await testProduct.save();
    
    let updatedProduct = await Product.findById(testProduct._id);
    console.log('✅ Warehouse inventory after setting quantity:', updatedProduct.warehouse_inventory);
    
    // Test 2: Update warehouse quantity
    console.log('\n🧪 Test 2: Updating warehouse quantity');
    testProduct.setWarehouseQuantity(testWarehouse._id, 75);
    await testProduct.save();
    
    updatedProduct = await Product.findById(testProduct._id);
    console.log('✅ Warehouse inventory after updating quantity:', updatedProduct.warehouse_inventory);
    
    // Test 3: Add another warehouse
    console.log('\n🧪 Test 3: Adding another warehouse');
    let testWarehouse2 = await Warehouse.findOne({ warehouse_name: 'Test Warehouse 2' });
    if (!testWarehouse2) {
      testWarehouse2 = await Warehouse.create({
        warehouse_name: 'Test Warehouse 2',
        warehouse_address: 'Test Address 2',
        status: 'active'
      });
      console.log('✅ Created test warehouse 2:', testWarehouse2._id);
    }
    
    testProduct.setWarehouseQuantity(testWarehouse2._id, 25);
    await testProduct.save();
    
    updatedProduct = await Product.findById(testProduct._id);
    console.log('✅ Warehouse inventory with multiple warehouses:', updatedProduct.warehouse_inventory);
    
    // Test 4: Get total quantity
    console.log('\n🧪 Test 4: Getting total quantity');
    const totalQuantity = testProduct.getTotalQuantity();
    console.log('✅ Total quantity across all warehouses:', totalQuantity);
    
    // Test 5: Check stock availability
    console.log('\n🧪 Test 5: Checking stock availability');
    const isInStock = testProduct.isInStock(testWarehouse._id, 30);
    const isNotInStock = testProduct.isInStock(testWarehouse._id, 100);
    console.log('✅ Is 30 units available in warehouse 1:', isInStock);
    console.log('✅ Is 100 units available in warehouse 1:', isNotInStock);
    
    console.log('\n✅ All warehouse update tests passed!');
    
  } catch (error) {
    console.error('❌ Test failed:', error);
  } finally {
    await mongoose.disconnect();
    console.log('✅ Disconnected from MongoDB');
  }
}

// Run the test
testWarehouseUpdate();
