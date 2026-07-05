'use strict';

// integrations/whatsappWebClient.js — UNOFFICIAL WhatsApp Web client (whatsapp-web.js).
//
// ⚠️ This is an UNOFFICIAL channel (QR login, drives WhatsApp Web via a headless browser).
// It violates WhatsApp ToS and carries a BAN RISK for the logged-in number. It exists as a
// TEMPORARY bridge to run the agent on a real number before the official Meta Cloud API
// number (508391773) is verified. The sanctioned channel stays routes/whatsappCloud.js.
//
// Scope here: QR login + session persistence, RECEIVE messages/attachments → ingest, and a
// minimal SEND (operator-initiated from the panel; the agent still never auto-sends).
//
// ─── READ-RECEIPT / UNREAD SAFETY (critical, enforced by whatsapp-readstate-guard) ─────────
// The operator must keep seeing unread chats. This client NEVER marks anything read and NEVER
// touches unread counters: no chat.sendSeen() / msg.markUnread() / markChatUnread(), it never
// opens a chat, and connects with markOnlineOnConnect:false (no presence side effects).
//
// whatsapp-web.js + qrcode-terminal are required LAZILY inside startClient so the rest of the
// backend (and unit tests) never load Puppeteer/Chromium.

const fs   = require('fs');
const path = require('path');

const SESSION_PATH = process.env.WHATSAPP_SESSION_PATH || path.join(__dirname, '..', '..', '.wwebjs_auth');
const MEDIA_DIR    = process.env.WHATSAPP_MEDIA_DIR    || path.join(__dirname, '..', '..', 'whatsapp_media');

function log(event, data) {
  console.log(`[whatsapp-web] ${JSON.stringify({ ts: new Date().toISOString(), event, ...data })}`);
}

// Normalize a phone (any stored form) → a WhatsApp chat JID "<digits>@c.us".
function toJid(to) {
  const digits = String(to || '').replace(/\D/g, '');
  return digits ? `${digits}@c.us` : null;
}

// Resolve a provider-agnostic contact descriptor (getContact is a page-context network call).
async function resolveContact(msg) {
  try {
    const c = await msg.getContact();
    return { name: c?.name || null, pushname: c?.pushname || null, shortName: c?.shortName || null, number: c?.number || (msg.from || '').split('@')[0] || null };
  } catch (_) {
    return { name: null, pushname: null, shortName: null, number: (msg.from || '').split('@')[0] || null };
  }
}

// startClient({ onIncoming, onReady }) — boots the client, wires events, returns it.
// onIncoming(raw) is called for every received (non-self) message; raw matches the
// whatsappIngestService shape: { id, from, contact, body, timestamp(sec), fromMe, attachments }.
async function startClient({ onIncoming, onReady, onQr } = {}) {
  const { Client, LocalAuth } = require('whatsapp-web.js'); // lazy — keeps Puppeteer out of app/tests
  const qrcode = require('qrcode-terminal');

  if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_PATH }),  // persist session — scan QR once
    markOnlineOnConnect: false,                               // SAFETY: no presence broadcast
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    },
  });

  client.on('qr', (qr) => { log('qr', { hint: 'Отсканируйте QR номером 507391773 (WhatsApp → Связанные устройства)' }); qrcode.generate(qr, { small: true }); if (typeof onQr === 'function') { try { onQr(qr); } catch (_) {} } });
  client.on('authenticated', () => log('authenticated', {}));
  client.on('auth_failure', (m) => log('auth_failure', { message: String(m) }));
  client.on('ready', () => { log('ready', { session: SESSION_PATH }); if (typeof onReady === 'function') onReady(client); });
  client.on('disconnected', (r) => log('disconnected', { reason: String(r) }));

  client.on('message', async (msg) => {
    try {
      if (msg.fromMe) return;                                 // ignore our own outgoing
      // SAFETY: never call msg.markUnread()/chat.sendSeen() — the message stays unread.
      const contact = await resolveContact(msg);

      const attachments = [];
      if (msg.hasMedia) {
        try {
          const media = await msg.downloadMedia();            // { mimetype, data(base64), filename }
          if (media && media.data) {
            const buf = Buffer.from(media.data, 'base64');
            const ext = (media.mimetype && media.mimetype.split('/')[1]) || 'bin';
            const safe = path.basename(media.filename || `${msg.id.id}.${ext}`);
            const dest = path.join(MEDIA_DIR, `${Date.now()}_${safe}`);
            fs.writeFileSync(dest, buf);                      // store locally; never forwarded
            attachments.push({ file_name: safe, mime_type: media.mimetype, size: buf.length, media_ref: dest });
          }
        } catch (mErr) { log('attachment_error', { id: msg.id && msg.id._serialized, error: mErr.message }); }
      }

      const raw = {
        provider:  'whatsapp_web',
        id:        msg.id && msg.id._serialized,
        from:      msg.from,
        contact,
        body:      msg.body || '',
        timestamp: msg.timestamp,                             // seconds
        fromMe:    false,
        attachments,
      };
      log('incoming', { id: raw.id, from: raw.from, contact: contact.name || contact.number, has_attachment: attachments.length > 0, len: raw.body.length });
      if (typeof onIncoming === 'function') await onIncoming(raw);
    } catch (err) {
      log('message_handler_error', { error: err.message });
    }
  });

  await client.initialize();
  return client;
}

// sendText(client, to, body, opts) — operator-initiated reply via the web client. Returns
// { ok, message_id } | { ok:false, reason }. The agent never calls this autonomously.
// opts.typingMs — show a human-like "typing…" state for that long before sending (anti-ban
// pacing; capped at 15s). Does NOT hide the fingerprint — just avoids robotic instant replies.
async function sendText(client, to, body, opts = {}) {
  if (!client) return { ok: false, reason: 'client_not_ready' };
  const jid = toJid(to);
  if (!jid || !body) return { ok: false, reason: 'missing_to_or_body' };
  try {
    if (opts.typingMs) {
      try {
        const chat = await client.getChatById(jid);
        await chat.sendStateTyping();
        await new Promise(r => setTimeout(r, Math.min(opts.typingMs, 15000)));
        await chat.clearState();
      } catch (_) { /* typing is best-effort */ }
    }
    const sent = await client.sendMessage(jid, String(body));
    return { ok: true, message_id: sent && sent.id && sent.id._serialized, to: jid };
  } catch (err) {
    return { ok: false, reason: 'send_failed', detail: err.message };
  }
}

module.exports = { startClient, sendText, resolveContact, toJid, SESSION_PATH, MEDIA_DIR };
