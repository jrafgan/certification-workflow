'use strict';

// routes/extractionReviews.js — Document Extraction Review Package API (operator review).
//
// Routes:
//   GET  /api/extraction-reviews              list pending extraction reviews (queue)
//   POST /api/extraction-reviews              read an uploaded file → create a review
//   POST /api/extraction-reviews/:id/decision record an operator decision (approve|reject)
//
// Creating a review only reads the file and writes its OWN review record. 'approve'
// records the operator-confirmed values; it does NOT write to the Declaration, sheet,
// Gmail, or WhatsApp. See services/extractionReviewService.js.

const express = require('express');
const router  = express.Router();
const extractionReviewService = require('../services/extractionReviewService');

// GET /api/extraction-reviews — pending reviews, highest confidence first.
router.get('/', async (req, res, next) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
    const reviews = await extractionReviewService.listPending(limit);
    res.status(200).json({ reviews, count: reviews.length });
  } catch (err) {
    next(err);
  }
});

// POST /api/extraction-reviews — { file: { file_name, media_ref, mime_type }, origin?, messageId? }.
// Reads the referenced file and creates a pending Review Package.
router.post('/', async (req, res, next) => {
  try {
    const { file, origin, messageId } = req.body || {};
    if (!file || (!file.media_ref && !file.path)) {
      return res.status(400).json({ error: 'file.media_ref (or file.path) is required' });
    }
    const result = await extractionReviewService.createFromFile(file, { origin, messageId });
    res.status(result.created ? 201 : 200).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/extraction-reviews/:id/decision — { decision: 'approve'|'reject', corrections?, decidedBy? }.
router.post('/:id/decision', async (req, res, next) => {
  try {
    const { decision, corrections, decidedBy } = req.body || {};
    const review = await extractionReviewService.decide(req.params.id, decision, { corrections, decidedBy });
    res.status(200).json({
      id:               review._id,
      status:           review.status,
      decision:         review.decision,
      confirmed_fields: review.confirmed_fields,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
