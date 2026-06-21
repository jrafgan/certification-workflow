'use strict';

// services/leadIntentService.js — PURE intent / language / service-category detection for
// inbound social-media lead messages (Stages 1–2). No I/O, no LLM — deterministic RU/KY/EN
// keyword rules, fully unit-testable. This is the conversation-understanding layer the lead
// agent needs; it intentionally errs toward 'unknown' rather than guessing (operator-gated
// actions never fire on a guess).

// ─── Language ──────────────────────────────────────────────────────────────────
// Kyrgyz-specific letters / function words distinguish KY from RU; Latin → EN.
const KY_LETTERS = /[өңүұ]/i;
// Distinctive Kyrgyz function words (no \b — ASCII boundaries don't bound Cyrillic).
const KY_WORDS = /(саламатсызбы|кандай|канча|керек|болот|жардам|баасы|турат)/i;
const CYRILLIC  = /[а-яё]/i;
const LATIN     = /[a-z]/i;

function detectLanguage(text = '') {
  const t = String(text || '');
  if (KY_LETTERS.test(t) || KY_WORDS.test(t)) return 'ky';
  if (CYRILLIC.test(t)) return 'ru';
  if (LATIN.test(t))    return 'en';
  return 'unknown';
}

// ─── Service category (Stage 2) ─────────────────────────────────────────────────
// Ordered by specificity; first hit wins. Branded tools (MPStats/Wildbox) before the
// generic doc types so "сертификат для wildbox" maps to the tool, not the certificate.
// NOTE: \b is ASCII-only and does NOT bound Cyrillic tokens. For short Cyrillic
// abbreviations (СГР/СС/ДС) use an explicit non-letter boundary instead.
const SERVICE_RULES = [
  { category: 'mpstats',        re: /\bmp\s*stats?\b|мпстатс|мп\s*статистик/i },
  { category: 'wildbox',        re: /\bwild\s*box\b|вайлдбокс|вилдбокс/i },
  { category: 'sgr',            re: /(?:^|[^а-яё])сгр(?:[^а-яё]|$)|свидетельств[оа]\s+о\s+гос|государственн[ао]й\s+регистрац/i },
  { category: 'refusal_letter', re: /отказн|отказное\s+письмо/i },
  { category: 'certificate',    re: /сертификат|(?:^|[^а-яё])сс(?:[^а-яё]|$)|certificate/i },
  { category: 'declaration',    re: /деклараци|(?:^|[^а-яё])дс(?:[^а-яё]|$)|declaration/i },
];

function detectServiceCategory(text = '') {
  const t = String(text || '');
  for (const r of SERVICE_RULES) if (r.re.test(t)) return r.category;
  return 'unknown';
}

// ─── Intent (Stages 1–2, plus payment/status cues) ──────────────────────────────
// Multiple intents can be present; we return the single most actionable one by precedence.
const INTENT_RULES = [
  { intent: 'payment_made',     re: /оплатил|оплачен|перев[её]л|перечислил|чек(?:[^а-яё]|$)|квитанц|тол[её]д[уи]м|оплату\s+отправил/i },
  { intent: 'price_question',   re: /сколько\s+стоит|цена|стоимост|по\s*чём|почем|канча\s+турат|баасы|price|cost|расцен/i },
  { intent: 'timeline_question',re: /сколько\s+(времени|дней|занимает)|какие\s+сроки|когда\s+будет|срок/i },
  { intent: 'docs_question',    re: /какие\s+документ|что\s+нужно|что\s+требу|какие\s+данные|нужн[ыо].*документ/i },
  { intent: 'service_question', re: /сертификат|деклараци|отказн|\bсгр\b|mp\s*stats?|wild\s*box|оформ/i },
  { intent: 'application_help', re: /заявк|заполн|анкет|как\s+подать|форм[аоуы]/i },
  { intent: 'greeting',         re: /^(привет|здравствуй|здрасьте|добр(ый|ое|ого)|салам|саламатсызбы|hello|hi|assalam|здравствуйте)/i },
];

function detectIntent(text = '') {
  const t = String(text || '').trim();
  for (const r of INTENT_RULES) if (r.re.test(t)) return r.intent;
  // A bare entity mention ("осоо bacci", "это парманова") = identifying self.
  if (/\b(ип|осоо|ооо)\b|^это\s+\S+/i.test(t)) return 'identify_self';
  return 'unknown';
}

// ─── Combined classification ─────────────────────────────────────────────────────
// Confidence: HIGH when intent AND a concrete service category are both known; MEDIUM when
// one is known; LOW when only a greeting; NONE when nothing classified.
function classify(text = '') {
  const language = detectLanguage(text);
  const intent   = detectIntent(text);
  const service_category = detectServiceCategory(text);

  let confidence = 'NONE';
  if (intent !== 'unknown' && service_category !== 'unknown') confidence = 'HIGH';
  else if (service_category !== 'unknown' || (intent !== 'unknown' && intent !== 'greeting')) confidence = 'MEDIUM';
  else if (intent === 'greeting') confidence = 'LOW';

  return { language, intent, service_category, confidence };
}

module.exports = {
  detectLanguage,
  detectServiceCategory,
  detectIntent,
  classify,
  SERVICE_RULES,
  INTENT_RULES,
};
