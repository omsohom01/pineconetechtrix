#!/usr/bin/env node

/**
 * Test Script - Simple Hackathon Message
 * Tests if messages are being delivered to WhatsApp
 */

const https = require('https');

const BACKEND_URL = 'https://double-slash-backend.onrender.com';
const RECIPIENT_PHONE = '919836444455'; // Your test number

// Simple hackathon campaign
const testPayload = {
  contacts: [
    {
      name: 'Sohom',
      phone: RECIPIENT_PHONE,
    },
  ],
  title: '🏆 Smart India Hackathon Invitation',
  description: 'You are invited to participate in the Smart India Hackathon 2025! This is an amazing opportunity to showcase your tech skills and win exciting prizes. Register now!',
  audioUrl: null,
  assets: [],
};

console.log('\n╔════════════════════════════════════════════════════════════════╗');
console.log('║           HACKATHON MESSAGE TEST                              ║');
console.log('╚════════════════════════════════════════════════════════════════╝\n');

console.log('📋 Test Configuration:');
console.log(`   📱 Recipient: ${RECIPIENT_PHONE}`);
console.log(`   📝 Title: ${testPayload.title}`);
console.log(`   📄 Message: ${testPayload.description}`);
console.log(`   🎵 Voice: None (simple text test)`);
console.log(`   📎 Attachments: None\n`);

console.log('🔄 Sending via backend API...\n');

const postData = JSON.stringify(testPayload);

const options = {
  hostname: 'double-slash-backend.onrender.com',
  port: 443,
  path: '/api/whatsapp/send-campaign',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData),
  },
};

const req = https.request(options, (res) => {
  let data = '';

  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    console.log(`\n📡 Response Status: ${res.statusCode}\n`);

    try {
      const response = JSON.parse(data);

      if (response.success) {
        console.log('✅ ✅ ✅ REQUEST SUCCESSFUL! ✅ ✅ ✅\n');
        console.log('Summary:');
        console.log(`   ✅ Messages Sent: ${response.summary.sent}`);
        console.log(`   ❌ Failed: ${response.summary.failed}`);
        console.log(`   ⏭️  Skipped: ${response.summary.skipped}`);

        console.log('\n📱 What to expect:');
        console.log('   ✓ Check WhatsApp on ' + RECIPIENT_PHONE);
        console.log('   ✓ You should see the hackathon invitation message');
        console.log('   ✓ Message: "🏆 Smart India Hackathon Invitation"');
        console.log('   ✓ Followed by: "You are invited to participate..."');

        console.log('\n⚠️  If no message appears:');
        console.log('   1. Verify ' + RECIPIENT_PHONE + ' is added as test recipient');
        console.log('   2. Check your WhatsApp Business Account in Meta Developers');
        console.log('   3. Make sure access token is valid');
        console.log('   4. Check phone number is registered\n');

        // Show detailed results
        if (response.results && response.results.length > 0) {
          console.log('Detailed Results:');
          response.results.forEach((result, idx) => {
            console.log(`\n   Contact ${idx + 1}: ${result.name} (${result.phone})`);
            console.log(`   Status: ${result.status}`);
            if (result.messages) {
              console.log(`   Messages Sent: ${result.messages.length}`);
              result.messages.forEach((msg, midx) => {
                console.log(`      ${midx + 1}. ${msg.type.toUpperCase()} - ID: ${msg.id?.substring(0, 20)}...`);
              });
            }
            if (result.error) {
              console.log(`   Error: ${result.error}`);
              console.log(`   Error Code: ${result.errorCode}`);
            }
          });
        }
      } else {
        console.log('❌ ❌ ❌ REQUEST FAILED! ❌ ❌ ❌\n');
        console.log('Error:', response.error);
      }

      console.log('\n╔════════════════════════════════════════════════════════════════╗');
      console.log('║                  TEST COMPLETE                                    ║');
      console.log('╚════════════════════════════════════════════════════════════════╝\n');

    } catch (parseErr) {
      console.error('❌ Failed to parse response:', parseErr.message);
      console.log('Raw response:', data);
    }
  });
});

req.on('error', (err) => {
  console.error('❌ Request error:', err.message);
  console.error('\nTroubleshooting:');
  console.error('   • Check if backend is running');
  console.error('   • Verify network connection');
  console.error('   • Check environment variables (WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN)\n');
});

req.write(postData);
req.end();
