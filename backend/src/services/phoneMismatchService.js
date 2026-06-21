'use strict';

// services/phoneMismatchService.js — READ-ONLY detection of contact-identity problems
// on inbound WhatsApp messages, for operator review.
//
// It flags when a message's sender identity does NOT cleanly resolve to exactly one
// Declaration order, and explains why. It changes nothing — no sends, no Declaration
// writes, no status changes. It consumes the identity already resolved at ingest
// (whatsappLidService) + the phone→order match (whatsappMatchService), plus an optional
// LIVE LID re-resolution to catch mapping drift.
//
// Mismatch types:
//   LID_ONLY_NO_PHONE     — sender is a LID with no resolvable phone → cannot match by phone
//   UNMATCHED_PHONE       — phone resolved but maps to NO Declaration row
//   AMBIGUOUS_MULTI_ORDER — phone maps to MANY orders (phone is a filter, not a resolver)
//   LID_MAPPING_DRIFT     — stored LID→phone differs from a fresh live resolution
//   NAME_MISMATCH         — uniquely matched, but the conversation names an entity that
//                           does not overlap the matched Declaration's client_name
//
// The pure `detectMismatches` is the single source of truth (no I/O), exported for tests.

const { matchKey } = require('../utils/phoneUtils');

const SEVERITY = { LID_ONLY_NO_PHONE: 'review', UNMATCHED_PHONE: 'review', AMBIGUOUS_MULTI_ORDER: 'review', LID_MAPPING_DRIFT: 'review', NAME_MISMATCH: 'review' };

const ORG = new Set(['ип', 'осоо', 'оао', 'тоо', 'ооо', 'зао', 'llc', 'чп']);
function entityTokens(s) {
  return String(s || '').toLowerCase().replace(/[^0-9a-zа-яё]+/gi, ' ').split(' ').filter(t => t.length >= 3 && !ORG.has(t));
}

// detectMismatches(input) → { ok, mismatches:[{type,severity,detail}] }
//   input = {
//     phone_resolution,            // 'phone'|'resolved_lid'|'stored_lid'|'lid_only'|null
//     phone_key, lid,              // resolved identity
//     match_status,                // 'matched'|'needs_review'|'unmatched'|'received'
//     candidates,                  // matched declaration candidates [{client_name,...}]
//     body,                        // conversation text (for NAME_MISMATCH)
//     live_phone_key,              // optional fresh LID re-resolution (for drift)
//   }
// Recommend-only correction proposal for each mismatch type (NEVER written).
const PROPOSAL = {
  LID_ONLY_NO_PHONE:     { action: 'request_or_resolve_phone',     detail: 'Запросить/распознать телефон для LID (или подтвердить контакт у оператора) — без номера сопоставление по телефону невозможно.' },
  UNMATCHED_PHONE:       { action: 'confirm_new_client_or_link',   detail: 'Телефон не найден в Декларации — подтвердить нового клиента или связать с существующей заявкой/заказом.' },
  AMBIGUOUS_MULTI_ORDER: { action: 'operator_select_order',        detail: 'Телефон соответствует нескольким заказам — оператор выбирает один.' },
  LID_MAPPING_DRIFT:     { action: 'update_lid_mapping',           detail: 'Свежее распознавание дало другой номер — после подтверждения обновить сохранённое сопоставление LID→телефон.' },
  NAME_MISMATCH:         { action: 'verify_correct_order',         detail: 'Проверить, относится ли сообщение к сопоставленному заказу (возможен другой клиент/заказ).' },
};

function detectMismatches(input = {}) {
  const m = [];
  const push = (type, detail) => m.push({ type, severity: SEVERITY[type] || 'review', detail, proposal: { ...PROPOSAL[type], write: false } });

  const candidates = Array.isArray(input.candidates) ? input.candidates : [];

  // 1) LID with no phone → unmatchable by phone
  if (input.phone_resolution === 'lid_only' || (!input.phone_key && input.lid)) {
    push('LID_ONLY_NO_PHONE', `Отправитель — LID${input.lid ? ` (${input.lid})` : ''} без распознанного номера; сопоставление по телефону невозможно.`);
  }

  // 2/3) phone present → check the match outcome
  if (input.phone_key) {
    if (input.match_status === 'unmatched') {
      push('UNMATCHED_PHONE', `Телефон распознан (key=${input.phone_key}), но не найден ни в одной строке Декларации.`);
    } else if (input.match_status === 'needs_review' || candidates.length > 1) {
      push('AMBIGUOUS_MULTI_ORDER', `Телефон соответствует ${candidates.length} заказам — по телефону нельзя выбрать один (нужен оператор).`);
    }
  }

  // 4) stored-mapping drift vs a fresh live resolution
  if (input.live_phone_key && input.phone_key && input.live_phone_key !== input.phone_key) {
    push('LID_MAPPING_DRIFT', `Сохранённое сопоставление LID→телефон (${input.phone_key}) отличается от свежего (${input.live_phone_key}).`);
  }

  // 5) unique match but the conversation names a different entity
  if (candidates.length === 1 && input.body) {
    const decl = candidates[0];
    const et = entityTokens(decl.client_name);
    if (et.length) {
      const hay = String(input.body).toLowerCase();
      const overlap = et.some(t => hay.includes(t));
      const namesSomeEntity = /(?<!\p{L})(ип|осоо|оао|тоо|ооо|зао|llc)(?!\p{L})/iu.test(input.body);
      if (!overlap && namesSomeEntity) {
        push('NAME_MISMATCH', `Сообщение упоминает юр.лицо, не совпадающее с клиентом сопоставленной строки («${decl.client_name || ''}») — проверить, тот ли заказ.`);
      }
    }
  }

  return { ok: m.length === 0, mismatches: m };
}

// ─── DB-backed: analyze one stored message (read-only) ──────────────────────────
// deps.lidResolver optionally re-resolves a LID live to detect mapping drift.
async function analyzeMessage(messageId, deps = {}) {
  const { WhatsAppMessage } = deps.WhatsAppMessage ? deps : require('../models/WhatsAppMessage');
  const lidService = deps.lidService || require('./whatsappLidService');

  const msg = await WhatsAppMessage.findById(messageId).lean();
  if (!msg) return { ok: false, reason: 'message_not_found' };

  let live_phone_key;
  if (msg.lid && typeof deps.lidResolver === 'function') {
    try {
      const arr = await deps.lidResolver([msg.lid]);
      const pn = (Array.isArray(arr) ? arr[0] : arr)?.pn;
      if (pn) live_phone_key = matchKey(lidService.phoneFromWid(pn));
    } catch (_) { /* drift check is best-effort */ }
  }

  const result = detectMismatches({
    phone_resolution: msg.phone_resolution,
    phone_key: msg.phone_key,
    lid: msg.lid,
    match_status: msg.match_status,
    candidates: msg.candidates,
    body: msg.body,
    live_phone_key,
  });
  return { message_id: String(msg._id), from_phone: msg.from_phone, lid: msg.lid || null, ...result };
}

// scanMessages(filter, deps) — analyze a batch of recent messages; return only those
// with mismatches. Read-only.
async function scanMessages({ limit = 200, since } = {}, deps = {}) {
  const { WhatsAppMessage } = deps.WhatsAppMessage ? deps : require('../models/WhatsAppMessage');
  const q = {};
  if (since) q.received_at = { $gte: since };
  const msgs = await WhatsAppMessage.find(q).sort({ received_at: -1 }).limit(limit).lean();

  const flagged = [];
  for (const msg of msgs) {
    const r = detectMismatches({
      phone_resolution: msg.phone_resolution, phone_key: msg.phone_key, lid: msg.lid,
      match_status: msg.match_status, candidates: msg.candidates, body: msg.body,
    });
    if (!r.ok) flagged.push({ message_id: String(msg._id), from_phone: msg.from_phone, lid: msg.lid || null, mismatches: r.mismatches });
  }
  return { scanned: msgs.length, flagged_count: flagged.length, flagged };
}

module.exports = { detectMismatches, analyzeMessage, scanMessages, SEVERITY, PROPOSAL };
