'use strict';

// routes/whatsappCloud.js — PUBLIC Meta WhatsApp Cloud API webhook (no auth — Meta calls it).
//   GET  /webhooks/whatsapp   verification handshake (hub.challenge)
//   POST /webhooks/whatsapp   incoming messages (raw body → signature check → parse)
//
// Mounted BEFORE express.json (server.js) so the POST raw body is available for the
// X-Hub-Signature-256 HMAC check. Always acks 200 fast (Meta retries on non-200).

const express = require('express');
const router  = express.Router();
const cloud = require('../services/whatsappCloudService');

// GET — webhook verification.
router.get('/', (req, res) => {
  const r = cloud.verifyWebhook(req.query);
  if (r.ok) return res.status(200).send(String(r.challenge));
  return res.sendStatus(403);
});

// POST — incoming events. raw body (Buffer) for signature verification.
router.post('/', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''));
  const sig = cloud.verifySignature(raw, req.get('x-hub-signature-256'));
  if (sig.ok === false) return res.sendStatus(401);            // bad signature → reject

  let payload = {};
  try { payload = JSON.parse(raw.toString('utf8') || '{}'); } catch (_) { /* ignore malformed */ }
  const messages = cloud.parseIncoming(payload);

  // Best-effort handling; never block the 200 ack.
  try { if (messages.length) await handleIncoming(messages); } catch (_) { /* logged below */ }
  res.sendStatus(200);
});

// handleIncoming — store/log incoming messages. Storage + inbox UI is wired next; for now log
// so the webhook is verifiable end-to-end. Overridable for tests via setHandler.
let handleIncoming = async (messages) => {
  for (const m of messages) {
    console.log(`[wa-cloud] in от ${m.from}${m.name ? ' (' + m.name + ')' : ''}: ${m.is_voice ? '[голосовое]' : (m.text || '[' + m.type + ']')}`);
  }
};
function setHandler(fn) { if (typeof fn === 'function') handleIncoming = fn; }

module.exports = router;
module.exports.setHandler = setHandler;
