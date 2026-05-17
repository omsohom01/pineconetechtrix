#!/usr/bin/env node
'use strict';

/**
 * 🔍 COMPREHENSIVE WEBHOOK DIAGNOSTIC
 * 
 * Tests everything that could prevent incoming messages from being received:
 * 1. Backend is running and accessible
 * 2. Webhook endpoint responds
 * 3. Environment variables are set
 * 4. Firebase can be accessed
 * 5. Webhook verify token is correct
 * 6. Test webhook locally
 * 
 * Run: node webhook-diagnostic.js
 */

const axios = require('axios');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '.env') });

const BACKEND_URL = process.env.RENDER_URL || 'http://localhost:3001';

const log = {
  title: (msg) => console.log(`\n${'═'.repeat(80)}\n${msg}\n${'═'.repeat(80)}`),
  section: (msg) => console.log(`\n${'─'.repeat(80)}\n📍 ${msg}\n${'─'.repeat(80)}`),
  step: (num, msg) => console.log(`\n${num}️⃣ ${msg}`),
  success: (msg) => console.log(`   ✅ ${msg}`),
  error: (msg) => console.log(`   ❌ ${msg}`),
  warning: (msg) => console.log(`   ⚠️  ${msg}`),
  info: (msg) => console.log(`   ℹ️  ${msg}`),
};

async function test1_BackendRunning() {
  log.section('TEST 1: Backend Server Running');

  try {
    log.step(1, `Checking if backend is accessible at: ${BACKEND_URL}`);
    
    const response = await axios.get(`${BACKEND_URL}/`, { timeout: 5000 });
    
    if (response.data?.status === 'OK') {
      log.success(`Backend is running and responding`);
      log.info(`Service: ${response.data.service}`);
      return true;
    } else {
      log.error(`Backend responded but with unexpected data`);
      console.log('Response:', response.data);
      return false;
    }
  } catch (err) {
    log.error(`Backend is NOT responding`);
    log.error(`Error: ${err.message}`);
    log.info(`If on Render: Check dashboard → Logs → is service running?`);
    log.info(`If local: Run 'npm run dev' to start backend`);
    return false;
  }
}

async function test2_WebhookEndpoint() {
  log.section('TEST 2: Webhook Endpoint Accessible');

  try {
    log.step(1, `Testing webhook status endpoint`);
    
    const response = await axios.get(`${BACKEND_URL}/api/whatsapp/webhook-status`, { timeout: 5000 });
    
    if (response.data?.webhook_url) {
      log.success(`Webhook endpoint is accessible`);
      log.info(`Webhook URL: ${response.data.webhook_url}`);
      return true;
    } else {
      log.error(`Endpoint responded but no webhook URL`);
      return false;
    }
  } catch (err) {
    log.error(`Webhook status endpoint not responding`);
    log.error(`Error: ${err.message}`);
    return false;
  }
}

function test3_EnvironmentVariables() {
  log.section('TEST 3: Environment Variables Set');

  const required = [
    'FIREBASE_PROJECT_ID',
    'FIREBASE_CLIENT_EMAIL',
    'FIREBASE_PRIVATE_KEY',
    'GEMINI_WHATSAPP_API_KEY',
    'WHATSAPP_PHONE_NUMBER_ID',
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
  ];

  let allSet = true;

  for (const envVar of required) {
    const value = process.env[envVar];
    if (value) {
      const preview = envVar.includes('KEY') || envVar.includes('TOKEN') || envVar.includes('PRIVATE')
        ? `${value.substring(0, 10)}...` 
        : value;
      log.success(`${envVar} = ${preview}`);
    } else {
      log.error(`${envVar} is NOT SET!`);
      allSet = false;
    }
  }

  if (!allSet) {
    log.warning(`Missing environment variables! Create/update .env file`);
    log.info(`Example .env:`);
    console.log(`
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_CLIENT_EMAIL=...@iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----"
GEMINI_WHATSAPP_API_KEY=your-api-key
WHATSAPP_PHONE_NUMBER_ID=1234567890123456
WHATSAPP_ACCESS_TOKEN=your-access-token
WHATSAPP_WEBHOOK_VERIFY_TOKEN=your-verify-token
    `);
  }

  return allSet;
}

async function test4_WebhookInMeta() {
  log.section('TEST 4: Webhook Registered in Meta');

  log.step(1, `Instructions to verify webhook in Meta Business Manager:`);
  console.log(`
  1. Go to: https://developers.facebook.com/
  2. Select your WhatsApp app
  3. Go to: Settings → Webhooks → WhatsApp Business Account
  4. Look for: "Callback URL"
  
  It should be:
  ✅ https://double-slash-backend.onrender.com/api/whatsapp/webhook
  
  It SHOULD NOT be:
  ❌ http://localhost:3001/api/whatsapp/webhook
  ❌ http://your-old-backend.com/endpoint
  ❌ (empty/blank)
  
  5. Verify Token should match: WHATSAPP_WEBHOOK_VERIFY_TOKEN
  6. Make sure "messages" field is CHECKED/SUBSCRIBED
  
  WITHOUT this setup, Meta won't send incoming messages to your backend!
  `);

  log.warning(`Cannot auto-verify webhook in Meta from here`);
  log.info(`You must manually check Meta dashboard`);

  return null; // Manual verification required
}

async function test5_SimulateWebhook() {
  log.section('TEST 5: Simulate Webhook Locally');

  try {
    log.step(1, `Sending test webhook POST to: ${BACKEND_URL}/api/whatsapp/webhook`);

    const testWebhook = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: '919836444455',
                    id: 'test_msg_' + Date.now(),
                    type: 'text',
                    text: { body: 'This is a test message from diagnostic' },
                    timestamp: Math.floor(Date.now() / 1000).toString(),
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const response = await axios.post(`${BACKEND_URL}/api/whatsapp/webhook`, testWebhook, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000,
    });

    if (response.status === 200) {
      log.success(`Webhook POST succeeded (status 200)`);
      log.info(`Backend accepted the webhook`);
      log.step(2, `Check backend logs for:`);
      console.log(`
  🔔 [WEBHOOK RECEIVED]
  📋 Webhook body: { object: 'whatsapp_business_account', entriesCount: 1 }
  🤳 Processing 1 incoming message(s)...
  ▓▓ 🔔 INCOMING MESSAGE HANDLER TRIGGERED
  ▓▓ 📱 Phone: 919836444455
  ▓▓ 📬 Type: text
  ▓▓ 📝 TEXT MESSAGE: "This is a test message from diagnostic"
      `);
      return true;
    } else {
      log.error(`Unexpected status: ${response.status}`);
      return false;
    }
  } catch (err) {
    log.error(`Failed to send test webhook`);
    log.error(`Error: ${err.message}`);
    log.info(`If it says "Connection refused": Backend not running`);
    return false;
  }
}

async function test6_FirebaseAccess() {
  log.section('TEST 6: Firebase Connection');

  try {
    const admin = require('firebase-admin');
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

    if (!projectId || !clientEmail || !privateKey) {
      log.error(`Firebase credentials not set in .env`);
      return false;
    }

    log.step(1, `Initializing Firebase Admin...`);

    if (admin.apps.length === 0) {
      admin.initializeApp({
        credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
      });
    }

    const db = admin.firestore();

    log.step(2, `Testing Firestore read access...`);

    const usersSnap = await db.collection('users').limit(1).get();
    log.success(`Firebase Firestore is accessible`);
    log.info(`Found ${usersSnap.size} user(s) in database`);

    return true;
  } catch (err) {
    log.error(`Firebase connection failed`);
    log.error(`Error: ${err.message}`);
    log.info(`Check: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY`);
    return false;
  }
}

async function test7_GeminiAccess() {
  log.section('TEST 7: Gemini API Access');

  try {
    const apiKey = process.env.GEMINI_WHATSAPP_API_KEY;

    if (!apiKey) {
      log.error(`GEMINI_WHATSAPP_API_KEY not set in .env`);
      return false;
    }

    log.step(1, `Testing Gemini API connectivity...`);

    const response = await axios.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
      {
        contents: [
          {
            parts: [
              {
                text: 'Say "Gemini API is working" in 5 words.',
              },
            ],
          },
        ],
      },
      {
        params: { key: apiKey },
        timeout: 10000,
      }
    );

    if (response.status === 200) {
      log.success(`Gemini API is accessible and working`);
      return true;
    } else {
      log.error(`Gemini API responded with status ${response.status}`);
      return false;
    }
  } catch (err) {
    if (err.response?.status === 400) {
      log.error(`Gemini API returned 400 - possibly invalid API key`);
    } else {
      log.error(`Gemini API connection failed: ${err.message}`);
    }
    log.info(`Check: GEMINI_WHATSAPP_API_KEY in .env`);
    return false;
  }
}

async function test8_WhatsAppToken() {
  log.section('TEST 8: WhatsApp API Token Validity');

  try {
    const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const token = process.env.WHATSAPP_ACCESS_TOKEN;

    if (!phoneId || !token) {
      log.error(`Missing WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN`);
      return false;
    }

    log.step(1, `Checking WhatsApp token validity...`);

    const response = await axios.get(
      `https://graph.facebook.com/v19.0/${phoneId}?fields=verified_name,display_phone_number`,
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 5000,
      }
    );

    if (response.status === 200) {
      log.success(`WhatsApp token is VALID`);
      log.data('Phone Number', response.data.display_phone_number);
      return true;
    } else {
      log.error(`WhatsApp API returned status ${response.status}`);
      return false;
    }
  } catch (err) {
    if (err.response?.status === 401) {
      log.error(`❌ WhatsApp token is EXPIRED or INVALID (401)`);
      log.info(`You MUST regenerate token from Meta Business Manager`);
      log.info(`Go to: https://developers.facebook.com/ → Your App → Settings → User Tokens`);
    } else {
      log.error(`WhatsApp API error: ${err.message}`);
    }
    return false;
  }
}

async function main() {
  log.title('🔍 COMPREHENSIVE WEBHOOK DIAGNOSTIC');

  log.info(`Backend URL: ${BACKEND_URL}`);
  log.info(`Testing all components...`);

  const results = [];

  // Test 1: Backend running
  const test1 = await test1_BackendRunning();
  results.push({ name: 'Backend Running', passed: test1 });

  if (!test1) {
    log.title('❌ DIAGNOSTIC FAILED - Backend Not Running');
    log.error(`Cannot continue without backend`);
    log.info(`If on Render: Check dashboard for service status`);
    log.info(`If local: Run: npm run dev`);
    process.exit(1);
  }

  // Test 2: Webhook endpoint
  const test2 = await test2_WebhookEndpoint();
  results.push({ name: 'Webhook Endpoint', passed: test2 });

  // Test 3: Environment variables
  const test3 = test3_EnvironmentVariables();
  results.push({ name: 'Environment Variables', passed: test3 });

  // Test 4: Webhook in Meta (manual)
  await test4_WebhookInMeta();
  results.push({ name: 'Webhook in Meta', passed: null }); // Manual verification

  // Test 5: Simulate webhook
  const test5 = await test5_SimulateWebhook();
  results.push({ name: 'Simulate Webhook', passed: test5 });

  // Test 6: Firebase
  const test6 = await test6_FirebaseAccess();
  results.push({ name: 'Firebase Access', passed: test6 });

  // Test 7: Gemini
  const test7 = await test7_GeminiAccess();
  results.push({ name: 'Gemini API', passed: test7 });

  // Test 8: WhatsApp token
  const test8 = await test8_WhatsAppToken();
  results.push({ name: 'WhatsApp Token', passed: test8 });

  // Summary
  log.title('📊 DIAGNOSTIC SUMMARY');

  const passed = results.filter((r) => r.passed === true).length;
  const failed = results.filter((r) => r.passed === false).length;
  const manual = results.filter((r) => r.passed === null).length;

  console.log(`\nResults: ${passed} Passed | ${failed} Failed | ${manual} Manual\n`);

  for (const result of results) {
    if (result.passed === true) {
      console.log(`  ✅ ${result.name}`);
    } else if (result.passed === false) {
      console.log(`  ❌ ${result.name}`);
    } else {
      console.log(`  ⏸️  ${result.name} (Manual Verification Required)`);
    }
  }

  log.title('🚨 IF NOTHING IS WORKING');

  console.log(`
Check in this order:

1. ❓ Backend running?
   → On Render: Check dashboard Logs tab
   → Local: Run: npm run dev

2. ❓ Environment variables set?
   → On Render: Check Settings → Environment Variables
   → Local: Check .env file exists with all variables

3. ❓ Webhook registered in Meta?
   → Most common issue! Go to Meta Business Manager
   → Settings → Webhooks → WhatsApp Business Account
   → Callback URL must be: https://double-slash-backend.onrender.com/api/whatsapp/webhook
   → Subscribe to: messages field

4. ❓ Webhook verify token matches?
   → Meta Webhooks page: Verify Token
   → Your .env: WHATSAPP_WEBHOOK_VERIFY_TOKEN
   → They must be EXACTLY the same

5. ❓ WhatsApp access token expired?
   → Run this diagnostic again
   → Look for "WhatsApp Token" section
   → If it says 401 = Token is expired, regenerate it

6. ❓ Phone number registered in Meta Account?
   → Go to: https://business.facebook.com/
   → Phone Numbers section
   → Must be verified with green checkmark

After fixing, send a test message on WhatsApp and check logs for:
→ 🔔 [WEBHOOK RECEIVED]
  `);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('❌ Diagnostic error:', err.message);
  process.exit(1);
});
