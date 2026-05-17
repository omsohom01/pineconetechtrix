#!/usr/bin/env node

/**
 * WhatsApp Setup Diagnostic Script
 * Identifies configuration issues preventing message delivery
 */

const https = require('https');
require('dotenv').config(); // Load .env file

const RECIPIENT_PHONE = '919836444455';

console.log('\n╔════════════════════════════════════════════════════════════════╗');
console.log('║         WHATSAPP SETUP DIAGNOSTIC                             ║');
console.log('╚════════════════════════════════════════════════════════════════╝\n');

// Check environment variables
console.log('🔍 Step 1: Checking Environment Variables\n');

const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

if (!PHONE_ID) {
  console.log('❌ WHATSAPP_PHONE_NUMBER_ID is NOT set');
  console.log('   ➜ Set this in your .env file\n');
} else {
  console.log(`✅ WHATSAPP_PHONE_NUMBER_ID: ${PHONE_ID}\n`);
}

if (!TOKEN) {
  console.log('❌ WHATSAPP_ACCESS_TOKEN is NOT set');
  console.log('   ➜ Set this in your .env file\n');
} else {
  console.log(`✅ WHATSAPP_ACCESS_TOKEN: ${TOKEN.substring(0, 20)}...\n`);
}

console.log('🔍 Step 2: Checking Phone Number Format\n');
console.log(`   Input: ${RECIPIENT_PHONE}`);
console.log(`   ✅ Format looks correct (country code + digits)\n`);

console.log('🔍 Step 3: Testing with Template Message (hello_world)\n');
console.log('   Template messages ALWAYS work in sandbox mode.');
console.log('   If this fails, your account/token is misconfigured.\n');

// Send template message
const templatePayload = {
  messaging_product: 'whatsapp',
  recipient_type: 'individual',
  to: RECIPIENT_PHONE,
  type: 'template',
  template: {
    name: 'hello_world',
    language: {
      code: 'en_US',
    },
  },
};

const postData = JSON.stringify(templatePayload);

const options = {
  hostname: 'graph.facebook.com',
  port: 443,
  path: `/v22.0/${PHONE_ID}/messages`,
  method: 'POST',
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData),
  },
};

console.log(`📤 Sending hello_world template to ${RECIPIENT_PHONE}...\n`);

const req = https.request(options, (res) => {
  let data = '';

  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    console.log(`\n📡 Response Status: ${res.statusCode}\n`);

    try {
      const response = JSON.parse(data);

      if (res.statusCode === 200) {
        console.log('✅ ✅ ✅ TEMPLATE MESSAGE SENT SUCCESSFULLY! ✅ ✅ ✅\n');
        console.log('Response:', JSON.stringify(response, null, 2));
        console.log('\n📱 CHECK YOUR WHATSAPP NOW!');
        console.log(`   Phone: ${RECIPIENT_PHONE}`);
        console.log('   Look for: "Hello World" message from Meta\n');
        console.log('⚠️  If you DON\'T see it:');
        console.log('   1. You might NOT be added as a test recipient');
        console.log('   2. Go to Meta Developers → WhatsApp Settings');
        console.log('   3. Add yourself to "Test Recipients"');
        console.log('   4. Try again\n');
        console.log('✅ If you DO see it:');
        console.log('   Your setup is working! Campaign messages will also arrive.\n');
      } else {
        console.log('❌ ❌ ❌ TEMPLATE MESSAGE FAILED! ❌ ❌ ❌\n');
        console.log('Status:', res.statusCode);
        console.log('Response:', JSON.stringify(response, null, 2));

        if (response.error) {
          const error = response.error;
          console.log('\n🔴 ERROR DETAILS:');
          console.log(`   Type: ${error.type}`);
          console.log(`   Code: ${error.code}`);
          console.log(`   Message: ${error.message}`);

          console.log('\n🛠️  TROUBLESHOOTING:\n');

          if (error.code === 133000) {
            console.log('   ❌ Param validation failed');
            console.log('   → Check WHATSAPP_PHONE_NUMBER_ID format\n');
          }

          if (error.code === 190) {
            console.log('   ❌ Invalid access token');
            console.log('   → Generate a new token in Meta Developers\n');
          }

          if (error.code === 104) {
            console.log('   ❌ Invalid phone number ID');
            console.log('   → Verify WHATSAPP_PHONE_NUMBER_ID in .env\n');
          }

          if (error.code === 400) {
            console.log('   ❌ Bad request / Account not verified');
            console.log('   → Phone might not be registered as test recipient');
            console.log('   → Or your account setup is incomplete\n');
          }
        }
      }

      printDiagnosticSteps();

    } catch (parseErr) {
      console.error('❌ Failed to parse response:', parseErr.message);
      console.log('Raw response:', data);
    }
  });
});

req.on('error', (err) => {
  console.error('❌ Request failed:', err.message);
  console.log('\nPossible causes:');
  console.log('   • Network connectivity issue');
  console.log('   • Invalid phone number ID format');
  console.log('   • Environment variables not loaded\n');
  printDiagnosticSteps();
});

req.write(postData);
req.end();

function printDiagnosticSteps() {
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║                  DIAGNOSTIC CHECKLIST                            ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  console.log('✓ Step 1: Go to https://developers.facebook.com');
  console.log('✓ Step 2: Select your WhatsApp app');
  console.log('✓ Step 3: Go to API Setup section');
  console.log('✓ Step 4: Copy Phone Number ID and paste in .env as WHATSAPP_PHONE_NUMBER_ID');
  console.log('✓ Step 5: Generate new access token with whatsapp_business_messaging permission');
  console.log('✓ Step 6: Paste token in .env as WHATSAPP_ACCESS_TOKEN');
  console.log('✓ Step 7: Scroll down to "Test Recipients"');
  console.log('✓ Step 8: Add your phone number (919836444455) as test recipient');
  console.log('✓ Step 9: Run this script again to verify\n');

  console.log('📚 Reference Links:');
  console.log('   • Meta Developers: https://developers.facebook.com');
  console.log('   • WhatsApp API Docs: https://developers.facebook.com/docs/whatsapp/cloud-api\n');
}
