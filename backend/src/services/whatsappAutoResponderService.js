'use strict';

// services/whatsappAutoResponderService.js — WhatsApp Auto-Responder.
//
// Answers the common, SAFE client questions automatically, using ONLY operator-approved
// answers already in the Knowledge Base (client_faq / application link). It is the executor of
// the KB policy `first_contact_autoreply_policy`: auto is allowed ONLY for five kinds
// (service_info | pricing_from_kb | timelines_from_kb | application_link | application_instructions);
// EVERYTHING ELSE stays gated (deferred to the operator, never sent).
//
// CHANNEL SPLIT (оператор 2026-07-05, [[whatsapp-channel-split]]): the conversation HISTORY the
// agent reads comes from `whatsapp_messages`, which is maintained by the web.js sync/backfill;
// the SEND goes out via GOWA (outboundWhatsappService prefers GOWA). This service never reads via
// GOWA scraping and never sends via web.js.
//
// Modes (env WA_AUTORESPONDER_MODE): off | shadow (default) | auto.
//   off    — do nothing.
//   shadow — classify + compose, RECORD what it would send, send NOTHING (observe-only).
//   auto   — auto-eligible + grounded KB answer → SEND via GOWA; everything else → gated.
//
// classifyTopic() and composeAnswer() are PURE (no I/O) and exported for tests. handleInbound()
// is the DB-backed orchestrator. NEVER invents facts; no approved KB match → gated.

const { matchKey, digitsOnly } = require('../utils/phoneUtils');

// Mirrors KB `first_contact_autoreply_policy.auto_allowed_kinds`. Anything not here → gated.
const AUTO_ALLOWED_KINDS = ['service_info', 'pricing_from_kb', 'timelines_from_kb', 'application_link', 'application_instructions'];

function mode() {
  const m = String(process.env.WA_AUTORESPONDER_MODE || 'shadow').toLowerCase();
  return ['off', 'shadow', 'auto'].includes(m) ? m : 'shadow';
}
function humanQuietMin() { return Number(process.env.WA_AUTORESPONDER_HUMAN_QUIET_MIN || 30); }

function phoneFromJid(jid) { return digitsOnly(String(jid || '').split('@')[0]); }

// ─── PURE: classify the client's question into a topic + kind ──────────────────
// Returns { kind, topic, faqKeys[] }. kind ∈ AUTO_ALLOWED_KINDS or 'other'. faqKeys are the
// approved client_faq `value.q` keys whose text answers the question. First match wins; specific
// topics are checked before broad ones. No match → { kind:'other', topic:null, faqKeys:[] }.
const TOPIC_RULES = [
  // application intake — how to leave/fill an application, ask for the link
  { topic: 'application', kind: 'application_link', faqKeys: ['какие документы нужны'],
    re: /как\s+(оставить|подать|оформить|заполнить|сделать)\s+заявк|где\s+(взять\s+)?заявк|ссылк\w*\s+на\s+заявк|дайте\s+ссылк|как\s+заказать|хочу\s+оформить|как\s+(мне\s+)?начать|форм[аеуы]\s+заявк|как\s+к\s+вам\s+обратиться/i },
  // price — ДС specifically
  { topic: 'price_ds', kind: 'pricing_from_kb', faqKeys: ['стоимость и сроки ДС'],
    re: /(сколько|цена|стоимост|поч[её]м|по\s*чем).{0,30}(деклараци|\bдс\b)|(деклараци|\bдс\b).{0,25}(сколько|цена|стоит|стоимост|поч[её]м)/i },
  // price — СС specifically
  { topic: 'price_ss', kind: 'pricing_from_kb', faqKeys: ['стоимость и сроки СС'],
    re: /(сколько|цена|стоимост|поч[её]м).{0,30}(сертификат|\bсс\b)|(сертификат|\bсс\b).{0,25}(сколько|цена|стоит|стоимост|поч[её]м)/i },
  // price — refusal letter
  { topic: 'price_refusal', kind: 'pricing_from_kb', faqKeys: ['отказное письмо'],
    re: /отказн\w*\s+письм|отказн\w*.{0,15}(сколько|цена|стоит|стоимост)/i },
  // ПИ (protocol) — concept + additional-PI cost
  { topic: 'pi', kind: 'service_info', faqKeys: ['что такое ПИ'],
    re: /что\s+так(ое|ая)\s+пи\b|\bпи\b\s*[-—–]?\s*это|протокол\s+испытан|зачем\s+(нужен\s+)?пи\b|доп\w*\s+пи\b/i },
  // ТН ВЭД code
  { topic: 'tnved', kind: 'service_info', faqKeys: ['что такое ТН ВЭД'],
    re: /тн\s*в[эе]д|тнв[эе]д|код\s+товар|код\s+тн/i },
  // samples
  { topic: 'samples', kind: 'service_info', faqKeys: ['можно ли без образцов'],
    re: /образц|образец|без\s+образц/i },
  // ГТД / customs / invoice for imported goods
  { topic: 'gtd', kind: 'service_info', faqKeys: ['нужна ли ГТД'],
    re: /\bгтд\b|таможенн\w*\s+деклараци|импортн\w*\s+товар|нужен\s+ли\s+инвойс/i },
  // foreign legal entity
  { topic: 'foreign', kind: 'service_info', faqKeys: ['зарубежная компания'],
    re: /зарубеж|иностранн\w*\s+(компан|юрлиц|фирм)|на\s+иностран|за\s+границ\w*\s+(компан|фирм|оформ)/i },
  // combining goods into one document
  { topic: 'combine', kind: 'service_info', faqKeys: ['можно ли объединить товары'],
    re: /объедин|вместе\s+оформ|в\s+один\s+документ|несколько\s+товар.{0,20}(один|вместе)/i },
  // partial payment
  { topic: 'payment_parts', kind: 'pricing_from_kb', faqKeys: ['оплата частями'],
    re: /част(ям|ично|ичн\w*)\s*(оплат|плат)|оплат\w*\s+част|предоплат|рассрочк|можно\s+ли\s+(не\s+сразу|потом)\s+(оплат|плат)/i },
  // required documents
  { topic: 'docs', kind: 'service_info', faqKeys: ['какие документы нужны'],
    re: /как(ие|их)\s+документ|что\s+(нужно|надо)\s+(для|чтобы\s+оформ)|что\s+(от\s+меня\s+)?(нужно|требует)|какие\s+данные\s+нужн/i },
  // timelines (broad — check before generic price)
  { topic: 'timelines', kind: 'timelines_from_kb', faqKeys: ['стоимость и сроки ДС', 'стоимость и сроки СС'],
    re: /сколько\s+(времени|дней|недель|делает|занимает|ждать)|как\s+долго|когда\s+(будет\s+)?готов|срок[и]?\s+(изготовл|оформл|готов|делан)|за\s+сколько\s+(дней|сделаете|успе)/i },
  // generic price (broad — last)
  { topic: 'price_general', kind: 'pricing_from_kb', faqKeys: ['стоимость и сроки ДС', 'стоимость и сроки СС'],
    re: /сколько\s+(стоит|будет\s+стоить|это\s+стоит|у\s+вас)|какая\s+(цена|стоимост)|прайс|расценк|по\s+цен/i },
];

function classifyTopic(text = '') {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return { kind: 'other', topic: null, faqKeys: [] };
  for (const rule of TOPIC_RULES) {
    if (rule.re.test(t)) return { kind: rule.kind, topic: rule.topic, faqKeys: rule.faqKeys.slice() };
  }
  return { kind: 'other', topic: null, faqKeys: [] };
}

// ─── PURE: compose the answer from APPROVED KB entries ─────────────────────────
// kb = array of approved knowledge entries (from getApprovedKnowledge); applicationUrl =
// the business_setting application_form_url (may be null). Returns { answer, matchedRef } or
// null when nothing grounded can be composed (→ caller gates it). NEVER invents text.
function composeAnswer(match = {}, kb = [], applicationUrl = null) {
  const faqKeys = match.faqKeys || [];
  const byKey = new Map();
  for (const e of kb) {
    const v = e && e.value;
    if (v && v.kind === 'client_faq' && v.q && faqKeys.includes(v.q)) {
      if (!byKey.has(v.q)) byKey.set(v.q, String(e.text || '').trim());
    }
  }
  // Preserve the order declared in faqKeys.
  const parts = faqKeys.map(k => byKey.get(k)).filter(Boolean);

  if (match.topic === 'application') {
    // The link is the point of an application answer — without it, gate to the operator.
    if (!applicationUrl) return null;
    const intro = `Оставить заявку можно по ссылке: ${applicationUrl}`;
    const body = parts.length ? `\n\n${parts.join('\n')}` : '';
    return { answer: `${intro}${body}`, matchedRef: `application_form_url${parts.length ? '+client_faq' : ''}` };
  }

  if (!parts.length) return null;                       // no approved answer → gate it
  return { answer: parts.join('\n\n'), matchedRef: `client_faq:${faqKeys.filter(k => byKey.has(k)).join(',')}` };
}

// ─── DB-backed: handle one inbound message ─────────────────────────────────────
// raw = the normalized inbound (gowaClient.toIngestRaw shape): { id, from, body, is_group,
// from_me, chat_id }. Idempotent by provider_message_id. Reads history from whatsapp_messages
// (web.js-maintained); SENDS via GOWA (outboundWhatsappService). Returns a summary.
async function handleInbound(raw = {}, deps = {}) {
  const m = mode();
  if (m === 'off') return { skipped: 'mode_off' };
  if (raw.from_me) return { skipped: 'from_me' };
  if (raw.is_group) return { skipped: 'group' };

  const text = String(raw.body || '').trim();
  if (!text) return { skipped: 'no_text' };

  const messageId = raw.id;
  if (!messageId) return { skipped: 'no_message_id' };   // can't dedup safely → skip

  const { WaAutoReply } = deps.WaAutoReply ? deps : require('../models/WaAutoReply');
  const { WhatsAppMessage } = deps.WhatsAppMessage ? deps : require('../models/WhatsAppMessage');
  const kbSvc = deps.knowledgeBaseService || require('./knowledgeBaseService');
  const outbound = deps.outbound || require('./outboundWhatsappService');

  // Idempotent — one decision per inbound message (webhook retries never double-answer).
  if (await WaAutoReply.exists({ provider_message_id: messageId })) return { skipped: 'duplicate' };

  const phone_key = matchKey(phoneFromJid(raw.from));
  const to_phone = phoneFromJid(raw.from);
  if (!phone_key) return { skipped: 'no_phone' };

  // Classify + compose (grounded in approved KB only).
  const match = classifyTopic(text);
  let kb = [];
  try { kb = await kbSvc.getApprovedKnowledge(); } catch (_) { kb = []; }
  let applicationUrl = null;
  if (match.topic === 'application') {
    try { const s = await kbSvc.getBusinessSetting('application_form_url'); applicationUrl = s && s.value; } catch (_) {}
  }
  const composed = AUTO_ALLOWED_KINDS.includes(match.kind) ? composeAnswer(match, kb, applicationUrl) : null;
  const autoEligible = !!composed;

  const record = {
    provider_message_id: messageId,
    phone_key, to_phone, inbound_text: text,
    kind: match.kind, topic: match.topic || undefined,
    matched_kb_ref: composed ? composed.matchedRef : undefined,
    answer_text: composed ? composed.answer : undefined,
    mode: m,
  };

  // Not auto-eligible → gated (operator handles via reply-draft). Never sends.
  if (!autoEligible) {
    record.decision = 'gated';
    await WaAutoReply.create(record);
    return { decision: 'gated', kind: match.kind };
  }

  // Don't step on the operator: a recent HUMAN outbound in this thread means a person is
  // handling it → defer instead of auto-sending. (Recent auto_sent by us is fine.)
  const quietMs = humanQuietMin() * 60 * 1000;
  const since = new Date(Date.now() - quietMs);
  const recentHuman = await WhatsAppMessage.exists({
    phone_key, direction: 'outbound', created_at: { $gte: since },
  });
  if (recentHuman) {
    record.decision = 'gated';
    record.skip_reason = 'human_active';
    await WaAutoReply.create(record);
    return { decision: 'gated', skip_reason: 'human_active' };
  }

  // shadow → record what we WOULD send, send nothing.
  if (m === 'shadow') {
    record.decision = 'shadow';
    await WaAutoReply.create(record);
    return { decision: 'shadow', kind: match.kind, answer: composed.answer };
  }

  // auto → SEND via GOWA (outboundWhatsappService prefers GOWA).
  let sendResult = null;
  try { sendResult = await outbound.send(to_phone, composed.answer); }
  catch (e) { sendResult = { ok: false, error: e.message }; }
  record.send_result = sendResult;
  if (sendResult && sendResult.ok) {
    record.decision = 'auto_sent';
    await WaAutoReply.create(record);
    return { decision: 'auto_sent', kind: match.kind };
  }
  // Send failed → record as gated so the operator picks it up.
  record.decision = 'gated';
  record.skip_reason = 'send_failed';
  await WaAutoReply.create(record);
  return { decision: 'gated', skip_reason: 'send_failed', send_result: sendResult };
}

module.exports = {
  classifyTopic, composeAnswer, handleInbound,
  AUTO_ALLOWED_KINDS, mode, _phoneFromJid: phoneFromJid,
};
