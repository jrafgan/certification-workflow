'use strict';

// routes/labEmails.js — lab email preparation (DRAFT only; never sends).
//   POST /api/lab-emails/prepare-from-form  { sheet_row } → classify + mockup + prepared email

const express = require('express');
const router  = express.Router();
const labEmail = require('../services/labEmailService');

router.post('/prepare-from-form', async (req, res, next) => {
  try {
    const row = req.body && req.body.sheet_row;
    if (row == null) { res.status(400).json({ prepared: false, blocked: 'sheet_row_required' }); return; }
    res.status(200).json(await labEmail.prepareFromForm(row));
  } catch (err) { next(err); }
});

module.exports = router;
