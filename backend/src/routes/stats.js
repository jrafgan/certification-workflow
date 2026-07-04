'use strict';

// routes/stats.js — operator work counter (authed; mounted at /api/stats).
//   GET /api/stats/operators?from=&to=  → per-operator reply counts, broken down by the
//                                          question type (intent) and topic (category).
//
// from/to are optional ISO dates (to is exclusive). See services/operatorStatsService.js.

const express = require('express');
const router  = express.Router();
const operatorStats = require('../services/operatorStatsService');

router.get('/operators', async (req, res, next) => {
  try {
    const { from, to } = req.query || {};
    const data = await operatorStats.compute({ from, to });
    res.status(200).json({ ...data, from: from || null, to: to || null });
  } catch (err) { next(err); }
});

module.exports = router;
