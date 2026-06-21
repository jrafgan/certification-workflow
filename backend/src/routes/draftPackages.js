'use strict';

// routes/draftPackages.js — Draft Package Generator API (operator review).
//
// Routes:
//   GET  /api/draft-packages              list pending proposals (review queue)
//   POST /api/draft-packages/generate     (re)generate proposals from current inputs
//   POST /api/draft-packages/:id/decision record an operator decision (approve|reject)
//   GET  /api/draft-packages/:id/preview  read-only before/after preview (no writes)
//   POST /api/draft-packages/:id/execute  execute an APPROVED CREATE_DECLARATION_ROW
//
// generate writes only the proposal store; 'approve' records intent only. Execution
// is the single gated step that appends the Declaration row to the sheet, and runs
// ONLY on an already-approved package. See services/draftPackageService.js.

const express = require('express');
const router  = express.Router();
const draftPackageService = require('../services/draftPackageService');

// GET /api/draft-packages — pending proposals, highest confidence first.
router.get('/', async (req, res, next) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
    const packages = await draftPackageService.listPending(limit);
    res.status(200).json({ packages, count: packages.length });
  } catch (err) {
    next(err);
  }
});

// POST /api/draft-packages/generate — read the inputs and build pending proposals.
router.post('/generate', async (req, res, next) => {
  try {
    const summary = await draftPackageService.generate();
    res.status(200).json({
      generated: summary.generated,
      skipped:   summary.skipped,
      reasons:   summary.reasons,
      reason:    summary.reason,
      count:     summary.packages.length,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/draft-packages/:id/decision — { decision: 'approve'|'reject', decidedBy? }.
router.post('/:id/decision', async (req, res, next) => {
  try {
    const { decision, decidedBy } = req.body || {};
    const pkg = await draftPackageService.decide(req.params.id, decision, { decidedBy });
    res.status(200).json({ id: pkg._id, status: pkg.status, decision: pkg.decision });
  } catch (err) {
    next(err);
  }
});

// GET /api/draft-packages/:id/preview — read-only before/after preview (no writes).
router.get('/:id/preview', async (req, res, next) => {
  try {
    const result = await draftPackageService.previewExecution(req.params.id);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/draft-packages/:id/execute — execute an APPROVED CREATE_DECLARATION_ROW.
// { executedBy? }. Refuses unless the package is already 'approved'.
router.post('/:id/execute', async (req, res, next) => {
  try {
    const { executedBy } = req.body || {};
    const result = await draftPackageService.executeApprovedPackage(req.params.id, { executedBy });
    res.status(result.ok ? 200 : 502).json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
