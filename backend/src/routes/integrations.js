'use strict';

// routes/integrations.js — Manual trigger routes for integrations
//
// Phase L1 routes implemented here:
//   GET  /api/integrations/gmail/search-threads   Gmail thread search with link status
//
// Routes planned for later phases (not yet implemented):
//   POST /api/integrations/forms/sync    Phase 6 — Google Forms Integration
//   POST /api/integrations/sheets/sync   Phase 7 — Google Sheets Synchronization
//   POST /api/scheduler/run              Phase 8 — Attention Engine

const express          = require('express');
const router           = express.Router();
const labCommService   = require('../services/labCommService');
const labCommValidator = require('../validators/labCommValidator');

// ─── Gmail thread search ──────────────────────────────────────────────────────

router.get('/gmail/search-threads', async (req, res, next) => {
  try {
    labCommValidator.validateGmailSearch(req.query);
    const maxResults = req.query.maxResults ? parseInt(req.query.maxResults, 10) : 20;
    const threads = await labCommService.searchGmailThreads(req.query.q, maxResults);
    res.status(200).json({ threads, count: threads.length, query: req.query.q });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
