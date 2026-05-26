const express = require('express');
const axios = require('axios');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { v2: cloudinary } = require('cloudinary');
const router = express.Router();

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
const {
  handleWhatsAppMessage,
  findLatestCampaignByPhone,
  generateCampaignReply,
  saveChatHistory,
} = require('../conversation-service');

const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WA_API_BASE = `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Normalize phone number to WhatsApp format (digits only, with country code).
 * Examples: "+91 98831 31455" → "919883131455"
 *           "9883131455" (10-digit India) → "919883131455"
 *           "919883131455" → "919883131455"
 */
function normalizePhone(raw) {
  if (!raw) return null;
  // Strip all non-digit characters
  let digits = String(raw).replace(/\D/g, '');
  // If exactly 10 digits, assume India (+91)
  if (digits.length === 10) {
    digits = '91' + digits;
  }
  return digits;
}

/**
 * Send a single WhatsApp message payload.
 */
async function sendWA(payload) {
  try {
    console.log(`🔄 WhatsApp API call to: ${WA_API_BASE}`);
    console.log(`   To: ${payload.to}`);
    console.log(`   Type: ${payload.type}`);
    
    // Increase timeout for audio/media messages
    const timeout = (payload.type === 'audio' || payload.type === 'image' || payload.type === 'document') ? 15000 : 8000;
    
    const res = await axios.post(WA_API_BASE, payload, {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout,
    });

    console.log(`✅ WhatsApp API success:`, JSON.stringify(res.data, null, 2));
    return res.data;
  } catch (err) {
    if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
      console.error(`❌ WhatsApp API TIMEOUT (request took too long):`);
      console.error(`   Payload type: ${payload.type}`);
      if (payload.type === 'audio') {
        console.error(`   ⚠️  Audio request timeout - the audio URL or WhatsApp API might be slow`);
      }
    } else {
      console.error(`❌ WhatsApp API error:`);
      console.error(`   Status: ${err?.response?.status}`);
      console.error(`   Message: ${err?.response?.data?.error?.message}`);
      console.error(`   Code: ${err?.response?.data?.error?.code}`);
      console.error(`   Type: ${err?.response?.data?.error?.type}`);
      
      const errorData = err?.response?.data?.error?.error_data;
      if (errorData) {
        console.error(`   Error Details:`, JSON.stringify(errorData, null, 2));
      }
      
      console.error(`   Full error:`, JSON.stringify(err?.response?.data, null, 2));
      
      // Additional debugging for audio failures
      if (payload.type === 'audio') {
        console.error(`\n🔍 AUDIO FAILURE DEBUGGING:`);
        console.error(`   Payload sent:`, JSON.stringify(payload, null, 2));
        console.error(`\n   💡 Possible causes:`);
        console.error(`      1. Cloudinary URL not accessible to WhatsApp`);
        console.error(`      2. Wrong Content-Type (should be audio/mpeg for MP3)`);
        console.error(`      3. File corrupted or not a valid MP3`);
        console.error(`      4. URL returns 404 or 403 when WhatsApp tries to fetch`);
        console.error(`      5. Cloudinary rate-limiting WhatsApp requests`);
      }
    }
    throw err;
  }
}

/**
 * Send a text message using template (works in sandbox mode).
 */
async function sendText(to, text) {
  return sendWA({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { body: text, preview_url: false },
  });
}

/**
 * Send a template message (required for sandbox/test mode).
 * Falls back to hello_world template which is built-in.
 */
async function sendTemplate(to, templateName = 'hello_world') {
  return sendWA({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: {
        code: 'en_US',
      },
    },
  });
}

/**
 * Send an audio/voice note.
 * ⚠️ CRITICAL: WhatsApp voice messages REQUIRE OGG/OPUS codec!
 * Reference: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages#audio-object
 * 
 * Supported formats:
 *   - Voice messages: audio/ogg; codecs=opus (REQUIRED - OGG/OPUS ONLY!)
 *   - Call audio: audio/mpeg, audio/wav
 * 
 * URL must be:
 *   1. Publicly accessible (no auth required)
 *   2. Return correct Content-Type: audio/ogg
 *   3. Not redirect (WhatsApp won't follow redirects)
 *   4. Stable URL (WhatsApp downloads asynchronously)
 */
async function sendAudio(to, audioUrl) {
  console.log(`\n🔊 [sendAudio] Attempting to send VOICE MESSAGE (OGG/OPUS required)`);
  console.log(`   To: ${to}`);
  console.log(`   Raw URL: ${audioUrl}`);
  console.log(`   URL Length: ${audioUrl?.length || 0} chars`);
  console.log(`   URL Secure: ${audioUrl?.startsWith('https') ? '✅ YES (https)' : '❌ NO (not https)'}`);
  
  // ✅ STEP 1: Detect and validate format
  const urlLower = audioUrl.toLowerCase();
  const isOGG = urlLower.includes('.ogg') || urlLower.includes('f_ogg') || urlLower.includes('format=ogg');
  const isOpus = urlLower.includes('opus') || urlLower.includes('ogg');
  const isMp3 = urlLower.includes('.mp3') || urlLower.includes('f_mp3');
  const isWAV = urlLower.includes('.wav') || urlLower.includes('format=wav');
  
  let format = 'UNKNOWN';
  if (isOGG && isOpus) {
    format = 'OGG/OPUS ✅ (CORRECT)';
  } else if (isMp3) {
    format = 'MP3 ❌ (UNSUPPORTED - WhatsApp voice requires OGG/OPUS!)';
  } else if (isWAV) {
    format = 'WAV ❌ (UNSUPPORTED - WhatsApp voice requires OGG/OPUS!)';
  }
  
  console.log(`   Format detected: ${format}`);
  
  if (!isOGG || !isOpus) {
    console.error(`\n   🚨 CRITICAL ERROR: Audio is not OGG/OPUS format!`);
    console.error(`   ❌ WhatsApp voice messages ONLY support: audio/ogg; codecs=opus`);
    console.error(`   ❌ Your URL is: ${format}`);
    console.error(`   ❌ This is why your audio messages are failing!`);
    console.error(`\n   Fix: Re-convert audio to OGG/OPUS using ffmpeg:`);
    console.error(`      ffmpeg -i input.wav -c:a libopus -b:a 24k output.ogg`);
  }
  
  // ✅ STEP 2: Verify URL accessibility and Content-Type
  console.log(`\n   🔍 Verifying URL accessibility...`);
  try {
    const headRes = await axios.head(audioUrl, {
      timeout: 5000,
      maxRedirects: 0,
    });
    
    const contentType = headRes.headers['content-type'] || 'unknown';
    const contentLength = headRes.headers['content-length'] || 'unknown';
    
    console.log(`   ✅ URL is accessible (HTTP ${headRes.status})`);
    console.log(`   📎 Content-Type: ${contentType}`);
    console.log(`   📦 Content-Length: ${contentLength} bytes`);
    
    if (!contentType.includes('audio/ogg')) {
      console.warn(`   ⚠️ WARNING: Content-Type is "${contentType}" but should be "audio/ogg"`);
      console.warn(`   ⚠️ WhatsApp may reject this file`);
    }
  } catch (headErr) {
    console.error(`   ❌ CRITICAL: URL verification failed!`);
    console.error(`      Error: ${headErr.message}`);
    console.error(`      WhatsApp cannot download the file`);
  }
  
  // ✅ STEP 3: Log final URL structure
  console.log(`\n   📋 URL structure breakdown:`);
  const urlParts = audioUrl.split('?');
  console.log(`     └─ Base: ${urlParts[0].substring(0, 100)}${urlParts[0].length > 100 ? '...' : ''}`);
  if (urlParts[1]) {
    const query = urlParts[1];
    console.log(`     └─ Transform: ${query.substring(0, 80)}${query.length > 80 ? '...' : ''}`);
  }
  
  // ✅ STEP 4: Send to WhatsApp
  console.log(`\n   📤 Sending OGG/OPUS voice message to WhatsApp API...`);
  return sendWA({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'audio',
    audio: { link: audioUrl },
  });
}

/**
 * Send an audio/voice note by WhatsApp media ID.
 * This avoids the need for a public URL.
 */
async function sendAudioById(to, mediaId) {
  return sendWA({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'audio',
    audio: { id: mediaId },
  });
}

function getGeminiApiKey() {
  return process.env.GEMINI_WHATSAPP_API_KEY || process.env.GEMINI_API_KEY || '';
}

function getGeminiTtsApiKey() {
  return process.env.GEMINI_TTS_API_KEY || getGeminiApiKey();
}

let cloudinaryConfigured = false;
function ensureCloudinaryConfigured() {
  if (cloudinaryConfigured) return;

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME || '';
  const apiKey = process.env.CLOUDINARY_API_KEY || '';
  const apiSecret = process.env.CLOUDINARY_API_SECRET || '';

  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error('Missing Cloudinary credentials for voice note uploads');
  }

  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
  });
  cloudinaryConfigured = true;
}

function buildWavBufferFromPcm(pcmBuffer, options = {}) {
  const { sampleRate = 24000, numChannels = 1, bitsPerSample = 16 } = options;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;

  const wavHeader = Buffer.alloc(44);
  wavHeader.write('RIFF', 0);
  wavHeader.writeUInt32LE(pcmBuffer.length + 36, 4);
  wavHeader.write('WAVE', 8);
  wavHeader.write('fmt ', 12);
  wavHeader.writeUInt32LE(16, 16);
  wavHeader.writeUInt16LE(1, 20);
  wavHeader.writeUInt16LE(numChannels, 22);
  wavHeader.writeUInt32LE(sampleRate, 24);
  wavHeader.writeUInt32LE(byteRate, 28);
  wavHeader.writeUInt16LE(blockAlign, 32);
  wavHeader.writeUInt16LE(bitsPerSample, 34);
  wavHeader.write('data', 36);
  wavHeader.writeUInt32LE(pcmBuffer.length, 40);

  return Buffer.concat([wavHeader, pcmBuffer]);
}

async function convertWavToOggOpus(wavBuffer) {
  const tempDir = os.tmpdir();
  const tempBase = `tts_${Date.now()}`;
  const wavPath = path.join(tempDir, `${tempBase}.wav`);
  const oggPath = path.join(tempDir, `${tempBase}.ogg`);

  try {
    await fs.writeFile(wavPath, wavBuffer);

    await new Promise((resolve, reject) => {
      ffmpeg(wavPath)
        .audioCodec('libopus')
        .audioFrequency(24000)
        .audioChannels(1)
        .audioBitrate('24k')
        .format('ogg')
        .on('start', (cmd) => console.log(`[TTS] 🎛️  ffmpeg: ${cmd}`))
        .on('end', resolve)
        .on('error', (err) => reject(new Error(`ffmpeg conversion failed: ${err.message}`)))
        .save(oggPath);
    });

    return await fs.readFile(oggPath);
  } finally {
    await Promise.all([
      fs.rm(wavPath, { force: true }),
      fs.rm(oggPath, { force: true }),
    ]);
  }
}

async function uploadOggToCloudinary(oggBuffer, publicId) {
  ensureCloudinaryConfigured();

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'raw',
        public_id: publicId,
        format: 'ogg',
      },
      (error, result) => {
        if (error) return reject(error);
        if (!result) return reject(new Error('Cloudinary upload failed'));
        resolve(result);
      }
    );

    stream.end(oggBuffer);
  });
}

async function fetchWhatsAppMediaInfo(mediaId) {
  const url = `https://graph.facebook.com/v22.0/${mediaId}`;
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
  });

  return {
    url: res.data?.url,
    mimeType: res.data?.mime_type,
    sha256: res.data?.sha256,
    fileSize: res.data?.file_size,
  };
}

async function downloadWhatsAppMedia(mediaUrl) {
  const res = await axios.get(mediaUrl, {
    responseType: 'arraybuffer',
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
  });

  return Buffer.from(res.data);
}

async function transcribeAudioWithGemini(audioBuffer, mimeType) {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error('Missing GEMINI api key for transcription');
  }

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: 'Transcribe this audio to plain text only.' },
          {
            inlineData: {
              mimeType: mimeType || 'audio/ogg',
              data: audioBuffer.toString('base64'),
            },
          },
        ],
      },
    ],
  };

  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`,
    body,
    { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
  );

  const parts = res.data?.candidates?.[0]?.content?.parts || [];
  const transcript = parts
    .map((part) => part.text)
    .filter(Boolean)
    .join('')
    .trim();

  return transcript;
}

async function synthesizeSpeechWithGemini(text, options = {}) {
  const apiKey = getGeminiTtsApiKey();
  if (!apiKey) throw new Error('Missing GEMINI api key for TTS');

  const voiceName = options.voiceName || process.env.GEMINI_TTS_VOICE || 'Kore';
  const ttsModel = process.env.GEMINI_TTS_MODEL || 'gemini-3.1-flash-tts-preview';
  console.log(`[TTS] 🧠 Generating voice with Gemini (${ttsModel}, ${voiceName})...`);

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: ttsModel }, { apiVersion: 'v1beta' });

  const response = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName },
        },
      },
    },
  });

  const audioPart = response.response?.candidates?.[0]?.content?.parts?.find(
    (part) => part.inlineData?.mimeType?.startsWith('audio/')
  );
  const audioBase64 = audioPart?.inlineData?.data;

  if (!audioBase64) {
    console.error('[TTS] No audio in response:', JSON.stringify(response.response?.candidates, null, 2));
    throw new Error('No audio data returned from TTS');
  }

  const audioBuffer = Buffer.from(audioBase64, 'base64');
  console.log(`[TTS] ✅ PCM audio received (${audioBuffer.length} bytes)`);
  return audioBuffer;
}

async function generateVoiceNoteAudioUrl(text, options = {}) {
  const voiceName = options.voiceName || process.env.GEMINI_TTS_VOICE || 'Kore';
  const publicIdPrefix =
    options.publicIdPrefix ||
    process.env.WHATSAPP_VOICE_PUBLIC_ID_PREFIX ||
    'outreachx-whatsapp/voice-notes';

  const pcmBuffer = await synthesizeSpeechWithGemini(text, { voiceName });

  console.log('[TTS] 🎛️  Building WAV container (PCM -> WAV)...');
  const wavBuffer = buildWavBufferFromPcm(pcmBuffer);
  console.log(`[TTS] ✅ WAV buffer ready (${wavBuffer.length} bytes)`);

  console.log('[TTS] 🎚️  Converting WAV to OGG/OPUS...');
  const oggBuffer = await convertWavToOggOpus(wavBuffer);
  console.log(`[TTS] ✅ OGG/OPUS ready (${oggBuffer.length} bytes)`);

  const publicId = `${publicIdPrefix}/${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  console.log(`[TTS] ☁️  Uploading to Cloudinary (${publicId})...`);
  const uploadResult = await uploadOggToCloudinary(oggBuffer, publicId);

  let audioUrl = uploadResult?.secure_url || uploadResult?.url || '';
  if (!audioUrl) throw new Error('Cloudinary upload returned no URL');

  if (!audioUrl.includes('f_ogg')) {
    audioUrl = audioUrl.replace('/upload/', '/upload/f_ogg/');
  }

  try {
    const headRes = await fetch(audioUrl, { method: 'HEAD' });
    if (!headRes.ok) {
      console.warn(`[TTS] ⚠️  Audio HEAD check failed (${headRes.status})`);
    }
  } catch (err) {
    console.warn(`[TTS] ⚠️  Audio HEAD check error: ${err.message}`);
  }

  console.log(`[TTS] ✅ Audio URL ready: ${audioUrl}`);
  return audioUrl;
}

async function sendVoiceNoteFromText(to, text) {
  const audioUrl = await generateVoiceNoteAudioUrl(text, {
    publicIdPrefix: `outreachx-whatsapp/voice-notes/${to}`,
  });
  const sendRes = await sendAudio(to, audioUrl);
  const messageId = sendRes?.messages?.[0]?.id || null;
  return { messageId, audioUrl };
}

/**
 * Send an image with optional caption.
 */
async function sendImage(to, imageUrl, caption = '') {
  return sendWA({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'image',
    image: { link: imageUrl, caption },
  });
}

/**
 * Send a document (PDF, etc.) with filename.
 */
async function sendDocument(to, docUrl, filename = 'document') {
  return sendWA({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'document',
    document: { link: docUrl, filename },
  });
}

/**
 * Determine message type from URL/extension.
 */
function getAssetType(asset) {
  if (!asset) return 'document';
  const url = (asset.url || asset.cloudinaryUrl || asset.link || '').toLowerCase();
  if (url.match(/\.(jpg|jpeg|png|gif|webp)(\?|$)/)) return 'image';
  if (url.match(/\.(pdf)(\?|$)/)) return 'document';
  if (url.match(/\.(mp3|ogg|oga|m4a|wav|aac)(\?|$)/)) return 'audio';
  if (url.match(/\.(mp4|mov|avi)(\?|$)/)) return 'video';
  // Cloudinary resource type hint
  if (asset.resource_type === 'image') return 'image';
  if (asset.resource_type === 'video') return 'video';
  if (asset.resource_type === 'raw') return 'document';
  return 'document';
}

/**
 * Update analysis collection in Firebase when WhatsApp message is processed
 * Calls frontend API to write to Firestore
 */
async function updateAnalysisForWhatsApp(userId, campaignId, contactData) {
  try {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    
    // Call frontend API to update analysis
    await axios.post(
      `${frontendUrl}/api/campaigns/${campaignId}/analysis/whatsapp`,
      {
        userId,
        campaignId,
        contactId: contactData.contactId,
        contactName: contactData.contactName,
        phone: contactData.phone,
        messages: contactData.messages || [],
      },
      {
        timeout: 5000,
        headers: { 'Content-Type': 'application/json' }
      }
    );
    console.log(`✅ Analysis updated for WhatsApp contact ${contactData.phone}`);
  } catch (err) {
    console.warn(`⚠️ Failed to update analysis:`, err.message);
    // Don't fail the entire flow if analysis update fails
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * POST /api/whatsapp/send-campaign
 *
 * Body:
 * {
 *   contacts: [{ name: string, phone: string }],
 *   title: string,
 *   description: string,
 *   audioUrl?: string,        // Cloudinary voice-note URL
 *   assets?: [{ url, name }]  // Images / posters / PDFs
 * }
 */
router.post('/send-campaign', async (req, res) => {
  const { contacts, title, description, audioUrl, assets } = req.body;

  if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
    return res.status(400).json({ error: 'contacts array is required' });
  }

  console.log(`\n📣 Sending WhatsApp campaign to ${contacts.length} contacts`);
  console.log(`   Title:      ${title}`);
  console.log(`   Audio URL:  ${audioUrl || 'NONE - NO VOICE WILL BE SENT'}`);
  console.log(`   Assets:     ${(assets || []).length} file(s)\n`);

  const results = [];
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

  for (const contact of contacts) {
    const phone = normalizePhone(contact.phone);
    if (!phone) {
      console.warn(`⚠️  Skipping contact "${contact.name}" – no phone number`);
      results.push({ name: contact.name, phone: contact.phone, status: 'skipped', reason: 'no phone' });
      continue;
    }

    const contactResult = { name: contact.name, phone, messages: [] };

    try {
      // 1. Send campaign title as text message
      if (title) {
        console.log(`📤 Sending title to ${contact.name}...`);
        const titleRes = await sendText(phone, title);
        const titleMsgId = titleRes?.messages?.[0]?.id;
        contactResult.messages.push({ type: 'text', id: titleMsgId, content: 'title' });
        console.log(`✅ [${contact.name}] Title sent: ${title}`);

        // Track the title message
        if (titleMsgId && req.body.userId && req.body.campaignId && contact.contactId) {
          try {
            await axios.post(
              `${frontendUrl}/api/inbox/webhook/track-sent`,
              {
                userId: req.body.userId,
                campaignId: req.body.campaignId,
                contactId: contact.contactId,
                phone,
                messageType: 'text',
                messageId: titleMsgId,
                content: title,
                timestamp: new Date().toISOString(),
              },
              {
                headers: { 'Content-Type': 'application/json' },
                timeout: 5000,
              }
            );
            console.log(`  ✅ Title message tracked`);
          } catch (trackErr) {
            console.warn(`  ⚠️ Failed to track title message:`, trackErr.message);
          }
        }
      }

      // 2. Send campaign description as text message
      if (description) {
        console.log(`📤 Sending description to ${contact.name}...`);
        const greetingName = contact.name || 'there';
        const descriptionBody = `Hey, ${greetingName}\n${description}`;
        const descRes = await sendText(phone, descriptionBody);
        const descMsgId = descRes?.messages?.[0]?.id;
        contactResult.messages.push({ type: 'text', id: descMsgId, content: 'description' });
        console.log(`✅ [${contact.name}] Description sent`);

        // Track the description message
        if (descMsgId && req.body.userId && req.body.campaignId && contact.contactId) {
          try {
            await axios.post(
              `${frontendUrl}/api/inbox/webhook/track-sent`,
              {
                userId: req.body.userId,
                campaignId: req.body.campaignId,
                contactId: contact.contactId,
                phone,
                messageType: 'text',
                messageId: descMsgId,
                content: descriptionBody,
                timestamp: new Date().toISOString(),
              },
              {
                headers: { 'Content-Type': 'application/json' },
                timeout: 5000,
              }
            );
            console.log(`  ✅ Description message tracked`);
          } catch (trackErr) {
            console.warn(`  ⚠️ Failed to track description message:`, trackErr.message);
          }
        }
      }

      // 3. Send voice note (audio) if exists
      if (audioUrl) {
        console.log(`\n🔊 SENDING AUDIO MESSAGE`);
        console.log(`   Contact: ${contact.name}`);
        console.log(`   Phone: ${phone}`);
        console.log(`   Audio URL: ${audioUrl}`);
        console.log(`   URL starts with https? ${audioUrl.startsWith('https') ? '✅ YES' : '❌ NO'}`);
        console.log(`   Length: ${audioUrl.length} chars`);
        try {
          const audioRes = await sendAudio(phone, audioUrl);
          const audioMsgId = audioRes?.messages?.[0]?.id;
          contactResult.messages.push({ type: 'audio', id: audioMsgId });
          console.log(`✅ [${contact.name}] Voice note sent successfully`);
          console.log(`   Message ID: ${audioMsgId}`);

          // Track the audio message
          if (audioMsgId && req.body.userId && req.body.campaignId && contact.contactId) {
            try {
              await axios.post(
                `${frontendUrl}/api/inbox/webhook/track-sent`,
                {
                  userId: req.body.userId,
                  campaignId: req.body.campaignId,
                  contactId: contact.contactId,
                  phone,
                  messageType: 'audio',
                  messageId: audioMsgId,
                  content: 'Voice message',
                  timestamp: new Date().toISOString(),
                },
                {
                  headers: { 'Content-Type': 'application/json' },
                  timeout: 5000,
                }
              );
              console.log(`  ✅ Audio message tracked`);
            } catch (trackErr) {
              console.warn(`  ⚠️ Failed to track audio message:`, trackErr.message);
            }
          }
        } catch (audioErr) {
          console.error(`\n❌ AUDIO SEND FAILED`);
          console.error(`   Contact: ${contact.name}`);
          console.error(`   Error: ${audioErr?.response?.data?.error?.message || audioErr.message}`);
          console.error(`   Error code: ${audioErr?.response?.data?.error?.code}`);
          console.error(`   Full error:`, JSON.stringify(audioErr?.response?.data, null, 2));
        }
      } else {
        console.log(`⏭️  Skipping voice note (audioUrl is null or empty)`);
      }

      // 4. Send each asset (image / document)
      if (assets && assets.length > 0) {
        for (const asset of assets) {
          const assetUrl = asset.url || asset.cloudinaryUrl || asset.link;
          if (!assetUrl) continue;

          const assetType = getAssetType(asset);
          const assetName = asset.name || asset.filename || 'attachment';

          let assetRes;
          if (assetType === 'image') {
            assetRes = await sendImage(phone, assetUrl, assetName);
          } else if (assetType === 'audio') {
            assetRes = await sendAudio(phone, assetUrl);
          } else {
            assetRes = await sendDocument(phone, assetUrl, assetName);
          }
          const assetMsgId = assetRes?.messages?.[0]?.id;
          contactResult.messages.push({ type: assetType, id: assetMsgId });
          console.log(`✅ [${contact.name}] ${assetType} sent: ${assetName}`);

          // Track the asset message
          if (assetMsgId && req.body.userId && req.body.campaignId && contact.contactId) {
            try {
              await axios.post(
                `${frontendUrl}/api/inbox/webhook/track-sent`,
                {
                  userId: req.body.userId,
                  campaignId: req.body.campaignId,
                  contactId: contact.contactId,
                  phone,
                  messageType: assetType,
                  messageId: assetMsgId,
                  content: assetName,
                  timestamp: new Date().toISOString(),
                },
                {
                  headers: { 'Content-Type': 'application/json' },
                  timeout: 5000,
                }
              );
              console.log(`  ✅ Asset message tracked`);
            } catch (trackErr) {
              console.warn(`  ⚠️ Failed to track asset message:`, trackErr.message);
            }
          }
        }
      }

      contactResult.status = 'sent';
    } catch (err) {
      const errData = err?.response?.data?.error;
      const errMsg = errData?.message || err.message;
      const errCode = errData?.code;
      
      console.error(`❌ [${contact.name}] Failed: ${errMsg} (Code: ${errCode})`);
      console.error(`   Full error:`, JSON.stringify(errData, null, 2));
      
      contactResult.status = 'failed';
      contactResult.error = errMsg;
      contactResult.errorCode = errCode;
    }

    results.push(contactResult);

    // Small delay to avoid rate limiting
    await new Promise((r) => setTimeout(r, 200));
  }

  const sent = results.filter((r) => r.status === 'sent').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;

  console.log(`\n📊 Campaign done – sent: ${sent}, failed: ${failed}, skipped: ${skipped}`);
  console.log(`\n⚠️  IMPORTANT CHECKLIST:`);
  console.log(`   ✓ Verify phone number is registered in WhatsApp Business Account: ${results[0]?.phone}`);
  console.log(`   ✓ Check that access token is valid and not expired`);
  console.log(`   ✓ Ensure phone number ID matches your WhatsApp Business Account`);
  console.log(`   ✓ Check recipient's WhatsApp for incoming messages\n`);

  return res.json({
    success: true,
    summary: { total: contacts.length, sent, failed, skipped },
    results,
    troubleshooting: {
      note: 'If messages show success but you don\'t receive them:',
      reason1: 'Phone number might not be registered in your WhatsApp Business Account',
      reason2: 'Your account might be in sandbox mode with limited test numbers',
      reason3: 'Access token might lack proper permissions',
      next_step: 'Run POST /api/whatsapp/test-send with the same phone number to verify setup'
    }
  });
});

/**
 * POST /api/whatsapp/send-message
 *
 * Send a single message to a single contact.
 *
 * Body:
 * {
 *   phone: string,
 *   type: "text" | "audio" | "image" | "document",
 *   content?: string,     // for text
 *   url?: string,         // for audio/image/document
 *   caption?: string,     // for image
 *   filename?: string     // for document
 * }
 */
router.post('/send-message', async (req, res) => {
  const { phone: rawPhone, type, content, url, caption, filename } = req.body;

  const phone = normalizePhone(rawPhone);
  if (!phone) {
    return res.status(400).json({ error: 'Valid phone number required' });
  }

  try {
    let result;
    switch (type) {
      case 'audio':
        result = await sendAudio(phone, url);
        break;
      case 'image':
        result = await sendImage(phone, url, caption || '');
        break;
      case 'document':
        result = await sendDocument(phone, url, filename || 'document');
        break;
      case 'text':
      default:
        result = await sendText(phone, content);
        break;
    }

    const msgId = result?.messages?.[0]?.id;
    console.log(`✅ Message sent to ${phone} – ID: ${msgId}`);
    return res.json({ success: true, messageId: msgId });
  } catch (err) {
    const errMsg = err?.response?.data?.error?.message || err.message;
    console.error(`❌ Failed to send to ${phone}: ${errMsg}`);
    return res.status(500).json({ error: errMsg });
  }
});

/**
 * POST /api/whatsapp/send-call-details
 *
 * Triggered during a phone call when the user asks to receive details on WhatsApp.
 * Generates a concise response from the campaign knowledge base and sends it only
 * to the caller's WhatsApp number.
 *
 * Body:
 * {
 *   phone: string,
 *   requestText: string,
 *   userId?: string,
 *   campaignId?: string,
 *   callId?: string
 * }
 */
router.post('/send-call-details', async (req, res) => {
  const { phone: rawPhone, requestText, userId, campaignId, callId } = req.body;

  const phone = normalizePhone(rawPhone);
  if (!phone) return res.status(400).json({ error: 'Valid phone required' });
  if (!requestText) return res.status(400).json({ error: 'requestText is required' });

  console.log(`\n📞 [CALL→WA] Request received`);
  console.log(`   Call ID: ${callId || 'unknown'}`);
  console.log(`   Phone: ${phone}`);
  console.log(`   Request: "${requestText}"`);

  let resolvedUserId = userId;
  let resolvedCampaignId = campaignId;
  let contactId = null;
  let contactName = 'Unknown Contact';

  // Try to resolve contact info from the latest campaign for this phone
  let latestCampaign = null;
  try {
    latestCampaign = await findLatestCampaignByPhone(phone);
  } catch (err) {
    console.warn(`[WhatsApp-Route] ⚠️ Failed to resolve latest campaign:`, err.message);
  }

  if (!resolvedUserId || !resolvedCampaignId) {
    if (!latestCampaign) {
      return res.status(404).json({ error: 'No campaign found for this phone number' });
    }
    resolvedUserId = latestCampaign.userId;
    resolvedCampaignId = latestCampaign.campaignId;
  }

  console.log(`   Resolved userId: ${resolvedUserId}`);
  console.log(`   Resolved campaignId: ${resolvedCampaignId}`);

  if (latestCampaign &&
      latestCampaign.userId === resolvedUserId &&
      latestCampaign.campaignId === resolvedCampaignId) {
    contactId = latestCampaign.contactId;
    contactName = latestCampaign.contactName || contactName;
  } else {
    contactId = `contact_${phone}_${resolvedCampaignId}`;
  }

  try {
    const aiReply = await generateCampaignReply(
      resolvedUserId,
      resolvedCampaignId,
      contactId,
      requestText
    );

    console.log(`   AI reply preview: "${aiReply.substring(0, 180)}${aiReply.length > 180 ? '...' : ''}"`);

    // Save call-originated request to chat history for traceability
    await saveChatHistory(
      resolvedUserId,
      resolvedCampaignId,
      contactId,
      requestText,
      aiReply,
      phone,
      contactName,
      {
        userType: 'call',
        aiType: 'text',
        userMeta: { source: 'call', callId: callId || null },
        aiMeta: { source: 'whatsapp', callId: callId || null },
      }
    );

    const sendResult = await sendText(phone, aiReply);
    const msgId = sendResult?.messages?.[0]?.id;

    console.log(`✅ [CALL→WA] Message sent — ID: ${msgId || 'unknown'}`);

    return res.json({ success: true, messageId: msgId, reply: aiReply });
  } catch (err) {
    const errMsg = err?.response?.data?.error?.message || err.message;
    console.error(`[WhatsApp-Route] ❌ send-call-details failed:`, errMsg);
    return res.status(500).json({ error: errMsg });
  }
});

/**
 * POST /api/whatsapp/send-reply
 *
 * Send an AI-generated reply text to a contact.
 *
 * Body: { phone: string, message: string }
 */
router.post('/send-reply', async (req, res) => {
  const { phone: rawPhone, message } = req.body;

  const phone = normalizePhone(rawPhone);
  if (!phone) return res.status(400).json({ error: 'Valid phone required' });
  if (!message) return res.status(400).json({ error: 'message is required' });

  try {
    const result = await sendText(phone, message);
    const msgId = result?.messages?.[0]?.id;
    console.log(`✅ Reply sent to ${phone} – ID: ${msgId}`);
    return res.json({ success: true, messageId: msgId });
  } catch (err) {
    const errMsg = err?.response?.data?.error?.message || err.message;
    console.error(`❌ Reply failed to ${phone}: ${errMsg}`);
    return res.status(500).json({ error: errMsg });
  }
});

/**
 * GET /api/whatsapp/debug
 *
 * Diagnostic endpoint to check WhatsApp credentials and API connectivity.
 */
router.get('/debug', async (req, res) => {
  const phoneIdOk = PHONE_NUMBER_ID ? '✅ Loaded' : '❌ Missing';
  const tokenOk = ACCESS_TOKEN ? '✅ Loaded' : '❌ Missing';
  const tokenPreview = ACCESS_TOKEN ? `${ACCESS_TOKEN.substring(0, 20)}...` : 'N/A';

  try {
    // Try to verify credentials by making a test API call
    const testRes = await axios.get(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}?fields=verified_name,display_phone_number,quality_rating`,
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );

    return res.json({
      status: 'CONFIGURED',
      phone_number_id: phoneIdOk,
      access_token: tokenOk,
      token_preview: tokenPreview,
      api_verification: '✅ SUCCESS',
      whatsapp_account: testRes.data,
    });
  } catch (err) {
    return res.json({
      status: 'ERROR',
      phone_number_id: phoneIdOk,
      access_token: tokenOk,
      token_preview: tokenPreview,
      api_verification: '❌ FAILED',
      error_details: {
        message: err?.response?.data?.error?.message || err.message,
        code: err?.response?.data?.error?.code,
        type: err?.response?.data?.error?.type,
      },
      troubleshooting: [
        '❓ Is your WhatsApp Business Account verified?',
        '❓ Is the phone number registered in Meta Business Manager?',
        '❓ Has the access token expired? Try regenerating it.',
        '❓ Is the phone number ID correct?',
      ],
    });
  }
});

/**
 * POST /api/whatsapp/test-conversation
 * 
 * 🧪 TESTING ENDPOINT
 * 
 * Manually trigger the conversation service to test if it works.
 * This is for debugging - you can call this and see detailed logs.
 * 
 * Body:
 * {
 *   phone: string,         // e.g. "919883131455"
 *   message: string        // The message to reply to
 * }
 */
router.post('/test-conversation', async (req, res) => {
  const { phone: rawPhone, message } = req.body;

  if (!rawPhone || !message) {
    return res.status(400).json({
      error: 'phone and message are required',
      example: { phone: '919883131455', message: 'Tell me about the campaign' },
    });
  }

  console.log(`\n\n${'═'.repeat(80)}`);
  console.log(`🧪 TEST-CONVERSATION endpoint called`);
  console.log(`   Phone: ${rawPhone}`);
  console.log(`   Message: ${message}`);
  console.log(`${'═'.repeat(80)}\n`);

  try {
    // Import and call the conversation service
    const { handleWhatsAppMessage } = require('../conversation-service');
    
    console.log(`[WhatsApp-Route] Calling handleWhatsAppMessage...`);
    await handleWhatsAppMessage(rawPhone, message, `test_${Date.now()}`);
    
    console.log(`[WhatsApp-Route] ✅ Conversation handler completed\n`);
    return res.json({
      success: true,
      message: 'Conversation processed - check console/logs for details',
      phone: rawPhone,
      messageProcessed: message,
    });
  } catch (err) {
    console.error(`[WhatsApp-Route] ❌ Test conversation failed:`, err.message);
    console.error(err.stack);

    return res.status(500).json({
      success: false,
      error: err.message,
      stack: err.stack,
      troubleshooting: {
        step1: 'Check that Firebase credentials are set in .env',
        step2: 'Check that GEMINI_WHATSAPP_API_KEY is set',
        step3: 'Make sure the phone number has a launched campaign',
        step4: 'Check the full error stack above for details',
      },
    });
  }
});

/**
 * GET /api/whatsapp/webhook-status
 * 
 * 🔍 DEBUG ENDPOINT
 * 
 * Shows webhook configuration status and helps verify setup.
 * Use this to check if webhook URL is correctly registered in Meta.
 */
router.get('/webhook-status', (req, res) => {
  const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

  const status = {
    timestamp: new Date().toISOString(),
    webhook_configured: {
      verify_token_set: !!verifyToken,
      phone_id_set: !!phoneId,
      access_token_set: !!accessToken,
    },
    webhook_url: 'https://double-slash-backend.onrender.com/api/whatsapp/webhook',
    instructions: [
      '1. Go to your WhatsApp app in Meta Business Manager',
      '2. Go to: Settings → Webhooks',
      '3. Set callback URL to: https://double-slash-backend.onrender.com/api/whatsapp/webhook',
      '4. Verify token (MUST match env var WHATSAPP_WEBHOOK_VERIFY_TOKEN)',
      '5. Subscribe to these webhook fields: messages, message_status, message_template_status_update',
      '6. Click "Verify and Save"',
      '',
      'After setup, when user sends message on WhatsApp:',
      '→ Meta sends POST to /api/whatsapp/webhook',
      '→ You should see 🔔 [WEBHOOK RECEIVED] log in backend',
      '→ Check: console.log or Render logs',
    ],
    test_webhook_locally: 'Use: curl -X POST http://localhost:3001/api/whatsapp/webhook -H "Content-Type: application/json" -d "{...}"',
    debugging_checklist: {
      step_1: '✅ Is backend running? Check: https://double-slash-backend.onrender.com/',
      step_2: '✅ Is webhook URL correct? Check: https://double-slash-backend.onrender.com/api/whatsapp/webhook-status',
      step_3: '✅ Is webhook registered in Meta? Go to App Dashboard → Webhooks',
      step_4: '✅ Send test message on WhatsApp',
      step_5: '✅ Check backend logs for: 🔔 [WEBHOOK RECEIVED]',
      step_6: '✅ If not in logs, webhook URL is not registered correctly',
    },
  };

  return res.json(status);
});

/**
 * GET /api/whatsapp/webhook
 * 
 * Webhook verification from Meta/WhatsApp.
 * Meta sends a challenge token to verify the webhook URL.
 */
router.get('/webhook', async (req, res) => {
  const WEBHOOK_VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || 'your_verify_token';

  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log(`\n🔐 Webhook verification request received`);
  console.log(`   Mode: ${mode}`);
  console.log(`   Token match: ${token === WEBHOOK_VERIFY_TOKEN}`);

  if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
    console.log(`✅ Webhook verified successfully`);
    return res.status(200).send(challenge);
  }

  console.error(`❌ Webhook verification failed`);
  return res.status(403).json({ error: 'Verification token mismatch' });
});

/**
 * POST /api/whatsapp/webhook
 * 
 * Receive incoming WhatsApp messages and delivery status updates.
 * Stores messages in a simple file-based database for now.
 */
router.post('/webhook', async (req, res) => {
  const timestamp = new Date().toISOString();
  
  // 🔴 LOG IMMEDIATELY UPON RECEIPT
  console.log(`\n\n${'█'.repeat(80)}`);
  console.log(`🔔 [WEBHOOK RECEIVED] ${timestamp}`);
  console.log(`█`.repeat(80));
  console.log(`📥 Request headers:`, {
    contentType: req.headers['content-type'],
    contentLength: req.headers['content-length'],
  });

  const { object, entry } = req.body;
  
  // Log what was received
  console.log(`📋 Webhook body:`, {
    object: object,
    entriesCount: entry ? entry.length : 0,
  });

  // Always return 200 OK to acknowledge receipt IMMEDIATELY
  res.status(200).json({ received: true });

  if (!object) {
    console.error(`❌ [WEBHOOK] No 'object' field in request body!`);
    return;
  }

  if (object !== 'whatsapp_business_account') {
    console.warn(`⚠️ [WEBHOOK] Unexpected webhook object type: "${object}" (expected: "whatsapp_business_account")`);
    return;
  }

  console.log(`✅ [WEBHOOK] Object type verified: whatsapp_business_account`);

  if (!entry || entry.length === 0) {
    console.log(`⚠️ [WEBHOOK] No entries in webhook data`);
    return;
  }

  console.log(`📦 [WEBHOOK] Processing ${entry.length} event(s)...`);

  try {
    for (let eventIdx = 0; eventIdx < entry.length; eventIdx++) {
      const event = entry[eventIdx];
      const changes = event.changes || [];

      console.log(`  Event ${eventIdx + 1}/${entry.length}: ${changes.length} change(s)`);

      for (let changeIdx = 0; changeIdx < changes.length; changeIdx++) {
        const change = changes[changeIdx];
        const { value } = change;
        const { messages, statuses } = value || {};

        console.log(`    Change ${changeIdx + 1}/${changes.length}:`);
        console.log(`      - Messages: ${messages ? messages.length : 0}`);
        console.log(`      - Statuses: ${statuses ? statuses.length : 0}`);

        // Handle incoming messages
        if (messages && messages.length > 0) {
          console.log(`    🤳 Processing ${messages.length} incoming message(s)...`);
          for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
            const message = messages[msgIdx];
            console.log(`      Message ${msgIdx + 1}/${messages.length}: type="${message.type}" from="${message.from}"`);
            try {
              await handleIncomingMessage(message, value);
            } catch (msgErr) {
              console.error(`        ❌ Error processing message:`, msgErr.message);
            }
          }
        }

        // Handle message delivery status
        if (statuses && statuses.length > 0) {
          console.log(`    📊 Processing ${statuses.length} status update(s)...`);
          for (let statusIdx = 0; statusIdx < statuses.length; statusIdx++) {
            const status = statuses[statusIdx];
            console.log(`      Status ${statusIdx + 1}/${statuses.length}: "${status.status}" for message="${status.id}"`);
            try {
              await handleMessageStatus(status, value);
            } catch (statusErr) {
              console.error(`        ❌ Error processing status:`, statusErr.message);
            }
          }
        }
      }
    }
  } catch (error) {
    console.error(`❌ [WEBHOOK] Fatal error processing webhook:`, error.message);
    console.error(error.stack);
  }

  console.log(`✅ [WEBHOOK] Webhook processing complete`);
  console.log(`${'█'.repeat(80)}\n`);
});

async function handleVoiceNoteConversation({ from, messageId, mediaId }) {
  const normalizedPhone = normalizePhone(from) || from;

  console.log(`  🔎 Fetching media info for voice note...`);
  const mediaInfo = await fetchWhatsAppMediaInfo(mediaId);
  if (!mediaInfo?.url) {
    throw new Error('WhatsApp media URL not found');
  }

  console.log(`  ⬇️ Downloading voice note media...`);
  const audioBuffer = await downloadWhatsAppMedia(mediaInfo.url);

  console.log(`  🧠 Transcribing voice note with Gemini...`);
  const transcript = await transcribeAudioWithGemini(
    audioBuffer,
    mediaInfo.mimeType || 'audio/ogg'
  );

  if (!transcript) {
    const apology = 'Sorry, I could not understand the voice note. Please try again.';
    await sendVoiceNoteFromText(normalizedPhone, apology);
    return { transcript: '', mediaUrl: mediaInfo.url };
  }

  console.log(`  📝 Transcript: "${transcript.substring(0, 120)}${transcript.length > 120 ? '...' : ''}"`);

  const campaign = await findLatestCampaignByPhone(normalizedPhone);
  if (!campaign) {
    const noCampaignText = 'Hi! I could not find an active campaign for your number. Please contact support.';
    await sendVoiceNoteFromText(normalizedPhone, noCampaignText);
    return { transcript, mediaUrl: mediaInfo.url };
  }

  const { userId, campaignId, contactId, contactName } = campaign;
  console.log(`  ✅ Campaign found for voice note: ${campaignId}`);

  const aiReply = await generateCampaignReply(userId, campaignId, contactId, transcript);

  let replyMessageId = null;
  let replyAudioUrl = null;
  let replyType = 'audio';

  try {
    const voiceSend = await sendVoiceNoteFromText(normalizedPhone, aiReply);
    replyMessageId = voiceSend.messageId;
    replyAudioUrl = voiceSend.audioUrl;
  } catch (sendErr) {
    replyType = 'text';
    console.error(`  ❌ Voice reply failed, falling back to text:`, sendErr.message);
    await sendText(normalizedPhone, aiReply);
  }

  await saveChatHistory(
    userId,
    campaignId,
    contactId,
    transcript,
    aiReply,
    normalizedPhone,
    contactName,
    {
      userType: 'audio',
      aiType: replyType,
      userMeta: {
        mediaId,
        mimeType: mediaInfo.mimeType || 'audio/ogg',
        transcript,
        whatsappMessageId: messageId,
      },
      aiMeta: {
        whatsappMessageId: replyMessageId,
        audioUrl: replyAudioUrl,
      },
    }
  );

  return { transcript, mediaUrl: mediaInfo.url };
}

/**
 * Handle incoming WhatsApp message
 * Now uses the conversation handler to generate AI responses
 */
async function handleIncomingMessage(message, metadata) {
  const { from, id: messageId, type, timestamp } = message;
  const { display_phone_number } = metadata;

  console.log(`\n\n${'▓'.repeat(80)}`);
  console.log(`  🔔 INCOMING MESSAGE HANDLER TRIGGERED`);
  console.log(`▓`.repeat(80));
  console.log(`  📱 Phone: ${from}`);
  console.log(`  📬 Type: ${type}`);
  console.log(`  ID: ${messageId}`);
  console.log(`  ⏰ Time: ${new Date(parseInt(timestamp) * 1000).toISOString()}`);
  console.log(`${'▓'.repeat(80)}`);

  try {
    let content = '';
    let mediaUrl = '';
    let mediaId = '';
    const isVoiceNote = type === 'audio' || type === 'voice';

    // Extract message content based on type
    if (type === 'text') {
      content = message.text?.body || '';
      console.log(`\n  📝 TEXT MESSAGE:`);
      console.log(`     "${content}"`);
    } else if (type === 'audio') {
      mediaId = message.audio?.id || '';
      mediaUrl = message.audio?.link || '';
      content = 'Audio message';
      console.log(`\n  🎵 AUDIO:`);
      console.log(`     ${mediaUrl}`);
    } else if (type === 'image') {
      mediaUrl = message.image?.link || '';
      content = message.image?.caption || 'Image message';
      console.log(`\n  🖼️ IMAGE:`);
      console.log(`     Caption: "${content}"`);
    } else if (type === 'document') {
      mediaUrl = message.document?.link || '';
      content = message.document?.filename || 'Document';
      console.log(`\n  📄 DOCUMENT:`);
      console.log(`     ${content}`);
    } else if (type === 'voice') {
      mediaId = message.voice?.id || '';
      mediaUrl = message.voice?.link || '';
      content = 'Voice message';
      console.log(`\n  🎙️ VOICE:`);
      console.log(`     ${mediaUrl}`);
    } else {
      content = `[${type} message]`;
      console.log(`\n  ❓ UNKNOWN TYPE:`);
      console.log(`     ${type}`);
    }

    // Handle conversation via WhatsApp conversation handler
    if (type === 'text' && content.trim()) {
      console.log(`\n  ✅ This is a TEXT MESSAGE - proceeding to conversation handler...`);
      console.log(`  🤖 Calling handleWhatsAppMessage()...`);

      try {
        // IMPORTANT: Await here so we wait for the async handler to complete
        await handleWhatsAppMessage(from, content, messageId);
        console.log(`  ✅ AI Response Handler COMPLETED successfully`);
      } catch (convErr) {
        console.error(`  ❌ AI Response Handler FAILED:`, convErr.message);
        console.error(convErr.stack);
      }
    } else if (isVoiceNote) {
      if (!mediaId) {
        console.warn(`\n  ⚠️ Voice note missing media id - skipping AI response generation`);
      } else {
        console.log(`\n  ✅ This is a VOICE NOTE - transcribing and replying with voice...`);
        try {
          const voiceResult = await handleVoiceNoteConversation({
            from,
            messageId,
            mediaId,
          });
          content = voiceResult.transcript || content;
          mediaUrl = voiceResult.mediaUrl || mediaUrl;
          console.log(`  ✅ Voice note flow completed`);
        } catch (voiceErr) {
          console.error(`  ❌ Voice note flow FAILED:`, voiceErr.message);
          console.error(voiceErr.stack);
        }
      }
    } else {
      console.log(`\n  ℹ️ Message type '${type}' - skipping AI response generation`);
    }

    // Also forward to frontend API to store in Firestore for history (non-critical)
    try {
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      const storeRes = await axios.post(
        `${frontendUrl}/api/inbox/webhook/message`,
        {
          fromPhone: from,
          type,
          content,
          mediaUrl: mediaUrl || null,
          messageId,
          timestamp: message.timestamp,
          // Note: campaignId and contactId should ideally be extracted from metadata
          // For now, this requires mapping from phone number to campaign/contact
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'x-webhook-secret': process.env.WEBHOOK_SECRET || 'dev-secret',
          },
          timeout: 5000,
        }
      );

      console.log(`✅ Message forwarded to frontend:`, storeRes.data);
    } catch (fwdError) {
      // Don't fail the webhook if forwarding fails, just log it
      console.warn(`⚠️ Failed to forward message to frontend:`, {
        status: fwdError?.response?.status,
        message: fwdError?.response?.data?.error || fwdError.message,
      });
    }

  } catch (error) {
    console.error('❌ Error handling incoming message:', error);
  }
}

/**
 * Handle message delivery status
 */
async function handleMessageStatus(status, metadata) {
  const { id: messageId, status: deliveryStatus, timestamp, recipient_id } = status;

  console.log(`\n📊 Message status for ${messageId}`);
  console.log(`   Status: ${deliveryStatus}`);
  console.log(`   Recipient: ${recipient_id}`);
  console.log(`   Timestamp: ${new Date(parseInt(timestamp) * 1000).toISOString()}`);

  try {
    const statusData = {
      messageId,
      status: deliveryStatus, // sent, delivered, read, failed
      recipientPhone: recipient_id,
      timestamp: new Date(parseInt(timestamp) * 1000).toISOString(),
      updatedAt: new Date().toISOString(),
    };

    console.log(`✅ Status recorded:`, JSON.stringify(statusData, null, 2));

    // Forward to frontend API to update message status in Firestore
    // The frontend will search for the message by WhatsApp messageId and update its status
    try {
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      const updateRes = await axios.post(
        `${frontendUrl}/api/inbox/webhook/status`,
        {
          toPhone: recipient_id,
          messageId,
          status: deliveryStatus,
          timestamp: statusData.timestamp,
          // campaignId and contactId can be looked up via messageTracking collection
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'x-webhook-secret': process.env.WEBHOOK_SECRET || 'dev-secret',
          },
          timeout: 5000,
        }
      );

      console.log(`✅ Status forwarded to frontend:`, updateRes.data);
    } catch (fwdError) {
      // Don't fail the webhook if forwarding fails
      console.warn(`⚠️ Failed to forward status to frontend:`, {
        status: fwdError?.response?.status,
        message: fwdError?.response?.data?.error || fwdError.message,
      });
    }

  } catch (error) {
    console.error('Error handling message status:', error);
  }
}

/**
 * POST /api/whatsapp/test-send
 *
 * Send a test message to verify setup.
 *
 * Body: { phone: string, message?: string }
 */
router.post('/test-send', async (req, res) => {
  const { phone: rawPhone, message = 'Test message from OutreachX ✅' } = req.body;

  const phone = normalizePhone(rawPhone);
  if (!phone) return res.status(400).json({ error: 'Valid phone required' });

  console.log(`\n📱 Test send to ${phone}`);
  console.log(`   Normalized: ${phone}`);
  console.log(`   Phone ID: ${PHONE_NUMBER_ID}`);
  console.log(`   Token valid: ${ACCESS_TOKEN ? 'Yes' : 'No'}\n`);

  try {
    const result = await sendTemplate(phone);
    const msgId = result?.messages?.[0]?.id;

    console.log(`✅ TEST MESSAGE SENT`);
    console.log(`   Message ID: ${msgId}`);
    console.log(`   To: ${phone}\n`);

    return res.json({
      success: true,
      messageId: msgId,
      phone_normalized: phone,
      template: 'hello_world',
      next_steps: [
        '1️⃣ Check your WhatsApp for the test message',
        '2️⃣ If you got it: Everything works! Your campaigns will be sent correctly.',
        '3️⃣ If you didn\'t get it: Your phone number might not be registered in your WhatsApp Business Account.',
      ],
    });
  } catch (err) {
    const errData = err?.response?.data?.error;
    const errMsg = errData?.message || err.message;

    console.error(`❌ TEST FAILED`);
    console.error(`   Error: ${errMsg}`);
    console.error(`   Code: ${errData?.code}`);
    console.error(`   Type: ${errData?.type}\n`);

    return res.status(500).json({
      success: false,
      error: errMsg,
      error_code: errData?.code,
      phone_attempted: phone,
      troubleshooting: {
        404: '❌ Phone number ID not found – check WHATSAPP_PHONE_NUMBER_ID',
        401: '❌ Invalid token – regenerate access token in Meta Developers',
        400: '❌ Invalid phone format or number not registered in Meta Business Manager',
      },
      tips: [
        '✅ Make sure phone number is registered in your WhatsApp Business Account',
        '✅ Access token must be valid and have whatsapp_business_messaging permission',
        '✅ If using India number: format as 919883131455 (country code first)',
        '✅ Regenerate access token in Meta App Dashboard if expired',
      ],
    });
  }
});

/**
 * POST /api/whatsapp/test-firebase-access
 * 
 * 🧪 DEBUG ENDPOINT
 * 
 * Tests if backend Firebase connection can see the same data as test client.
 * Used for diagnosing "Found 0 users" issue.
 * 
 * Body: { phone: string }
 */
router.post('/test-firebase-access', async (req, res) => {
  const { phone: rawPhone } = req.body;

  if (!rawPhone) {
    return res.status(400).json({ error: 'phone is required' });
  }

  try {
    const { findLatestCampaignByPhone } = require('../conversation-service');

    console.log(`\n🧪 [Firebase-Debug] Testing Firebase access for phone: ${rawPhone}`);

    // This function internally gets DB and queries users
    const campaign = await findLatestCampaignByPhone(rawPhone);

    const response = {
      phone: rawPhone,
      campaignFound: campaign ? true : false,
      campaign: campaign,
    };

    console.log(`[Firebase-Debug] Returning response:`, JSON.stringify(response, null, 2));

    return res.json(response);
  } catch (err) {
    console.error(`[Firebase-Debug] Error:`, err.message);
    console.error(err.stack);

    return res.status(500).json({
      success: false,
      error: err.message,
      stack: err.stack,
    });
  }
});

/**
 * POST /api/whatsapp/test-audio
 *
 * Test endpoint to verify audio sending works.
 * ⚠️ IMPORTANT: Audio MUST be OGG/OPUS format for voice messages!
 *
 * Body: { phone: string, audioUrl: string }
 */
router.post('/test-audio', async (req, res) => {
  const { phone: rawPhone, audioUrl } = req.body;

  if (!audioUrl) {
    return res.status(400).json({ error: 'audioUrl is required' });
  }

  const phone = normalizePhone(rawPhone);
  if (!phone) {
    return res.status(400).json({ error: 'Valid phone number required' });
  }

  try {
    console.log(`\n\n${'═'.repeat(80)}`);
    console.log(`🧪 OGG/OPUS AUDIO DELIVERY TESTING`);
    console.log(`═`.repeat(80));
    console.log(`   Phone: ${phone}`);
    console.log(`   Audio URL: ${audioUrl}`);
    
    // STEP 1: Validate URL format
    console.log(`\n📋 STEP 1: URL Format Validation`);
    const urlLower = audioUrl.toLowerCase();
    const isOgg = urlLower.includes('.ogg') || urlLower.includes('f_ogg');
    const isMp3 = urlLower.includes('.mp3') || urlLower.includes('f_mp3');
    
    console.log(`   ✓ Starts with https? ${audioUrl.startsWith('https') ? '✅' : '❌'}`);
    console.log(`   ✓ Is OGG/OPUS? ${isOgg ? '✅ YES' : '❌ NO'}`);
    if (isMp3) {
      console.log(`   ✗ Is MP3? ❌ YES - BUT MP3 IS NOT SUPPORTED!`);
      console.log(`   \n   🚨 CRITICAL: WhatsApp voice messages require OGG/OPUS, not MP3!`);
    }
    console.log(`   ✓ URL Length: ${audioUrl.length} chars`);
    
    // STEP 2: Test if URL is accessible
    console.log(`\n📡 STEP 2: URL Accessibility Test`);
    try {
      const headRes = await axios.head(audioUrl, {
        timeout: 5000,
        maxRedirects: 0,
      });
      
      const contentType = headRes.headers['content-type'] || 'none';
      const contentLength = headRes.headers['content-length'] || 'unknown';
      
      console.log(`   ✅ URL is accessible`);
      console.log(`   ✓ HTTP Status: ${headRes.status}`);
      console.log(`   ✓ Content-Type: ${contentType}`);
      console.log(`   ✓ Content-Length: ${contentLength} bytes`);
      
      if (contentType.includes('audio/ogg')) {
        console.log(`   ✅ Content-Type is correct: audio/ogg ✅`);
      } else {
        console.log(`   ❌ Content-Type is wrong: "${contentType}" (expected: audio/ogg)`);
        console.log(`   ❌ WhatsApp will reject this file!`);
      }
    } catch (checkErr) {
      console.error(`   ❌ URL is NOT accessible`);
      console.error(`   Error: ${checkErr.message}`);
      
      return res.status(400).json({
        success: false,
        error: 'URL is not accessible',
        details: checkErr.message,
        diagnosis: 'Root cause: WhatsApp cannot download the audio file from this URL',
        solutions: [
          '1. Verify Cloudinary URL is correct',
          '2. Check if OGG/OPUS file still exists in Cloudinary',
          '3. Ensure URL is public (no authentication required)',
          '4. Try accessing the URL directly in a browser',
          '5. Verify Content-Type is audio/ogg',
        ],
      });
    }
    
    // STEP 3: Send test audio
    console.log(`\n📤 STEP 3: Sending Test Voice Message to WhatsApp`);
    const result = await sendAudio(phone, audioUrl);
    const msgId = result?.messages?.[0]?.id;

    console.log(`✅ VOICE MESSAGE SENT SUCCESSFULLY`);
    console.log(`   Message ID: ${msgId}`);
    console.log(`   Format: OGG/OPUS ✅`);
    console.log(`   Status: Check WhatsApp in 30 seconds`);
    console.log(`═`.repeat(80));

    return res.json({
      success: true,
      messageId: msgId,
      phone,
      audioUrl,
      format: 'OGG/OPUS',
      message: 'Voice message sent! Check your WhatsApp within 30 seconds.',
      next_steps: [
        '✅ Received the voice message in WhatsApp? Setup is correct!',
        '❌ Got "failed" webhook? (Cloudinary URL might be inaccessible)',
        '❓ No message at all? (Phone might not be registered)',
      ],
    });
  } catch (err) {
    const errMsg = err?.response?.data?.error?.message || err.message;
    const errCode = err?.response?.data?.error?.code;

    console.error(`\n❌ TEST FAILED`);
    console.error(`   Error: ${errMsg}`);
    console.error(`   Code: ${errCode}`);
    console.error(`═`.repeat(80));

    return res.status(500).json({
      success: false,
      error: errMsg,
      errorCode: errCode,
      phone,
      audioUrl,
      format: 'OGG/OPUS',
      diagnosis: {
        404: 'Phone number ID not found - check WHATSAPP_PHONE_NUMBER_ID',
        401: 'Invalid token - regenerate in Meta App Dashboard',
        400: 'Invalid phone or format - audio must be OGG/OPUS!',
        403: 'Access token lacks whatsapp_business_messaging permission',
      },
      troubleshooting: [
        '1️⃣ Verify the audio URL returns: Content-Type: audio/ogg',
        '2️⃣ Confirm the audio file is OGG format with OPUS codec',
        '3️⃣ Try POST /api/whatsapp/test-send with text (verify phone works)',
        '4️⃣ If text works but audio fails: audio format is wrong',
        '5️⃣ Re-convert to OGG/OPUS using: ffmpeg -i input.wav -c:a libopus -b:a 24k output.ogg',
      ],
    });
  }
});

module.exports = router;
