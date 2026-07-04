'use strict';

// services/operatorStatsService.js — per-operator work counter.
//
// Counting unit (operator's choice): a SENT REPLY to a client. When an operator sends a
// WhatsApp reply from the panel (routes/whatsappSend.js), we record an outbound
// WhatsAppMessage attributed to that operator (handled_by) and classify the inbound
// question it answered (leadIntentService → question_intent + question_category). This
// service both RECORDS those outbound replies and AGGREGATES them into the counter
// ("какой сотрудник какие вопросы и сколько").
//
// READ-ONLY toward the world: recording the metric never sends and never touches the
// Declaration/Gmail — the reply itself was already sent by the route. The aggregate
// function is PURE (no I/O) and exported for testing.

const { matchKey } = require('../utils/phoneUtils');

// ─── Record: store an attributed outbound reply (best-effort metric) ──────────
// recordOutboundReply({ to, body, handledBy }, deps) — find the last INBOUND message from
// the same client, classify it, and persist an outbound WhatsAppMessage carrying the
// operator attribution + question classification. Returns the created doc (or null on
// no-op). MUST NOT throw past the caller's try/catch — a metric write must never break the
// already-completed send. deps: { WhatsAppMessage?, classifier? }.
async function recordOutboundReply({ to, body, handledBy } = {}, deps = {}) {
  const { WhatsAppMessage } = deps.WhatsAppMessage ? deps : require('../models/WhatsAppMessage');
  const classifier = deps.classifier || require('./leadIntentService');

  const key = matchKey(to);
  // The question being answered = the most recent inbound message from this client.
  let lastInbound = null;
  if (key) {
    lastInbound = await WhatsAppMessage
      .findOne({ direction: 'inbound', phone_key: key })
      .sort({ received_at: -1, created_at: -1 })
      .lean();
  }
  const cls = classifier.classify((lastInbound && lastInbound.body) || '');

  return WhatsAppMessage.create({
    provider:          'cloud_api',
    direction:         'outbound',
    to_phone:          String(to || ''),
    phone_key:         key || undefined,
    body:              String(body || ''),
    handled_by:        handledBy || undefined,
    handled_at:        new Date(),
    question_intent:   cls.intent,
    question_category: cls.service_category,
    sent_at:           new Date(),
  });
}

// ─── Pure: aggregate outbound reply records → per-operator counters ───────────
// aggregate(messages, { users }) → { operators: [...], totals: {...} }. `messages` are
// outbound records (each may carry handled_by, question_intent, question_category).
// `users` (optional) maps operator id → display name. Pure — exported for testing.
function aggregate(messages = [], { users = {} } = {}) {
  const byOp = new Map();
  const totals = { total: 0, by_intent: {}, by_category: {} };
  const bump = (obj, k) => { const key = k || 'unknown'; obj[key] = (obj[key] || 0) + 1; };

  for (const m of messages) {
    const opId = m.handled_by ? String(m.handled_by) : 'unassigned';
    if (!byOp.has(opId)) byOp.set(opId, { operator_id: opId, total: 0, by_intent: {}, by_category: {} });
    const op = byOp.get(opId);
    op.total += 1;
    bump(op.by_intent, m.question_intent);
    bump(op.by_category, m.question_category);
    totals.total += 1;
    bump(totals.by_intent, m.question_intent);
    bump(totals.by_category, m.question_category);
  }

  const operators = [...byOp.values()]
    .map(op => ({ ...op, display_name: users[op.operator_id] || (op.operator_id === 'unassigned' ? 'Не закреплено' : op.operator_id) }))
    .sort((a, b) => b.total - a.total);

  return { operators, totals };
}

// ─── DB-backed: compute the counter over a date range ─────────────────────────
// compute({ from, to }, deps) → aggregate of outbound replies in [from, to). Joins the
// users collection for display names. deps: { WhatsAppMessage?, User? }.
async function compute({ from, to } = {}, deps = {}) {
  const { WhatsAppMessage } = deps.WhatsAppMessage ? deps : require('../models/WhatsAppMessage');
  const User = deps.User || require('../models/User').User;

  const q = { direction: 'outbound' };
  if (from || to) {
    q.handled_at = {};
    if (from) q.handled_at.$gte = new Date(from);
    if (to)   q.handled_at.$lt  = new Date(to);
  }
  const messages = await WhatsAppMessage.find(q).select('handled_by question_intent question_category').lean();

  const userDocs = await User.find({}).select('display_name username').lean();
  const users = {};
  for (const u of userDocs) users[String(u._id)] = u.display_name || u.username;

  return aggregate(messages, { users });
}

module.exports = { recordOutboundReply, aggregate, compute };
