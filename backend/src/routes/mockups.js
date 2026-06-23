'use strict';

// routes/mockups.js — Mockup generation + DOCX download (first production workflow).
//
//   POST /api/mockups/generate-from-form   latest «Новая форма» row → classify → DOCX
//   POST /api/mockups/generate             body: a mapped application object → classify → DOCX
//   GET  /api/mockups/:id/download[?kind=attachment]   stream the generated DOCX
//
// Output-only: generation never sends. Download streams a previously generated draft file.

const express = require('express');
const router  = express.Router();
const gen = require('../services/mockupGenerationService');
const errorUtils = require('../utils/errorUtils');

router.post('/generate-from-form', async (_req, res, next) => {
  try { res.status(200).json(await gen.generateFromLatestForm()); }
  catch (err) { next(err); }
});

router.post('/generate', async (req, res, next) => {
  try {
    const application = req.body && req.body.application ? req.body.application : req.body;
    res.status(200).json(gen.generateFromApplication(application || {}));
  } catch (err) { next(err); }
});

router.get('/:id/download', (req, res, next) => {
  try {
    const kind = req.query.kind === 'attachment' ? 'attachment' : 'mockup';
    const file = gen.resolveDownload(req.params.id, kind);
    if (!file) throw errorUtils.notFoundError('Файл макета не найден');
    // res.download sets Content-Disposition (UTF-8 filename* for the Cyrillic name).
    res.download(file.path, file.filename);
  } catch (err) { next(err); }
});

module.exports = router;
