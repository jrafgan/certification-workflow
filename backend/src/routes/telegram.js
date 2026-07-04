'use strict';

// routes/telegram.js — PUBLIC Telegram Bot webhook (no auth — Telegram calls it).
//   POST /webhooks/telegram   incoming Update → verify secret header → parse → ingest as a lead.
//
// Mounted AFTER express.json (server.js): Telegram sends JSON and authenticates via the
// X-Telegram-Bot-Api-Secret-Token header (set on setWebhook), not an HMAC of the raw body.
// Always acks 200 fast. Read-only toward the world: ingest only proposes operator-gated
// drafts (services/leadConversionService) — nothing is sent autonomously.

const express  = require('express');
const router   = express.Router();
const telegram = require('../integrations/telegramClient');
const svc      = require('../services/leadConversionService');
const menu     = require('../services/telegramMenuService');
const { RealAdapter } = require('../integrations/platformAdapter');

router.post('/', async (req, res) => {
  const sig = telegram.verifySecret(req.get('x-telegram-bot-api-secret-token'));
  if (sig.ok === false) return res.sendStatus(401); // bad/missing secret → reject

  const parsed = telegram.parseUpdate(req.body || {});
  // Best-effort; never block the 200 ack (Telegram retries on non-200).
  if (parsed && parsed.text) {
    try {
      const cmd = menu.parseCommand(parsed.text);
      const answer = cmd && menu.autoReplyEnabled() ? menu.answerFor(cmd, {}) : null;
      // Menu FAQ commands: track the lead WITHOUT queuing redundant drafts (we auto-answer);
      // everything else goes through the normal gated-draft flow.
      await svc.ingestInquiry(parsed, { adapter: RealAdapter, skipDrafts: !!answer });
      if (answer) await telegram.sendMessage(parsed.handle, answer);
      console.log(`[telegram] in от ${parsed.handle}${parsed.username ? ' (' + parsed.username + ')' : ''}: ${parsed.text}${answer ? ' → авто-ответ меню' : ''}`);
    } catch (err) {
      console.error(`[telegram] ingest failed: ${err.message}`);
    }
  }
  res.sendStatus(200);
});

module.exports = router;
