// Test script to verify product slug generation works with empty slug
require("dotenv").config();
const mongoose = require("mongoose");
const { getMongoUri } = require("./connection");

// Connect to MongoDB
const connectDB = async () => {
  try {
    await mongoose.connect(getMongoUri());
    console.log("✅ Connected to MongoDB");
  } catch (error) {
    console.error("❌ MongoDB connection error:", error);
    process.exit(1);
  }
};

const testProductSlug = async () => {
  console.log("🧪 Testing Product Slug Generation...\n");

  // Import the Product model
  const Product = require("./models/product");

  try {
    // Test 1: Create product with empty slug
    console.log("📝 Test 1: Creating product with empty slug");
    const testProduct1 = {
      product_name: "Gaming Laptop Pro Max",
      product_slug: "", // Empty slug
      product_price: "999.99",
      product_description: "High performance gaming laptop"
    };

    console.log("Input data:", testProduct1);
    const product1 = await Product.create(testProduct1);
    console.log("✅ Created product 1:");
    console.log("   - product_name:", product1.product_name);
    console.log("   - product_slug:", product1.product_slug);
    console.log("   - Expected: 'gaming-laptop-pro-max'\n");

    // Test 2: Create product with null slug
    console.log("📝 Test 2: Creating product with null slug");
    const testProduct2 = {
      product_name: "iPhone 15 Pro Max!!!",
      product_slug: null, // Null slug
      product_price: "1199.99",
      product_description: "Latest iPhone model"
    };

    console.log("Input data:", testProduct2);
    const product2 = await Product.create(testProduct2);
    console.log("✅ Created product 2:");
    console.log("   - product_name:", product2.product_name);
    console.log("   - product_slug:", product2.product_slug);
    console.log("   - Expected: 'iphone-15-pro-max'\n");

    // Test 3: Create product without slug field
    console.log("📝 Test 3: Creating product without slug field");
    const testProduct3 = {
      product_name: "Wireless Mouse @ $29.99",
      // product_slug not provided
      product_price: "29.99",
      product_description: "Ergonomic wireless mouse"
    };

    console.log("Input data:", testProduct3);
    const product3 = await Product.create(testProduct3);
    console.log("✅ Created product 3:");
    console.log("   - product_name:", product3.product_name);
    console.log("   - product_slug:", product3.product_slug);
    console.log("   - Expected: 'wireless-mouse-2999'\n");

    // Test 4: Create product with custom slug (should be slugified)
    console.log("📝 Test 4: Creating product with custom slug");
    const testProduct4 = {
      product_name: "Mechanical Keyboard",
      product_slug: "CUSTOM Slug With Spaces!!!", // Custom slug that needs slugifying
      product_price: "149.99",
      product_description: "RGB mechanical keyboard"
    };

    console.log("Input data:", testProduct4);
    const product4 = await Product.create(testProduct4);
    console.log("✅ Created product 4:");
    console.log("   - product_name:", product4.product_name);
    console.log("   - product_slug:", product4.product_slug);
    console.log("   - Expected: 'custom-slug-with-spaces'\n");

    console.log("🎉 All tests completed!");

    // Clean up test data
    console.log("🧹 Cleaning up test data...");
    await Product.deleteMany({
      _id: { $in: [product1._id, product2._id, product3._id, product4._id] }
    });
    console.log("✅ Test data cleaned up");

  } catch (error) {
    console.error("❌ Test error:", error);
  } finally {
    // Close the connection
    await mongoose.connection.close();
    console.log("👋 Database connection closed");
  }
};

// Run the test
const runTest = async () => {
  await connectDB();
  await testProductSlug();
};

if (require.main === module) {
  runTest();
}

module.exports = { testProductSlug };

