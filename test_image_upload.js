const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const fetch = require('node-fetch');

async function testImageUpload() {
  try {
    console.log('🧪 Testing image upload functionality...');
    
    // Create a simple test image (1x1 pixel PNG)
    const testImageBuffer = Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xDE, 0x00, 0x00, 0x00,
      0x0C, 0x49, 0x44, 0x41, 0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xCF, 0x00,
      0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xDD, 0x8D, 0xB0, 0x00, 0x00, 0x00,
      0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82
    ]);
    
    // Create form data
    const form = new FormData();
    form.append('name', 'Test User with Image');
    form.append('email', 'testimage@example.com');
    form.append('password', 'password123');
    form.append('profile_image', testImageBuffer, {
      filename: 'test_image.png',
      contentType: 'image/png'
    });
    
    console.log('📤 Sending request to /api/user/create...');
    
    const response = await fetch('http://localhost:8000/api/user/create', {
      method: 'POST',
      body: form
    });
    
    const result = await response.json();
    
    console.log('📥 Response status:', response.status);
    console.log('📥 Response body:', JSON.stringify(result, null, 2));
    
    if (response.ok && result.success) {
      console.log('✅ Image upload test successful!');
      console.log('📁 Image path in database:', result.data.profile_image);
      
      // Check if the file was actually created
      if (result.data.profile_image) {
        const imagePath = path.join(__dirname, result.data.profile_image);
        if (fs.existsSync(imagePath)) {
          console.log('✅ Image file created successfully at:', imagePath);
        } else {
          console.log('❌ Image file not found at:', imagePath);
        }
      }
    } else {
      console.log('❌ Image upload test failed!');
    }
    
  } catch (error) {
    console.error('❌ Test error:', error.message);
  }
}

// Run the test
testImageUpload();
