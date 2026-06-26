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
const ingest = require('../services/whatsappIngestService');

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

// handleIncoming — persist each incoming message via the ingest pipeline (stores a
// WhatsAppMessage replica, idempotent on provider_message_id, then phone→order matching)
// and log it. Read-only toward the world (never sends/writes the sheet). Resilient
// per-message: a failure on one must not lose the others or block the 200 ack.
// Overridable for tests via setHandler.
let handleIncoming = async (messages) => {
  for (const m of messages) {
    console.log(`[wa-cloud] in от ${m.from}${m.name ? ' (' + m.name + ')' : ''}: ${m.is_voice ? '[голосовое]' : (m.text || '[' + m.type + ']')}`);
    try {
      await ingest.ingestIncoming(cloud.toIngestRaw(m));
    } catch (err) {
      console.error(`[wa-cloud] ingest failed for ${m.id}: ${err.message}`);
    }
  }
};
function setHandler(fn) { if (typeof fn === 'function') handleIncoming = fn; }

module.exports = router;
module.exports.setHandler = setHandler;
