'use strict';

// services/whatsappIngestService.js — turn a raw incoming WhatsApp message into a
// stored WhatsAppMessage replica record, then run phone→order matching.
//
// READ-ONLY toward the world: this never sends, never writes the Declaration
// sheet, never touches Gmail. It only writes the working replica collection
// (whatsapp_messages) and logs the event.
//
// `mapIncomingMessage` is a PURE function (no DB, no whatsapp-web.js) so the
// normalization is unit-testable in isolation.

const { digitsOnly, matchKey } = require('../utils/phoneUtils');
const lidService = require('./whatsappLidService');

// Extract the bare number from a whatsapp-web.js JID like "996777240858@c.us".
function phoneFromJid(jid) {
  return digitsOnly(String(jid || '').split('@')[0]);
}

// operatorMeKeys — the match keys that count as "the operator" for group addressing.
// OPERATOR_WHATSAPP_NUMBERS is a CSV (default 507391773, the operator's own number).
function operatorMeKeys() {
  return String(process.env.OPERATOR_WHATSAPP_NUMBERS || '507391773')
    .split(',').map(s => matchKey(s)).filter(Boolean);
}

// computeAddressing — PURE. Did this inbound message reach the operator, and why?
//   direct (1:1)  → always { addressed_me:true, reason:'direct' }
//   group (@g.us) → true only when the operator was @mentioned, was replied-to, or the text
//                   shows certification interest (opts.detect, injected). Otherwise ignored.
// raw carries is_group, mentioned_jids[], quoted_author, body. opts.meKeys / opts.detect are
// injectable for tests.
function computeAddressing(raw = {}, opts = {}) {
  if (!raw.is_group) return { addressed_me: true, addressed_reason: 'direct' };
  const meSet = new Set(opts.meKeys || operatorMeKeys());
  if ((raw.mentioned_jids || []).some(j => meSet.has(matchKey(j))))
    return { addressed_me: true, addressed_reason: 'mention' };
  if (raw.quoted_author && meSet.has(matchKey(raw.quoted_author)))
    return { addressed_me: true, addressed_reason: 'reply' };
  const detect = opts.detect || null;
  if (detect && raw.body) { const d = detect(raw.body); if (d && d.interested) return { addressed_me: true, addressed_reason: 'keyword' }; }
  return { addressed_me: false, addressed_reason: null };
}

// mapIncomingMessage(raw, identity?) — raw is a provider-agnostic shape:
//   { id, from, body, timestamp(seconds), fromMe, attachments: [{file_name,mime_type,size,media_ref}] }
// `identity` is the resolved contact identity from whatsappLidService (from_phone,
// phone_key, lid, lid_key, resolution, resolved_at). When omitted, it is derived
// purely from raw.from (so a LID sender is NOT mistaken for a phone). Returns a plain
// object matching the WhatsAppMessage schema (direction inbound).
function mapIncomingMessage(raw = {}, identity = null, addressing = null) {
  const id = identity || lidService.deriveIdentity(raw);
  const addr = addressing || computeAddressing(raw);
  const attachments = Array.isArray(raw.attachments) ? raw.attachments.map(a => ({
    file_name: a.file_name || a.filename || null,
    mime_type: a.mime_type || a.mimetype || null,
    size:      typeof a.size === 'number' ? a.size : undefined,
    media_ref: a.media_ref || null,
  })) : [];

  return {
    provider:            raw.provider || 'whatsapp_web',
    provider_message_id: raw.id || undefined,
    conversation_ref:    raw.from || undefined,
    direction:           'inbound',
    from_phone:          id.from_phone,
    phone_key:           id.phone_key,
    lid:                 id.lid || undefined,
    lid_key:             id.lid_key || undefined,
    phone_resolution:    id.resolution || null,
    phone_resolved_at:   id.resolved_at || undefined,
    body:                raw.body || '',
    attachments,
    sent_at:             raw.timestamp ? new Date(raw.timestamp * 1000) : undefined,
    received_at:         new Date(),
    match_status:        'received',
    // group / addressing context (populated by the GOWA transport; direct chats ⇒ is_group:false)
    chat_id:             raw.chat_id || undefined,
    is_group:            !!raw.is_group,
    group_subject:       raw.group_subject || undefined,
    addressed_me:        addr.addressed_me,
    addressed_reason:    addr.addressed_reason,
  };
}

// ingestIncoming(raw, deps) — resolve LID→phone, store (idempotent on
// provider_message_id) then match. Returns { message, match } or { skipped:'duplicate' }.
async function ingestIncoming(raw, deps = {}) {
  const { WhatsAppMessage } = deps.WhatsAppMessage ? deps : require('../models/WhatsAppMessage');
  const matchService = deps.matchService || require('./whatsappMatchService');

  // Resolve contact identity first (phone → resolved LID → stored LID → LID-only).
  // Never throws past here — a LID-only identity still produces a stored message.
  const identity = await lidService.resolveIdentity(raw, deps);
  // Addressing: for a group message, decide whether it reached the operator (§3 of
  // operator-task-inbox). detect is injectable; falls back to the interest detector.
  const detect = deps.detect || (raw.is_group ? require('./interestDetectionService').detect : null);
  const addressing = computeAddressing(raw, { detect });
  // ARCHIVE EVERYTHING: every message is stored so old conversations can be searched later.
  // Operator-facing views (task inbox / attention) filter to direct + addressed-group so group
  // chatter never floods the operator — the archive keeps it for analysis regardless.
  const doc = mapIncomingMessage(raw, identity, addressing);

  // Idempotency — same provider message id must not double-insert.
  if (doc.provider_message_id) {
    const existing = await WhatsAppMessage.findOne({ provider_message_id: doc.provider_message_id }).lean();
    if (existing) return { skipped: 'duplicate', messageId: existing._id };
  }

  const message = await WhatsAppMessage.create(doc);

  // Matching runs only for direct chats or group messages addressed to the operator (skip the
  // firehose of unaddressed group chatter — it's archived, not routed to an order).
  let match = null;
  if (!raw.is_group || addressing.addressed_me) {
    try {
      match = await matchService.matchMessage(message._id, deps);
    } catch (err) {
      match = { error: err.message }; // matching failure must not lose the ingested message
    }
  }

  return { message, match };
}

// archiveOutbound(raw, deps) — store OUR OWN sent message (is_from_me) for full-conversation
// history. No matching, no interest detection. Idempotent on provider_message_id.
async function archiveOutbound(raw = {}, deps = {}) {
  const { WhatsAppMessage } = deps.WhatsAppMessage ? deps : require('../models/WhatsAppMessage');
  // recipient = the chat (direct: client jid; group: group jid); the client key we thread by.
  const recipient = phoneFromJid(raw.chat_id || raw.to || '');
  const attachments = Array.isArray(raw.attachments) ? raw.attachments.map(a => ({
    file_name: a.file_name || a.filename || null, mime_type: a.mime_type || a.mimetype || null,
    size: typeof a.size === 'number' ? a.size : undefined, media_ref: a.media_ref || null,
  })) : [];
  const doc = {
    provider: raw.provider || 'gowa', provider_message_id: raw.id || undefined,
    conversation_ref: raw.chat_id || raw.from || undefined,
    direction: 'outbound',
    from_phone: phoneFromJid(raw.from || ''),          // us (507)
    to_phone: recipient,
    phone_key: raw.is_group ? undefined : matchKey(recipient),
    body: raw.body || '',
    attachments,
    sent_at: raw.timestamp ? new Date(raw.timestamp * 1000) : undefined,
    received_at: new Date(),
    match_status: 'received',
    chat_id: raw.chat_id || undefined,
    is_group: !!raw.is_group,
    group_subject: raw.group_subject || undefined,
    addressed_me: false, addressed_reason: null,
  };
  if (doc.provider_message_id) {
    const existing = await WhatsAppMessage.findOne({ provider_message_id: doc.provider_message_id }).lean();
    if (existing) return { skipped: 'duplicate', messageId: existing._id };
  }
  const message = await WhatsAppMessage.create(doc);
  return { message };
}

module.exports = { mapIncomingMessage, phoneFromJid, ingestIncoming, archiveOutbound, computeAddressing, operatorMeKeys };
