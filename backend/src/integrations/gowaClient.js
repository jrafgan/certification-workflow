'use strict';

// integrations/gowaClient.js — transport for GOWA (go-whatsapp-web-multidevice, whatsmeow).
//
// ⚠️ UNOFFICIAL channel (ban risk) — replaces the hand-rolled Chromium bridge. GOWA runs as its
// own container (socket-based, no browser) exposing a REST API; our backend SENDS via its REST
// and RECEIVES via its webhook (routes/gowa.js). All outbound still passes the anti-ban safety
// gate (services/whatsappWebSafety.js) and stays operator-gated.
//
// Env: GOWA_URL (e.g. http://gowa:3000), GOWA_BASIC_AUTH ("user:pass"), GOWA_WEBHOOK_SECRET.
// HTTP is injectable (deps.fetch) for tests.

const crypto = require('crypto');

function baseUrl() { return process.env.GOWA_URL || null; }
function isConfigured() { return !!baseUrl(); }
function authHeader() {
  const a = process.env.GOWA_BASIC_AUTH;
  return a ? 'Basic ' + Buffer.from(a).toString('base64') : null;
}

// ─── Outbound: send a text message via GOWA REST (POST /send/message) ────────────
async function sendText(to, body, deps = {}) {
  if (!isConfigured()) return { ok: false, reason: 'not_configured', hint: 'Задайте GOWA_URL.' };
  if (!to || !body) return { ok: false, reason: 'missing_to_or_body' };
  const phone = String(to).replace(/[^\d]/g, '');           // GOWA expects digits, no '+'
  const doFetch = deps.fetch || globalThis.fetch;
  const headers = { 'Content-Type': 'application/json' };
  const auth = authHeader();
  if (auth) headers.Authorization = auth;
  // Multi-account GOWA routes device-scoped REST calls by this header.
  const device = process.env.GOWA_DEVICE_ID;
  if (device) headers['X-Device-Id'] = device;
  try {
    const res = await doFetch(`${baseUrl()}/send/message`, {
      method: 'POST', headers, body: JSON.stringify({ phone, message: String(body) }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: 'gowa_error', status: res.status, detail: json };
    // GOWA returns { code, message, results:{ message_id, status } } on success.
    const mid = json.results && (json.results.message_id || json.results.id);
    return { ok: true, message_id: mid, to: phone, detail: json };
  } catch (err) {
    return { ok: false, reason: 'request_failed', detail: err.message };
  }
}

// ─── Inbound: verify the webhook HMAC (X-Hub-Signature-256: sha256=<hmac of raw body>) ──
function verifySignature(rawBody, signatureHeader) {
  const secret = process.env.GOWA_WEBHOOK_SECRET;
  if (!secret) return { ok: null, reason: 'no_webhook_secret' };
  if (!signatureHeader) return { ok: false, reason: 'no_signature' };
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  return { ok: a.length === b.length && crypto.timingSafeEqual(a, b) };
}

// bareDigits — strip a JID ("996777240858@s.whatsapp.net") down to its digits.
function bareDigits(jid) { return String(jid == null ? '' : jid).split('@')[0].replace(/\D/g, ''); }

// extractMentions — the JIDs @-mentioned in a group message, defensively parsed across the
// possible GOWA/whatsmeow shapes (top-level or nested under context). → array of digit strings.
function extractMentions(p = {}) {
  const ctx = p.context || {};
  const cand = p.mentioned_jid || p.mentioned_jids || p.mentions || ctx.mentioned_jid || ctx.mentioned_jids || ctx.mentions || [];
  const arr = Array.isArray(cand) ? cand : (cand ? [cand] : []);
  return arr.map(bareDigits).filter(Boolean);
}

// extractQuotedAuthor — when this message REPLIES to another, the JID of the quoted message's
// author (whatsmeow ContextInfo.Participant). → digit string or null.
function extractQuotedAuthor(p = {}) {
  const ctx = p.context || {};
  const q = p.quoted_message || p.quoted || ctx.quoted_message || ctx.quoted || null;
  const author = ctx.participant || p.quoted_author || (q && (q.participant || q.from || q.author || q.sender)) || null;
  return author ? bareDigits(author) : null;
}

// ─── Inbound: map a GOWA "message" webhook → the whatsappIngestService raw shape ─────
// GOWA payload: { event, payload:{ id, chat_id, from(JID), from_name, timestamp(RFC3339),
// is_from_me, body, image?/video?/audio?/document?, context?/mentioned_jid?/quoted? } }.
// For a GROUP, chat_id is the group JID ("…@g.us") and `from` is the participant (the actual
// sender). PURE — unit-testable. Returns null for non-message events or our own outgoing.
const MEDIA_KEYS = ['image', 'video', 'audio', 'document', 'sticker'];
function toIngestRaw(event = {}) {
  if (event.event !== 'message' || !event.payload) return null;
  const p = event.payload;
  const fromMe = !!p.is_from_me;   // our own sent message — archived as outbound, not dropped
  const attachments = [];
  for (const k of MEDIA_KEYS) {
    if (p[k]) {
      const m = p[k];
      attachments.push({ file_name: m.file_name || m.filename || null, mime_type: m.mime_type || m.mimetype || null, media_ref: m.url || m.file_path || m.path || null });
    }
  }
  const tsMs = p.timestamp ? Date.parse(p.timestamp) : NaN;
  const chatId = p.chat_id || p.chatId || null;
  const isGroup = typeof p.is_group === 'boolean' ? p.is_group : /@g\.us$/.test(String(chatId || ''));
  return {
    provider:      'gowa',
    id:            p.id,
    from_me:       fromMe,                                   // true → our own outgoing (archive as outbound)
    from:          p.from,                                   // JID "<digits>@s.whatsapp.net" (participant in a group)
    from_name:     p.from_name || p.push_name || p.pushName || null,
    body:          p.body || '',
    timestamp:     Number.isFinite(tsMs) ? Math.floor(tsMs / 1000) : undefined,
    attachments,
    // group / addressing context (kept so the inbox can filter "addressed to me")
    chat_id:       chatId,
    is_group:      isGroup,
    group_subject: isGroup ? (p.chat_name || p.group_subject || p.group_name || null) : null,
    mentioned_jids: extractMentions(p),
    quoted_author:  extractQuotedAuthor(p),
  };
}

module.exports = { isConfigured, sendText, verifySignature, toIngestRaw, bareDigits, extractMentions, extractQuotedAuthor };
