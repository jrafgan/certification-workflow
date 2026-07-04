'use strict';

// routes/whatsappSend.js — operator-initiated WhatsApp send via the Cloud API (authed).
// The OPERATOR sends each reply (UI calls this); the agent never auto-sends.
//   GET  /api/whatsapp/status   { configured }
//   POST /api/whatsapp/send     { to, body } → Cloud API send result

const express = require('express');
const router  = express.Router();
const cloud = require('../services/whatsappCloudService');
const gowa  = require('../integrations/gowaClient');
const outbound = require('../services/outboundWhatsappService');
const operatorStats = require('../services/operatorStatsService');

const sendVia = (to, body) => outbound.send(to, body); // safety-gated, active channel

router.get('/status', (_req, res) => res.json({ configured: gowa.isConfigured() || cloud.isConfigured() || !!process.env.WHATSAPP_WEB_SEND_URL, channel: outbound.activeChannel() }));

router.post('/send', async (req, res, next) => {
  try {
    const { to, body } = req.body || {};
    if (!to || !body) { res.status(400).json({ ok: false, reason: 'to_and_body_required' }); return; }
    const result = await sendVia(to, body);

    // Attribute the sent reply to the operator (per-operator counter). Best-effort: a
    // metric write must never break or delay the send result the operator is waiting on.
    if (result && result.ok) {
      const handledBy = req.user && req.user.id;
      operatorStats.recordOutboundReply({ to, body, handledBy })
        .catch(err => console.error(`[wa-send] metric record failed: ${err.message}`));
    }

    res.status(200).json(result);
  } catch (err) { next(err); }
});

module.exports = router;
