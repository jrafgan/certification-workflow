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

// mapIncomingMessage(raw, identity?) — raw is a provider-agnostic shape:
//   { id, from, body, timestamp(seconds), fromMe, attachments: [{file_name,mime_type,size,media_ref}] }
// `identity` is the resolved contact identity from whatsappLidService (from_phone,
// phone_key, lid, lid_key, resolution, resolved_at). When omitted, it is derived
// purely from raw.from (so a LID sender is NOT mistaken for a phone). Returns a plain
// object matching the WhatsAppMessage schema (direction inbound).
function mapIncomingMessage(raw = {}, identity = null) {
  const id = identity || lidService.deriveIdentity(raw);
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
  const doc = mapIncomingMessage(raw, identity);

  // Idempotency — same provider message id must not double-insert.
  if (doc.provider_message_id) {
    const existing = await WhatsAppMessage.findOne({ provider_message_id: doc.provider_message_id }).lean();
    if (existing) return { skipped: 'duplicate', messageId: existing._id };
  }

  const message = await WhatsAppMessage.create(doc);

  // Match by phone (read-only toward Declaration; writes only the message record).
  let match = null;
  try {
    match = await matchService.matchMessage(message._id, deps);
  } catch (err) {
    // Matching failure must not lose the ingested message.
    match = { error: err.message };
  }

  return { message, match };
}

module.exports = { mapIncomingMessage, phoneFromJid, ingestIncoming };
