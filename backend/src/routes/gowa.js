'use strict';

// routes/gowa.js — PUBLIC webhook for the GOWA WhatsApp gateway (no auth — GOWA calls it).
//   POST /webhooks/gowa   incoming message → verify HMAC → map → ingest → panel inbox.
//
// Mounted BEFORE express.json (server.js) so the raw body is available for the
// X-Hub-Signature-256 HMAC check. Always acks 200 fast. Read-only toward the world.

const express = require('express');
const router  = express.Router();
const gowa    = require('../integrations/gowaClient');
const ingest  = require('../services/whatsappIngestService');
const interest = require('../services/interestDetectionService');
const firstContact = require('../services/firstContactService');
const autoResponder = require('../services/whatsappAutoResponderService');

router.post('/', express.raw({ type: '*/*', limit: '5mb' }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''));
  const sig = gowa.verifySignature(raw, req.get('x-hub-signature-256'));
  if (sig.ok === false) return res.sendStatus(401);          // bad signature → reject

  let event = {};
  try { event = JSON.parse(raw.toString('utf8') || '{}'); } catch (_) { /* ignore malformed */ }
  const rawMsg = gowa.toIngestRaw(event);

  if (rawMsg && (rawMsg.body || (rawMsg.attachments && rawMsg.attachments.length))) {
    const p = event.payload || {};
    const isGroup = !!rawMsg.is_group;
    try {
      // Our own outgoing → archive as outbound (full-conversation history), nothing else.
      if (rawMsg.from_me) {
        await ingest.archiveOutbound(rawMsg);
        console.log(`[gowa] out → ${rawMsg.chat_id || ''}: ${rawMsg.body || '[вложение]'}`);
        return res.sendStatus(200);
      }
      // ALL incoming are ARCHIVED (searchable). ingestIncoming stores everything; matching +
      // the operator inbox still see only direct + group-addressed-to-me (interest below).
      const r = await ingest.ingestIncoming(rawMsg);
      console.log(`[gowa] in${isGroup ? ' (группа)' : ''} от ${rawMsg.from}: ${rawMsg.body || '[вложение]'}${r && r.skipped ? ` [${r.skipped}]` : ''}`);

      // Certification INTEREST (direct OR group) → propose a gated first-contact DM (operator
      // decides; the send still passes the anti-ban gate). proposeFromChatInterest skips
      // people we're already in direct contact with, so it only surfaces real new leads.
      if (rawMsg.body) {
        const det = interest.detect(rawMsg.body);
        if (det.interested) {
          const senderPhone = String(p.from || '').split('@')[0];
          const ctx = isGroup ? `группа ${String(p.chat_id || '').replace(/@g\.us$/, '')}` : 'личка';
          const r = await firstContact.proposeFromChatInterest({ phone: senderPhone, name: p.from_name, context: ctx, detection: det });
          if (r.generated) console.log(`[gowa] лид по интересу: ${senderPhone} (${det.category}) из «${ctx}»`);
        }
      }

      // Auto-Responder: answer safe, KB-approved questions from a DIRECT client message.
      // Mode-gated (WA_AUTORESPONDER_MODE=off|shadow|auto, default shadow → sends nothing).
      // Reads history from whatsapp_messages (web.js-maintained); sends via GOWA. Never throws
      // up the webhook. Not for groups (guarded inside).
      if (!isGroup && rawMsg.body) {
        try {
          const ar = await autoResponder.handleInbound(rawMsg);
          if (ar && (ar.decision || ar.skipped)) {
            console.log(`[gowa] автоответчик от ${rawMsg.from}: ${ar.decision || 'skip:' + ar.skipped}${ar.kind ? ' (' + ar.kind + ')' : ''}`);
          }
        } catch (e) { console.error(`[gowa] autoresponder failed: ${e.message}`); }
      }
    } catch (err) {
      console.error(`[gowa] handle failed: ${err.message}`);
    }
  }
  res.sendStatus(200);
});

module.exports = router;
