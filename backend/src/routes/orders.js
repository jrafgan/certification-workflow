'use strict';

// routes/orders.js — Order API routes
//
// Phase L1 routes implemented here:
//   GET    /api/orders/search                                   searchOrders
//   POST   /api/orders/:id/lab-interactions/:version/lab-thread linkThread
//   DELETE /api/orders/:id/lab-threads/:threadRecordId          unlinkThread
//   POST   /api/orders/:id/lab-threads/:threadRecordId/close    closeThread
//   GET    /api/orders/:id/lab-threads                          getThreadsForOrder
//
// Routes planned for Phase 3 (not yet implemented):
//   POST   /api/orders
//   GET    /api/orders
//   GET    /api/orders/:id
//   PATCH  /api/orders/:id
//   POST   /api/orders/:id/transition
//   POST   /api/orders/:id/payments
//   PATCH  /api/orders/:id/payments/:paymentId/void
//   POST   /api/orders/:id/lab-interactions
//   POST   /api/orders/:id/lab-interactions/:v/reminder
//   POST   /api/orders/:id/layouts
//   PATCH  /api/orders/:id/layouts/:v/sent
//   POST   /api/orders/:id/layouts/:v/decision
//   POST   /api/orders/:id/original/received
//   POST   /api/orders/:id/original/sent
//   POST   /api/orders/:id/cancel
//   POST   /api/orders/:id/close
//   GET    /api/orders/:id/tasks

const express         = require('express');
const router          = express.Router();
const labCommService  = require('../services/labCommService');
const labCommValidator = require('../validators/labCommValidator');

// ─── Order search ─────────────────────────────────────────────────────────────
// MUST be declared before /:id — Express matches routes in registration order,
// and 'search' would otherwise be consumed as an :id parameter.

router.get('/search', async (req, res, next) => {
  try {
    labCommValidator.validateOrderSearch(req.query);
    const results = await labCommService.searchOrders(req.query);
    res.status(200).json({ results, count: results.length });
  } catch (err) {
    next(err);
  }
});

// ─── Link a Gmail thread to a lab interaction ─────────────────────────────────

router.post('/:id/lab-interactions/:version/lab-thread', async (req, res, next) => {
  try {
    labCommValidator.validateOrderId(req.params.id);
    labCommValidator.validateVersion(req.params.version);
    labCommValidator.validateLinkThread(req.body);

    const thread = await labCommService.linkThread({
      orderId:  req.params.id,
      version:  parseInt(req.params.version, 10),
      threadId: req.body.threadId,
      linkMode: req.body.linkMode,
      sentAt:   req.body.sentAt ? new Date(req.body.sentAt) : null,
      context:  req.body.context,
    });

    res.status(201).json(thread.toObject());
  } catch (err) {
    next(err);
  }
});

// ─── Unlink (data correction — does not fire LAB_THREAD_CLOSED) ───────────────

router.delete('/:id/lab-threads/:threadRecordId', async (req, res, next) => {
  try {
    labCommValidator.validateOrderId(req.params.id);
    labCommValidator.validateOrderId(req.params.threadRecordId);

    const thread = await labCommService.unlinkThread(req.params.threadRecordId, req.params.id);
    res.status(200).json(thread.toObject());
  } catch (err) {
    next(err);
  }
});

// ─── Close (normal workflow completion — fires LAB_THREAD_CLOSED) ─────────────

router.post('/:id/lab-threads/:threadRecordId/close', async (req, res, next) => {
  try {
    labCommValidator.validateOrderId(req.params.id);
    labCommValidator.validateOrderId(req.params.threadRecordId);

    const thread = await labCommService.closeThread(req.params.threadRecordId, req.params.id);
    res.status(200).json(thread.toObject());
  } catch (err) {
    next(err);
  }
});

// ─── List threads for an order (with risk and slaStatus) ──────────────────────

router.get('/:id/lab-threads', async (req, res, next) => {
  try {
    labCommValidator.validateOrderId(req.params.id);

    const threads = await labCommService.getThreadsForOrder(req.params.id);
    res.status(200).json(threads);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
