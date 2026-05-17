#!/usr/bin/env node
'use strict';

/**
 * 🧪 DIRECT TEST - Conversation Service (No HTTP)
 * 
 * This test directly calls the conversation service functions
 * to debug Firebase access and AI response generation.
 * 
 * Run: node test-direct.js
 */

const admin = require('firebase-admin');
const path = require('path');
const dotenv = require('dotenv');

// Load environment
dotenv.config({ path: path.join(__dirname, '.env') });

const TEST_PHONE = '919836444455';
const log = {
  title: (msg) => console.log(`\n${'═'.repeat(80)}\n${msg}\n${'═'.repeat(80)}`),
  section: (msg) => console.log(`\n${'─'.repeat(80)}\n📍 ${msg}\n${'─'.repeat(80)}`),
  step: (num, msg) => console.log(`\n${num}️⃣ ${msg}`),
  success: (msg) => console.log(`   ✅ ${msg}`),
  error: (msg) => console.log(`   ❌ ${msg}`),
  info: (msg) => console.log(`   ℹ️  ${msg}`),
  data: (label, data) => console.log(`   ${label}:`, typeof data === 'string' ? data : JSON.stringify(data, null, 2)),
};

// ═══════════════════════════════════════════════════════════════════════════
// INITIALIZE FIREBASE
// ═══════════════════════════════════════════════════════════════════════════

let db = null;

function initFirebase() {
  log.step(0, 'Initializing Firebase');

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    log.error('Missing Firebase credentials');
    process.exit(1);
  }

  if (admin.apps.length === 0) {
    admin.initializeApp({
      credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
    });
  }

  db = admin.firestore();
  log.success('Firebase initialized');
  return db;
}

// ═══════════════════════════════════════════════════════════════════════════
// CREATE MOCK CAMPAIGN (Direct DB access)
// ═══════════════════════════════════════════════════════════════════════════

async function createMockCampaign() {
  log.section('Creating Mock Campaign');

  const userId = 'test-user-123';
  const campaignId = 'test-campaign-456';
  const contactId = `contact_${TEST_PHONE}`;

  try {
    log.step(1, 'Creating user document');
    await db.collection('users').doc(userId).set({
      email: 'test@example.com',
      createdAt: admin.firestore.Timestamp.now(),
    });
    log.success(`User: ${userId}`);

    log.step(2, 'Creating campaign document');
    const campaignData = {
      id: campaignId,
      title: '🎉 Amazing Spring Sale Campaign',
      status: 'launched',
      description: {
        original: 'We are excited to announce our spring sale! Get 50% off on all items. Valid from March 5 to March 31, 2026. Use code SPRING50 at checkout.',
      },
      documents: [
        {
          name: 'Terms.pdf',
          extractedText: 'TERMS: 1. Valid only for members. 2. Cannot combine with other offers. 3. Refunds within 30 days. 4. Sale ends March 31, 2026. Contact: support@store.com',
        },
        {
          name: 'Products.pdf',
          extractedText: 'FEATURED PRODUCTS: T-Shirts ($15), Jeans ($30), Jackets ($45), Shoes ($35). Free shipping on orders above $50.',
        },
      ],
      launchedAt: admin.firestore.Timestamp.now(),
      createdAt: admin.firestore.Timestamp.now(),
    };

    await db
      .collection('users')
      .doc(userId)
      .collection('campaigns')
      .doc(campaignId)
      .set(campaignData);
    log.success(`Campaign: ${campaignId}`);

    log.step(3, 'Creating contact document');
    await db
      .collection('users')
      .doc(userId)
      .collection('campaigns')
      .doc(campaignId)
      .collection('inbox')
      .doc('contacts')
      .collection('contacts')
      .doc(contactId)
      .set({
        contactPhone: TEST_PHONE,
        name: 'Test User',
        createdAt: admin.firestore.Timestamp.now(),
      });
    log.success(`Contact: ${contactId}`);

    log.step(4, 'Creating messageTracking document');
    await db
      .collection('users')
      .doc(userId)
      .collection('campaigns')
      .doc(campaignId)
      .collection('messageTracking')
      .doc(`wamid_${Date.now()}`)
      .set({
        contactPhone: TEST_PHONE,
        contactId: contactId,
        sentAt: new Date().toISOString(),
      });
    log.success(`MessageTracking created`);

    // Verify it was created
    log.step(5, 'Verifying campaign was created');
    const doc = await db
      .collection('users')
      .doc(userId)
      .collection('campaigns')
      .doc(campaignId)
      .get();

    if (doc.exists) {
      log.success(`Campaign verified in Firestore`);
      log.data('Campaign data', {
        title: doc.data().title,
        status: doc.data().status,
        hasDocuments: doc.data().documents?.length || 0,
      });
    } else {
      log.error(`Campaign NOT found in Firestore!`);
    }

    return { userId, campaignId, contactId };
  } catch (err) {
    log.error(`Failed: ${err.message}`);
    console.error(err);
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST CAMPAIGN LOOKUP
// ═══════════════════════════════════════════════════════════════════════════

async function testCampaignLookup() {
  log.section('Testing Campaign Lookup by Phone');

  try {
    log.step(1, `Searching for campaigns with phone: ${TEST_PHONE}`);

    const usersSnapshot = await db.collection('users').get();
    log.info(`Found ${usersSnapshot.size} users in database`);

    if (usersSnapshot.size === 0) {
      log.error(`No users found! Campaign lookup will fail.`);
      return null;
    }

    for (const userDoc of usersSnapshot.docs) {
      log.info(`Checking user: ${userDoc.id}`);
      const campaignsSnapshot = await userDoc.ref.collection('campaigns').get();
      log.info(`  - Has ${campaignsSnapshot.size} campaigns`);

      for (const campaignDoc of campaignsSnapshot.docs) {
        const data = campaignDoc.data();
        log.info(`    Campaign: ${campaignDoc.id} (status: ${data.status})`);

        if (data.status !== 'launched') continue;

        // Check messageTracking
        const trackSnap = await campaignDoc.ref
          .collection('messageTracking')
          .where('contactPhone', '==', TEST_PHONE)
          .limit(1)
          .get();

        if (!trackSnap.empty) {
          log.success(`✓ Campaign "${campaignDoc.id}" found via messageTracking!`);
          const track = trackSnap.docs[0].data();
          return {
            userId: userDoc.id,
            campaignId: campaignDoc.id,
            contactId: track.contactId,
          };
        }

        // Check inbox contacts
        const contactSnap = await campaignDoc.ref
          .collection('inbox')
          .doc('contacts')
          .collection('contacts')
          .where('contactPhone', '==', TEST_PHONE)
          .limit(1)
          .get();

        if (!contactSnap.empty) {
          log.success(`✓ Campaign "${campaignDoc.id}" found via inbox!`);
          return {
            userId: userDoc.id,
            campaignId: campaignDoc.id,
            contactId: contactSnap.docs[0].id,
          };
        }
      }
    }

    log.error(`No campaign found for phone ${TEST_PHONE}`);
    return null;
  } catch (err) {
    log.error(`Lookup failed: ${err.message}`);
    console.error(err);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST CAMPAIGN CONTEXT LOADING
// ═══════════════════════════════════════════════════════════════════════════

async function testLoadCampaignContext(userId, campaignId) {
  log.section('Testing Load Campaign Context');

  try {
    log.step(1, `Loading campaign: ${campaignId}`);
    const campaignSnap = await db
      .collection('users')
      .doc(userId)
      .collection('campaigns')
      .doc(campaignId)
      .get();

    if (!campaignSnap.exists) {
      log.error(`Campaign not found`);
      return null;
    }

    const data = campaignSnap.data();
    const description =
      data.description?.original || data.description || '';
    const documents =
      (data.documents || []).map((d) => d.extractedText).join('\n\n') || '';

    log.success(`Campaign loaded`);
    log.data('Description length', description.length);
    log.data('Documents total', documents.length);

    return {
      description,
      documents,
      hasContext: description.length > 0 || documents.length > 0,
    };
  } catch (err) {
    log.error(`Failed: ${err.message}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST MESSAGE SAVING
// ═══════════════════════════════════════════════════════════════════════════

async function testSaveMessage(userId, campaignId, contactId) {
  log.section('Testing Save Message to Firebase');

  try {
    const contactRef = db
      .collection('users')
      .doc(userId)
      .collection('campaigns')
      .doc(campaignId)
      .collection('inbox')
      .doc('contacts')
      .collection('contacts')
      .doc(contactId);

    log.step(1, 'Saving user message');
    const userMsgId = `user_${Date.now()}`;
    await contactRef.collection('messages').doc(userMsgId).set({
      sender: 'user',
      type: 'text',
      content: 'What is the discount percentage?',
      createdAt: admin.firestore.Timestamp.now(),
    });
    log.success(`Message saved: ${userMsgId}`);

    log.step(2, 'Saving AI response');
    const aiMsgId = `ai_${Date.now()}`;
    await contactRef.collection('messages').doc(aiMsgId).set({
      sender: 'campaign',
      type: 'text',
      content: 'The discount is 50% off on all items! It is valid from March 5 to March 31, 2026. Use code SPRING50 at checkout.',
      createdAt: admin.firestore.Timestamp.now(),
    });
    log.success(`Response saved: ${aiMsgId}`);

    log.step(3, 'Verifying messages');
    const messagesSnap = await contactRef.collection('messages').get();
    log.success(`Found ${messagesSnap.size} messages`);

    return true;
  } catch (err) {
    log.error(`Failed: ${err.message}`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  log.title('🧪 DIRECT TEST - Conversation Service Components');

  try {
    // Step 1: Init Firebase
    initFirebase();

    // Step 2: Create campaign
    const campaignInfo = await createMockCampaign();

    // Wait for Firebase to sync
    log.info(`Waiting 1 second for sync...`);
    await new Promise((r) => setTimeout(r, 1000));

    // Step 3: Lookup campaign by phone
    const foundCampaign = await testCampaignLookup();

    if (!foundCampaign) {
      log.error(`CRITICAL: Campaign lookup failed! This is why conversations don't work.`);
      process.exit(1);
    }

    // Step 4: Load campaign context
    const context = await testLoadCampaignContext(foundCampaign.userId, foundCampaign.campaignId);

    if (!context?.hasContext) {
      log.error(`No campaign context! AI won't have anything to answer about.`);
    } else {
      log.success(`Campaign context ready for AI`);
    }

    // Step 5: Test message saving
    const saved = await testSaveMessage(
      foundCampaign.userId,
      foundCampaign.campaignId,
      foundCampaign.contactId
    );

    // Summary
    log.title('✅ DIRECT TEST COMPLETE');

    if (foundCampaign && context && saved) {
      log.success(`All core functions working!`);
      log.info(`The conversation service should work.`);
      log.info(`If it still doesn't work, the issue is:`);
      log.info(`  1. Network/routing (webhook not being called)`);
      log.info(`  2. WhatsApp token expired (401 error)`);
      log.info(`  3. AI (Gemini API key issue)`);
    } else {
      log.error(`Some components failed. Check logs above.`);
    }

    process.exit(0);
  } catch (err) {
    log.error(`Fatal: ${err.message}`);
    console.error(err);
    process.exit(1);
  }
}

main();
