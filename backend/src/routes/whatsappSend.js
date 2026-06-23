'use strict';

// routes/whatsappSend.js — operator-initiated WhatsApp send via the Cloud API (authed).
// The OPERATOR sends each reply (UI calls this); the agent never auto-sends.
//   GET  /api/whatsapp/status   { configured }
//   POST /api/whatsapp/send     { to, body } → Cloud API send result

const express = require('express');
const router  = express.Router();
const cloud = require('../services/whatsappCloudService');

router.get('/status', (_req, res) => res.json({ configured: cloud.isConfigured() }));

router.post('/send', async (req, res, next) => {
  try {
    const { to, body } = req.body || {};
    if (!to || !body) { res.status(400).json({ ok: false, reason: 'to_and_body_required' }); return; }
    res.status(200).json(await cloud.sendText(to, body));
  } catch (err) { next(err); }
});

module.exports = router;
