'use strict';

// routes/controlCenter.js — Agent Control Center API (operator web UI).
// All routes here run AFTER requireAuth (mounted under the gated /api). req.user carries
// { username, role }. Admin-only routes add requireRole('administrator').
//
// Read screens: /dashboard /summary /pipeline /inbox /drafts /kb /sources /audit
// Actions:      /decide /chat
// Admin:        /users (GET/POST), /users/:id/active, /kb-pending, /kb/:id/decision

const express = require('express');
const router  = express.Router();
const cc = require('../services/controlCenterService');
const { requireRole } = require('../middleware/auth');
const admin = requireRole('administrator');

// ── read screens (any authenticated user) ──────────────────────────────────
router.get('/dashboard', async (_req, res, next) => { try { res.json(await cc.businessDashboard()); } catch (e) { next(e); } });
router.get('/summary',   async (_req, res, next) => { try { res.json(await cc.summary()); } catch (e) { next(e); } });
router.get('/pipeline',  async (_req, res, next) => { try { res.json(await cc.pipeline()); } catch (e) { next(e); } });
router.get('/inbox',     async (req, res, next) => { try { res.json(await cc.inbox({ limit: req.query.limit ? parseInt(req.query.limit, 10) : 60 })); } catch (e) { next(e); } });
router.get('/drafts',    async (_req, res, next) => { try { res.json(await cc.drafts()); } catch (e) { next(e); } });
router.get('/kb',        async (req, res, next) => { try { res.json(await cc.kb({ category: req.query.category })); } catch (e) { next(e); } });
router.get('/sources',   async (_req, res, next) => { try { res.json(await cc.sources()); } catch (e) { next(e); } });
router.get('/audit',     async (req, res, next) => { try { res.json(await cc.auditLog({ limit: req.query.limit ? parseInt(req.query.limit, 10) : 100 })); } catch (e) { next(e); } });
router.get('/attention', async (_req, res, next) => { try { res.json(await cc.attention()); } catch (e) { next(e); } });
router.get('/order/:id/timeline', async (req, res, next) => { try { res.json(await cc.orderTimeline(req.params.id)); } catch (e) { next(e); } });
router.get('/order/:id/workspace', async (req, res, next) => { try { res.json(await cc.orderWorkspace(req.params.id)); } catch (e) { next(e); } });

// ── actions (operator + admin), audited ─────────────────────────────────────
router.post('/decide', async (req, res, next) => {
  try {
    const { type, id, action, text, note } = req.body || {};
    res.json(await cc.decide({ type, id, action, text, note, actor: req.user }));
  } catch (e) { next(e); }
});

router.post('/chat', async (req, res, next) => {
  try {
    const { type, id, question } = req.body || {};
    res.json(await cc.chat({ type, id, question }));
  } catch (e) { next(e); }
});

// ── admin: user management ──────────────────────────────────────────────────
router.get('/users', admin, async (_req, res, next) => { try { res.json({ users: await cc.listUsers() }); } catch (e) { next(e); } });
router.post('/users', admin, async (req, res, next) => {
  try { res.status(201).json({ user: await cc.createUser(req.body || {}, req.user) }); } catch (e) { next(e); }
});
router.post('/users/:id/active', admin, async (req, res, next) => {
  try { res.json({ user: await cc.setUserActive(req.params.id, !!(req.body && req.body.active), req.user) }); } catch (e) { next(e); }
});

// ── admin: KB management ────────────────────────────────────────────────────
router.get('/kb-pending', admin, async (_req, res, next) => { try { res.json(await cc.kbPending()); } catch (e) { next(e); } });
router.post('/kb/:id/decision', admin, async (req, res, next) => {
  try { res.json(await cc.kbDecide(req.params.id, (req.body && req.body.decision) || 'approve', req.user)); } catch (e) { next(e); }
});

module.exports = router;
