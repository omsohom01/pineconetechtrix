#!/usr/bin/env node

/**
 * 🎯 CAMPAIGN LATEST SELECTOR UTILITY
 * 
 * This utility helps the backend correctly identify and use the LATEST campaign
 * for any given phone number when answering WhatsApp questions.
 * 
 * Key features:
 * - Finds the most recently launched campaign for a phone
 * - Verifies campaign has proper context (description, documents)
 * - Handles multiple campaigns sent to same phone
 * - Used by conversation service to answer questions
 */

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// ── Phone Normalizer (same as everywhere else) ───────────────────────────────
function normalizePhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) digits = '91' + digits;
  return digits;
}

/**
 * Find the absolute LATEST campaign for a phone number across all users
 * 
 * Returns:
 * {
 *   userId: string,
 *   campaignId: string,
 *   campaignTitle: string,
 *   status: string,
 *   launchedAt: Date,
 *   hasContext: boolean (has description + documents)
 * }
 * or null if not found
 */
async function findLatestCampaignForPhone(rawPhone, db) {
  const normalizedPhone = normalizePhone(rawPhone);
  
  if (!normalizedPhone) {
    console.error(`[LatestSelector] ❌ Invalid phone: ${rawPhone}`);
    return null;
  }

  console.log(`[LatestSelector] 🔍 Finding latest campaign for phone: ${normalizedPhone}`);

  let latestCampaign = null;
  let latestTimestamp = 0;

  try {
    // Scan all users
    const usersSnapshot = await db.collection('users').get();
    console.log(`[LatestSelector]    Found ${usersSnapshot.size} users`);

    for (const userDoc of usersSnapshot.docs) {
      const userId = userDoc.id;
      const campaignsSnapshot = await userDoc.ref.collection('campaigns').get();

      for (const campaignDoc of campaignsSnapshot.docs) {
        const campaignId = campaignDoc.id;
        const data = campaignDoc.data();

        // Must be launched
        if (data.status !== 'launched' && !data.launchedAt) {
          continue;
        }

        const launchedAt = data.launchedAt?.toMillis?.() ||
          (data.launchedAt ? new Date(data.launchedAt).getTime() : 0);

        // Check if this phone is in messageTracking or contacts
        let found = false;

        // Strategy 1: Check messageTracking
        try {
          const trackingSnap = await campaignDoc.ref
            .collection('messageTracking')
            .where('contactPhone', '==', normalizedPhone)
            .limit(1)
            .get();

          if (!trackingSnap.empty) {
            found = true;
          }
        } catch (e) {
          // Continue
        }

        // Strategy 2: Check inbox/contacts
        if (!found) {
          try {
            const contactSnap = await campaignDoc.ref
              .collection('inbox')
              .doc('contacts')
              .collection('contacts')
              .where('contactPhone', '==', normalizedPhone)
              .limit(1)
              .get();

            if (!contactSnap.empty) {
              found = true;
            }
          } catch (e) {
            // Continue
          }
        }

        // If found and is latest
        if (found && launchedAt > latestTimestamp) {
          latestTimestamp = launchedAt;
          
          // Check if has context
          const hasContext = !!(
            (data.description || data.description?.original || data.description?.aiEnhanced) &&
            (data.documents && data.documents.length > 0)
          );

          latestCampaign = {
            userId,
            campaignId,
            campaignTitle: data.title || 'Untitled',
            status: data.status,
            launchedAt: new Date(launchedAt),
            hasContext,
            campaignData: data,
          };

          console.log(`[LatestSelector]    ✓ Campaign "${latestCampaign.campaignTitle}" (launched: ${new Date(launchedAt).toISOString()})`);
        }
      }
    }

    if (latestCampaign) {
      console.log(`[LatestSelector] ✅ Latest campaign found:`);
      console.log(`    Title: "${latestCampaign.campaignTitle}"`);
      console.log(`    Campaign ID: ${latestCampaign.campaignId}`);
      console.log(`    User ID: ${latestCampaign.userId}`);
      console.log(`    Status: ${latestCampaign.status}`);
      console.log(`    Launched: ${latestCampaign.launchedAt.toISOString()}`);
      console.log(`    Has Context: ${latestCampaign.hasContext ? '✅ Yes' : '⚠️ No'}`);
    } else {
      console.warn(`[LatestSelector] ⚠️ NO campaign found for phone ${normalizedPhone}`);
    }

    return latestCampaign;

  } catch (error) {
    console.error(`[LatestSelector] ❌ Error finding campaign:`, error.message);
    return null;
  }
}

/**
 * Verify that a campaign has all necessary context for AI responses
 */
async function verifyCampaignContext(userId, campaignId, db) {
  try {
    const campaignSnap = await db
      .collection('users')
      .doc(userId)
      .collection('campaigns')
      .doc(campaignId)
      .get();

    if (!campaignSnap.exists) {
      return { valid: false, reason: 'Campaign not found' };
    }

    const data = campaignSnap.data();
    const checks = [];

    // Check title
    const hasTitle = !!data.title;
    checks.push({ field: 'title', valid: hasTitle, value: data.title });

    // Check description (multiple possible formats)
    const description = data.description?.original || data.description?.aiEnhanced || data.description || '';
    const hasDescription = !!description;
    checks.push({ field: 'description', valid: hasDescription, length: description.length });

    // Check documents
    const hasDocuments = data.documents && Array.isArray(data.documents) && data.documents.length > 0;
    const docCount = data.documents ? data.documents.length : 0;
    checks.push({ field: 'documents', valid: hasDocuments, count: docCount });

    // Check if documents have extractedText
    const docsWithText = data.documents ? data.documents.filter(d => d.extractedText) : [];
    checks.push({ field: 'document extractedText', valid: docsWithText.length > 0, count: docsWithText.length });

    // All critical fields present?
    const allValid = hasTitle && hasDescription && hasDocuments && docsWithText.length > 0;

    return {
      valid: allValid,
      checks,
    };

  } catch (error) {
    return { valid: false, reason: error.message };
  }
}

/**
 * Get all campaigns for a phone (sorted by date, newest first)
 */
async function getAllCampaignsForPhone(rawPhone, db) {
  const normalizedPhone = normalizePhone(rawPhone);
  
  if (!normalizedPhone) {
    return [];
  }

  const campaigns = [];

  try {
    const usersSnapshot = await db.collection('users').get();

    for (const userDoc of usersSnapshot.docs) {
      const campaignsSnapshot = await userDoc.ref.collection('campaigns').get();

      for (const campaignDoc of campaignsSnapshot.docs) {
        const data = campaignDoc.data();

        if (data.status !== 'launched' && !data.launchedAt) {
          continue;
        }

        // Check if phone exists in this campaign
        let found = false;

        try {
          const trackingSnap = await campaignDoc.ref
            .collection('messageTracking')
            .where('contactPhone', '==', normalizedPhone)
            .limit(1)
            .get();
          if (!trackingSnap.empty) found = true;
        } catch (e) {
          // Skip
        }

        if (!found) {
          try {
            const contactSnap = await campaignDoc.ref
              .collection('inbox')
              .doc('contacts')
              .collection('contacts')
              .where('contactPhone', '==', normalizedPhone)
              .limit(1)
              .get();
            if (!contactSnap.empty) found = true;
          } catch (e) {
            // Skip
          }
        }

        if (found) {
          const launchedAt = data.launchedAt?.toMillis?.() ||
            (data.launchedAt ? new Date(data.launchedAt).getTime() : 0);

          campaigns.push({
            userId: userDoc.id,
            campaignId: campaignDoc.id,
            campaignTitle: data.title || 'Untitled',
            status: data.status,
            launchedAt: new Date(launchedAt),
          });
        }
      }
    }

    // Sort by launchedAt (newest first)
    return campaigns.sort((a, b) => b.launchedAt - a.launchedAt);

  } catch (error) {
    console.error(`Error getting all campaigns:`, error.message);
    return [];
  }
}

module.exports = {
  normalizePhone,
  findLatestCampaignForPhone,
  verifyCampaignContext,
  getAllCampaignsForPhone,
};
