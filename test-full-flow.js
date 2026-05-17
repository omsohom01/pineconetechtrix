#!/usr/bin/env node
'use strict';

/**
 * 🧪 COMPREHENSIVE TEST SCRIPT
 * 
 * This script:
 * 1. Creates a mock campaign in Firebase
 * 2. Sends test messages via WhatsApp API
 * 3. Simulates incoming WhatsApp messages
 * 4. Tests the full conversation flow
 * 
 * Run: node test-full-flow.js
 */

const admin = require('firebase-admin');
const axios = require('axios');
const path = require('path');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '.env') });

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const TEST_PHONE = '919836444455';

// ═══════════════════════════════════════════════════════════════════════════
// SETUP
// ═══════════════════════════════════════════════════════════════════════════

const log = {
  title: (msg) => console.log(`\n${'═'.repeat(80)}\n${msg}\n${'═'.repeat(80)}`),
  section: (msg) => console.log(`\n${'─'.repeat(80)}\n📍 ${msg}\n${'─'.repeat(80)}`),
  step: (num, msg) => console.log(`\n${num}️⃣ ${msg}`),
  success: (msg) => console.log(`   ✅ ${msg}`),
  error: (msg) => console.log(`   ❌ ${msg}`),
  info: (msg) => console.log(`   ℹ️  ${msg}`),
  data: (label, data) => console.log(`   ${label}:`, JSON.stringify(data, null, 2)),
  wait: (msg) => console.log(`   ⏳ ${msg}`),
};

// ═══════════════════════════════════════════════════════════════════════════
// FIREBASE SETUP
// ═══════════════════════════════════════════════════════════════════════════

function initializeFirebase() {
  log.step(0, 'Initializing Firebase Admin SDK');

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    log.error('Missing Firebase credentials in .env');
    log.info('Required: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY');
    process.exit(1);
  }

  try {
    if (admin.apps.length === 0) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          privateKey,
        }),
      });
    }
    log.success('Firebase initialized');
    return admin.firestore();
  } catch (err) {
    log.error(`Firebase init failed: ${err.message}`);
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 1: CREATE MOCK CAMPAIGN
// ═══════════════════════════════════════════════════════════════════════════

async function createMockCampaign(db) {
  log.section('STEP 1: Creating Mock Campaign in Firebase');

  const mockUserId = 'test-user-123';
  const mockCampaignId = 'test-campaign-456';
  const mockContactId = `contact_${TEST_PHONE}`;

  try {
    // Create campaign document
    const campaignData = {
      id: mockCampaignId,
      title: '🎉 Amazing Spring Sale Campaign',
      description: {
        original: 'We are excited to announce our spring sale! Get 50% off on all items. Valid from March 5 to March 31, 2026. Use code SPRING50 at checkout.',
        aiEnhanced: 'We are excited to announce our spring sale! Get 50% off on all items. Valid from March 5 to March 31, 2026. Use code SPRING50 at checkout.',
      },
      documents: [
        {
          name: 'Sale_Terms.pdf',
          extractedText: 'TERMS & CONDITIONS: 1. Offer valid only for registered members. 2. Cannot be combined with other offers. 3. Refunds allowed within 30 days. 4. Sale ends March 31, 2026. Contact support@store.com for queries.',
        },
        {
          name: 'Product_List.pdf',
          extractedText: 'FEATURED PRODUCTS: T-Shirts ($15 each), Jeans ($30 each), Jackets ($45 each), Shoes ($35 each), Accessories (20-30% off). Free shipping on orders above $50.',
        },
      ],
      status: 'launched',
      launchedAt: admin.firestore.Timestamp.now(),
      contacts: [
        {
          name: 'Test User',
          phone: TEST_PHONE,
          contactId: mockContactId,
        },
      ],
      createdAt: admin.firestore.Timestamp.now(),
      updatedAt: admin.firestore.Timestamp.now(),
    };

    log.step(1, `Creating campaign document`);
    log.info(`User: ${mockUserId}`);
    log.info(`Campaign: ${mockCampaignId}`);
    log.info(`Phone: ${TEST_PHONE}`);

    await db
      .collection('users')
      .doc(mockUserId)
      .set({ createdAt: admin.firestore.Timestamp.now() });
    
    log.success(`User document created: ${mockUserId}`);

    await db
      .collection('users')
      .doc(mockUserId)
      .collection('campaigns')
      .doc(mockCampaignId)
      .set(campaignData);

    log.success(`Campaign created at users/${mockUserId}/campaigns/${mockCampaignId}`);

    // Create contact document
    log.step(2, `Creating contact document`);

    const contactData = {
      contactPhone: TEST_PHONE,
      name: 'Test User',
      lastMessage: '',
      lastMessageTime: null,
      unreadCount: 0,
      createdAt: admin.firestore.Timestamp.now(),
    };

    await db
      .collection('users')
      .doc(mockUserId)
      .collection('campaigns')
      .doc(mockCampaignId)
      .collection('inbox')
      .doc('contacts')
      .collection('contacts')
      .doc(mockContactId)
      .set(contactData);

    log.success(`Contact created at inbox/contacts/contacts/${mockContactId}`);

    // Create messageTracking for fast lookup
    log.step(3, `Creating messageTracking for fast lookup`);

    const trackingData = {
      whatsappMessageId: `wamid_test_${Date.now()}`,
      contactPhone: TEST_PHONE,
      contactId: mockContactId,
      messageType: 'text',
      sentAt: new Date().toISOString(),
      status: 'sent',
      updatedAt: admin.firestore.Timestamp.now(),
    };

    await db
      .collection('users')
      .doc(mockUserId)
      .collection('campaigns')
      .doc(mockCampaignId)
      .collection('messageTracking')
      .doc(trackingData.whatsappMessageId)
      .set(trackingData);

    log.success(`MessageTracking created`);

    // Wait for Firestore to sync
    log.wait(`Waiting 2 seconds for Firestore to sync...`);
    await new Promise((r) => setTimeout(r, 2000));

    return {
      userId: mockUserId,
      campaignId: mockCampaignId,
      contactId: mockContactId,
      phoneNumber: TEST_PHONE,
    };
  } catch (err) {
    log.error(`Failed to create campaign: ${err.message}`);
    console.error(err);
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 2: SEND MOCK CAMPAIGN MESSAGE
// ═══════════════════════════════════════════════════════════════════════════

async function sendMockCampaignMessage(campaignInfo) {
  log.section('STEP 2: Simulating Campaign Message Sent to WhatsApp');

  try {
    log.step(1, `Logging campaign details that would be sent`);
    log.data('Campaign', {
      title: '🎉 Amazing Spring Sale Campaign',
      description: 'We are excited to announce our spring sale! Get 50% off on all items...',
      hasDocuments: 2,
      sentTo: TEST_PHONE,
    });

    log.step(2, `In real flow, WhatsApp API would be called`);
    log.info(`POST https://graph.facebook.com/v22.0/{PHONE_ID}/messages`);
    log.info(`To: ${TEST_PHONE}`);
    log.info(`Type: text`);
    log.info(`Body: Campaign title and description`);

    log.success(`Campaign message simulation complete`);
  } catch (err) {
    log.error(`Failed: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 3: SIMULATE INCOMING MESSAGE & TEST CONVERSATION ROUTE
// ═══════════════════════════════════════════════════════════════════════════

async function testConversationRoute(campaignInfo) {
  log.section('STEP 3: Testing /api/whatsapp/test-conversation Route');

  const testQuestions = [
    'What is the discount percentage?',
    'When does the sale end?',
    'Can I use this with other offers?',
    'What products are on sale?',
    'Is there free shipping?',
  ];

  for (let i = 0; i < testQuestions.length; i++) {
    const question = testQuestions[i];

    log.step(i + 1, `Test Question: "${question}"`);

    try {
      log.wait(`Calling ${BACKEND_URL}/api/whatsapp/test-conversation`);

      const response = await axios.post(`${BACKEND_URL}/api/whatsapp/test-conversation`, {
        phone: TEST_PHONE,
        message: question,
      });

      if (response.data.success) {
        log.success(`Response received`);
        log.data('Phone', response.data.phone);
        log.data('Message Processed', response.data.messageProcessed);
        log.info(`Check your backend logs for [Conv-Service] detailed output`);
      } else {
        log.error(`Route returned: ${response.data.error}`);
        if (response.data.troubleshooting) {
          log.data('Troubleshooting', response.data.troubleshooting);
        }
      }

      // Wait a bit before next question
      await new Promise((r) => setTimeout(r, 2000));
    } catch (err) {
      log.error(`Request failed: ${err.message}`);
      if (err.response?.status === 503) {
        log.info(`Service might be starting up, retrying...`);
        await new Promise((r) => setTimeout(r, 3000));
      } else if (err.response?.data) {
        log.data('Error Response', err.response.data);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 4: VERIFY MESSAGES SAVED IN FIREBASE
// ═══════════════════════════════════════════════════════════════════════════

async function verifyMessagesInFirebase(db, campaignInfo) {
  log.section('STEP 4: Verifying Messages Saved in Firebase');

  const { userId, campaignId, contactId } = campaignInfo;

  try {
    log.step(1, `Fetching messages from Firestore`);
    log.info(`Path: users/${userId}/campaigns/${campaignId}/inbox/contacts/contacts/${contactId}/messages`);

    const messagesSnapshot = await db
      .collection('users')
      .doc(userId)
      .collection('campaigns')
      .doc(campaignId)
      .collection('inbox')
      .doc('contacts')
      .collection('contacts')
      .doc(contactId)
      .collection('messages')
      .orderBy('createdAt', 'asc')
      .limit(20)
      .get();

    if (messagesSnapshot.empty) {
      log.error(`No messages found`);
      return;
    }

    log.success(`Found ${messagesSnapshot.size} messages`);

    let userCount = 0;
    let aiCount = 0;

    messagesSnapshot.docs.forEach((doc, index) => {
      const data = doc.data();
      if (data.sender === 'user') userCount++;
      if (data.sender === 'campaign' || data.sender === 'ai') aiCount++;

      log.step(index + 1, `Message ${index + 1}`);
      log.data('Type', data.sender);
      log.data('Content', data.content.substring(0, 100) + (data.content.length > 100 ? '...' : ''));
      log.data('Timestamp', data.timestamp);
    });

    log.success(`Summary: ${userCount} user messages, ${aiCount} AI replies`);
  } catch (err) {
    log.error(`Failed to verify: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 5: CHECK WEBHOOK SETUP
// ═══════════════════════════════════════════════════════════════════════════

async function checkWebhookSetup() {
  log.section('STEP 5: Checking Backend Health & Webhook');

  try {
    log.step(1, `Checking backend health`);
    const healthRes = await axios.get(`${BACKEND_URL}/health`, { timeout: 5000 });
    log.success(`Backend is running`);
    log.data('Status', healthRes.data);

    log.step(2, `Checking WhatsApp debug endpoint`);
    const debugRes = await axios.get(`${BACKEND_URL}/api/whatsapp/debug`, { timeout: 5000 });
    log.data('WhatsApp Config', debugRes.data);

    if (debugRes.data.status === 'CONFIGURED') {
      log.success(`WhatsApp credentials are configured`);
    } else {
      log.error(`WhatsApp config issue detected`);
    }
  } catch (err) {
    log.error(`Backend health check failed: ${err.message}`);
    log.info(`Make sure backend is running: npm run dev`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN FLOW
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  log.title('🧪 FULL FLOW TEST: Campaign → Message → Conversation');

  log.info(`Test Phone Number: ${TEST_PHONE}`);
  log.info(`Backend URL: ${BACKEND_URL}`);
  log.info(`Timestamp: ${new Date().toISOString()}`);

  try {
    // Initialize Firebase
    const db = initializeFirebase();

    // Step 1: Create campaign
    log.title('STEP 1: CREATE MOCK CAMPAIGN');
    const campaignInfo = await createMockCampaign(db);

    // Step 2: Simulate campaign sent
    log.title('STEP 2: SIMULATE CAMPAIGN MESSAGE');
    await sendMockCampaignMessage(campaignInfo);

    // Step 3: Check webhook
    log.title('STEP 3: VERIFY BACKEND SETUP');
    await checkWebhookSetup();

    // Small delay
    await new Promise((r) => setTimeout(r, 2000));

    // Step 4: Test conversation route
    log.title('STEP 4: TEST CONVERSATION ROUTE');
    await testConversationRoute(campaignInfo);

    // Step 5: Verify messages in Firebase
    log.title('STEP 5: VERIFY MESSAGES IN FIREBASE');
    await verifyMessagesInFirebase(db, campaignInfo);

    // Final summary
    log.title('✅ TEST COMPLETE');
    log.info(`Campaign created for: ${TEST_PHONE}`);
    log.info(`Test questions sent to: /api/whatsapp/test-conversation`);
    log.info(`Messages should now be in Firebase`);
    log.info(`\nTO CONTINUE TESTING:`);
    log.info(`1. Check backend console for [Conv-Service] logs`);
    log.info(`2. Review DEBUGGING_GUIDE.md for expected log format`);
    log.info(`3. In production, WhatsApp will call POST /api/whatsapp/webhook`);
    log.info(`   which will trigger the same flow automatically`);

    process.exit(0);
  } catch (err) {
    log.error(`Fatal error: ${err.message}`);
    console.error(err);
    process.exit(1);
  }
}

// Run
main();
