'use strict';

// services/whatsappMatchService.js — match an inbound WhatsApp message to a
// Declaration order by phone.
//
// Rules (WHATSAPP_AGENT_V1_SPEC.md §9, order-identity model):
//   - Match on the canonical phone key (normalized suffix), never exact string.
//   - One phone → MANY orders. Phone alone does NOT pick one order:
//       0 candidates  → unmatched
//       1 candidate   → matched   (HIGH — unique)
//       >1 candidates → needs_review (operator must choose; never auto-assigned)
//
// The pure ranking function `rankByPhone` is exported for testing and takes its
// declarations as input (no DB), so the decision logic is verifiable in
// isolation. `matchMessage` is the thin DB-backed wrapper.

const { matchKey } = require('../utils/phoneUtils');

// rankByPhone(phone, declarations) → { match_status, match_confidence, candidates }
// `declarations` is an array of plain Declaration-like objects with at least
// { _id, order_id, sheet_row_id, client_name, phone, status }.
function rankByPhone(phone, declarations = []) {
  const key = matchKey(phone);
  if (!key) {
    return { match_status: 'unmatched', match_confidence: null, candidates: [], reason: 'phone_too_short_or_empty' };
  }

  const candidates = declarations
    .filter(d => matchKey(d.phone) === key)
    .map(d => ({
      order_id:       d.order_id || null,
      declaration_id: d._id || null,
      sheet_row_id:   d.sheet_row_id || null,
      client_name:    d.client_name || null,
      document_type:  d.document_type || null,
      status:         d.status || null,
    }));

  if (candidates.length === 0) {
    return { match_status: 'unmatched', match_confidence: null, candidates: [], reason: 'no_candidate' };
  }
  if (candidates.length === 1) {
    // Unique phone→order resolution. Phone equality is exact on the canonical key.
    return { match_status: 'matched', match_confidence: 'HIGH', candidates, reason: 'unique_phone_match' };
  }
  // Multiple orders share this phone — cannot pick one from phone alone.
  return {
    match_status: 'needs_review',
    match_confidence: 'MEDIUM',
    candidates,
    reason: `phone_maps_to_${candidates.length}_orders`,
  };
}

// matchMessage(messageId) — DB-backed: loads the message, finds candidate
// Declarations by phone key, writes the matching outcome back onto the message.
// Read/replica-only: it reads the Declaration replica and updates the
// whatsapp_messages working record. It never writes the sheet or an Order.
async function matchMessage(messageId, deps = {}) {
  const { WhatsAppMessage } = deps.WhatsAppMessage ? deps : require('../models/WhatsAppMessage');
  const { Declaration }     = deps.Declaration ? deps : require('../models/Declaration');

  const msg = await WhatsAppMessage.findById(messageId);
  if (!msg) throw require('../utils/errorUtils').notFoundError('WhatsApp message not found');

  const key = msg.phone_key || matchKey(msg.from_phone);
  // Narrow the scan when a phone_key index exists on the replica; otherwise the
  // caller can pass a prefiltered set. Here we query by stored phone_key when set,
  // else fall back to scanning (replica is bounded).
  const query = key ? { phone_key: key } : { _id: null };
  let decls = await Declaration.find(query).lean();
  if (!decls.length && key) {
    // Replica may not have phone_key populated yet (pre-sync) — scan + filter.
    decls = (await Declaration.find({}).lean()).filter(d => matchKey(d.phone) === key);
  }

  const result = rankByPhone(msg.from_phone, decls);
  msg.match_status     = result.match_status;
  msg.match_confidence = result.match_confidence;
  msg.candidates       = result.candidates;
  msg.matched_order_id = result.match_status === 'matched' ? (result.candidates[0].order_id || null) : null;
  await msg.save();

  return { message: msg, ...result };
}

// ─── lookupByPhone — Sprint 2 read-only Declaration lookup ────────────────────
//
// Pure: given a phone and a set of Declaration-like records, returns the matched
// orders projected to { row, client, document, status } plus the "last
// Declaration row" (the highest sheet row number — usually the newest order, a
// matching signal, NOT a guarantee). One phone may map to many orders.
function lookupByPhone(phone, declarations = []) {
  const ranked = rankByPhone(phone, declarations);
  const results = ranked.candidates.map(c => ({
    row:      c.sheet_row_id,
    client:   c.client_name,
    document: c.document_type,
    status:   c.status,
  }));

  // "Last Declaration row" = the candidate with the greatest numeric row id.
  let last = null;
  for (const r of results) {
    const n = parseInt(r.row, 10);
    if (!Number.isNaN(n) && (last === null || n > last._n)) last = { ...r, _n: n };
  }
  if (last) delete last._n;

  return {
    phone,
    phone_key: matchKey(phone),
    match_status: ranked.match_status,   // matched | needs_review | unmatched
    match_count: results.length,
    results,
    last_declaration_row: last,
  };
}

// DB-backed read-only wrapper: reads the Declaration replica and returns the
// lookup result. No writes, no status changes, no messages.
async function lookupOrdersByPhone(phone, deps = {}) {
  const { Declaration } = deps.Declaration ? deps : require('../models/Declaration');
  const key = matchKey(phone);
  if (!key) return lookupByPhone(phone, []);

  let decls = await Declaration.find({ phone_key: key }).lean();
  if (!decls.length) {
    // Replica may not have phone_key populated yet — scan + filter by canonical key.
    decls = (await Declaration.find({}).lean()).filter(d => matchKey(d.phone) === key);
  }
  return lookupByPhone(phone, decls);
}

module.exports = { rankByPhone, matchMessage, lookupByPhone, lookupOrdersByPhone };
