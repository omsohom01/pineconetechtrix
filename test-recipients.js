#!/usr/bin/env node

/**
 * WhatsApp Test Recipients Checker
 * Shows which numbers are registered as test recipients
 * and helps add new ones
 */

const https = require('https');
require('dotenv').config();

const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const YOUR_PHONE = '919836444455';

console.log('\n╔════════════════════════════════════════════════════════════════╗');
console.log('║        TEST RECIPIENTS CHECKER                                ║');
console.log('╚════════════════════════════════════════════════════════════════╝\n');

if (!PHONE_ID || !TOKEN) {
  console.log('❌ Missing environment variables');
  console.log('   • WHATSAPP_PHONE_NUMBER_ID: ' + (PHONE_ID ? '✅' : '❌'));
  console.log('   • WHATSAPP_ACCESS_TOKEN: ' + (TOKEN ? '✅' : '❌'));
  console.log('\nPlease set these in .env file\n');
  process.exit(1);
}

console.log('🔍 Checking test recipients registered for this phone number...\n');

// Get test phone numbers
const options = {
  hostname: 'graph.facebook.com',
  port: 443,
  path: `/v22.0/${PHONE_ID}?fields=phone_number_id,verified_name,test_phone_numbers`,
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

      if (response.error) {
        console.log('❌ Error fetching phone details:');
        console.log('   ' + response.error.message);
        console.log('\n⚠️  Token might be expired. Generate a new one:\n');
        console.log('   1. Go to https://developers.facebook.com');
        console.log('   2. Select your WhatsApp app');
        console.log('   3. Tools → Generate new token');
        console.log('   4. Update WHATSAPP_ACCESS_TOKEN in .env\n');
        process.exit(1);
      }

      console.log('✅ Phone Number Details:\n');
      console.log('   Phone Number ID: ' + response.phone_number_id);
      console.log('   Verified Name: ' + (response.verified_name || 'Not verified'));

      const testNumbers = response.test_phone_numbers || [];

      console.log('\n🔐 Currently Registered Test Recipients:\n');

      if (testNumbers.length === 0) {
        console.log('   ❌ NO test recipients registered!');
      } else {
        testNumbers.forEach((num, idx) => {
          console.log(`   ${idx + 1}. ${num}`);
        });
      }

      console.log('\n📱 Your Phone Number: ' + YOUR_PHONE);

      const isRegistered = testNumbers.some(
        (num) => num.replace(/\D/g, '') === YOUR_PHONE.replace(/\D/g, '')
      );

      if (isRegistered) {
        console.log('   ✅ ✅ ✅ ALREADY REGISTERED! ✅ ✅ ✅\n');
        console.log('   Your number is in the test recipients list.');
        console.log('   Messages should arrive in your WhatsApp.\n');
        console.log('   ⚠️  If you still don\'t receive messages:');
        console.log('      1. Make sure WhatsApp app is installed on this phone');
        console.log('      2. Check your spam/archive folders');
        console.log('      3. Try a fresh test: node test-hackathon.js');
        console.log('      4. Check your phone number format\n');
      } else {
        console.log('   ❌ ❌ ❌ NOT REGISTERED! ❌ ❌ ❌\n');
        console.log('   THIS IS THE PROBLEM! Add it manually:\n');
        console.log('   📌 STEPS TO ADD YOUR NUMBER:\n');
        console.log('      1. Go to https://developers.facebook.com');
        console.log('      2. Select your WhatsApp app');
        console.log('      3. Go to API Setup');
        console.log('      4. Scroll down to "Test Recipients"');
        console.log('      5. Click "Add Recipient"');
        console.log('      6. Enter phone: 919836444455 (or your number)');
        console.log('      7. Click "Add" or "Confirm"');
        console.log('      8. Wait 1-2 minutes');
        console.log('      9. Then run: node test-hackathon.js\n');

        console.log('   🎥 Video Guide:');
        console.log('      https://www.youtube.com/watch?v=B6E3HtXRDrQ\n');
      }

      console.log('╔════════════════════════════════════════════════════════════════╗');
      console.log('║                  QUICK REFERENCE                              ║');
      console.log('╚════════════════════════════════════════════════════════════════╝\n');

      console.log('Meta Developers URL:');
      console.log('  https://developers.facebook.com/apps/\n');

      console.log('WhatsApp Settings:');
      console.log('  https://developers.facebook.com/docs/whatsapp/cloud-api\n');

    } catch (parseErr) {
      console.error('❌ Error parsing response:', parseErr.message);
      console.log('Raw response:', data);
    }
  });
});

req.on('error', (err) => {
  console.error('❌ Request failed:', err.message);
});

req.end();
