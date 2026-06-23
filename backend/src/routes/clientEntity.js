'use strict';

// routes/clientEntity.js — the client entity (сущность) by WhatsApp phone (read-only).
//   GET /api/client-entity?phone=+996...

const express = require('express');
const router  = express.Router();
const clientEntity = require('../services/clientEntityService');

router.get('/', async (req, res, next) => {
  try {
    if (!req.query.phone) { res.status(400).json({ found: false, reason: 'phone_required' }); return; }
    res.status(200).json(await clientEntity.buildByPhone(req.query.phone));
  } catch (err) { next(err); }
});

module.exports = router;
