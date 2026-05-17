'use strict';

const admin = require('firebase-admin');

// ── Firebase Admin Init ─────────────────────────────────────────────────────
let _db = null;

function getDb() {
  if (_db) return _db;
  
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY || '';
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('❌ Missing Firebase credentials');
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
  _db = admin.firestore();
  return _db;
}

/**
 * Update WhatsApp conversation in ANALYSIS collection (Backend Direct)
 * Called whenever a chat message is exchanged on WhatsApp
 * 
 * Stores:
 *   - Full conversation thread with all messages
 *   - Total message count
 *   - Message sender breakdown (sent vs received)
 */
async function updateAnalysisWhatsApp(userId, campaignId, contactData) {
  const db = getDb();
  
  try {
    console.log(`\n📱 UPDATING WHATSAPP ANALYTICS (Direct Backend)`);
    console.log(`   userId: ${userId}`);
    console.log(`   campaignId: ${campaignId}`);
    console.log(`   contact: ${contactData.contactName} (${contactData.phone})`);
    console.log(`   messageCount: ${contactData.messages?.length || 0}`);

    const analysisRef = db
      .collection('analysis')
      .doc(userId)
      .collection('campaigns')
      .doc(campaignId);

    // Get current data
    const doc = await analysisRef.get();
    const currentData = doc.data() || {};

    // Ensure whatsapp object exists
    if (!currentData.whatsapp) {
      currentData.whatsapp = {
        conversations: {},
        users: {},
        totalMessages: 0,
        totalUsers: 0,
      };
    }

    // Ensure conversations and users are objects
    const conversations = currentData.whatsapp.conversations || {};
    const users = currentData.whatsapp.users || {};

    // Count messages from contact
    const messages = contactData.messages || [];
    const messagesSent = messages.filter((m) => m.sender === 'campaign' || m.sender === 'ai').length;
    const messagesReceived = messages.filter((m) => m.sender === 'user').length;
    const totalMessages = messages.length;

    console.log(`   📊 Message breakdown: ${messagesSent} sent, ${messagesReceived} received, ${totalMessages} total`);

    // Store/Update conversation
    conversations[contactData.contactId] = {
      contactId: contactData.contactId,
      contactName: contactData.contactName,
      phone: contactData.phone,
      messages: messages,
      messagesSent,
      messagesReceived,
      updatedAt: new Date().toISOString(),
    };

    // Store/Update user (unique contact)
    if (!users[contactData.contactId]) {
      console.log(`   ➕ NEW WHATSAPP USER: ${contactData.contactName}`);
    } else {
      console.log(`   🔄 EXISTING WHATSAPP USER: ${contactData.contactName}`);
    }

    users[contactData.contactId] = {
      contactId: contactData.contactId,
      contactName: contactData.contactName,
      phone: contactData.phone,
      firstInteractionAt: users[contactData.contactId]?.firstInteractionAt || new Date().toISOString(),
      lastInteractionAt: new Date().toISOString(),
    };

    // Calculate totals
    const totalMessagesAcross = Object.values(conversations).reduce(
      (sum, conv) => sum + (conv.messages?.length || 0),
      0
    );

    // Write to Firestore
    console.log(`\n✍️ WRITING TO FIRESTORE:`);
    console.log(`   conversations: ${Object.keys(conversations).length} total`);
    console.log(`   users: ${Object.keys(users).length} total`);
    console.log(`   totalMessages: ${totalMessagesAcross}`);

    await analysisRef.update({
      'whatsapp.conversations': conversations,
      'whatsapp.users': users,
      'whatsapp.totalMessages': totalMessagesAcross,
      'whatsapp.totalUsers': Object.keys(users).length,
      updatedAt: new Date(),
    });

    console.log(`✅ WHATSAPP ANALYSIS UPDATED IN FIRESTORE\n`);

    return {
      success: true,
      totalConversations: Object.keys(conversations).length,
      totalUsers: Object.keys(users).length,
      totalMessages: totalMessagesAcross,
    };
  } catch (error) {
    console.error(`\n❌ ERROR updating WhatsApp analysis:`, error.message);
    console.error(error.stack);
    throw error;
  }
}

module.exports = { updateAnalysisWhatsApp };
