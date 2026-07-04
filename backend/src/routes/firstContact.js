'use strict';

// routes/firstContact.js — First-Contact Verification Engine API (authed; /api/first-contact).
//   GET  /api/first-contact            list proposals awaiting the operator
//   POST /api/first-contact/scan       scan New Form apps → build proposals for unknown numbers
//   POST /api/first-contact/:id/decision  { decision: 'approve'|'reject' }
//
// scan writes only the proposal store; 'approve' sends a Meta-approved template
// (operator-triggered) — the agent never sends on its own. See services/firstContactService.js.

const express = require('express');
const router  = express.Router();
const firstContact = require('../services/firstContactService');

router.get('/', async (req, res, next) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 100;
    const proposals = await firstContact.listPending(limit);
    res.status(200).json({ proposals, count: proposals.length });
  } catch (err) { next(err); }
});

router.post('/scan', async (req, res, next) => {
  try {
    const summary = await firstContact.scanUnknownApplicants();
    res.status(200).json({ generated: summary.generated, skipped: summary.skipped, reasons: summary.reasons, count: summary.proposals.length });
  } catch (err) { next(err); }
});

router.post('/:id/decision', async (req, res, next) => {
  try {
    const { decision } = req.body || {};
    if (decision !== 'approve' && decision !== 'reject') {
      res.status(400).json({ ok: false, reason: 'decision_must_be_approve_or_reject' }); return;
    }
    const decidedBy = req.user && req.user.username;
    const p = await firstContact.decide(req.params.id, decision, { decidedBy });
    res.status(200).json({ id: p._id, state: p.state, decision: p.decision, send_result: p.send_result || null });
  } catch (err) { next(err); }
});

module.exports = router;
