'use strict';

const admin = require('firebase-admin');

let _db = null;

function getDb() {
  if (_db) return _db;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY || '';
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('Missing Firebase credentials for campaign opt-out service');
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

function normalizePhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) digits = '91' + digits;
  return digits;
}

const BUTTON_STOP = 'campaign_pref_stop';
const BUTTON_CONTINUE = 'campaign_pref_continue';

/**
 * Check if a phone number opted out of WhatsApp updates for a specific campaign.
 */
async function isCampaignOptedOut(phone, userId, campaignId) {
  if (!phone || !userId || !campaignId) return false;

  const db = getDb();
  const normalizedPhone = normalizePhone(phone) || phone;

  try {
    const contactSnap = await db.collection('contacts').doc(normalizedPhone).get();
    if (contactSnap.exists) {
      const campaigns = contactSnap.data().campaigns || [];
      const entry = campaigns.find((c) => c.campaignId === campaignId && c.userId === userId);
      if (entry?.whatsappOptOut === true) {
        return true;
      }
    }

    const contactId = `contact_${normalizedPhone}_${campaignId}`;
    const inboxSnap = await db
      .collection('users')
      .doc(userId)
      .collection('campaigns')
      .doc(campaignId)
      .collection('inbox')
      .doc('contacts')
      .collection('contacts')
      .doc(contactId)
      .get();

    if (inboxSnap.exists && inboxSnap.data().whatsappOptOut === true) {
      return true;
    }
  } catch (error) {
    console.warn(`[Opt-Out] Failed to check opt-out for ${normalizedPhone}:`, error.message);
  }

  return false;
}

/**
 * Check if the preference prompt was already sent for this phone + campaign.
 */
async function wasPreferencePromptSent(phone, userId, campaignId) {
  if (!phone || !userId || !campaignId) return false;

  const db = getDb();
  const normalizedPhone = normalizePhone(phone) || phone;

  try {
    const contactSnap = await db.collection('contacts').doc(normalizedPhone).get();
    if (!contactSnap.exists) return false;

    const campaigns = contactSnap.data().campaigns || [];
    const entry = campaigns.find((c) => c.campaignId === campaignId && c.userId === userId);
    return entry?.whatsappPreferenceAsked === true;
  } catch (error) {
    console.warn(`[Opt-Out] Failed to check preference prompt status:`, error.message);
    return false;
  }
}

/**
 * Persist opt-out / opt-in preference for a phone + campaign pair.
 */
async function setCampaignOptOut(phone, userId, campaignId, contactId, optedOut) {
  const db = getDb();
  const normalizedPhone = normalizePhone(phone) || phone;
  const resolvedContactId = contactId || `contact_${normalizedPhone}_${campaignId}`;
  const now = new Date().toISOString();

  const contactDocRef = db.collection('contacts').doc(normalizedPhone);
  const contactSnap = await contactDocRef.get();
  const existingCampaigns = contactSnap.exists ? contactSnap.data().campaigns || [] : [];

  let found = false;
  const updatedCampaigns = existingCampaigns.map((entry) => {
    if (entry.campaignId === campaignId && entry.userId === userId) {
      found = true;
      return {
        ...entry,
        whatsappOptOut: optedOut,
        whatsappOptOutAt: optedOut ? now : null,
        whatsappPreferenceAnswered: true,
        whatsappPreferenceAnsweredAt: now,
      };
    }
    return entry;
  });

  if (!found) {
    updatedCampaigns.push({
      campaignId,
      userId,
      whatsappOptOut: optedOut,
      whatsappOptOutAt: optedOut ? now : null,
      whatsappPreferenceAnswered: true,
      whatsappPreferenceAnsweredAt: now,
    });
  }

  await contactDocRef.set(
    {
      phone: normalizedPhone,
      campaigns: updatedCampaigns,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  const inboxContactRef = db
    .collection('users')
    .doc(userId)
    .collection('campaigns')
    .doc(campaignId)
    .collection('inbox')
    .doc('contacts')
    .collection('contacts')
    .doc(resolvedContactId);

  await inboxContactRef.set(
    {
      contactPhone: normalizedPhone,
      whatsappOptOut: optedOut,
      whatsappOptOutAt: optedOut ? now : null,
      whatsappPreferenceAnswered: true,
      whatsappPreferenceAnsweredAt: now,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  console.log(
    `[Opt-Out] ${optedOut ? 'Opted out' : 'Opted in'} — phone=${normalizedPhone}, campaign=${campaignId}`
  );
}

/**
 * Mark that the one-time preference prompt was sent after campaign launch.
 */
async function markPreferencePromptSent(phone, userId, campaignId) {
  const db = getDb();
  const normalizedPhone = normalizePhone(phone) || phone;

  const contactDocRef = db.collection('contacts').doc(normalizedPhone);
  const contactSnap = await contactDocRef.get();
  const existingCampaigns = contactSnap.exists ? contactSnap.data().campaigns || [] : [];

  let found = false;
  const updatedCampaigns = existingCampaigns.map((entry) => {
    if (entry.campaignId === campaignId && entry.userId === userId) {
      found = true;
      return {
        ...entry,
        whatsappPreferenceAsked: true,
        whatsappPreferenceAskedAt: new Date().toISOString(),
      };
    }
    return entry;
  });

  if (!found) {
    updatedCampaigns.push({
      campaignId,
      userId,
      whatsappPreferenceAsked: true,
      whatsappPreferenceAskedAt: new Date().toISOString(),
    });
  }

  await contactDocRef.set(
    {
      phone: normalizedPhone,
      campaigns: updatedCampaigns,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

module.exports = {
  BUTTON_STOP,
  BUTTON_CONTINUE,
  normalizePhone,
  isCampaignOptedOut,
  wasPreferencePromptSent,
  setCampaignOptOut,
  markPreferencePromptSent,
};
