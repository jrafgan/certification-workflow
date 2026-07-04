'use strict';

// services/whatsappCloudService.js — official Meta WhatsApp Cloud API (Graph API).
//
// The sanctioned way to send/receive on WhatsApp (no ban risk vs whatsapp-web.js). Outbound:
// POST to graph.facebook.com. Inbound: Meta calls our webhook. This module is the transport;
// it stays recommend-only at the product level (operator clicks to send; the agent never
// auto-sends). All credentials are env-provided (operator sets them on the Meta side).
//
// Env: WHATSAPP_CLOUD_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN,
//      WHATSAPP_APP_SECRET, GRAPH_API_VERSION (default v21.0).
// The HTTP call is injectable (deps.fetch) for tests — no real Graph call in tests.

const crypto = require('crypto');

function graphVersion() { return process.env.GRAPH_API_VERSION || 'v21.0'; }
function token() { return process.env.WHATSAPP_CLOUD_TOKEN || null; }
function phoneNumberId() { return process.env.WHATSAPP_PHONE_NUMBER_ID || null; }
function isConfigured() { return !!(token() && phoneNumberId()); }

// ─── Outbound: send a text message ──────────────────────────────────────────────
async function sendText(to, body, deps = {}) {
  if (!isConfigured()) return { ok: false, reason: 'not_configured', hint: 'Задайте WHATSAPP_CLOUD_TOKEN и WHATSAPP_PHONE_NUMBER_ID.' };
  if (!to || !body) return { ok: false, reason: 'missing_to_or_body' };

  const url = `https://graph.facebook.com/${graphVersion()}/${phoneNumberId()}/messages`;
  const doFetch = deps.fetch || globalThis.fetch;
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: String(to).replace(/[^\d]/g, ''), type: 'text', text: { body: String(body) } }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: 'api_error', status: res.status, detail: json };
    return { ok: true, message_id: json.messages && json.messages[0] && json.messages[0].id, to };
  } catch (err) {
    return { ok: false, reason: 'request_failed', detail: err.message };
  }
}

// ─── Outbound: send a pre-approved message TEMPLATE ─────────────────────────────
// Business-initiated messages to a recipient OUTSIDE the 24h customer-service window
// (e.g. a number that never wrote us — see firstContactService) MUST use a Meta-approved
// template; free text is rejected. `components` is optional (for templates with variables).
async function sendTemplate(to, name, lang = 'ru', components = null, deps = {}) {
  if (!isConfigured()) return { ok: false, reason: 'not_configured', hint: 'Задайте WHATSAPP_CLOUD_TOKEN и WHATSAPP_PHONE_NUMBER_ID.' };
  if (!to || !name) return { ok: false, reason: 'missing_to_or_template' };

  const url = `https://graph.facebook.com/${graphVersion()}/${phoneNumberId()}/messages`;
  const doFetch = deps.fetch || globalThis.fetch;
  const template = { name: String(name), language: { code: String(lang || 'ru') } };
  if (Array.isArray(components) && components.length) template.components = components;
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: String(to).replace(/[^\d]/g, ''), type: 'template', template }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: 'api_error', status: res.status, detail: json };
    return { ok: true, message_id: json.messages && json.messages[0] && json.messages[0].id, to };
  } catch (err) {
    return { ok: false, reason: 'request_failed', detail: err.message };
  }
}

// ─── Inbound: webhook verification (GET) ────────────────────────────────────────
// Meta calls GET ?hub.mode=subscribe&hub.verify_token=...&hub.challenge=... — echo the
// challenge when the verify token matches.
function verifyWebhook(query = {}) {
  const mode = query['hub.mode'];
  const tok = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  const expected = process.env.WHATSAPP_VERIFY_TOKEN;
  if (mode === 'subscribe' && expected && tok === expected) return { ok: true, challenge };
  return { ok: false };
}

// ─── Inbound: payload signature (POST X-Hub-Signature-256) ──────────────────────
// HMAC-SHA256 of the RAW body with the app secret. Returns ok:null when no secret is
// configured (skip verification in dev), ok:true/false otherwise.
function verifySignature(rawBody, signatureHeader) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return { ok: null, reason: 'no_app_secret' };
  if (!signatureHeader) return { ok: false, reason: 'no_signature' };
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return { ok };
}

// ─── Inbound: parse incoming messages from the webhook payload ──────────────────
// → [{ id, from, type, text, name, timestamp, media_id }]. Audio/voice carry a media_id
// to fetch + transcribe (see audioTranscriptionService).
function parseIncoming(payload = {}) {
  const out = [];
  for (const entry of payload.entry || []) {
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      const name = v.contacts && v.contacts[0] && v.contacts[0].profile && v.contacts[0].profile.name;
      for (const m of v.messages || []) {
        const media = m.audio || m.voice || m.image || m.document || m.video || null;
        out.push({
          id: m.id, from: m.from, type: m.type, timestamp: m.timestamp,
          text: m.type === 'text' ? (m.text && m.text.body) : (m.caption || null),
          name: name || null,
          media_id: media && media.id ? media.id : null,
          is_voice: m.type === 'audio' || m.type === 'voice',
        });
      }
    }
  }
  return out;
}

// ─── Inbound: map a parsed Cloud message → the provider-agnostic ingest shape ────
// whatsappIngestService.ingestIncoming expects { id, from, body, timestamp(seconds),
// provider, attachments:[{media_ref,mime_type}] }. PURE (no DB) — unit-testable.
const TYPE_MIME = { image: 'image/*', audio: 'audio/ogg', voice: 'audio/ogg', video: 'video/mp4', document: 'application/octet-stream' };
function toIngestRaw(parsed = {}) {
  const attachments = parsed.media_id
    ? [{ media_ref: parsed.media_id, mime_type: TYPE_MIME[parsed.type] || null }]
    : [];
  const ts = parsed.timestamp != null ? Number(parsed.timestamp) : undefined;
  return {
    id:          parsed.id,
    from:        parsed.from,
    body:        parsed.text || '',
    timestamp:   Number.isFinite(ts) ? ts : undefined,
    provider:    'cloud_api',
    attachments,
  };
}

module.exports = { isConfigured, graphVersion, sendText, sendTemplate, verifyWebhook, verifySignature, parseIncoming, toIngestRaw };
