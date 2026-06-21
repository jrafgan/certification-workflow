'use strict';

// routes/emailDrafts.js — Draft Email Engine API (operator review).
//
// Routes:
//   GET  /api/email-drafts              list drafts awaiting the operator
//   POST /api/email-drafts/generate     scan orders → build pending lab-email drafts
//   POST /api/email-drafts/:id/decision record an operator decision (approve|reject|request_changes)
//
// generate writes only the draft store; 'approve' authorizes the text but does NOT send.
// Email is a lab-only channel. See services/draftEmailService.js.

const express = require('express');
const router  = express.Router();
const draftEmailService = require('../services/draftEmailService');

router.get('/', async (req, res, next) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
    const drafts = await draftEmailService.listPending(limit);
    res.status(200).json({ drafts, count: drafts.length });
  } catch (err) {
    next(err);
  }
});

router.post('/generate', async (req, res, next) => {
  try {
    const summary = await draftEmailService.generate();
    res.status(200).json({
      generated: summary.generated,
      skipped:   summary.skipped,
      reasons:   summary.reasons,
      count:     summary.drafts.length,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/decision', async (req, res, next) => {
  try {
    const { decision, decidedBy, changeNote } = req.body || {};
    const draft = await draftEmailService.decide(req.params.id, decision, { decidedBy, changeNote });
    res.status(200).json({ id: draft._id, state: draft.state, decision: draft.decision });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
