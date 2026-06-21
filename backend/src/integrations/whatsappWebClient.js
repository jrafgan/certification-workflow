'use strict';

// integrations/whatsappWebClient.js — WhatsApp Web client (whatsapp-web.js) for
// the Dokumenty.pro WhatsApp Business number.
//
// V1 SCOPE: QR login, session persistence, RECEIVE messages + attachments, log
// incoming events. It deliberately exposes NO send capability — there is no
// sendMessage path here, by design (recommendation mode / forbidden autonomous
// actions). Outbound is operator-controlled and out of scope for this module.
//
// ─── READ-RECEIPT / UNREAD SAFETY (critical) ───────────────────────────────────
// The operator must keep seeing unread chats exactly as before. This client therefore
// NEVER marks anything read and NEVER touches unread counters:
//   • it never calls chat.sendSeen() / msg.markUnread() / markChatUnread(),
//   • it never opens a chat in the active UI,
//   • it connects with markOnlineOnConnect:false so the account does not even appear
//     online (no presence side effects).
// Receiving a 'message' event does not send a read receipt; only the omitted calls
// above would. Keep it that way.
//
// ─── TEST_MODE ─────────────────────────────────────────────────────────────────
// When TEST_MODE is on, only the single allowed contact ("Мой Билайн" by default) is
// processed; every other contact is OBSERVE-ONLY (logged, nothing else — no media
// download, no onIncoming). See services/whatsappTestModeService.js.
//
// whatsapp-web.js and qrcode-terminal are required LAZILY inside startClient so
// the rest of the backend (and the unit tests) never load Puppeteer/Chromium.

const fs   = require('fs');
const path = require('path');
const testMode = require('../services/whatsappTestModeService');

const SESSION_PATH = process.env.WHATSAPP_SESSION_PATH || path.join(__dirname, '..', '..', '.wwebjs_auth');
const MEDIA_DIR    = process.env.WHATSAPP_MEDIA_DIR    || path.join(__dirname, '..', '..', 'whatsapp_media');

function log(event, data) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...data });
  console.log(`[whatsapp] ${line}`);
}

// Resolves a provider-agnostic contact descriptor from a whatsapp-web.js message,
// tolerating failures (getContact is a network call into the page context).
async function resolveContact(msg) {
  try {
    const c = await msg.getContact();
    return {
      name:      c?.name || null,
      pushname:  c?.pushname || null,
      shortName: c?.shortName || null,
      number:    c?.number || (msg.from || '').split('@')[0] || null,
    };
  } catch (_) {
    return { name: null, pushname: null, shortName: null, number: (msg.from || '').split('@')[0] || null };
  }
}

// startClient({ onIncoming, onObserved }) — boots the client, wires events, returns it.
// onIncoming(rawMessage) is called only for messages that should be PROCESSED (the
// allowed test contact, or any contact when TEST_MODE is off). onObserved(info) is
// called for OBSERVE-ONLY messages (TEST_MODE on, non-allowed contact) — log only.
async function startClient({ onIncoming, onObserved } = {}) {
  // Lazy require — keeps Puppeteer out of the normal app/test load path.
  const { Client, LocalAuth } = require('whatsapp-web.js');
  const qrcode = require('qrcode-terminal');

  if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

  const inTestMode = testMode.isTestMode();
  const allowed    = testMode.allowedContactName();
  log('config', { test_mode: inTestMode, allowed_contact: inTestMode ? allowed : '(all — TEST_MODE off)' });

  const client = new Client({
    // LocalAuth persists the session under SESSION_PATH → no re-scan each start.
    authStrategy: new LocalAuth({ dataPath: SESSION_PATH }),
    // SAFETY: do not broadcast presence; do not let the lib mark the account online.
    markOnlineOnConnect: false,
    puppeteer: {
      headless: true,
      // In containers, point at the distro Chromium via PUPPETEER_EXECUTABLE_PATH
      // (more reliable than the bundled download in slim images). Falls back to the
      // bundled Chromium locally when the env var is unset.
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    },
  });

  client.on('qr', (qr) => {
    log('qr', { hint: 'Scan this QR with the Dokumenty.pro WhatsApp Business number' });
    qrcode.generate(qr, { small: true });
  });
  client.on('authenticated', () => log('authenticated', {}));
  client.on('auth_failure', (m) => log('auth_failure', { message: String(m) }));
  client.on('ready',        () => log('ready', { session: SESSION_PATH, test_mode: inTestMode }));
  client.on('disconnected', (r) => log('disconnected', { reason: String(r) }));

  client.on('message', async (msg) => {
    try {
      const contact  = await resolveContact(msg);
      const isAllowed = testMode.isAllowedContact(contact, allowed);
      const decision  = testMode.decideHandling({ fromMe: msg.fromMe, testMode: inTestMode, allowed: isAllowed });

      // SAFETY: we NEVER call msg.markUnread()/chat.sendSeen() — the message stays
      // unread for the operator regardless of the branch taken below.

      if (decision === 'skip_self') return;

      if (decision === 'observe_only') {
        // Observe only: log, no media download, no processing, no actions.
        const info = {
          id: msg.id && msg.id._serialized, from: msg.from, contact: contact.name || contact.pushname || contact.number,
          has_media: !!msg.hasMedia, len: (msg.body || '').length,
        };
        log('observed', { ...info, note: 'TEST_MODE: not the allowed contact — observe only' });
        if (typeof onObserved === 'function') await onObserved(info);
        return;
      }

      // decision === 'process' — allowed contact (or TEST_MODE off): receive fully.
      const attachments = [];
      if (msg.hasMedia) {
        try {
          const media = await msg.downloadMedia(); // { mimetype, data(base64), filename }
          if (media && media.data) {
            const buf = Buffer.from(media.data, 'base64');
            const ext = (media.mimetype && media.mimetype.split('/')[1]) || 'bin';
            const fname = media.filename || `${msg.id.id}.${ext}`;
            const safe  = path.basename(fname);
            const dest  = path.join(MEDIA_DIR, `${Date.now()}_${safe}`);
            fs.writeFileSync(dest, buf); // receive (store) attachment locally; never forwarded
            attachments.push({ file_name: safe, mime_type: media.mimetype, size: buf.length, media_ref: dest });
          }
        } catch (mErr) {
          log('attachment_error', { id: msg.id && msg.id._serialized, error: mErr.message });
        }
      }

      const raw = {
        id:        msg.id && msg.id._serialized,
        from:      msg.from,
        contact,
        body:      msg.body || '',
        timestamp: msg.timestamp,
        fromMe:    msg.fromMe,
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

module.exports = { startClient, resolveContact, SESSION_PATH, MEDIA_DIR };
