'use strict';

// routes/tgUserbot.js — PUBLIC-on-internal webhook for the Telegram USERBOT (tg-userbot service).
//   POST /webhooks/tg-userbot   incoming TG message (DM/group) → verify HMAC → lead + interest.
//
// Mounted BEFORE express.json (server.js) for the raw-body HMAC check. The userbot is on the
// internal docker network. DMs always become a Telegram lead in the panel; group messages only
// when they show certification interest (so the panel isn't flooded with group chatter).

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const leadConversion = require('../services/leadConversionService');
const interest = require('../services/interestDetectionService');

function verify(rawBody, header) {
  const secret = process.env.TG_WEBHOOK_SECRET;
  if (!secret) return null;                                 // no secret configured → skip (dev)
  if (!header) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(header), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.post('/', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''));
  if (verify(raw, req.get('x-hub-signature-256')) === false) return res.sendStatus(401);

  let event = {};
  try { event = JSON.parse(raw.toString('utf8') || '{}'); } catch (_) { /* ignore */ }
  const p = event && event.payload;

  if (event.event === 'message' && p && p.text) {
    const det = interest.detect(p.text);
    // DM (always) or a group message that shows certification interest → create/update a
    // Telegram lead in the panel (the operator can then reply/DM via the userbot).
    if (!p.is_group || det.interested) {
      try {
        await leadConversion.ingestInquiry({
          platform: 'telegram',
          handle:   String(p.from_id || p.chat_id),
          display_name: p.from_name || (p.username ? '@' + p.username : null),
          text:     p.text,
        });
        console.log(`[tg-userbot] лид${p.is_group ? ' (группа, интерес)' : ''} от ${p.from_name || p.from_id}: ${p.text.slice(0, 60)}`);
      } catch (err) {
        console.error(`[tg-userbot] ingest failed: ${err.message}`);
      }
    }
  }
  res.sendStatus(200);
});

module.exports = router;
