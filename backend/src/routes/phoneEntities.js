'use strict';

// routes/phoneEntities.js — Phone ↔ Legal Entity Registry API (operator review, Phase 2).
//
// Routes:
//   GET  /api/phone-entities/review        proposals + conflicts awaiting operator review
//   GET  /api/phone-entities/confirmed     the active confirmed registry
//   GET  /api/phone-entities/resolve?phone=...  resolve a number → confirmed entity (or null)
//   POST /api/phone-entities/propose       create a GATED proposal (never auto-confirms)
//   POST /api/phone-entities/:id/confirm   operator confirms (supersede:true to replace a binding)
//   POST /api/phone-entities/:id/reject    operator rejects
//
// Recommend-only: nothing here writes to Declaration / Google Sheets / Email / WhatsApp.

const express = require('express');
const router  = express.Router();
const svc = require('../services/phoneEntityService');

router.get('/review', async (req, res, next) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
    const links = await svc.listForReview({ limit });
    res.status(200).json({ links, count: links.length });
  } catch (err) { next(err); }
});

router.get('/confirmed', async (_req, res, next) => {
  try {
    const links = await svc.listConfirmed();
    res.status(200).json({ links, count: links.length });
  } catch (err) { next(err); }
});

router.get('/resolve', async (req, res, next) => {
  try {
    const link = await svc.resolve(req.query.phone);
    res.status(200).json({ resolved: !!link, link: link || null });
  } catch (err) { next(err); }
});

router.post('/propose', async (req, res, next) => {
  try {
    const result = await svc.propose(req.body || {});
    res.status(result.created ? 201 : 200).json(result);
  } catch (err) { next(err); }
});

router.post('/:id/confirm', async (req, res, next) => {
  try {
    const { confirmedBy, supersede } = req.body || {};
    const link = await svc.confirm(req.params.id, { confirmedBy, supersede: !!supersede });
    res.status(200).json({ id: link._id, status: link.status, legal_entity: link.legal_entity });
  } catch (err) { next(err); }
});

router.post('/:id/reject', async (req, res, next) => {
  try {
    const { rejectedBy } = req.body || {};
    const link = await svc.reject(req.params.id, { rejectedBy });
    res.status(200).json({ id: link._id, status: link.status });
  } catch (err) { next(err); }
});

module.exports = router;
