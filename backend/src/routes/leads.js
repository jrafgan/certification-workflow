'use strict';

// routes/leads.js — Lead Conversion Agent API (operator-facing; output-only).
//
// Routes:
//   GET  /api/leads                       list leads (optional ?state=)
//   GET  /api/leads/drafts                list message drafts awaiting the operator
//   POST /api/leads/ingest                ingest an inbound inquiry → classify + propose
//   POST /api/leads/:id/advance           run the next state-machine action (propose draft)
//   POST /api/leads/:id/calculation       generate a preliminary calc proposal (gated)
//   POST /api/leads/drafts/:id/decision   approve|reject|request_changes a message draft
//   POST /api/leads/drafts/:id/release    release an APPROVED draft via the platform adapter
//
// Nothing is sent autonomously: every outbound is a draft the operator approves and releases.
// V1 uses the stub platform adapter (no live Instagram/Facebook/Telegram). See
// services/leadConversionService.js.

const express = require('express');
const router  = express.Router();
const svc = require('../services/leadConversionService');
const { RealAdapter } = require('../integrations/platformAdapter');

router.get('/', async (req, res, next) => {
  try {
    const leads = await svc.listLeads({ state: req.query.state, limit: req.query.limit ? parseInt(req.query.limit, 10) : 50 });
    res.status(200).json({ leads, count: leads.length });
  } catch (err) { next(err); }
});

router.get('/drafts', async (req, res, next) => {
  try {
    const drafts = await svc.listPendingDrafts(req.query.limit ? parseInt(req.query.limit, 10) : 50);
    res.status(200).json({ drafts, count: drafts.length });
  } catch (err) { next(err); }
});

router.post('/ingest', async (req, res, next) => {
  try {
    const result = await svc.ingestInquiry(req.body || {});
    res.status(201).json({
      lead_id: result.lead._id, state: result.lead.state, classification: result.classification,
      is_new_lead: result.is_new_lead, drafts: result.drafts.map(d => ({ id: d._id, kind: d.kind, auto_allowed: d.auto_allowed, text: d.proposed_text })),
    });
  } catch (err) { next(err); }
});

router.post('/:id/advance', async (req, res, next) => {
  try {
    const r = await svc.advance(req.params.id);
    res.status(200).json({ state: r.lead.state, action: r.action, draft: r.draft ? { id: r.draft._id, kind: r.draft.kind, text: r.draft.proposed_text } : null });
  } catch (err) { next(err); }
});

router.post('/:id/calculation', async (req, res, next) => {
  try {
    const r = await svc.generateCalculationProposal(req.params.id, req.body || {});
    res.status(201).json({ state: r.lead.state, calc: r.calc, draft: r.draft ? { id: r.draft._id, text: r.draft.proposed_text } : null });
  } catch (err) { next(err); }
});

router.post('/drafts/:id/decision', async (req, res, next) => {
  try {
    const { decision, decidedBy, changeNote } = req.body || {};
    const d = await svc.decideDraft(req.params.id, decision, { decidedBy, changeNote });
    res.status(200).json({ id: d._id, state: d.state, decision: d.decision });
  } catch (err) { next(err); }
});

router.post('/drafts/:id/release', async (req, res, next) => {
  try {
    // Use the live platform adapter (Telegram wired; IG/FB fall back to stub until Meta clears).
    const r = await svc.releaseDraft(req.params.id, { adapter: RealAdapter });
    res.status(r.ok ? 200 : 502).json(r);
  } catch (err) { next(err); }
});

module.exports = router;
