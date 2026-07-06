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

// «Декларация» columns (source of truth is the SHEET; the Mongo Declaration replica is empty,
// so matching must read the live sheet — see memory whatsapp-match-empty-replica-bug).
const DECL_CLIENT_COL = 3;   // D — Клиент
const DECL_PHONE_COL  = 9;   // J — Номер тел
const DECL_STATUS_COL = 13;  // N — Статус
const DECL_TTL_MS = 60_000;  // cache the sheet read to avoid one Google call per inbound webhook
let _declCache = { at: 0, rows: null };

// mapDeclRows — raw sheet rows → matcher candidate shape. The sheet row IS the order
// (sheet_row_id); there is no Mongo Order to point at, so order_id stays null.
function mapDeclRows(raw = []) {
  return (raw || []).map((r, i) => ({
    order_id: null,
    declaration_id: null,
    sheet_row_id: String(i + 2),                       // data rows start at sheet row 2
    client_name: String(r[DECL_CLIENT_COL] || '').trim() || null,
    document_type: null,
    status: String(r[DECL_STATUS_COL] || '').trim() || null,
    phone: r[DECL_PHONE_COL] != null ? String(r[DECL_PHONE_COL]) : '',
  }));
}

// liveDeclarations — cached read of the LIVE «Декларация» sheet. Injectable via
// deps.readDeclaration (tests / callers bypass the cache).
async function liveDeclarations(deps = {}) {
  if (deps.readDeclaration) return mapDeclRows(await deps.readDeclaration());
  if (_declCache.rows && Date.now() - _declCache.at < DECL_TTL_MS) return _declCache.rows;
  const rows = mapDeclRows(await require('./workQueueService').defaultReadDeclaration());
  _declCache = { at: Date.now(), rows };
  return rows;
}

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
  // Multiple orders share this phone — cannot pick one from phone alone (order-identity: confirm on
  // ambiguity, NEVER auto-assign). We only ADD advisory hints so the operator chooses faster: which
  // orders are still active (status ≠ завершен/отказ) and which is the newest sheet row (the newest
  // row is a recency SIGNAL, not a guarantee — labs work out of order). The most likely current order
  // (newest still-active) is sorted first and flagged `likely_current`. match_status stays needs_review.
  const { stageFor } = require('./clientEntityService');
  const rowNum = (c) => { const n = parseInt(c.sheet_row_id, 10); return Number.isNaN(n) ? -1 : n; };
  const newestRow = candidates.reduce((mx, c) => Math.max(mx, rowNum(c)), -1);
  for (const c of candidates) {
    const stage = stageFor(c.status);
    c.stage     = stage;
    c.is_active = stage !== 'done' && stage !== 'refusal';
    c.is_newest = rowNum(c) === newestRow && newestRow >= 0;
  }
  // Display order: active first, then newest row first. Advisory only — does not change the outcome.
  candidates.sort((a, b) => (Number(b.is_active) - Number(a.is_active)) || (rowNum(b) - rowNum(a)));
  const current = candidates.find(c => c.is_active) || candidates[0];   // newest active, else newest
  for (const c of candidates) c.likely_current = c === current;
  return {
    match_status: 'needs_review',
    match_confidence: 'MEDIUM',
    candidates,
    reason: `phone_maps_to_${candidates.length}_orders`,
  };
}

// orderIdsByRows — resolve Mongo Order._id for a set of «Декларация» sheet rows. Orders are
// materialized by declarationOrderService.sync() keyed by Order.sheet_row_id (see memory
// email-tasks-empty-orders), so a matched sheet row can now point at a real Order — that is what
// makes the panel's «Открыть заказ» work. Best-effort: an empty map if the model/DB is unavailable
// (matching still succeeds on the sheet row; only the deep-link is missing).
async function orderIdsByRows(rows, deps = {}) {
  const uniq = [...new Set((rows || []).map(r => (r != null ? String(r) : '')).filter(Boolean))];
  if (!uniq.length) return new Map();
  try {
    const { Order } = ('Order' in deps) ? deps : require('../models');
    if (!Order) return new Map();
    const docs = await Order.find({ sheet_row_id: { $in: uniq } }).select('_id sheet_row_id').lean();
    return new Map(docs.map(o => [String(o.sheet_row_id), o._id]));
  } catch (_) { return new Map(); }
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

  // Candidate source = the LIVE «Декларация» sheet (source of truth). Fall back to the Mongo
  // replica only if the sheet is unreachable (the replica is normally empty).
  let decls;
  try {
    decls = await liveDeclarations(deps);
  } catch (_) {
    const key = msg.phone_key || matchKey(msg.from_phone);
    decls = key ? (await Declaration.find({}).lean()) : [];
  }

  const result = rankByPhone(msg.from_phone || msg.phone_key, decls);
  // Deep-link: fill each candidate's order_id from the materialized Mongo Order (by sheet row).
  if (result.candidates.length) {
    const byRow = await orderIdsByRows(result.candidates.map(c => c.sheet_row_id), deps);
    for (const c of result.candidates) if (!c.order_id && byRow.has(String(c.sheet_row_id))) c.order_id = byRow.get(String(c.sheet_row_id));
  }
  msg.match_status      = result.match_status;
  msg.match_confidence  = result.match_confidence;
  msg.candidates        = result.candidates;
  // The matched entity is the sheet row (matched_sheet_row); matched_order_id is the Mongo Order
  // when it has been materialized (else null — the task inbox still shows the order from the sheet).
  msg.matched_order_id  = result.match_status === 'matched' ? (result.candidates[0].order_id || null) : null;
  msg.matched_sheet_row = result.match_status === 'matched' ? (result.candidates[0].sheet_row_id || null) : null;
  await msg.save();

  return { message: msg, ...result };
}

// rematchAll — re-run matching on stored inbound messages (e.g. after the source was fixed).
// Read-only toward the world; only updates the whatsapp_messages working records.
async function rematchAll(deps = {}) {
  const { WhatsAppMessage } = deps.WhatsAppMessage ? deps : require('../models/WhatsAppMessage');
  const ids = await WhatsAppMessage.find({ direction: 'inbound' }).select('_id').lean();
  const out = { total: ids.length, matched: 0, needs_review: 0, unmatched: 0 };
  for (const { _id } of ids) {
    const r = await matchMessage(_id, deps);
    out[r.match_status] = (out[r.match_status] || 0) + 1;
  }
  return out;
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
    order_id: c.order_id || null,          // Mongo Order._id when materialized (filled by the DB wrapper)
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
  const key = matchKey(phone);
  if (!key) return lookupByPhone(phone, []);
  // LIVE sheet is the source of truth; fall back to the Mongo replica if unreachable.
  let decls;
  try {
    decls = await liveDeclarations(deps);
  } catch (_) {
    const { Declaration } = deps.Declaration ? deps : require('../models/Declaration');
    decls = await Declaration.find({}).lean();
  }
  const base = lookupByPhone(phone, decls);
  // Deep-link each matched row to its materialized Mongo Order so «Открыть заказ» works.
  if (base.results.length) {
    const byRow = await orderIdsByRows(base.results.map(r => r.row), deps);
    for (const r of base.results) if (!r.order_id && byRow.has(String(r.row))) r.order_id = byRow.get(String(r.row));
    if (base.last_declaration_row && byRow.has(String(base.last_declaration_row.row)))
      base.last_declaration_row.order_id = byRow.get(String(base.last_declaration_row.row));
  }
  return base;
}

module.exports = { rankByPhone, matchMessage, rematchAll, lookupByPhone, lookupOrdersByPhone, liveDeclarations, mapDeclRows };
