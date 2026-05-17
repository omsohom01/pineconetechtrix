#!/usr/bin/env node

/**
 * Check Test Recipients - Direct API Call
 */

const https = require('https');
require('dotenv').config();

const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

console.log('\n╔════════════════════════════════════════════════════════════════╗');
console.log('║     REGISTERED TEST RECIPIENTS CHECK                         ║');
console.log('╚════════════════════════════════════════════════════════════════╝\n');

// The API uses a different structure - need to get from the app or WABA
// Let's try getting the test phone numbers from the phone itself by querying test_phone_numbers

const testPath = `/v22.0/${PHONE_ID}?fields=test_phone_numbers`;

console.log(`📡 Querying: ${testPath}\n`);

const options = {
  hostname: 'graph.facebook.com',
  port: 443,
  path: testPath,
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
    try {
      const response = JSON.parse(data);

      if (response.test_phone_numbers) {
        console.log('✅ Test Phone Numbers Found:\n');
        response.test_phone_numbers.forEach((num) => {
          console.log(`   • ${num}`);
        });

        // Check if user's number is in list
        const yourNumber = '919836444455';
        const isFound = response.test_phone_numbers.some((num) =>
          num.replace(/\D/g, '') === yourNumber.replace(/\D/g, '')
        );

        if (isFound) {
          console.log(`\n✅ Your number ${yourNumber} IS registered!\n`);
        } else {
          console.log(`\n❌ Your number ${yourNumber} is NOT in the list!\n`);
          printInstructions();
        }
      } else if (response.error) {
        console.log('⚠️  Cannot fetch test phone numbers via API\n');
        console.log('Error:', response.error.message);
        console.log('\n📌 This is normal for some accounts.\n');
        printInstructions();
      } else {
        console.log('Response (no test_phone_numbers field):\n');
        console.log(JSON.stringify(response, null, 2));
        console.log('\n');
        printInstructions();
      }
    } catch (e) {
      console.error('Parse error:', e.message);
    }
  });
});

req.on('error', (err) => {
  console.error('❌ Request error:', err.message);
  printInstructions();
});

req.end();

function printInstructions() {
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║          HOW TO ADD TEST RECIPIENTS (MANUAL)                  ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  console.log('🎯 YOUR SITUATION:');
  console.log('   • Your WhatsApp Business phone: 15551411188 (US)');
  console.log('   • Testing with: 919836444455 (India)');
  console.log('   • Status: might not be on test recipients list\n');

  console.log('✅ TO ADD YOUR PHONE NUMBER:\n');

  console.log('METHOD 1 - Via Meta Developers (Recommended):\n');
  console.log('  1. Go to https://developers.facebook.com/apps/');
  console.log('  2. Select your WhatsApp Business app');
  console.log('  3. Go to Settings → Basic → Get Page Access Token');
  console.log('  4. On the app dashboard, find "WhatsApp" product');
  console.log('  5. Click "API Setup"');
  console.log('  6. Look for "Test Recipients" section');
  console.log('  7. Click "Add Recipient"');
  console.log('  8. Enter: 919836444455');
  console.log('  9. Click "Add Phone Number"');
  console.log('  10. Wait 2-3 minutes\n');

  console.log('METHOD 2 - Alternative Location:\n');
  console.log('  1. Go to Meta Developers');
  console.log('  2. Apps → Your WhatsApp App');
  console.log('  3. Dashboard');
  console.log('  4. Look for "Status" or "API Setup" card');
  console.log('  5. Click "Test Recipients" link\n');

  console.log('🎥 VISUAL GUIDE:');
  console.log('  https://www.youtube.com/watch?v=B6E3HtXRDrQ\n');

  console.log('⏱️  TIMING:\n');
  console.log('  • After adding: Wait 2-3 minutes');
  console.log('  • Then run: node test-hackathon.js\n');

  console.log('🔍 VERIFICATION:\n');
  console.log('  Once added, you should be able to receive:');
  console.log('  • hello_world template messages');
  console.log('  • Custom text messages');
  console.log('  • Images and documents\n');

  console.log('❌ IF IT STILL DOESN\'T WORK:\n');
  console.log('  1. Your account might be in production mode');
  console.log('  2. Check if phone needs to be verified');
  console.log('  3. Check WhatsApp Business Account settings');
  console.log('  4. Verify access token hasn\'t expired\n');
}
