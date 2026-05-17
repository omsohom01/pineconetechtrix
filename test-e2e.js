#!/usr/bin/env node
'use strict';

/**
 * 🎯 END-TO-END TEST
 * 
 * Complete test of the conversation flow:
 *   1. Create mock campaign with context
 *   2. Send test questions via HTTP endpoint  
 *   3. Verify responses are saved in Firebase
 *   4. Check AI conversation worked end-to-end
 */

const admin = require('firebase-admin');
const path = require('path');
const dotenv = require('dotenv');
const axios = require('axios');

dotenv.config({ path: path.join(__dirname, '.env') });

const TEST_PHONE = '919836444455';
const BACKEND_URL = 'http://localhost:3001';

let db = null;
const log = {
  title: (msg) => console.log(`\n${'═'.repeat(80)}\n${msg}\n${'═'.repeat(80)}`),
  section: (msg) => console.log(`\n${'─'.repeat(80)}\n📍 ${msg}\n${'─'.repeat(80)}`),
  step: (num, msg) => console.log(`\n${num}️⃣ ${msg}`),
  success: (msg) => console.log(`   ✅ ${msg}`),
  error: (msg) => console.log(`   ❌ ${msg}`),
  info: (msg) => console.log(`   ℹ️  ${msg}`),
  data: (label, value) => console.log(`   ${label}: ${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`),
};

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
  log.success('Firebase initialized');
}

async function createTestCampaign() {
  log.section('Creating Test Campaign');

  const userId = 'e2e-user-' + Date.now();
  const campaignId = 'e2e-campaign-' + Date.now();
  const contactId = `contact_${TEST_PHONE}`;

  try {
    log.step(1, 'Creating user document');
    await db.collection('users').doc(userId).set({
      email: 'e2e-test@example.com',
      createdAt: admin.firestore.Timestamp.now(),
    });
    log.success(`User: ${userId}`);

    log.step(2, 'Creating campaign with rich context');
    const campaignData = {
      id: campaignId,
      title: '🌟 Premium Membership Plus Plan',
      status: 'launched',
      description: {
        original: `
We're excited to present our Premium Membership Plus Plan! 

BENEFITS:
- Unlimited access to all premium features
- Priority customer support available 24/7
- 30% discount on all additional services
- Free shipping on all orders (no minimum)
- Exclusive member-only quarterly previews and events

PRICING:
- Annual Plan: $99/year (Save 30% vs monthly)
- Monthly Plan: $12/month (Cancel anytime)

VALIDITY: This offer is valid from January 1, 2025 to March 31, 2025.
Promo code: PREMIUM25 (applies 25% additional discount at checkout)

TERMS & CONDITIONS:
1. Membership is non-transferable
2. Automatic renewal unless cancelled 30 days before renewal date
3. Refund available only within the first 14 days of purchase
4. Member benefits may be changed with 30 days notice
5. Contact: support@premium.com or call 1-800-PREMIUM1

Join thousands of satisfied members enjoying premium benefits today!
        `.trim(),
      },
      documents: [
        {
          name: 'MembershipGuide.pdf',
          extractedText: `MEMBERSHIP QUICK START GUIDE

Getting Started:
1. Download our mobile app from App Store or Play Store
2. Create your account with your email address
3. Enter promo code PREMIUM25 at checkout for extra savings
4. Access your dashboard immediately

First Steps:
- Complete your profile (2 min)
- Link your payment method (2 min)
- Browse premium content (unlimited!)
- Contact support if you need help

Feature Highlights:
- Unlimited streaming of all premium content
- Ad-free experience across all platforms
- Family sharing (up to 4 accounts)
- Offline download capability
- Personalized recommendations
- Custom watchlists and favorites`,
        },
        {
          name: 'FAQs.pdf',
          extractedText: `FREQUENTLY ASKED QUESTIONS

Q: Can I cancel anytime?
A: Yes! You can cancel membership any time. We require 30 days notice before renewal.

Q: What payment methods are accepted?
A: Credit cards (Visa, Mastercard, American Express), PayPal, and Apple Pay.

Q: Is student discount available?
A: Yes! Valid students get 50% off with .edu email verification.

Q: How many devices can I use?
A: Up to 4 simultaneous streams on family plan, 2 on individual plan.

Q: Is my data secure?
A: Yes! We use industry-standard 256-bit SSL encryption.

Q: What if I have technical issues?
A: Contact support@premium.com or live chat (24/7 available for members).

Q: Can I upgrade or downgrade?
A: Yes! Changes take effect on your next billing cycle.

Q: Is there a free trial?
A: No free trial, but 14-day money-back guarantee on first purchase.`,
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
    log.data('Title', campaignData.title);
    log.data('Description length', campaignData.description.original.length + ' chars');
    log.data('Documents', campaignData.documents.length + ' files');

    log.step(3, 'Creating contact');
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
        name: 'E2E Test User',
        createdAt: admin.firestore.Timestamp.now(),
      });
    log.success(`Contact: ${contactId}`);

    log.step(4, 'Creating messageTracking');
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
    log.success('MessageTracking created');

    return { userId, campaignId, contactId, campaignTitle: campaignData.title };
  } catch (err) {
    log.error(`Failed to create campaign: ${err.message}`);
    process.exit(1);
  }
}

async function sendTestQuestions(count = 5) {
  log.section('Sending Test Questions via Backend');

  const questions = [
    "What are the main benefits of the premium membership?",
    "What's the price and can I cancel anytime?",
    "Is there a student discount available?",
    "How many devices can I use simultaneously?",
    "What's the refund policy if I'm not satisfied?"
  ];

  const results = [];

  for (let i = 0; i < Math.min(count, questions.length); i++) {
    const q = questions[i];
    log.step(i + 1, `Sending question: "${q}"`);

    try {
      const response = await axios.post(
        `${BACKEND_URL}/api/whatsapp/test-conversation`,
        { 
          phone: TEST_PHONE,
          message: q
        },
        { timeout: 15000 }
      );

      log.success(`Response received (check backend logs)`);
      results.push({ question: q, success: true, response: response.data });
      
      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      log.error(`Failed: ${err?.response?.data?.error || err.message}`);
      results.push({ question: q, success: false, error: err.message });
    }
  }

  return results;
}

async function verifyMessagesInFirebase(userId, campaignId, contactId) {
  log.section('Verifying Messages Saved in Firebase');

  try {
    log.step(1, `Querying messages for contact: ${contactId}`);

    const messagesSnap = await db
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
      .get();

    const count = messagesSnap.size;
    log.success(`Found ${count} messages`);

    if (count === 0) {
      log.error('No messages found! Something went wrong.');
      return false;
    }

    log.step(2, 'Analyzing message structure');

    let userMsgs = 0;
    let aiMsgs = 0;
    const samples = [];

    messagesSnap.docs.forEach((doc, idx) => {
      const data = doc.data();
      if (data.sender === 'user') userMsgs++;
      if (data.sender === 'campaign' || data.sender === 'ai') aiMsgs++;
      
      if (idx < 3) {  // Show first 3 messages
        samples.push({
          sender: data.sender,
          content: data.content?.substring(0, 60) + (data.content?.length > 60 ? '...' : ''),
        });
      }
    });

    log.data('User messages', userMsgs);
    log.data('AI responses', aiMsgs);
    log.info(`Sample messages:`);
    samples.forEach(s => {
      log.info(`  ${s.sender}: "${s.content}"`);
    });

    if (userMsgs > 0 && aiMsgs > 0) {
      log.success(`✅ Conversation flow working! ${userMsgs} user msgs, ${aiMsgs} AI responses`);
      return true;
    } else {
      log.error(`Message count issue: user=${userMsgs}, ai=${aiMsgs}`);
      return false;
    }
  } catch (err) {
    log.error(`Failed to verify: ${err.message}`);
    return false;
  }
}

async function main() {
  log.title('🎯 END-TO-END TEST: Conversation Flow');

  try {
    // Initialize Firebase
    log.section('Setup');
    initFirebase();
    log.info('Backend URL: ' + BACKEND_URL);
    log.info('Test phone: ' + TEST_PHONE);

    // Create campaign
    const campaign = await createTestCampaign();

    // Wait for Firebase sync
    log.info('Waiting 2 seconds for Firebase sync...');
    await new Promise(r => setTimeout(r, 2000));

    // Send questions
    const questionResults = await sendTestQuestions(3);
    const successCount = questionResults.filter(r => r.success).length;
    log.info(`Sent ${successCount}/${questionResults.length} questions successfully`);

    // Wait for responses to be processed and saved
    log.info('Waiting 3 seconds for responses to be processed and saved...');
    await new Promise(r => setTimeout(r, 3000));

    // Verify messages in Firebase
    const verified = await verifyMessagesInFirebase(
      campaign.userId,
      campaign.campaignId,
      campaign.contactId
    );

    // Final summary
    log.title('📊 TEST SUMMARY');

    if (verified && successCount === questionResults.length) {
      log.success(`✅✅✅ END-TO-END TEST PASSED!`);
      log.info(`Campaign created and conversation flow working correctly.`);
      log.info(`Next step: Deploy backend to Render with valid WhatsApp token.`);
    } else {
      log.error(`Test completed with issues:`);
      if (successCount < questionResults.length) {
        log.error(`  - ${questionResults.length - successCount} questions failed to send`);
      }
      if (!verified) {
        log.error(`  - Messages not verified in Firebase`);
        log.error(`  - Check backend logs for errors`);
      }
    }

    process.exit(verified && successCount === questionResults.length ? 0 : 1);
  } catch (err) {
    log.error(`FATAL: ${err.message}`);
    console.error(err);
    process.exit(1);
  }
}

main();
