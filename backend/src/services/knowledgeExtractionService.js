'use strict';

// services/knowledgeExtractionService.js — PURE extraction of structured knowledge
// from a video transcript. No I/O, no DB, no network — fully unit-testable.
//
// It is a deterministic FIRST-PASS extractor (keyword/regex heuristics tuned for the
// Russian certification domain). Everything it emits is a CANDIDATE: low/medium
// confidence and needs_review:true. A semantic (LLM) extractor can be layered on later
// by feeding richer entries into the same shape — the persistence + review gating in
// knowledgeBaseService is agnostic to how entries were produced.
//
// HARD RULE: extraction never decides truth. It proposes; the operator disposes.

// ─── Category detectors (Russian domain keywords) ─────────────────────────────
// NOTE: JS \w / \b are ASCII-only and do NOT work for Cyrillic. Short abbreviations
// (СС/ДС/ПИ) use Unicode letter look-arounds (\p{L}, /u); everything else uses stems.
const CATEGORY_PATTERNS = {
  'Certificates':        [/сертификат/i, /сертификац/i, /(?<!\p{L})сс(?!\p{L})/iu],
  'Declarations':        [/деклараци/i, /декларир/i, /(?<!\p{L})дс(?!\p{L})/iu],
  'TN VED':              [/тн\s?вэд/i, /тнвэд/i, /товарной номенклатур/i, /код товара/i],
  'PI Calculations':     [/позиц/i, /(?<!\p{L})пи(?!\p{L})/iu, /наименован/i, /единиц/i],
  'Laboratories':        [/лаборатор/i, /испытани/i, /протокол/i, /аккредит/i],
  'Payments':            [/оплат/i, /стоимост/i, /цен[аыуе]/i, /прайс/i, /предоплат/i],
  'Samples':             [/образц/i, /образец/i, /проб[аеыу]/i, /отбор/i],
  'Client Communication':[/клиент/i, /объясн/i, /расскаж/i, /как сказать/i, /общени/i],
  'FAQ':                 [/часто задаваем/i, /вопрос/i, /\bfaq\b/i],
};

const NORMATIVE_CUES = [/нужно/i, /должн/i, /обязательн/i, /требу[ею]/i, /необходим/i, /нельзя/i, /запрещ/i, /следует/i, /оформля/i, /подаётся/i, /подается/i];

const OUTDATED_CUES = [/раньше/i, /сейчас/i, /на сегодняшний день/i, /новые правила/i, /измен[её]ни/i, /с прошлого года/i, /устарел/i, /больше не/i];

const PRICE_RE = /(\d[\d\s.,]*\d|\d)\s*(сом(?:ов|а)?|руб(?:лей|\.)?|₽|тенге|тг|usd|\$|доллар[а-яё]*|евро|€)/gi;
const TIME_RE  = /(\d+)\s*(?:[-–]\s*(\d+)\s*)?(рабоч[а-яё]*\s+)?(дн[а-яё]+|недел[а-яё]+|месяц[а-яё]*|час[а-яё]*)/gi;
const TNVED_CODE_RE = /\b\d{4}(?:\s?\d{2,4}){0,4}\b/g;
const YEAR_RE = /\b(19|20)\d{2}\b/;

const DEFAULT_OUTDATED_MONTHS = parseInt(process.env.KB_OUTDATED_MONTHS, 10) || 24;

// ─── Sentence splitting ────────────────────────────────────────────────────────
function splitSentences(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?…])\s+|\n+/)
    .map(s => s.trim())
    .filter(s => s.length >= 5);
}

// ─── Field extractors (each returns matches with context) ─────────────────────
function detectCategories(sentence) {
  const hits = [];
  for (const [cat, pats] of Object.entries(CATEGORY_PATTERNS)) {
    if (pats.some(p => p.test(sentence))) hits.push(cat);
  }
  return hits;
}

function extractPrices(text) {
  const out = [];
  for (const s of splitSentences(text)) {
    let m;
    PRICE_RE.lastIndex = 0;
    while ((m = PRICE_RE.exec(s)) !== null) {
      const amount = parseFloat(m[1].replace(/[\s.]/g, '').replace(',', '.'));
      out.push({ raw: m[0].trim(), amount: isNaN(amount) ? null : amount, currency: m[2].toLowerCase(), context: s });
    }
  }
  return out;
}

function extractTimelines(text) {
  const out = [];
  for (const s of splitSentences(text)) {
    let m;
    TIME_RE.lastIndex = 0;
    while ((m = TIME_RE.exec(s)) !== null) {
      out.push({ raw: m[0].trim(), value: parseInt(m[1], 10), value_to: m[2] ? parseInt(m[2], 10) : null, business_days: !!m[3], unit: m[4], context: s });
    }
  }
  return out;
}

function extractTnVed(text) {
  const out = [];
  for (const s of splitSentences(text)) {
    if (!/тн\s?вэд|тнвэд/i.test(s)) continue;
    let m; TNVED_CODE_RE.lastIndex = 0;
    const codes = [];
    while ((m = TNVED_CODE_RE.exec(s)) !== null) codes.push(m[0].replace(/\s/g, ''));
    out.push({ context: s, codes });
  }
  return out;
}

// ─── Confidence + outdated heuristics ──────────────────────────────────────────
function scoreConfidence({ categories, hasPrice, hasTimeline, normative }) {
  if (hasPrice || hasTimeline) return 'MEDIUM';       // a structured value is present
  if (categories.length >= 2 || normative) return 'MEDIUM';
  return 'LOW';
}

function isPossiblyOutdated(sentence, publishedAt, hasPrice) {
  if (hasPrice) return true;                            // prices are volatile → always review
  if (OUTDATED_CUES.some(p => p.test(sentence))) return true;
  if (YEAR_RE.test(sentence)) return true;
  if (publishedAt) {
    const months = (Date.now() - new Date(publishedAt).getTime()) / (1000 * 60 * 60 * 24 * 30);
    if (months > DEFAULT_OUTDATED_MONTHS) return true;
  }
  return false;
}

// ─── Per-video extraction ───────────────────────────────────────────────────────
function summarize(sentences) {
  const head = sentences.slice(0, 3).join(' ');
  const words = sentences.join(' ').split(/\s+/).filter(Boolean).length;
  return `${head}${head ? ' ' : ''}[heuristic summary — ${sentences.length} sentences, ${words} words]`;
}

// buildVideoExtraction({ video, transcript }) → structured per-video extraction.
// `video` = { video_id, title, published_at, url }; `transcript` = { text }.
function buildVideoExtraction({ video = {}, transcript = {} } = {}) {
  const sentences = splitSentences(transcript.text);
  const publishedAt = video.published_at || null;
  const entries = [];

  for (const s of sentences) {
    const categories = detectCategories(s);
    PRICE_RE.lastIndex = 0; const prices = extractPricesInSentence(s);
    TIME_RE.lastIndex = 0;  const timelines = extractTimelinesInSentence(s);
    if (categories.length === 0 && prices.length === 0 && timelines.length === 0) continue;

    const normative = NORMATIVE_CUES.some(p => p.test(s));
    const hasPrice = prices.length > 0;
    const hasTimeline = timelines.length > 0;
    const outdated = isPossiblyOutdated(s, publishedAt, hasPrice);
    const confidence = scoreConfidence({ categories, hasPrice, hasTimeline, normative });

    // Category rule/fact entries (one per detected category).
    for (const cat of categories) {
      entries.push({
        category: cat,
        type: normative ? 'rule' : 'fact',
        text: s,
        confidence,
        possibly_outdated: outdated,
      });
    }
    // Price entries → Payments.
    for (const p of prices) {
      entries.push({ category: 'Payments', type: 'price', text: s, value: { amount: p.amount, currency: p.currency, raw: p.raw }, confidence: 'MEDIUM', possibly_outdated: true });
    }
    // Timeline entries → Laboratories if lab/sample context, else Declarations.
    for (const t of timelines) {
      const cat = /лаборатор|испытани|протокол|образц/i.test(s) ? 'Laboratories' : (categories[0] || 'Declarations');
      entries.push({ category: cat, type: 'timeline', text: s, value: { value: t.value, value_to: t.value_to, unit: t.unit, business_days: t.business_days, raw: t.raw }, confidence: 'MEDIUM', possibly_outdated: outdated });
    }
  }

  // Operator-confirmation questions (deduped).
  const questions = [];
  const seenQ = new Set();
  const addQ = (q) => { if (!seenQ.has(q)) { seenQ.add(q); questions.push(q); } };
  for (const e of entries) {
    if (e.type === 'price')    addQ(`Confirm current price — video says: "${e.text}"`);
    if (e.type === 'timeline') addQ(`Confirm timeline still accurate — "${e.text}"`);
    if (e.type !== 'price' && e.type !== 'timeline' && e.possibly_outdated) addQ(`Verify still current vs latest regulations — "${e.text}"`);
  }

  const facts     = entries.filter(e => e.type === 'fact');
  const rules     = entries.filter(e => e.type === 'rule');
  const prices    = entries.filter(e => e.type === 'price');
  const timelines = entries.filter(e => e.type === 'timeline');
  const possibly_outdated = entries.some(e => e.possibly_outdated);
  const confidence = entries.some(e => e.confidence === 'MEDIUM') ? 'MEDIUM' : (entries.length ? 'LOW' : 'LOW');

  return {
    video_id: video.video_id || null,
    title: video.title || '',
    published_at: publishedAt,
    url: video.url || '',
    summary: summarize(sentences),
    facts, rules, prices, timelines,
    entries,
    confidence,
    possibly_outdated,
    questions,
  };
}

// helpers reused inside buildVideoExtraction (sentence-scoped)
function extractPricesInSentence(s) {
  const out = []; let m; PRICE_RE.lastIndex = 0;
  while ((m = PRICE_RE.exec(s)) !== null) {
    const amount = parseFloat(m[1].replace(/[\s.]/g, '').replace(',', '.'));
    out.push({ raw: m[0].trim(), amount: isNaN(amount) ? null : amount, currency: m[2].toLowerCase() });
  }
  return out;
}
function extractTimelinesInSentence(s) {
  const out = []; let m; TIME_RE.lastIndex = 0;
  while ((m = TIME_RE.exec(s)) !== null) {
    out.push({ raw: m[0].trim(), value: parseInt(m[1], 10), value_to: m[2] ? parseInt(m[2], 10) : null, business_days: !!m[3], unit: m[4] });
  }
  return out;
}

// buildReviewPackage(extractions) → aggregate review artifact.
function buildReviewPackage(extractions = []) {
  const by_category = {};
  let entry_count = 0, possibly_outdated_count = 0, questions_count = 0;
  for (const ex of extractions) {
    entry_count += ex.entries.length;
    possibly_outdated_count += ex.entries.filter(e => e.possibly_outdated).length;
    questions_count += ex.questions.length;
    for (const e of ex.entries) by_category[e.category] = (by_category[e.category] || 0) + 1;
  }
  return {
    video_count: extractions.length,
    entry_count,
    possibly_outdated_count,
    questions_count,
    by_category,
    videos: extractions.map(ex => ({
      video_id: ex.video_id, title: ex.title, published_at: ex.published_at,
      entry_count: ex.entries.length, confidence: ex.confidence, possibly_outdated: ex.possibly_outdated,
      questions: ex.questions.length,
    })),
  };
}

module.exports = {
  CATEGORY_PATTERNS,
  splitSentences,
  detectCategories,
  extractPrices,
  extractTimelines,
  extractTnVed,
  scoreConfidence,
  isPossiblyOutdated,
  buildVideoExtraction,
  buildReviewPackage,
  DEFAULT_OUTDATED_MONTHS,
};
