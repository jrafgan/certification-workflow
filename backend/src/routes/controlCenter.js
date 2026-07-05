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
const newAppProposal = require('../services/newApplicationProposalService');
const declarationOrder = require('../services/declarationOrderService');
const draftEmail = require('../services/draftEmailService');
const emailFollowup = require('../services/emailFollowupService');
const emailReplyDraft = require('../services/emailReplyDraftService');
const whatsappReplyDraft = require('../services/whatsappReplyDraftService');
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
router.get('/attention-center', async (_req, res, next) => { try { res.json(await cc.attentionCenter()); } catch (e) { next(e); } });

// ── Task Inbox (WhatsApp-style to-do) ───────────────────────────────────────
router.get('/tasks',  async (_req, res, next) => { try { res.json(await cc.taskInbox()); } catch (e) { next(e); } });
router.get('/thread', async (req, res, next) => { try { res.json(await cc.taskThread(req.query.phone)); } catch (e) { next(e); } });
router.get('/wa-search', async (req, res, next) => { try { res.json(await cc.waSearch({ q: req.query.q, phone: req.query.phone, limit: req.query.limit })); } catch (e) { next(e); } });
// Авто-ответчик: решения агента для проверки оператором (перед включением реальной отправки).
router.get('/autoreplies', async (req, res, next) => { try { res.json(await cc.autoReplies({ limit: req.query.limit ? parseInt(req.query.limit, 10) : 80, decision: req.query.decision })); } catch (e) { next(e); } });
// Ленивый Gmail-поиск писем клиента (медленный → отдельно от карточки).
router.get('/client-emails', async (req, res, next) => { try { res.json(await cc.clientEmails(req.query.phone)); } catch (e) { next(e); } });
// Неотвеченные письма — живой список цепочек Gmail, где мы так и не ответили (последнее
// сообщение не от нас). Показывает тему, текст и файл последнего сообщения.
router.get('/emails-unanswered', async (req, res, next) => {
  try { res.json(await emailFollowup.unanswered({ limit: req.query.limit ? parseInt(req.query.limit, 10) : 30 })); } catch (e) { next(e); }
});
// Подготовить черновик ответа на письмо (по требованию, на LLM). Output-only.
router.post('/emails/:threadId/draft', async (req, res, next) => {
  try { res.json(await emailReplyDraft.draftReply({ threadId: req.params.threadId })); } catch (e) { next(e); }
});
// Подготовить черновик ответа КЛИЕНТУ в WhatsApp — учитывает статус в «Декларации» + историю
// переписки + БЗ. Output-only (оператор правит и шлёт существующей кнопкой отправки).
router.post('/whatsapp-draft', async (req, res, next) => {
  try { res.json(await whatsappReplyDraft.draftReply({ phone: (req.body && req.body.phone) })); } catch (e) { next(e); }
});
router.post('/thread/seen', async (req, res, next) => {
  try {
    const { phone, action, until } = req.body || {};
    res.json(await cc.markThread({ phone, action: action || 'seen', until, actor: req.user }));
  } catch (e) { next(e); }
});

// Operator verdict on a New-Form application: mark «не новая» (reason) or reopen. Audited.
router.post('/applications/mark', async (req, res, next) => {
  try {
    const { phone, sheet_row, client_name, reason, note } = req.body || {};
    res.json(await cc.markApplication({ phone, sheet_row, client_name, reason, note, actor: req.user }));
  } catch (e) { next(e); }
});
router.post('/applications/reopen', async (req, res, next) => {
  try {
    const { phone, sheet_row } = req.body || {};
    res.json(await cc.reopenApplication({ phone, sheet_row, actor: req.user }));
  } catch (e) { next(e); }
});

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

// Просканировать Новую форму → создать предложения по новым заявкам (ПИ+сумма+черновик).
// Output-only, идемпотентно (дубли пропускаются). Показывается в /inbox.
router.post('/new-applications/scan', async (req, res, next) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 25;
    res.json(await newAppProposal.generate({ limit, newestFirst: true }));
  } catch (e) { next(e); }
});

// Ручной запуск синка «Декларация» → Order + подготовки писем-заявок лабораториям (то же,
// что делает шедулер _runOrderSync). Output-only, идемпотентно, письма НЕ отправляются.
router.post('/order-sync', async (req, res, next) => {
  try {
    const draftLimit = req.query.draft_limit ? parseInt(req.query.draft_limit, 10) : 15;
    const sync = await declarationOrder.sync();
    const drafts = await draftEmail.generate({ limit: draftLimit });
    res.json({ sync, drafts, recommend_only: true });
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
// Per-user activity counter (кто что сделал и сколько) — oversight for error review.
router.get('/user-activity', admin, async (req, res, next) => {
  try { res.json(await cc.userActivity({ days: req.query.days ? parseInt(req.query.days, 10) : 30 })); } catch (e) { next(e); }
});

// ── admin: KB management ────────────────────────────────────────────────────
router.get('/kb-pending', admin, async (_req, res, next) => { try { res.json(await cc.kbPending()); } catch (e) { next(e); } });
router.post('/kb/:id/decision', admin, async (req, res, next) => {
  try { res.json(await cc.kbDecide(req.params.id, (req.body && req.body.decision) || 'approve', req.user)); } catch (e) { next(e); }
});

module.exports = router;
