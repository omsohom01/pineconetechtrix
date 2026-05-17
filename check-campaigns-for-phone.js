#!/usr/bin/env node

/**
 * DIAGNOSTIC SCRIPT: Check Multiple Campaigns for Phone 919836444455
 * 
 * This script queries Firestore to verify:
 * 1. How many campaigns have 919836444455 as a contact
 * 2. Are all 3 campaigns stored correctly?
 * 3. Is the phone number normalized properly?
 * 4. Are messageTracking documents created?
 * 
 * Usage: 
 *   node check-campaigns-for-phone.js
 * 
 * Setup before running:
 *   1. Create a .env file with Firebase credentials
 *   2. Or set environment variables manually
 */

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// Color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
};

function log(msg, color = 'reset') {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

function section(title) {
  console.log('\n' + '═'.repeat(80));
  log(title, 'bold');
  console.log('═'.repeat(80));
}

async function checkCampaignsForPhone() {
  section('📱 CHECKING CAMPAIGNS FOR PHONE: 919836444455');

  const targetPhone = '919836444455';
  log(`\nSearching for phone number: ${targetPhone}`, 'cyan');

  try {
    // Initialize Firebase (using environment variables)
    log('\n1️⃣  Initializing Firebase...', 'blue');
    
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;

    if (!projectId || !privateKey || !clientEmail) {
      log('\n❌ Firebase credentials not found!', 'red');
      log('\nTo run this script, set these environment variables:', 'yellow');
      log('  FIREBASE_PROJECT_ID=your_project_id', 'yellow');
      log('  FIREBASE_CLIENT_EMAIL=your_email@firebase.iam.gserviceaccount.com', 'yellow');
      log('  FIREBASE_PRIVATE_KEY=your_private_key', 'yellow');
      log('\nOr create a .env file with these values', 'yellow');
      log('\nAlternatively, run this query from Firebase Cloud Shell:', 'yellow');
      console.log(`
// Firebase Cloud Shell Command:
db.collectionGroup('contacts').where('contactPhone', '==', '919836444455').get()
  .then(snap => {
    console.log('Found documents: ' + snap.size);
    snap.docs.forEach(doc => {
      console.log(doc.ref.path + ' -> ' + JSON.stringify(doc.data()));
    });
  })
  .catch(err => console.error(err));
      `);
      return;
    }

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          privateKey: privateKey.replace(/\\n/g, '\n'),
          clientEmail,
        }),
      });
    }

    const db = admin.firestore();
    log('✅ Firebase initialized', 'green');

    section('STEP 1: Query All Users');
    
    const usersSnapshot = await db.collection('users').get();
    log(`Found ${usersSnapshot.size} users in database`, 'cyan');

    let totalCampaignsFound = 0;
    let campaignsWithPhone = [];

    section('STEP 2: Check Each User\'s Campaigns');

    for (const userDoc of usersSnapshot.docs) {
      const userId = userDoc.id;
      log(`\n👤 User: ${userId}`, 'blue');

      const campaignsSnapshot = await userDoc.ref.collection('campaigns').get();
      log(`   📊 Total campaigns: ${campaignsSnapshot.size}`, 'cyan');

      for (const campaignDoc of campaignsSnapshot.docs) {
        const campaignId = campaignDoc.id;
        const campaignData = campaignDoc.data();

        log(`\n   📋 Campaign: ${campaignId}`, 'cyan');
        log(`      Status: ${campaignData.status}`, 'cyan');
        log(`      Title: ${campaignData.title || 'N/A'}`, 'cyan');
        log(`      Launched: ${campaignData.launchedAt ? campaignData.launchedAt.toDate().toISOString() : 'N/A'}`, 'cyan');

        // STRATEGY 1: Check messageTracking
        log(`      Checking messageTracking...`, 'yellow');
        try {
          const trackingSnapshot = await campaignDoc.ref
            .collection('messageTracking')
            .where('contactPhone', '==', targetPhone)
            .get();

          if (!trackingSnapshot.empty) {
            log(`      ✅ Found ${trackingSnapshot.empty ? 0 : trackingSnapshot.size} tracking document(s)!`, 'green');
            trackingSnapshot.docs.forEach(doc => {
              const data = doc.data();
              log(`         Document ID: ${doc.id}`, 'green');
              log(`         contactPhone: ${data.contactPhone}`, 'green');
              log(`         contactId: ${data.contactId}`, 'green');
              log(`         sentAt: ${data.sentAt}`, 'green');
              totalCampaignsFound++;
              campaignsWithPhone.push({
                userId,
                campaignId,
                contactId: data.contactId,
                source: 'messageTracking',
                launchedAt: campaignData.launchedAt,
                title: campaignData.title,
              });
            });
          } else {
            log(`      ⚠️  No tracking document found`, 'yellow');
          }
        } catch (e) {
          log(`      ❌ Error querying messageTracking: ${e.message}`, 'red');
        }

        // STRATEGY 2: Check inbox/contacts
        log(`      Checking inbox/contacts...`, 'yellow');
        try {
          const contactsSnapshot = await campaignDoc.ref
            .collection('inbox')
            .doc('contacts')
            .collection('contacts')
            .where('contactPhone', '==', targetPhone)
            .get();

          if (!contactsSnapshot.empty) {
            log(`      ✅ Found ${contactsSnapshot.empty ? 0 : contactsSnapshot.size} contact document(s) in inbox!`, 'green');
            contactsSnapshot.docs.forEach(doc => {
              const data = doc.data();
              log(`         Document ID: ${doc.id}`, 'green');
              log(`         contactPhone: ${data.contactPhone}`, 'green');
              log(`         contactName: ${data.contactName}`, 'green');
              if (!campaignsWithPhone.find(c => c.contactId === doc.id)) {
                totalCampaignsFound++;
                campaignsWithPhone.push({
                  userId,
                  campaignId,
                  contactId: doc.id,
                  source: 'inbox/contacts',
                  launchedAt: campaignData.launchedAt,
                  title: campaignData.title,
                });
              }
            });
          } else {
            log(`      ⚠️  No contact document found in inbox`, 'yellow');
          }
        } catch (e) {
          log(`      ❌ Error querying inbox/contacts: ${e.message}`, 'red');
        }
      }
    }

    section('STEP 3: RESULTS');

    if (totalCampaignsFound === 0) {
      log('\n❌ NO CAMPAIGNS FOUND for phone 919836444455!', 'red');
      log('\nThis means:', 'yellow');
      log('  1. No contacts with this phone number are stored in Firestore', 'yellow');
      log('  2. Neither messageTracking nor inbox/contacts has this number', 'yellow');
      log('  3. Campaigns may not have been launched', 'yellow');
      log('  4. Phone numbers may not be normalized correctly', 'yellow');

      section('TROUBLESHOOTING');
      log('\n🔍 Things to check:', 'blue');
      log('  1. Were campaigns actually created and launched in the UI?', 'cyan');
      log('  2. Did the contacts upload successfully?', 'cyan');
      log('  3. Check browser console (F12) for upload errors', 'cyan');
      log('  4. Check server logs for campaign launch process', 'cyan');
      log('  5. Go to Firestore Console manually:', 'cyan');
      log('     https://console.firebase.google.com/', 'cyan');
      log('     Navigate: campaigns → {campaignId} → inbox → contacts → contacts', 'cyan');
      log('     Or: campaigns → {campaignId} → messageTracking', 'cyan');
      log('  6. Search for ANY documents with contactPhone field', 'cyan');

    } else if (totalCampaignsFound === 1) {
      log(`\n⚠️  Only 1 campaign found for phone 919836444455`, 'yellow');
      log(`\nYou mentioned sending 3 campaigns, but only 1 is stored.`, 'yellow');
      log(`\nPossible issues:`, 'red');
      log('  1. Other 2 campaigns were NOT launched', 'red');
      log('  2. Other 2 campaigns have different phone format (not normalized)', 'red');
      log('  3. Other 2 campaigns were not sent to this contact', 'red');

      section('FOUND CAMPAIGN(S)');
      campaignsWithPhone.forEach((c, i) => {
        log(`\n${i + 1}. Campaign: ${c.title}`, 'green');
        log(`   Campaign ID: ${c.campaignId}`, 'cyan');
        log(`   User ID: ${c.userId}`, 'cyan');
        log(`   Contact ID: ${c.contactId}`, 'cyan');
        log(`   Launched At: ${c.launchedAt ? c.launchedAt.toDate().toISOString() : 'N/A'}`, 'cyan');
        log(`   Found Via: ${c.source}`, 'cyan');
      });

    } else if (totalCampaignsFound === 3) {
      log(`\n✅ ALL 3 CAMPAIGNS FOUND! Perfect!`, 'green');
      log(`\nPhone number 919836444455 is correctly stored in ${totalCampaignsFound} campaigns.`, 'green');

      section('FOUND CAMPAIGN(S)');
      campaignsWithPhone.sort((a, b) => {
        const aTime = a.launchedAt?.toMillis?.() || 0;
        const bTime = b.launchedAt?.toMillis?.() || 0;
        return aTime - bTime;
      });

      campaignsWithPhone.forEach((c, i) => {
        log(`\n${i + 1}. Campaign: ${c.title}`, 'green');
        log(`   Campaign ID: ${c.campaignId}`, 'cyan');
        log(`   User ID: ${c.userId}`, 'cyan');
        log(`   Contact ID: ${c.contactId}`, 'cyan');
        log(`   Launched At: ${c.launchedAt ? c.launchedAt.toDate().toISOString() : 'N/A'}`, 'cyan');
        log(`   Found Via: ${c.source}`, 'cyan');
      });

      log(`\n✅ Backend will find LATEST campaign (by launchedAt timestamp)`, 'green');
      const latest = campaignsWithPhone[campaignsWithPhone.length - 1];
      log(`   Latest: ${latest.title}`, 'green');

    } else {
      log(`\n⚠️  Found ${totalCampaignsFound} campaigns (expected 3)`, 'yellow');

      section('FOUND CAMPAIGN(S)');
      campaignsWithPhone.forEach((c, i) => {
        log(`\n${i + 1}. Campaign: ${c.title}`, 'yellow');
        log(`   Campaign ID: ${c.campaignId}`, 'cyan');
        log(`   User ID: ${c.userId}`, 'cyan');
        log(`   Contact ID: ${c.contactId}`, 'cyan');
        log(`   Launched At: ${c.launchedAt ? c.launchedAt.toDate().toISOString() : 'N/A'}`, 'cyan');
        log(`   Found Via: ${c.source}`, 'cyan');
      });
    }

    section('NEXT STEPS');

    if (totalCampaignsFound === 0) {
      log('\n1️⃣  Check Frontend Campaign Creation:', 'blue');
      log('   - Are campaigns being created successfully?', 'cyan');
      log('   - Check browser console for errors', 'cyan');
      log('   - Open Firestore Console manually', 'cyan');
      log('   - Look for ANY documents in campaigns collection', 'cyan');

      log('\n2️⃣  Check Contact Upload:', 'blue');
      log('   - Was the CSV file uploaded successfully?', 'cyan');
      log('   - Check server logs for "Extracted contacts" message', 'cyan');
      log('   - Verify CSV has correct column names: Name, Phone', 'cyan');

      log('\n3️⃣  Check Campaign Launch:', 'blue');
      log('   - Did you click "Launch Campaign" button?', 'cyan');
      log('   - Check server logs for "Campaign marked as launched"', 'cyan');

    } else if (totalCampaignsFound < 3) {
      log('\n1️⃣  Create the missing campaigns:', 'blue');
      log(`   ${3 - totalCampaignsFound} more campaigns needed`, 'yellow');

      log('\n2️⃣  Verify each campaign:', 'blue');
      log('   - Upload CSV with phone: 919836444455', 'cyan');
      log('   - Click "Launch Campaign"', 'cyan');
      log('   - Check server logs for success message', 'cyan');

    } else if (totalCampaignsFound === 3) {
      log('\n✅ Everything is stored correctly!', 'green');
      log('\nNext: Send a WhatsApp message from 919836444455', 'blue');
      log('   Backend will:', 'cyan');
      log('   1. Normalize phone: 919836444455', 'cyan');
      log('   2. Query messageTracking for this phone', 'cyan');
      log('   3. Find LATEST campaign (by launchedAt)', 'cyan');
      log('   4. Load campaign context', 'cyan');
      log('   5. Generate context-aware response', 'cyan');
    }

    console.log('\n' + '═'.repeat(80) + '\n');

  } catch (error) {
    log(`\n❌ Fatal Error: ${error.message}`, 'red');
    log(`\nStack: ${error.stack}`, 'red');
  }

  process.exit(0);
}

// Run the check
checkCampaignsForPhone();
