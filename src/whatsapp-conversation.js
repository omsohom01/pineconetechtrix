const admin = require('firebase-admin');
const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
const axios = require('axios');

/**
 * WhatsApp Conversation Handler
 * 
 * Handles incoming WhatsApp messages, generates AI responses,
 * and maintains conversation history all in the backend.
 */

// Initialize Gemini
const model = new ChatGoogleGenerativeAI({
  model: 'gemini-2.5-flash',
  apiKey: process.env.GEMINI_WHATSAPP_API_KEY || '',
  temperature: 0.1,
});

// Firebase setup
let db = null;

function initializeFirebase() {
  if (db) return;
  
  try {
    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    
    if (!admin.apps.length) {
      if (serviceAccountPath) {
        const serviceAccount = require(serviceAccountPath);
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
        });
      } else {
        // Try to use application default credentials
        admin.initializeApp();
      }
    }
    
    db = admin.firestore();
    console.log('✅ Firebase initialized for WhatsApp conversations');
  } catch (error) {
    console.error('❌ Failed to initialize Firebase:', error.message);
    db = null;
  }
}

/**
 * Find which campaign a phone number belongs to
 * Maps phone number to userId and campaignId
 */
async function findCampaignByPhone(phone) {
  if (!db) return null;
  
  try {
    // Search all users for campaigns that have this phone
    const usersSnapshot = await db.collection('users').get();
    
    for (const userDoc of usersSnapshot.docs) {
      const campaignsSnapshot = await userDoc.ref
        .collection('campaigns')
        .get();
      
      for (const campaignDoc of campaignsSnapshot.docs) {
        const inboxRef = campaignDoc.ref
          .collection('inbox')
          .doc('contacts')
          .collection('contacts');
        
        const contactSnapshot = await inboxRef
          .where('contactPhone', '==', phone)
          .limit(1)
          .get();
        
        if (!contactSnapshot.empty) {
          return {
            userId: userDoc.id,
            campaignId: campaignDoc.id,
            contactId: contactSnapshot.docs[0].id,
            contactPhone: phone,
          };
        }
      }
    }
  } catch (error) {
    console.error('❌ Error finding campaign by phone:', error.message);
  }
  
  return null;
}

/**
 * Load campaign context (description and documents)
 */
async function loadCampaignContext(userId, campaignId) {
  if (!db) return { description: '', documents: '' };
  
  try {
    const campaignSnap = await db
      .collection('users')
      .doc(userId)
      .collection('campaigns')
      .doc(campaignId)
      .get();
    
    if (!campaignSnap.exists) {
      console.warn(`⚠️ Campaign not found: ${campaignId}`);
      return { description: '', documents: '' };
    }
    
    const data = campaignSnap.data();
    const description = data.description?.original || data.description || '';
    const documents = data.documents
      ?.map((d) => d.extractedText)
      .join('\n\n') || '';
    
    return { description, documents };
  } catch (error) {
    console.error('❌ Error loading campaign context:', error.message);
    return { description: '', documents: '' };
  }
}

/**
 * Load conversation history from Firestore
 */
async function loadConversationHistory(userId, campaignId, contactId) {
  if (!db) return [];
  
  try {
    const snapshot = await db
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
    
    const history = [];
    let lastUserMsg = '';
    
    snapshot.docs.forEach((doc) => {
      const data = doc.data();
      if (data.sender === 'user') {
        lastUserMsg = data.content;
      } else if ((data.sender === 'campaign' || data.sender === 'ai') && lastUserMsg) {
        history.push({ input: lastUserMsg, output: data.content });
        lastUserMsg = '';
      }
    });
    
    console.log(`📚 Loaded ${history.length} conversation exchanges`);
    return history;
  } catch (error) {
    console.error('❌ Error loading conversation history:', error.message);
    return [];
  }
}

/**
 * Generate AI response based on campaign context and conversation history
 */
async function generateResponse(userId, campaignId, contactId, userMessage) {
  try {
    console.log(`🤖 Generating AI response for message: "${userMessage}"`);
    
    // Load context and history
    const { description, documents } = await loadCampaignContext(userId, campaignId);
    const history = await loadConversationHistory(userId, campaignId, contactId);
    
    const context = `${description}\n${documents}`.trim();
    
    const prompt = `You are a helpful, sales-oriented event assistant. Keep answers warm, confident, and concise.

Use ONLY the Firebase campaign context below (description + extracted documents). Do not invent details.
If the answer is not in the context, say you do not have that info and ask a short follow-up.
Do NOT mention "campaign context" or internal data sources.

Firebase campaign context:
${context}

Conversation history:
${history.map((h) => `User: ${h.input}\nAssistant: ${h.output}`).join('\n')}

User: ${userMessage}
Assistant:`;
    
    console.log(`🔄 Calling Gemini API...`);
    const result = await model.invoke(prompt);
    const aiReply = result.content?.toString().trim() 
      || 'I am here to assist you with any questions regarding the provided information.';
    
    console.log(`✅ AI response generated (${aiReply.length} chars): "${aiReply.substring(0, 80)}..."`);
    return aiReply;
  } catch (error) {
    console.error('❌ Error generating response:', error.message);
    return 'Thanks! Ask about offers, dates, or campaign info.';
  }
}

/**
 * Store message in Firestore
 */
async function storeMessage(userId, campaignId, contactId, sender, content, whatsappMessageId = null) {
  if (!db) {
    console.warn('⚠️ Firebase not initialized, skipping storage');
    return;
  }
  
  try {
    const messageRef = db
      .collection('users')
      .doc(userId)
      .collection('campaigns')
      .doc(campaignId)
      .collection('inbox')
      .doc('contacts')
      .collection('contacts')
      .doc(contactId)
      .collection('messages')
      .doc();
    
    await messageRef.set({
      id: messageRef.id,
      sender,
      type: 'text',
      content,
      whatsappMessageId,
      timestamp: new Date().toISOString(),
      status: 'sent',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    
    console.log(`💾 Message stored: ${sender}`);
  } catch (error) {
    console.error('❌ Error storing message:', error.message);
  }
}

/**
 * Send WhatsApp message via backend
 */
async function sendWhatsAppMessage(phone, content) {
  try {
    const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
    const WA_API_BASE = `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`;
    
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'text',
      text: { body: content, preview_url: false },
    };
    
    console.log(`📤 Sending WhatsApp message to ${phone}...`);
    const res = await axios.post(WA_API_BASE, payload, {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
    
    const msgId = res.data?.messages?.[0]?.id;
    console.log(`✅ WhatsApp message sent, ID: ${msgId}`);
    return msgId;
  } catch (error) {
    console.error('❌ Error sending WhatsApp message:', error.message);
    return null;
  }
}

/**
 * Handle incoming WhatsApp message
 * This is called from the webhook handler
 */
async function handleWhatsAppMessage(phone, userMessage, messageId) {
  console.log(`\n🔄 Processing WhatsApp conversation for ${phone}`);
  
  // Initialize Firebase if needed
  initializeFirebase();
  
  try {
    // Step 1: Find which campaign this phone belongs to
    console.log(`🔍 Finding campaign for phone: ${phone}`);
    const campaign = await findCampaignByPhone(phone);
    
    if (!campaign) {
      console.warn(`⚠️ No campaign found for phone ${phone}`);
      // Send a generic message
      await sendWhatsAppMessage(phone, 'Hi! I didn\'t find an active campaign for this number. Please contact support.');
      return;
    }
    
    console.log(`✅ Found campaign:`, {
      userId: campaign.userId,
      campaignId: campaign.campaignId,
      contactId: campaign.contactId,
    });
    
    // Step 2: Store user message
    console.log(`💾 Storing user message...`);
    await storeMessage(
      campaign.userId,
      campaign.campaignId,
      campaign.contactId,
      'user',
      userMessage,
      messageId
    );
    
    // Step 3: Generate AI response
    console.log(`🤖 Generating AI response...`);
    const aiReply = await generateResponse(
      campaign.userId,
      campaign.campaignId,
      campaign.contactId,
      userMessage
    );
    
    // Step 4: Send AI response back via WhatsApp
    console.log(`📨 Sending AI response via WhatsApp...`);
    const responseMessageId = await sendWhatsAppMessage(phone, aiReply);
    
    // Step 5: Store AI response
    if (responseMessageId) {
      console.log(`💾 Storing AI response...`);
      await storeMessage(
        campaign.userId,
        campaign.campaignId,
        campaign.contactId,
        'campaign',
        aiReply,
        responseMessageId
      );
    }
    
    console.log(`✅ Conversation processed successfully\n`);
  } catch (error) {
    console.error('❌ Error handling WhatsApp message:', error);
  }
}

module.exports = {
  handleWhatsAppMessage,
  initializeFirebase,
};
