'use strict';

// services/interestDetectionService.js — detect certification INTEREST in an incoming message
// (direct OR group chat) so the agent can propose a gated first-contact draft to the operator.
//
// PURE. Reuses leadIntentService (the same RU/KY/EN classifier the rest of the agent uses).
// Output-only signal — it never sends; it just flags "this person showed interest in
// сертификат/декларация/отказное/СГР". The operator decides whether to reach out (and any
// cold DM still passes the anti-ban gate, which caps cold outreach — see whatsappWebSafety).

const leadIntent = require('./leadIntentService');

// Service categories that mean a real certification need.
const CERT_CATEGORIES = ['certificate', 'declaration', 'refusal_letter', 'sgr'];
// Question intents that, combined with any known service topic, indicate a buying signal.
const BUYING_INTENTS = ['price_question', 'docs_question', 'service_question', 'application_help'];

// detect(text) → { interested, category, intent, confidence, reason }. PURE.
function detect(text = '') {
  const cls = leadIntent.classify(text);
  const categoryHit = CERT_CATEGORIES.includes(cls.service_category);
  const buyingHit = BUYING_INTENTS.includes(cls.intent) && cls.service_category !== 'unknown';
  const interested = categoryHit || buyingHit;
  return {
    interested,
    category: cls.service_category,
    intent: cls.intent,
    language: cls.language,
    confidence: cls.confidence,
    reason: interested
      ? `Интерес к «${cls.service_category !== 'unknown' ? cls.service_category : cls.intent}» (${cls.confidence}).`
      : null,
  };
}

module.exports = { detect, CERT_CATEGORIES, BUYING_INTENTS };
