#!/usr/bin/env node

/**
 * WhatsApp Phone Number Info Checker
 * Gets test recipients for a phone number
 */

const https = require('https');
require('dotenv').config();

const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const YOUR_PHONE = '919836444455';

console.log('\n╔════════════════════════════════════════════════════════════════╗');
console.log('║      WHATSAPP PHONE INFO & TEST RECIPIENTS                   ║');
console.log('╚════════════════════════════════════════════════════════════════╝\n');

if (!PHONE_ID || !TOKEN) {
  console.log('❌ Missing environment variables\n');
  process.exit(1);
}

console.log(`🔍 Checking for phone: ${PHONE_ID}\n`);

// Try to get test phone numbers for this number
const options = {
  hostname: 'graph.facebook.com',
  port: 443,
  path: `/v22.0/${PHONE_ID}`,
  method: 'GET',
  headers: {
    Authorization: `Bearer ${TOKEN}`,
  },
};

const req = https.request(options, (res) => {
  let data = '';

  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    console.log(`📡 Response Status: ${res.statusCode}\n`);

    try {
      const response = JSON.parse(data);

      if (response.error) {
        console.log('Response has error:', response.error.message);
        console.log('\nTrying alternative endpoint...\n');
        
        // Try getting account info instead
        tryAccountEndpoint();
      } else {
        console.log('✅ Phone Info Retrieved:\n');
        console.log(JSON.stringify(response, null, 2));
      }
    } catch (e) {
      console.error('Parse error:', e.message);
    }
  });
});

req.on('error', (err) => {
  console.error('❌ Request error:', err.message);
});

req.end();

function tryAccountEndpoint() {
  // Try to get WhatsApp Business Account info
  const accOptions = {
    hostname: 'graph.facebook.com',
    port: 443,
    path: `/v22.0/${PHONE_ID}?fields=id,phone_number,test_phone_numbers`,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
    },
  };

  const accReq = https.request(accOptions, (res) => {
    let data = '';

    res.on('data', (chunk) => {
      data += chunk;
    });

    res.on('end', () => {
      console.log(`📡 Alternative Endpoint Response:\n`);

      try {
        const response = JSON.parse(data);
        console.log(JSON.stringify(response, null, 2));

        if (response.error) {
          showManualInstructions();
        }
      } catch (e) {
        showManualInstructions();
      }
    });
  });

  accReq.on('error', () => showManualInstructions());
  accReq.end();
}

function showManualInstructions() {
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║           ⚠️  MANUAL SETUP REQUIRED                            ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  console.log('Messages aren\'t arriving because your phone number might not be');
  console.log('registered as a test recipient.\n');

  console.log('✅ FOLLOW THESE STEPS:\n');

  console.log('1️⃣  Open Meta Developers Console:');
  console.log('    https://developers.facebook.com/apps/\n');

  console.log('2️⃣  Select Your WhatsApp App\n');

  console.log('3️⃣  Click "Tools" → "API Setup" (in left sidebar)\n');

  console.log('4️⃣  Scroll down to "Test Recipients" section\n');

  console.log('5️⃣  Click "Add Recipient":\n');
  console.log('    • Phone: 919836444455');
  console.log('    • Or your phone number\n');

  console.log('6️⃣  Click "Add" or "Confirm"\n');

  console.log('7️⃣  Wait 1-2 minutes for it to register\n');

  console.log('8️⃣  Then test by running:\n');
  console.log('    node test-hackathon.js\n');

  console.log('🎯 IMPORTANT:\n');
  console.log('   • In SANDBOX MODE, only test recipients can receive messages');
  console.log('   • Production accounts can send to any number');
  console.log('   • If your app is in sandbox, add yourself as test number\n');

  console.log('📺 Video Tutorial:');
  console.log('   https://www.youtube.com/results?search_query=whatsapp+test+recipients\n');

  console.log('🆘 Still not working?\n');
  console.log('   1. Verify access token is NOT expired');
  console.log('   2. Check phone number ID is correct');
  console.log('   3. Make sure you have correct permissions\n');
}
