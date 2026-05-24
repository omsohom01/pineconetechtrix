'use strict';

const admin = require('firebase-admin');
const { ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings } = require('@langchain/google-genai');
const { Pinecone } = require('@pinecone-database/pinecone');
const axios = require('axios');
const { updateAnalysisWhatsApp } = require('./analysis-service');

// ── Firebase Admin Init (from env vars, no file path needed) ─────────────────
let _db = null;

function getDb() {
  if (_db) return _db;
  
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY || '';
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  
  console.log(`[Conv-Service] 🔧 Firebase Init Check:`);
  console.log(`   projectId: ${projectId ? '✓ set' : '✗ MISSING'}`);
  console.log(`   clientEmail: ${clientEmail ? '✓ set' : '✗ MISSING'}`);
  console.log(`   privateKey: ${privateKey ? '✓ set' : '✗ MISSING'}`);
  
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('❌ Missing Firebase credentials - check .env vars');
  }
  
  if (!admin.apps.length) {
    try {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          privateKey: privateKey.replace(/\\n/g, '\n'),
          clientEmail,
        }),
      });
      console.log(`[Conv-Service] ✅ Firebase initialized successfully`);
    } catch (err) {
      console.error(`[Conv-Service] ❌ Firebase init failed:`, err.message);
      throw err;
    }
  }
  _db = admin.firestore();
  return _db;
}

// ── Gemini Model ─────────────────────────────────────────────────────────────
function getModel() {
  const apiKey = process.env.GEMINI_WHATSAPP_API_KEY;
  console.log(`[Conv-Service] Gemini API Key: ${apiKey ? '✓ set' : '✗ MISSING'}`);
  
  return new ChatGoogleGenerativeAI({
    model: 'gemini-2.5-flash',
    apiKey: apiKey || '',
    temperature: 0.1,
  });
}

// ── Embeddings + Pinecone ───────────────────────────────────────────────────
let _embeddingModel = null;
let _pineconeIndex = null;

function getEmbeddingModel() {
  if (_embeddingModel) return _embeddingModel;

  const apiKey =
    process.env.GEMINI_WHATSAPP_API_KEY || process.env.GEMINI_API_KEY || '';
  if (!apiKey) {
    console.warn('[Conv-Service] ⚠️ Missing Gemini API key for embeddings');
  }

  _embeddingModel = new GoogleGenerativeAIEmbeddings({
    apiKey,
    model: 'gemini-embedding-2',
  });

  return _embeddingModel;
}

function getPineconeIndex() {
  if (_pineconeIndex) return _pineconeIndex;

  const apiKey = process.env.PINECONE_API_KEY;
  const indexName = process.env.PINECONE_INDEX_NAME;

  if (!apiKey || !indexName) {
    throw new Error('Missing Pinecone configuration (PINECONE_API_KEY, PINECONE_INDEX_NAME)');
  }

  const client = new Pinecone({ apiKey });
  _pineconeIndex = client.Index(indexName);
  return _pineconeIndex;
}

// ── Phone Normalizer ─────────────────────────────────────────────────────────
function normalizePhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) digits = '91' + digits;
  return digits;
}

// ── Find latest campaign for phone from contacts collection ──────────────────
/**
 * NEW CONTACTS COLLECTION APPROACH:
 * Queries root-level contacts/{phoneNumber} document.
 * Each contact document has:
 *   - campaigns: [{ campaignId, userId, title, description, ... }, ...]
 *   - lastCampaignId: most recent campaign ID
 *   - updatedAt: timestamp
 *
 * Returns the LATEST campaign for this phone number.
 * If multiple campaigns have contacted this number, uses lastCampaignId.
 *
 * Returns { userId, campaignId, contactId, contactPhone } or null.
 */
async function findLatestCampaignByPhone(phone) {
  const db = getDb();
  const normalizedPhone = normalizePhone(phone) || phone;

  console.log(`\n[Conv-Service] 🔍 START: findLatestCampaignByPhone("${phone}") → normalized: "${normalizedPhone}"`);
  console.log(`[Conv-Service]    📍 Querying contacts collection for this phone...`);

  try {
    // Query the contacts collection for this phone number
    const contactDocRef = db.collection("contacts").doc(normalizedPhone);
    const contactSnap = await contactDocRef.get();

    if (!contactSnap.exists) {
      console.warn(`[Conv-Service] ❌ Phone ${normalizedPhone} not found in contacts collection`);
      return null;
    }

    const contactData = contactSnap.data();
    const lastCampaignId = contactData.lastCampaignId;
    const campaigns = contactData.campaigns || [];

    console.log(`[Conv-Service]    ✓ Contact found:`);
    console.log(`[Conv-Service]      Phone: ${normalizedPhone}`);
    console.log(`[Conv-Service]      Total campaigns: ${campaigns.length}`);

    if (!lastCampaignId) {
      console.warn(`[Conv-Service] ❌ No lastCampaignId in contact document`);
      return null;
    }

    // Find the last campaign object from the campaigns array
    const lastCampaign = campaigns.find(c => c.campaignId === lastCampaignId);
    
    if (!lastCampaign) {
      console.warn(`[Conv-Service] ❌ Campaign ${lastCampaignId} not found in campaigns array`);
      return null;
    }

    console.log(`[Conv-Service]      Last campaign ID: ${lastCampaignId}`);
    console.log(`[Conv-Service]      Last campaign title: "${lastCampaign.title}"`);
    console.log(`[Conv-Service]      Campaign launched at: ${lastCampaign.launchedAt?.toISOString?.() || lastCampaign.launchedAt}`);

    // Generate contact ID
    const contactId = `contact_${normalizedPhone}_${lastCampaignId}`;

    // Load campaign data to find contact name
    let contactName = 'Unknown Contact';
    try {
      const db = getDb();
      const campaignSnap = await db
        .collection('users')
        .doc(lastCampaign.userId)
        .collection('campaigns')
        .doc(lastCampaignId)
        .get();
      
      if (campaignSnap.exists) {
        const campaignData = campaignSnap.data();
        const contacts = campaignData.contacts || campaignData.contactsSummary?.items || [];
        const contact = contacts.find((c) => 
          c.phone?.replace(/\D/g, '') === normalizedPhone.replace(/\D/g, '')
        );
        if (contact && contact.name) {
          contactName = contact.name;
        }
      }
    } catch (err) {
      console.warn(`[Conv-Service] Could not load contact name:`, err.message);
    }

    const result = {
      userId: lastCampaign.userId,
      campaignId: lastCampaignId,
      contactId,
      contactPhone: normalizedPhone,
      contactName,
    };

    console.log(`[Conv-Service] ✅ RESULT: Using LATEST campaign for ${normalizedPhone}:`, {
      userId: result.userId,
      campaignId: result.campaignId,
      contactName: result.contactName,
      title: lastCampaign.title,
    });

    return result;
  } catch (error) {
    console.error(`[Conv-Service] ❌ findLatestCampaignByPhone FATAL:`, error.message);
    console.error(error.stack);
    return null;
  }
}

// ── Load campaign context (title + description + documents) ──────────────────
async function loadCampaignContext(userId, campaignId) {
  const db = getDb();
  try {
    const campaignSnap = await db
      .collection('users')
      .doc(userId)
      .collection('campaigns')
      .doc(campaignId)
      .get();

    if (!campaignSnap.exists) {
      console.warn(`⚠️ Campaign not found: ${campaignId}`);
      return { title: '', description: '', documents: '', assets: '' };
    }

    const data = campaignSnap.data();
    
    // 1. Title
    const title = data.title || '';
    console.log(`   📌 Campaign Title: "${title}"`);
    
    // 2. Description (try multiple field names)
    let description = '';
    if (data.description?.aiEnhanced) {
      description = data.description.aiEnhanced;
      console.log(`   📝 Description (aiEnhanced): ${description.length} chars`);
    } else if (data.description?.original) {
      description = data.description.original;
      console.log(`   📝 Description (original): ${description.length} chars`);
    } else if (typeof data.description === 'string') {
      description = data.description;
      console.log(`   📝 Description (string): ${description.length} chars`);
    } else if (data.description) {
      description = JSON.stringify(data.description);
      console.log(`   📝 Description (object): ${description.length} chars`);
    }

    // 3. Documents
    let documents = '';
    if (data.documents && Array.isArray(data.documents)) {
      documents = data.documents
        .map((d) => {
          if (d.extractedText) return d.extractedText;
          if (typeof d === 'string') return d;
          return JSON.stringify(d);
        })
        .filter(Boolean)
        .join('\n\n');
      console.log(`   📄 Documents: ${documents.length} chars (${data.documents.length} files)`);
    }

    // 4. Assets (images, videos, PDFs)
    let assets = '';
    if (data.assets && Array.isArray(data.assets)) {
      assets = data.assets
        .map((a) => `[${a.name || 'Asset'}: ${a.type || 'unknown'}]`)
        .join(', ');
      console.log(`   🎨 Assets: ${assets}`);
    }

    const fullContext = [title, description, documents, assets].filter(Boolean).join('\n\n');
    console.log(`   ✅ Total context: ${fullContext.length} chars`);
    console.log('   🧾 RAW CONTEXT START');
    console.log(`   Title: ${title || '(empty)'}`);
    console.log(`   Description: ${description || '(empty)'}`);
    console.log(`   Documents: ${documents || '(empty)'}`);
    console.log(`   Assets: ${assets || '(empty)'}`);
    console.log('   🧾 RAW CONTEXT END');

    return { title, description, documents, assets, fullContext };
  } catch (error) {
    console.error('❌ loadCampaignContext error:', error.message);
    console.error(error.stack);
    return { title: '', description: '', documents: '', assets: '', fullContext: '' };
  }
}

// ── Pinecone namespace loader (vectoruser store) ───────────────────────────
async function loadPineconeNamespace(userId, campaignId) {
  const db = getDb();
  try {
    const docSnap = await db
      .collection('vectoruser')
      .doc(userId)
      .collection('projects')
      .doc(campaignId)
      .get();

    if (docSnap.exists) {
      const data = docSnap.data();
      if (data?.pineconeNamespace) {
        return data.pineconeNamespace;
      }
    }
  } catch (error) {
    console.warn('[Conv-Service] ⚠️ Failed to load pinecone namespace:', error.message);
  }

  return `project_${campaignId}`;
}

function extractContextFromMetadata(metadata) {
  if (!metadata) return '';

  const candidates = [
    metadata.text,
    metadata.chunk,
    metadata.content,
    metadata.pageContent,
    metadata.body,
  ];

  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return '';
}

async function getChunkTextFromFirestore(userId, campaignId, fileName, chunkIndex) {
  if (!fileName || chunkIndex === undefined || chunkIndex === null) return '';
  const db = getDb();
  try {
    const chunksSnap = await db
      .collection('users')
      .doc(userId)
      .collection('campaigns')
      .doc(campaignId)
      .collection('chunks')
      .where('docName', '==', fileName)
      .where('index', '==', Number(chunkIndex))
      .get();

    if (!chunksSnap.empty) {
      const data = chunksSnap.docs[0].data();
      return data.chunkText || '';
    }
  } catch (error) {
    console.warn(`[Conv-Service] ⚠️ Failed to fetch chunk from Firestore:`, error.message);
  }
  return '';
}

// ── Fetch Q&A pairs from Firestore qna subcollection ───────────────────────
/**
 * Loads all question-answer pairs stored under:
 *   users/{userId}/campaigns/{campaignId}/qna/{docId}
 * Each document is expected to have at least { question, answer } fields.
 * Returns a formatted string ready to be injected into the prompt, or '' if empty.
 */
async function fetchQnaFromFirestore(userId, campaignId) {
  const db = getDb();
  try {
    const qnaSnap = await db
      .collection('users')
      .doc(userId)
      .collection('campaigns')
      .doc(campaignId)
      .collection('qna')
      .get();

    if (qnaSnap.empty) {
      console.log(`[Conv-Service]    🔴 QnA collection is empty for campaign ${campaignId}`);
      return '';
    }

    const pairs = [];
    qnaSnap.docs.forEach((doc) => {
      const d = doc.data();
      const q = d.question || d.q || '';
      const a = d.answer   || d.a || '';
      if (q && a) {
        pairs.push(`Q: ${q}\nA: ${a}`);
      }
    });

    console.log(`[Conv-Service]    ✅ QnA: loaded ${pairs.length} pairs from Firestore`);
    return pairs.join('\n\n');
  } catch (error) {
    console.warn(`[Conv-Service]    ⚠️ fetchQnaFromFirestore failed:`, error.message);
    return '';
  }
}

async function retrieveRagContext(userId, campaignId, question) {
  const namespace = await loadPineconeNamespace(userId, campaignId);
  const index = getPineconeIndex();
  const embeddings = getEmbeddingModel();

  console.log(`[Conv-Service]    🔍 RAG RETRIEVAL START`);
  console.log(`[Conv-Service]       Namespace: ${namespace}`);
  console.log(`[Conv-Service]       Question: "${question}"`);

  const vector = await embeddings.embedQuery(question);
  console.log(`[Conv-Service]       ✓ Question embedded (vector dimension: ${vector.length})`);

  const results = await index
    .namespace(namespace)
    .query({ vector, topK: 6, includeMetadata: true });

  const matches = results.matches || [];
  console.log(`[Conv-Service]    📊 Pinecone results: ${matches.length} total matches`);
  console.log(`[Conv-Service]    🔍 Resolving match texts from Firestore chunks collection...`);

  // Fetch all chunk contents from Firestore in parallel
  const matchesWithContent = await Promise.all(
    matches.map(async (match, idx) => {
      const metadata = match.metadata || {};
      let content = extractContextFromMetadata(metadata);
      
      // Fallback to Firestore if Pinecone metadata doesn't contain the text content
      if (!content && metadata.fileName && metadata.chunkIndex !== undefined) {
        content = await getChunkTextFromFirestore(
          userId,
          campaignId,
          metadata.fileName,
          metadata.chunkIndex
        );
      }
      
      return {
        ...match,
        content: content || '',
      };
    })
  );

  console.log(`[Conv-Service]    📋 All Matches:\n`);
  
  // Log all matches with scores
  matchesWithContent.forEach((match, idx) => {
    const score = (match.score ?? 0).toFixed(3);
    const chunkId = match.id || `chunk_${idx}`;
    const metadata = match.metadata || {};
    const preview = match.content.substring(0, 80);
    const metaKeys = Object.keys(metadata).join(', ');
    
    console.log(`[Conv-Service]       [${idx + 1}] Chunk ID: ${chunkId}`);
    console.log(`[Conv-Service]           Score: ${score} ${parseFloat(score) >= 0.2 ? '✅ RELEVANT' : '❌ FILTERED'}`);
    console.log(`[Conv-Service]           Metadata keys: ${metaKeys || '(none)'}`);
    console.log(`[Conv-Service]           Preview: "${preview}${preview.length > 80 ? '...' : ''}"`);
    console.log(`[Conv-Service]    `);
  });

  const RELEVANCE_THRESHOLD = 0.2;
  const relevant = matchesWithContent.filter((match) => (match.score ?? 0) >= RELEVANCE_THRESHOLD);
  
  console.log(`[Conv-Service]    ✅ Filtering by threshold (${RELEVANCE_THRESHOLD}): ${relevant.length}/${matches.length} passed`);
  console.log(`[Conv-Service]    📌 Selected Chunks:\n`);
  
  const contextChunks = relevant
    .map((match, idx) => {
      const chunkId = match.id || `chunk_${idx}`;
      const score = (match.score ?? 0).toFixed(3);
      const content = match.content;
      
      console.log(`[Conv-Service]       Chunk ${idx + 1}/${relevant.length}: ${chunkId}`);
      console.log(`[Conv-Service]           Score: ${score}`);
      console.log(`[Conv-Service]           Length: ${content.length} chars`);
      console.log(`[Conv-Service]           Content preview: "${content.substring(0, 100)}${content.length > 100 ? '...' : ''}"`);
      console.log(`[Conv-Service]    `);
      
      return content;
    })
    .filter(Boolean);

  const finalContext = contextChunks.join('\n\n');
  console.log(`[Conv-Service]    🎯 RAG CONTEXT READY`);
  console.log(`[Conv-Service]       Total chunks used: ${contextChunks.length}`);
  console.log(`[Conv-Service]       Combined context length: ${finalContext.length} chars`);
  console.log(`[Conv-Service]    🔍 RAG RETRIEVAL END\n`);

  return {
    namespace,
    context: finalContext,
    matchCount: relevant.length,
    chunkDetails: relevant.map((match, idx) => ({
      chunkId: match.id || `chunk_${idx}`,
      score: (match.score ?? 0).toFixed(3),
      content: match.content,
    })),
  };
}

// ── Load chat history (last 20 exchanges) ────────────────────────────────────
/**
 * Mirrors loadChatHistory from campaign-langchain.ts.
 * Returns array of { input, output } exchange pairs.
 */
async function loadChatHistory(userId, campaignId, contactId) {
  const db = getDb();
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
      const d = doc.data();
      if (d.sender === 'user') {
        lastUserMsg = d.content;
      } else if ((d.sender === 'ai' || d.sender === 'campaign') && lastUserMsg) {
        history.push({ input: lastUserMsg, output: d.content });
        lastUserMsg = '';
      }
    });

    console.log(`📚 Loaded ${history.length} conversation exchanges`);
    return history;
  } catch (error) {
    console.error('❌ loadChatHistory error:', error.message);
    return [];
  }
}

// ── Save user message + AI reply to Firestore ────────────────────────────────
/**
 * Stores:
 *   - user message as sender:'user'
 *   - AI reply as sender:'campaign'
 * Also updates the contact document's lastMessage/lastMessageTime/unreadCount.
 */
async function saveChatHistory(userId, campaignId, contactId, userMessage, aiReply, phone, contactName, options = {}) {
  const db = getDb();
  const userType = options.userType || 'text';
  const aiType = options.aiType || 'text';
  const userMeta = options.userMeta || {};
  const aiMeta = options.aiMeta || {};

  const contactRef = db
    .collection('users')
    .doc(userId)
    .collection('campaigns')
    .doc(campaignId)
    .collection('inbox')
    .doc('contacts')
    .collection('contacts')
    .doc(contactId);

  try {
    // Ensure contact document exists
    await contactRef.set(
      {
        contactPhone: phone,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // Store user message
    const userMsgId = `user_${Date.now()}`;
    await contactRef.collection('messages').doc(userMsgId).set({
      id: userMsgId,
      sender: 'user',
      type: userType,
      content: userMessage,
      contactPhone: phone,
      meta: userMeta,
      timestamp: new Date().toISOString(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Store AI reply
    const aiMsgId = `ai_${Date.now() + 1}`;
    await contactRef.collection('messages').doc(aiMsgId).set({
      id: aiMsgId,
      sender: 'campaign',
      type: aiType,
      content: aiReply,
      meta: aiMeta,
      timestamp: new Date().toISOString(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Update contact last message metadata
    await contactRef.set(
      {
        lastMessage: aiReply,
        lastMessageTime: admin.firestore.FieldValue.serverTimestamp(),
        unreadCount: admin.firestore.FieldValue.increment(1),
      },
      { merge: true }
    );

    console.log(`💾 Messages saved — user: ${userMsgId}, ai: ${aiMsgId}`);

    // Update analysis collection DIRECTLY (Backend)
    try {
      // Get all messages for this contact
      const messagesSnapshot = await contactRef.collection('messages').get();
      const messages = messagesSnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));

      // Call backend analysis service directly
      const result = await updateAnalysisWhatsApp(userId, campaignId, {
        contactId,
        contactName: contactName || 'Unknown',
        phone,
        messages,
      });
      
      console.log(`✅ WhatsApp analysis updated: ${result.totalMessages} messages, ${result.totalUsers} users`);
    } catch (analysisErr) {
      console.warn(`⚠️ Failed to update WhatsApp analysis:`, analysisErr.message);
      // Don't fail the entire flow if analysis update fails
    }
  } catch (error) {
    console.error('❌ saveChatHistory error:', error.message);
  }
}

// ── Generate AI reply using Gemini ───────────────────────────────────────────
/**
 * Generates a reply based on the specific campaign context.
 * CRITICAL: Only answer questions about the campaign topic. Refuse irrelevant questions.
 */
async function generateCampaignReply(userId, campaignId, contactId, message) {
  try {
    console.log(`[Conv-Service]    🤖 Generating AI reply (CAMPAIGN-CONTEXT)...`);
    console.log(`[Conv-Service]       User: ${userId}, Campaign: ${campaignId}, Contact: ${contactId}`);

    // Load static context + chat history first (fast)
    const context = await loadCampaignContext(userId, campaignId);
    // ⚠️  Destructure BOTH title AND documents — the documents string already contains
    //     any Q&A pairs the user embedded in their uploaded files.
    const { title, documents: campaignDocuments } = context;
    console.log(`[Conv-Service]       Context loaded: title=${title.length > 0 ? '✓' : '✗'}, docs=${campaignDocuments?.length ?? 0} chars`);

    const history = await loadChatHistory(userId, campaignId, contactId);
    console.log(`[Conv-Service]       History: ${history.length} exchanges`);

    // Fetch RAG (Pinecone) + QnA (Firestore) in PARALLEL for speed
    console.log(`[Conv-Service]       🔄 Fetching RAG context + QnA pairs in parallel...`);
    const [rag, qnaContext] = await Promise.all([
      retrieveRagContext(userId, campaignId, message),
      fetchQnaFromFirestore(userId, campaignId),
    ]);

    console.log(`[Conv-Service]       RAG context : ${rag.context.length} chars, matches=${rag.matchCount}`);
    console.log(`[Conv-Service]       QnA context : ${qnaContext.length} chars`);

    // Display chunk sources in detail
    if (rag.chunkDetails && rag.chunkDetails.length > 0) {
      console.log(`[Conv-Service]       📦 CHUNK SOURCES:\n`);
      rag.chunkDetails.forEach((chunk, idx) => {
        console.log(`[Conv-Service]           [${idx + 1}] ${chunk.chunkId}`);
        console.log(`[Conv-Service]               Similarity Score: ${chunk.score}`);
        console.log(`[Conv-Service]               Source Content: "${chunk.content.substring(0, 120)}${chunk.content.length > 120 ? '...' : ''}"\n`);
      });
    }

    // Need at least one knowledge source to proceed
    if (!rag.context && !qnaContext && !campaignDocuments) {
      return 'Sorry, I do not have information related to that.';
    }

    // ── Build knowledge blocks (only include non-empty ones) ─────────────────
    //
    //  1. CAMPAIGN DOCUMENTS — the full extracted text from uploaded files.
    //     This is the MOST RELIABLE source because it bypasses Pinecone entirely.
    //     It already contains any Q&A pairs the user typed into their documents.
    //
    //  2. RAG SNIPPETS — semantically retrieved chunks from Pinecone.
    //     Useful for large corpora; may be empty if chunk retrieval from
    //     Firestore failed (known issue when chunk field names mismatch).
    //
    //  3. DEDICATED Q&A PAIRS — from the campaign's /qna Firestore subcollection
    //     (if the user stores them separately).

    const docsBlock = campaignDocuments
      ? `=== CAMPAIGN DOCUMENTS (complete extracted text, includes any Q&A pairs) ===\n${campaignDocuments}\n=== END CAMPAIGN DOCUMENTS ===`
      : '';

    const ragBlock = rag.context
      ? `=== ADDITIONAL RAG SNIPPETS (semantically matched chunks) ===\n${rag.context}\n=== END RAG SNIPPETS ===`
      : '';

    const qnaBlock = qnaContext
      ? `=== DEDICATED Q&A PAIRS ===\n${qnaContext}\n=== END DEDICATED Q&A PAIRS ===`
      : '';

    const knowledgeSection = [docsBlock, ragBlock, qnaBlock].filter(Boolean).join('\n\n');

    console.log(`[Conv-Service]       📚 Knowledge blocks: docs=${docsBlock.length}, rag=${ragBlock.length}, qna=${qnaBlock.length} chars`);

    // 🔥 CRITICAL: Strong prompt that forces context-based answers
    const prompt = `You are a helpful, sales-oriented assistant for the "${title}" campaign.

Below are your knowledge sources. Use ALL of them to answer the user's question.
The CAMPAIGN DOCUMENTS are your primary reference — they contain the full event/product details and any Q&A pairs embedded in the documents.
Use RAG SNIPPETS and Q&A PAIRS as additional confirmation.

${knowledgeSection}

CRITICAL RULES:
1. Answer using ONLY information from the knowledge blocks above
2. Do NOT say "based on the context", "based on the documents", or reveal internal source names
3. If the answer exists ANYWHERE in the knowledge blocks, use it — do NOT say you don't have information
4. If the answer truly cannot be found in any knowledge block, say you don't have that detail and ask one short follow-up
5. Keep the tone warm, confident, and concise

Recent conversation history:
${history.length > 0 ? history.map((h) => `Q: ${h.input}\nA: ${h.output}`).join('\n\n') : 'No previous conversation'}

User question: "${message}"

RESPOND NOW - Use the knowledge above to answer clearly.`;

    const model = getModel();
    console.log(`[Conv-Service]       📝 Prompt length: ${prompt.length} chars`);
    console.log(`[Conv-Service]       🔄 Calling Gemini API (CONTEXT-BASED)...`);

    const result = await model.invoke(prompt);
    const aiReply = result.content?.toString().trim() || 'I\'m here to help with questions about this campaign.';

    console.log(`[Conv-Service]       ✅ Reply generated (${aiReply.length} chars)`);
    console.log(`[Conv-Service]       📝 "${aiReply.substring(0, 100)}..."`);

    return aiReply;
  } catch (error) {
    console.error(`[Conv-Service]    ❌ generateCampaignReply FAILED:`, error.message);
    console.error(error.stack);
    return 'I apologize for the error. Please ask your question again about this campaign.';
  }
}

// ── Send WhatsApp reply ───────────────────────────────────────────────────────
async function sendWhatsAppReply(phone, content) {
  const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
  const WA_API_BASE = `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`;

  console.log(`[Conv-Service]    📤 WhatsApp config check:`);
  console.log(`[Conv-Service]       Phone ID: ${PHONE_NUMBER_ID ? '✓' : '✗'}`);
  console.log(`[Conv-Service]       Access Token: ${ACCESS_TOKEN ? '✓ set' : '✗ MISSING'}`);

  try {
    console.log(`[Conv-Service]    📤 Calling WhatsApp API...`);
    const res = await axios.post(
      WA_API_BASE,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phone,
        type: 'text',
        text: { body: content, preview_url: false },
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
    const msgId = res.data?.messages?.[0]?.id;
    console.log(`[Conv-Service]    ✅ WhatsApp API success, msgId: ${msgId}`);
    return msgId;
  } catch (error) {
    const errMsg = error?.response?.data?.error?.message || error.message;
    const errCode = error?.response?.data?.error?.code;
    console.error(`[Conv-Service]    ❌ WhatsApp API FAILED:`);
    console.error(`[Conv-Service]       Status: ${error?.response?.status}`);
    console.error(`[Conv-Service]       Code: ${errCode}`);
    console.error(`[Conv-Service]       Message: ${errMsg}`);
    throw error;
  }
}

// ── Main handler: called from the webhook ────────────────────────────────────
/**
 * Orchestrates the full conversation flow:
 *   1. Find the latest campaign for this phone
 *   2. Generate an AI reply based on campaign context
 *   3. Save user message + AI reply to Firestore
 *   4. Send the AI reply back via WhatsApp
 *
 * @param {string} phone     - Sender's phone (raw, will be normalised)
 * @param {string} content   - User's message text
 * @param {string} messageId - WhatsApp message ID (for deduplication)
 */
async function handleWhatsAppMessage(phone, content, messageId) {
  console.log(`\n\n${'═'.repeat(80)}`);
  console.log(`[Conv-Service] 🚀 START handleWhatsAppMessage`);
  console.log(`   Phone: "${phone}" (raw)`);
  console.log(`   Message ID: ${messageId}`);
  console.log(`   Content: "${content}"`);
  console.log(`${'═'.repeat(80)}`);

  const normalizedPhone = normalizePhone(phone) || phone;
  console.log(`[Conv-Service] Phone normalized: "${phone}" → "${normalizedPhone}"`);

  // 1. Find latest campaign
  console.log(`\n[Conv-Service] STEP 1️⃣: Finding campaign for ${normalizedPhone}...`);
  const campaign = await findLatestCampaignByPhone(normalizedPhone);

  if (!campaign) {
    console.error(`\n[Conv-Service] ❌ STEP 1 FAILED: No campaign found for ${normalizedPhone}!`);
    console.log(`[Conv-Service] 📤 Sending response indicating no campaign found...`);
    try {
      await sendWhatsAppReply(normalizedPhone, "Hi! I couldn't find an active campaign for your number. Please contact support.");
      console.log(`[Conv-Service] ✅ Reply sent`);
    } catch (err) {
      console.error(`[Conv-Service] ❌ Failed to send reply:`, err.message);
    }
    console.log(`${'═'.repeat(80)}\n`);
    return;
  }

  const { userId, campaignId, contactId, contactName } = campaign;
  console.log(`[Conv-Service] ✅ STEP 1: Campaign found!`);
  console.log(`   userId: ${userId}`);
  console.log(`   campaignId: ${campaignId}`);
  console.log(`   contactId: ${contactId}`);
  console.log(`   contactName: ${contactName}`);

  try {
    // 2. Generate AI reply based on campaign context
    console.log(`\n[Conv-Service] STEP 2️⃣: Generating AI reply using CAMPAIGN CONTEXT...`);
    const aiReply = await generateCampaignReply(userId, campaignId, contactId, content);
    console.log(`[Conv-Service] ✅ STEP 2: AI reply generated`);
    console.log(`   Length: ${aiReply.length} chars`);
    console.log(`   Preview: "${aiReply.substring(0, 100)}..."`);

    // 3. Save both messages to Firestore (same structure as frontend)
    console.log(`\n[Conv-Service] STEP 3️⃣: Saving to Firebase...`);
    await saveChatHistory(userId, campaignId, contactId, content, aiReply, normalizedPhone, contactName);
    console.log(`[Conv-Service] ✅ STEP 3: Messages saved`);

    // 4. Send AI reply back via WhatsApp
    console.log(`\n[Conv-Service] STEP 4️⃣: Sending via WhatsApp...`);
    await sendWhatsAppReply(normalizedPhone, aiReply);
    console.log(`[Conv-Service] ✅ STEP 4: Reply sent`);

    console.log(`\n[Conv-Service] ✅✅✅ COMPLETE: Message processed successfully with CAMPAIGN CONTEXT`);
    console.log(`${'═'.repeat(80)}\n`);
  } catch (error) {
    console.error(`\n[Conv-Service] ❌ FATAL ERROR in handleWhatsAppMessage:`, error.message);
    console.error(error.stack);
    console.log(`${'═'.repeat(80)}\n`);
  }
}

module.exports = {
  handleWhatsAppMessage,
  findLatestCampaignByPhone,
  generateCampaignReply,
  saveChatHistory,
  sendWhatsAppReply,
};
