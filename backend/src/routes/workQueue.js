'use strict';

// routes/workQueue.js — agent-built operational work queue (read-only).
//   GET /api/work-queue   8 sections (counts + items) of "what needs attention today".

const express = require('express');
const router  = express.Router();
const workQueue = require('../services/workQueueService');

router.get('/', async (_req, res, next) => {
  try { res.status(200).json(await workQueue.build()); }
  catch (err) { next(err); }
});

module.exports = router;
