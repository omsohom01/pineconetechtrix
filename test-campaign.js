#!/usr/bin/env node

/**
 * Test Campaign WhatsApp Sending
 * Simulates what happens when you launch a campaign
 */

const https = require('https');

const BACKEND_URL = 'https://double-slash-backend.onrender.com';
const RECIPIENT_PHONE = '919836444455'; // Your India number (recipient)

// Simulate a campaign payload
const campaignPayload = {
  contacts: [
    {
      name: 'Sohom',
      phone: RECIPIENT_PHONE,
    },
  ],
  title: 'Smart India Hackathon 2025 🚀',
  description: 'You are invited to participate in the Smart India Hackathon! 🎉\n\nJoin us for an amazing experience where you can showcase your skills and build innovative solutions.\n\nDate: March 15-16, 2025\nLocation: Virtual + On-site\n\nRegister now at: smartindiahackathon.com',
  audioUrl: 'https://res.cloudinary.com/outreachx/raw/upload/v1772610051/outreachx-campaigns/campaigns/user_3ARaRTixmCoRJhICh9Rq9u6XXBY/voice_kovuMxt6GIFScEICuUEa.wav', // Voice note
  assets: [
    {
      url: 'https://via.placeholder.com/400x300?text=SIH+2025+Invitation',
      name: 'hackathon-poster.jpg',
    },
  ],
};

console.log('═══════════════════════════════════════════════════════════════');
console.log('🚀 CAMPAIGN TEST SCRIPT');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log('📋 Campaign Details:');
console.log(`   Title: ${campaignPayload.title}`);
console.log(`   Description: ${campaignPayload.description}`);
console.log(`   Recipients: ${campaignPayload.contacts.length}`);
console.log(`   To Phone: ${RECIPIENT_PHONE}`);
console.log(`   Assets: ${campaignPayload.assets.length}`);
console.log('');

console.log('🔄 Sending campaign via backend...\n');

// Make POST request to backend
const postData = JSON.stringify(campaignPayload);

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
    console.log(`\n📡 Backend Response (Status: ${res.statusCode}):\n`);

    try {
      const response = JSON.parse(data);
      console.log(JSON.stringify(response, null, 2));

      console.log('\n═══════════════════════════════════════════════════════════════');

      if (response.success) {
        console.log('✅ CAMPAIGN SENDING SUCCESSFUL!\n');
        console.log('Summary:');
        console.log(`   ✅ Sent: ${response.summary.sent}`);
        console.log(`   ❌ Failed: ${response.summary.failed}`);
        console.log(`   ⏭️  Skipped: ${response.summary.skipped}`);

        console.log('\n📱 Check your WhatsApp for the test message!');
        console.log(`   Phone: ${RECIPIENT_PHONE}`);
        console.log('');
        console.log('Expected messages:');
        console.log('   1️⃣ Text message with campaign title & description');
        console.log('   2️⃣ Image attachment\n');
      } else {
        console.log('❌ CAMPAIGN SENDING FAILED!\n');
        console.log('Error:', response.error);
        console.log('\nTroubleshooting:');
        console.log('  • Check if phone number is added to test recipients');
        console.log('  • Verify the access token is still valid');
        console.log('  • Make sure phone number format is correct (country code + digits)\n');
      }

      console.log('═══════════════════════════════════════════════════════════════\n');
    } catch (err) {
      console.error('❌ Failed to parse response:', err.message);
      console.error('Raw response:', data);
    }
  });
});

req.on('error', (error) => {
  console.error('❌ Request failed:', error);
});

req.write(postData);
req.end();
