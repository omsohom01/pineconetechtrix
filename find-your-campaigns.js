#!/usr/bin/env node

/**
 * SIMPLE DIAGNOSTIC: Find ALL Campaigns with Phone 919836444455
 * 
 * This script searches across ALL users and shows which campaigns 
 * contain phone 919836444455, making it easy to identify yours.
 * 
 * Usage: 
 *   node find-your-campaigns.js
 * 
 * No setup needed - uses existing Firebase config from this backend!
 */

const admin = require('firebase-admin');
const path = require('path');

// Try to load Firebase credentials if available
let serviceAccount;
try {
  // Try loading from the backend's firebase config
  const possible_paths = [
    path.join(__dirname, '..', 'firebase-key.json'),
    path.join(__dirname, 'firebase-key.json'),
    path.join(__dirname, '..', '..', 'firebase-key.json'),
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
  ];

  for (const p of possible_paths) {
    if (p && require('fs').existsSync(p)) {
      serviceAccount = require(p);
      console.log(`✅ Loaded Firebase credentials from: ${p}\n`);
      break;
    }
  }
} catch (e) {
  // continue
}

// Color codes
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
  magenta: '\x1b[35m',
};

function log(msg, color = 'reset') {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

function section(title) {
  console.log('\n' + '═'.repeat(90));
  log(title, 'bold');
  console.log('═'.repeat(90));
}

async function findYourCampaigns() {
  section('🔍 FINDING ALL CAMPAIGNS WITH PHONE: 919836444455');

  const targetPhone = '919836444455';

  try {
    // Initialize Firebase
    if (serviceAccount) {
      if (!admin.apps.length) {
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
        });
      }
    } else {
      log('\n⚠️  No Firebase credentials found!', 'yellow');
      log('   Trying to use default credentials...', 'yellow');
      
      if (!admin.apps.length) {
        admin.initializeApp();
      }
    }

    const db = admin.firestore();
    log('\n✅ Connected to Firestore', 'green');

    // Get all users
    log('\n📊 Scanning all users...', 'cyan');
    const usersSnapshot = await db.collection('users').get();
    log(`   Found ${usersSnapshot.size} total users`, 'cyan');

    const results = [];

    // For each user, find campaigns with this phone
    for (const userDoc of usersSnapshot.docs) {
      const userId = userDoc.id;
      const userData = userDoc.data();
      const userEmail = userData.email || 'unknown';

      // Get all campaigns for this user
      const campaignsSnapshot = await userDoc.ref.collection('campaigns').get();

      if (campaignsSnapshot.size === 0) continue;

      // For each campaign, check if it has this phone number
      for (const campaignDoc of campaignsSnapshot.docs) {
        const campaignId = campaignDoc.id;
        const campaignData = campaignDoc.data();

        // Check messageTracking
        const trackingSnapshot = await campaignDoc.ref
          .collection('messageTracking')
          .where('contactPhone', '==', targetPhone)
          .get();

        if (!trackingSnapshot.empty) {
          results.push({
            userId,
            userEmail,
            campaignId,
            campaignTitle: campaignData.title || 'Untitled Campaign',
            launchedAt: campaignData.launchedAt,
            source: 'messageTracking',
            trackingCount: trackingSnapshot.size,
          });
          continue;
        }

        // Check inbox/contacts
        const contactsSnapshot = await campaignDoc.ref
          .collection('inbox')
          .doc('contacts')
          .collection('contacts')
          .where('contactPhone', '==', targetPhone)
          .get();

        if (!contactsSnapshot.empty) {
          results.push({
            userId,
            userEmail,
            campaignId,
            campaignTitle: campaignData.title || 'Untitled Campaign',
            launchedAt: campaignData.launchedAt,
            source: 'inbox/contacts',
            contactCount: contactsSnapshot.size,
          });
        }
      }
    }

    // Display results
    section(`RESULTS: Found ${results.length} Campaign(s) with Phone 919836444455`);

    if (results.length === 0) {
      log('\n❌ NO campaigns found with phone 919836444455!', 'red');
      log('\nThis could mean:', 'yellow');
      log('  1. No campaigns have been created yet', 'yellow');
      log('  2. No contacts with this phone were uploaded', 'yellow');
      log('  3. Campaigns were not launched', 'yellow');
      log('  4. Phone number format is different (check Firestore manually)', 'yellow');
    } else {
      // Sort by launch date
      results.sort((a, b) => {
        const aTime = a.launchedAt?.toMillis?.() || 0;
        const bTime = b.launchedAt?.toMillis?.() || 0;
        return aTime - bTime;
      });

      log(`\n✅ Found ${results.length} campaign(s) total\n`, 'green');

      results.forEach((result, index) => {
        log(`\n${colors.magenta}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
        log(`${index + 1}. ${result.campaignTitle}`, 'green');
        log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, 'magenta');

        log(`   👤 User Email: ${result.userEmail}`, 'cyan');
        log(`   🆔 User ID: ${result.userId}`, 'cyan');
        log(`   📋 Campaign ID: ${result.campaignId}`, 'cyan');
        
        if (result.launchedAt) {
          log(`   📅 Launched: ${result.launchedAt.toDate().toLocaleString()}`, 'cyan');
        }
        
        log(`   📍 Found In: ${result.source}`, 'cyan');
        
        if (result.trackingCount) {
          log(`   📊 Tracking Documents: ${result.trackingCount}`, 'cyan');
        }
        if (result.contactCount) {
          log(`   📊 Contact Documents: ${result.contactCount}`, 'cyan');
        }
      });

      section('YOUR CAMPAIGNS SUMMARY');
      
      // Group by user
      const byUser = {};
      results.forEach(r => {
        if (!byUser[r.userEmail]) {
          byUser[r.userEmail] = [];
        }
        byUser[r.userEmail].push(r);
      });

      Object.entries(byUser).forEach(([email, campaigns]) => {
        log(`\n${email}: ${campaigns.length} campaign(s)`, 'green');
        campaigns.forEach((c, i) => {
          log(`  ${i + 1}. ${c.campaignTitle}`, 'cyan');
          log(`     Campaign ID: ${c.campaignId}`, 'gray');
          log(`     Launched: ${c.launchedAt ? c.launchedAt.toDate().toLocaleString() : 'N/A'}`, 'gray');
        });
      });

      log(`\n`, 'reset');
      const latestCampaign = results[results.length - 1];
      log(`⭐ LATEST CAMPAIGN (Most Recently Launched):`, 'yellow');
      log(`   ${latestCampaign.campaignTitle}`, 'green');
      log(`   User: ${latestCampaign.userEmail}`, 'green');
      log(`   Campaign ID: ${latestCampaign.campaignId}`, 'green');

      section('NEXT STEPS');
      log('\n1️⃣  Identify which campaigns above are yours', 'blue');
      log('   (Based on email or campaign title)', 'cyan');

      log('\n2️⃣  Copy your Campaign ID and User ID', 'blue');

      log('\n3️⃣  To test context-aware answers:', 'blue');
      log('   - Send WhatsApp message from 919836444455', 'cyan');
      log('   - Backend will find the LATEST campaign', 'cyan');
      log('   - AI will answer using that campaign\'s context', 'cyan');

      log('\n4️⃣  Check Campaign Details:', 'blue');
      log('   Go to Firestore Console:', 'cyan');
      log('   → users/{userId} → campaigns/{campaignId}', 'cyan');
      log('   → View title, description, and documents', 'cyan');
    }

    console.log('\n' + '═'.repeat(90) + '\n');

  } catch (error) {
    log(`\n❌ Error: ${error.message}`, 'red');
    log(`\nMake sure:`, 'yellow');
    log('  1. You have internet connection', 'yellow');
    log('  2. Firebase project is accessible', 'yellow');
    log('  3. You have Firestore read permissions', 'yellow');
    log('\nIf problem persists:', 'yellow');
    log('  - Open Firebase Console manually', 'yellow');
    log('  - Go to Firestore Database → collections', 'yellow');
    log('  - Navigate to: users → {yourUserId} → campaigns', 'yellow');
    log(`\nFull Error: ${error.stack}`, 'gray');
  }

  process.exit(0);
}

// Run it
findYourCampaigns();
