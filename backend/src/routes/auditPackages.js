'use strict';

// routes/auditPackages.js — Workflow Auditor API (operator review).
//
// Routes:
//   GET  /api/audit-packages              list pending audits (recommended + most confident first)
//   POST /api/audit-packages/run          audit active orders → build pending AUDIT PACKAGEs
//   POST /api/audit-packages/:id/decision record a decision (approve|reject|acknowledge)
//
// run writes only the audit store; 'approve' authorizes a proposed status change but does
// NOT apply it. No status is ever changed automatically. See services/workflowAuditService.js.

const express = require('express');
const router  = express.Router();
const workflowAuditService = require('../services/workflowAuditService');

router.get('/', async (req, res, next) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
    const packages = await workflowAuditService.listPending(limit);
    res.status(200).json({ packages, count: packages.length });
  } catch (err) {
    next(err);
  }
});

router.post('/run', async (req, res, next) => {
  try {
    const summary = await workflowAuditService.audit();
    res.status(200).json({
      generated: summary.generated,
      skipped:   summary.skipped,
      reasons:   summary.reasons,
      count:     summary.packages.length,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/decision', async (req, res, next) => {
  try {
    const { decision, decidedBy } = req.body || {};
    const pkg = await workflowAuditService.decide(req.params.id, decision, { decidedBy });
    res.status(200).json({ id: pkg._id, state: pkg.state, decision: pkg.decision });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
