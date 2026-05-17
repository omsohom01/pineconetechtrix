#!/usr/bin/env node
'use strict';

/**
 * 🧪 DIAGNOSTIC TEST
 * 
 * 1. Create test data via direct Firebase  
 * 2. Call backend HTTP endpoint to test its Firebase access
 * 3. Compare if backend sees the same data
 */

const admin = require('firebase-admin');
const path = require('path');
const dotenv = require('dotenv');
const axios = require('axios');

dotenv.config({ path: path.join(__dirname, '.env') });

const TEST_PHONE = '919836444455';
const BACKEND_URL = 'http://localhost:3001';

let db = null;

function initFirebase() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  if (admin.apps.length === 0) {
    admin.initializeApp({
      credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
    });
  }

  db = admin.firestore();
  console.log('✅ Firebase initialized in test script\n');
}

async function createTestData() {
  console.log('═'.repeat(80));
  console.log('STEP 1: Creating test data...');
  console.log('═'.repeat(80));

  const userId = 'test-user-' + Date.now();
  const campaignId = 'test-campaign-' + Date.now();
  const contactId = `contact_${TEST_PHONE}`;

  try {
    // Create user
    await db.collection('users').doc(userId).set({
      email: 'test@example.com',
      createdAt: admin.firestore.Timestamp.now(),
    });
    console.log(`✅ User created: ${userId}`);

    // Create campaign
    await db
      .collection('users')
      .doc(userId)
      .collection('campaigns')
      .doc(campaignId)
      .set({
        id: campaignId,
        title: 'Test Campaign for Diagnostic',
        status: 'launched',
        description: {
          original: 'This is a diagnostic test campaign to check Firebase access.',
        },
        documents: [],
        launchedAt: admin.firestore.Timestamp.now(),
        createdAt: admin.firestore.Timestamp.now(),
      });
    console.log(`✅ Campaign created: ${campaignId}`);

    // Create contact
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
        name: 'Diagnostic Test User',
        createdAt: admin.firestore.Timestamp.now(),
      });
    console.log(`✅ Contact created: ${contactId}`);

    // Create messageTracking
    await db
      .collection('users')
      .doc(userId)
      .collection('campaigns')
      .doc(campaignId)
      .collection('messageTracking')
      .doc('msg_' + Date.now())
      .set({
        contactPhone: TEST_PHONE,
        contactId: contactId,
        sentAt: new Date().toISOString(),
      });
    console.log(`✅ MessageTracking created`);

    // Verify immediately
    console.log('\n📍 Verifying data in test script:');
    const usersSnap = await db.collection('users').get();
    console.log(`   Users in DB: ${usersSnap.size}`);
    const userIds = usersSnap.docs.map(d => d.id);
    console.log(`   IDs: ${userIds.join(', ')}`);

    return { userId, campaignId, contactId };
  } catch (err) {
    console.error('❌ Failed to create test data:', err.message);
    process.exit(1);
  }
}

async function testBackendAccess(userId) {
  console.log('\n' + '═'.repeat(80));
  console.log('STEP 2: Testing backend Firebase access...');
  console.log('═'.repeat(80));

  try {
    console.log(`🔄 Calling: POST ${BACKEND_URL}/api/whatsapp/test-firebase-access`);
    console.log(`   Phone: ${TEST_PHONE}\n`);

    const response = await axios.post(
      `${BACKEND_URL}/api/whatsapp/test-firebase-access`,
      { phone: TEST_PHONE },
      { timeout: 10000 }
    );

    console.log('✅ Backend responded:');
    console.log(JSON.stringify(response.data, null, 2));

    return response.data;
  } catch (err) {
    console.error('❌ Backend call failed:');
    console.error(`   Status: ${err?.response?.status}`);
    console.error(`   Message: ${err?.response?.data?.error || err.message}`);
    return null;
  }
}

async function cleanup(userId, campaignId) {
  console.log('\n' + '═'.repeat(80));
  console.log('CLEANUP: Removing test data...');
  console.log('═'.repeat(80));

  try {
    // Delete all subcollections first (Firestore limitation)
    // In real app would use recursive delete, but for now just log
    console.log('⚠️  Note: Manual cleanup needed (Firestore requires careful subcollection deletion)');
  } catch (err) {
    console.warn('Cleanup error:', err.message);
  }
}

async function main() {
  console.log('\n🧪 DIAGNOSTIC: Backend Firebase Access Test\n');

  initFirebase();
  const data = await createTestData();

  console.log('\n⏳ Waiting 2 seconds for Firebase sync...\n');
  await new Promise(r => setTimeout(r, 2000));

  const backendResult = await testBackendAccess(data.userId);

  if (backendResult?.usersFound === undefined) {
    console.log('\n⚠️  Backend did not return usersFound count - check if endpoint exists');
    console.log('   Make sure server has this route implemented');
  } else if (backendResult.usersFound === 0) {
    console.error('\n❌ PROBLEM FOUND:');
    console.error('   Test script sees the user');
    console.error('   BUT backend sees 0 users!');
    console.error('   This means backend Firebase connection is different/isolated');
  } else if (backendResult.usersFound > 0) {
    console.log('\n✅ SUCCESS:');
    console.log('   Both test script and backend see the same Firebase data!');
    if (backendResult.campaignFound) {
      console.log('   Campaign was found and loaded successfully');
    } else {
      console.log('   Campaign NOT found (check phone normalization)');
    }
  }

  await cleanup(data.userId, data.campaignId);
  process.exit(0);
}

main();
