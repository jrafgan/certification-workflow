'use strict';

// routes/leadRecoveries.js — Lead Recovery Engine API (operator review).
//
// Routes:
//   GET  /api/lead-recoveries              list recoveries awaiting the operator (severe first)
//   POST /api/lead-recoveries/scan         scan orders/applications → build pending recoveries
//   POST /api/lead-recoveries/:id/decision record a decision (approve|reject|request_changes)
//
// scan writes only the recovery store; 'approve' authorizes the WhatsApp follow-up text
// but does NOT send. Clients are reached on WhatsApp only. See services/leadRecoveryService.js.

const express = require('express');
const router  = express.Router();
const leadRecoveryService = require('../services/leadRecoveryService');

router.get('/', async (req, res, next) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
    const recoveries = await leadRecoveryService.listPending(limit);
    res.status(200).json({ recoveries, count: recoveries.length });
  } catch (err) {
    next(err);
  }
});

router.post('/scan', async (req, res, next) => {
  try {
    const summary = await leadRecoveryService.scan();
    res.status(200).json({
      generated: summary.generated,
      skipped:   summary.skipped,
      reasons:   summary.reasons,
      count:     summary.recoveries.length,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/decision', async (req, res, next) => {
  try {
    const { decision, decidedBy, changeNote } = req.body || {};
    const rec = await leadRecoveryService.decide(req.params.id, decision, { decidedBy, changeNote });
    res.status(200).json({ id: rec._id, state: rec.state, decision: rec.decision });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
