'use strict';

// services/applicationMatchService.js — match a WhatsApp conversation to a New
// Applications (form) submission, returning candidate matches with confidence.
//
// Signals (per Sprint 3 requirements): phone number, legal entity name,
// application timestamp. Read-only — no sheet writes, no Declaration changes,
// no orders, no messages.
//
// Confirmed rule: PHONE IS A FILTER, NOT A RESOLVER. If the phone matches more
// than one application, the result is needs_review — never auto-select.
//
// `matchConversationToApplications` is PURE (no I/O) and exported for testing.

const { phonesMatch } = require('../utils/phoneUtils');

// Business rule: LEGAL ENTITY NAME > PHONE NUMBER. One entity legitimately uses many
// phones (owner/manager/assistant/old+new WhatsApp), so entity identifies the CLIENT
// more strongly than phone. Timestamp is OPTIONAL — it only raises confidence when
// present and never blocks a match (the real New Form has no timestamp column).
const WEIGHTS = { entity: 0.5, phone: 0.4, time: 0.1 };
const TIME_WINDOW_HOURS = 72; // proximity window for the optional timestamp signal

const ORG = new Set(['ип', 'осоо', 'оао', 'тоо', 'ооо', 'зао', 'llc', 'чп']);
function normalizeText(s) {
  return String(s || '').toLowerCase().replace(/[«»"'.,()\/\\-]/g, ' ').replace(/\s+/g, ' ').trim();
}
function entityTokens(s) {
  return normalizeText(s).split(' ').filter(t => t.length >= 3 && !ORG.has(t));
}

// Fraction of the application's entity-name tokens that appear in the
// conversation text (0..1). 0 when either side is empty.
function entityScore(conversationText, legalEntity) {
  const et = entityTokens(legalEntity);
  if (!et.length) return 0;
  const hay = normalizeText(conversationText);
  if (!hay) return 0;
  const found = et.filter(t => hay.includes(t)).length;
  return found / et.length;
}

// Timestamp proximity (0..1): 1 when simultaneous, decaying to 0 at the window edge.
function timeScore(conversationTs, submittedAt, windowHours = TIME_WINDOW_HOURS) {
  if (!conversationTs || !submittedAt) return 0;
  const a = new Date(conversationTs).getTime();
  const b = new Date(submittedAt).getTime();
  if (isNaN(a) || isNaN(b)) return 0;
  const diffH = Math.abs(a - b) / 3_600_000;
  if (diffH >= windowHours) return 0;
  return +(1 - diffH / windowHours);
}

// conversation: { phone, text, timestamp }
// applications: [{ row, phone, legal_entity, submitted_at }]
function matchConversationToApplications(conversation = {}, applications = []) {
  const candidates = applications.map(app => {
    const p = phonesMatch(conversation.phone, app.phone) ? 1 : 0;
    const e = entityScore(conversation.text, app.legal_entity);
    const t = timeScore(conversation.timestamp, app.submitted_at);
    const score = +(WEIGHTS.phone * p + WEIGHTS.entity * e + WEIGHTS.time * t).toFixed(3);
    return {
      row:          app.row,
      legal_entity: app.legal_entity,
      submitted_at: app.submitted_at,
      score,
      signals:      { phone: !!p, entity: +e.toFixed(2), time: +t.toFixed(2) },
    };
  })
    // A candidate requires phone OR entity evidence. Timestamp proximity alone is
    // noise (every submission that week would "match") — it only boosts/ranks.
    .filter(c => c.signals.phone || c.signals.entity > 0)
    .sort((a, b) => b.score - a.score);

  if (candidates.length === 0) {
    return { status: 'unmatched', confidence: null, candidates: [] };
  }

  const phoneMatches = candidates.filter(c => c.signals.phone);
  const top = candidates[0], second = candidates[1];

  let status, confidence;
  if (phoneMatches.length > 1) {
    // Phone is a filter, not a resolver — multiple phone candidates → review.
    status = 'needs_review'; confidence = 'MEDIUM';
  } else if (top.score >= 0.7 && (!second || top.score - second.score >= 0.2)) {
    status = 'matched'; confidence = 'HIGH';
  } else if (top.score >= 0.4) {
    status = 'needs_review'; confidence = 'MEDIUM';
  } else {
    status = 'needs_review'; confidence = 'LOW';
  }

  return { status, confidence, candidates };
}

// DB/reader-backed wrapper: read applications (read-only) then match.
async function matchConversation(conversation, deps = {}) {
  const client = deps.newApplicationsClient || require('../integrations/newApplicationsClient');
  const { applications } = await client.readApplications();
  return { ...matchConversationToApplications(conversation, applications), application_count: applications.length };
}

// ─── "I filled the form" intent ──────────────────────────────────────────────
// detectFilledFormIntent(text) — PURE. True when the client says they submitted the
// application/form (RU phrasings). Used to distinguish "claims filled but no app found"
// from a generic unmatched message.
const FILLED_FORM_PATTERNS = [
  /заполнил[аи]?\s+(заявк|форм|анкет)/i,
  /заявк[ауи]\s+заполнил/i,
  /(отправил[аи]?|оставил[аи]?|подал[аи]?)\s+(заявк|форм|анкет)/i,
  /форм[ауы]\s+(заполнил|отправил|отправлен)/i,
  /заполнил[аи]?\s+(всё|все|анкету)/i,
];
function detectFilledFormIntent(text) {
  const s = String(text || '');
  return { claims_filled: FILLED_FORM_PATTERNS.some(p => p.test(s)) };
}

// ─── Correction proposals (recommend-only; NEVER written) ─────────────────────
function proposal(action, detail, refs = {}) { return { action, detail, ...refs, write: false }; }

// ─── Scenario classification ──────────────────────────────────────────────────
// classifyContact(conversation, applications) → PURE. Resolves the WhatsApp Client ↔
// Application relationship into one scenario and emits recommend-only proposals.
// Scenarios:
//   MATCHED                         phone uniquely maps to one application
//   AMBIGUOUS_MULTIPLE_APPLICATIONS phone maps to >1 application (operator selects)
//   PHONE_MISMATCH                  entity matches an application but the phone differs
//   CLAIMS_FILLED_NO_APPLICATION    client says "I filled the form" but none is found
//   NO_APPLICATION                  client wrote but no application matches
const ENTITY_STRONG = 0.5;
function classifyContact(conversation = {}, applications = []) {
  const base   = matchConversationToApplications(conversation, applications);
  const intent = detectFilledFormIntent(conversation.text);
  const phoneMatches = base.candidates.filter(c => c.signals.phone);
  const top = base.candidates[0] || null;

  let scenario, confidence = base.confidence, proposals = [];

  if (phoneMatches.length === 1) {
    scenario = 'MATCHED';
    confidence = 'HIGH';
  } else if (phoneMatches.length > 1) {
    scenario = 'AMBIGUOUS_MULTIPLE_APPLICATIONS';
    confidence = 'MEDIUM';
    proposals.push(proposal('operator_select_application', `Телефон соответствует ${phoneMatches.length} заявкам — оператор выбирает нужную.`, { candidates: phoneMatches.map(c => c.row) }));
  } else if (top && top.signals.entity >= ENTITY_STRONG) {
    // Entity matches an application but the phone differs. Per business rule
    // (Entity > Phone), this is likely the SAME client on another number — recommend,
    // never auto-merge / auto-correct. Review package only.
    scenario = 'POSSIBLE_ADDITIONAL_PHONE';
    confidence = 'MEDIUM';
    proposals.push(proposal('possible_additional_phone_for_client',
      `Possible additional phone number for existing client. Название из переписки совпадает с заявкой (строка ${top.row}, «${top.legal_entity}»), но номер WhatsApp другой — одно юр.лицо может использовать несколько номеров. Рекомендация для проверки оператором; не объединять и не изменять автоматически.`,
      { application_row: top.row, application_phone: top.phone || null, whatsapp_phone: conversation.phone || null }));
  } else if (intent.claims_filled) {
    // "I filled the form" but nothing matches → scenarios 1 + 3.
    scenario = 'CLAIMS_FILLED_NO_APPLICATION';
    confidence = 'LOW';
    proposals.push(proposal('verify_application_submitted',
      'Клиент сообщает, что заполнил заявку, но подходящая заявка не найдена — попросить клиента подтвердить номер/название или прислать заявку повторно; оператору проверить «Новую форму».',
      { whatsapp_phone: conversation.phone || null }));
  } else {
    scenario = 'NO_APPLICATION';
    confidence = 'LOW';
    proposals.push(proposal('treat_as_new_lead',
      'Сообщение от клиента без подходящей заявки — обработать как новый лид и отправить ссылку на заявку.',
      { whatsapp_phone: conversation.phone || null }));
  }

  return { scenario, status: base.status, confidence, claims_filled: intent.claims_filled, candidates: base.candidates, proposals };
}

// DB-backed wrapper for classifyContact. Default source is the New Form spreadsheet
// (the real submissions feed, 'Ответы на форму (1)'); override via deps.applicationsReader.
async function classifyConversation(conversation, deps = {}) {
  const client = deps.applicationsReader || deps.newApplicationsClient || require('../integrations/newFormClient');
  const { applications = [] } = await client.readApplications();
  return { ...classifyContact(conversation, applications), application_count: applications.length };
}

// ─── Silent applications (application exists but client never wrote) — scenario 2 ──
// findSilentApplications(applications, contactedPhones) — PURE. Returns applications
// whose phone has NOT appeared in WhatsApp (no inbound message), each with a proposal.
function findSilentApplications(applications = [], contactedPhones = []) {
  const { matchKey } = require('../utils/phoneUtils');
  const contacted = new Set(contactedPhones.map(p => matchKey(p)).filter(Boolean));
  return applications
    .filter(a => { const k = matchKey(a.phone); return k && !contacted.has(k); })
    .map(a => ({
      row: a.row, legal_entity: a.legal_entity, phone: a.phone, submitted_at: a.submitted_at,
      proposal: proposal('operator_outreach',
        `Заявка есть (строка ${a.row}, «${a.legal_entity}»), но клиент ещё не писал в WhatsApp — предложить оператору связаться.`,
        { application_row: a.row }),
    }));
}

// DB-backed: read applications + the set of phones seen in WhatsApp, then find silent ones.
async function findSilentApplicationsLive(deps = {}) {
  const client = deps.newApplicationsClient || require('../integrations/newApplicationsClient');
  const { WhatsAppMessage } = deps.WhatsAppMessage ? deps : require('../models/WhatsAppMessage');
  const { applications = [] } = await client.readApplications();
  const keys = await WhatsAppMessage.distinct('phone_key', { phone_key: { $nin: [null, ''] } });
  const phones = await WhatsAppMessage.distinct('from_phone', { from_phone: { $nin: [null, ''] } });
  const silent = findSilentApplications(applications, [...keys, ...phones]);
  return { application_count: applications.length, silent_count: silent.length, silent };
}

module.exports = {
  matchConversationToApplications,
  matchConversation,
  detectFilledFormIntent,
  classifyContact,
  classifyConversation,
  findSilentApplications,
  findSilentApplicationsLive,
  entityScore,
  timeScore,
  WEIGHTS,
  TIME_WINDOW_HOURS,
};
