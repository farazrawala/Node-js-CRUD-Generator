const fs = require('fs');
const path = require('path');

// Create uploads directory structure
const uploadsDir = path.join(__dirname, 'uploads');

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log('✅ Created uploads directory');
} else {
  console.log('📁 Uploads directory already exists');
}

console.log('📂 Uploads directory path:', uploadsDir);
