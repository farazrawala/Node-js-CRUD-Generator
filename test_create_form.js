const http = require('http');

function testCreateForm() {
  const options = {
    hostname: 'localhost',
    port: 8000,
    path: '/admin/blogs/create',
    method: 'GET',
    headers: {
      'User-Agent': 'Test Script'
    }
  };

  const req = http.request(options, (res) => {
    let data = '';
    
    res.on('data', (chunk) => {
      data += chunk;
    });
    
    res.on('end', () => {
      console.log('Status Code:', res.statusCode);
      
      // Check if the response contains user options
      if (data.includes('Posted User')) {
        console.log('✅ Found "Posted User" label in the form');
        
        // Look for select options
        const selectMatch = data.match(/<select[^>]*id="user_id"[^>]*>([\s\S]*?)<\/select>/);
        if (selectMatch) {
          const selectContent = selectMatch[1];
          const optionMatches = selectContent.match(/<option[^>]*value="[^"]*"[^>]*>([^<]*)<\/option>/g);
          
          if (optionMatches && optionMatches.length > 1) { // More than just the default option
            console.log('✅ Found user options in select dropdown:');
            optionMatches.forEach((option, index) => {
              const valueMatch = option.match(/value="([^"]*)"/);
              const textMatch = option.match(/>([^<]*)</);
              if (valueMatch && textMatch) {
                console.log(`  ${index + 1}. Value: ${valueMatch[1]}, Text: ${textMatch[1]}`);
              }
            });
          } else {
            console.log('❌ No user options found in select dropdown');
            console.log('Select content:', selectContent);
          }
        } else {
          console.log('❌ No select element found for user_id');
        }
      } else {
        console.log('❌ "Posted User" label not found in the form');
      }
      
      // Check if the response contains any error messages
      if (data.includes('Error') || data.includes('error')) {
        console.log('⚠️  Error detected in response');
      }
    });
  });

  req.on('error', (error) => {
    console.error('❌ Request error:', error.message);
  });

  req.end();
}

console.log('🧪 Testing blog create form...');
testCreateForm();
