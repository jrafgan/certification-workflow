'use strict';

// routes/dashboard.js — Dashboard API routes
//
// Phase L2 (active):
//   GET  /api/dashboard            — lab comm attention view (threads needing action)
//
// Phase 5 (planned):
//   GET  /api/dashboard/attention  — attention engine output
//   GET  /api/dashboard/orders     — active orders list
//   GET  /api/dashboard/orders/closed
//   GET  /api/dashboard/orders/cancelled

const express            = require('express');
const router             = express.Router();
const { LabCommThread }  = require('../models/LabCommThread');
const { Order }          = require('../models/Order');
const { Task }           = require('../models/Task');
const {
  computeThreadRisk,
  computeSlaStatus,
} = require('../services/labCommService');

const RISK_ORDER   = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
const STATUS_ORDER = { replied: 0, timed_out: 1, unreachable: 2, waiting: 3 };

// GET /api/dashboard
// Returns all active lab comm threads enriched with risk, order context, and open tasks.
// Sorted: CRITICAL first, then HIGH → MEDIUM → LOW; within same risk: replied > timed_out.

router.get('/', async (req, res, next) => {
  try {
    const threads = await LabCommThread
      .find({ status: { $in: ['waiting', 'replied', 'timed_out', 'unreachable'] } })
      .sort({ created_at: -1 })
      .lean();

    if (threads.length === 0) {
      return res.json({
        threads: [],
        summary: {
          critical:            0,
          high:                0,
          replied_unprocessed: 0,
          timed_out:           0,
          unreachable:         0,
          total_active:        0,
        },
      });
    }

    const orderIds = [...new Set(threads.map(t => String(t.order_id)))];

    const [orders, tasks] = await Promise.all([
      Order.find({ _id: { $in: orderIds } })
        .select('status client.name client.companyName laboratory.laboratoryName deadlines')
        .lean(),
      Task.find({ order_id: { $in: orderIds }, status: 'open' }).lean(),
    ]);

    const orderMap = Object.fromEntries(orders.map(o => [String(o._id), o]));

    const taskMap = {};
    for (const t of tasks) {
      const key = String(t.order_id);
      (taskMap[key] = taskMap[key] || []).push(t);
    }

    const enriched = threads.map(thread => {
      const order = orderMap[String(thread.order_id)] || null;
      const risk  = computeThreadRisk(thread, order);
      return {
        ...thread,
        risk,
        slaStatus:  computeSlaStatus(thread),
        order: order ? {
          _id:            order._id,
          status:         order.status,
          clientName:     order.client?.name             || null,
          companyName:    order.client?.companyName      || null,
          laboratoryName: order.laboratory?.laboratoryName || null,
        } : null,
        openTasks: taskMap[String(thread.order_id)] || [],
      };
    });

    enriched.sort((a, b) => {
      const rd = (RISK_ORDER[a.risk] ?? 3) - (RISK_ORDER[b.risk] ?? 3);
      if (rd !== 0) return rd;
      return (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3);
    });

    const summary = {
      critical:            enriched.filter(t => t.risk === 'CRITICAL').length,
      high:                enriched.filter(t => t.risk === 'HIGH').length,
      replied_unprocessed: enriched.filter(t => t.status === 'replied').length,
      timed_out:           enriched.filter(t => t.status === 'timed_out').length,
      unreachable:         enriched.filter(t => t.status === 'unreachable').length,
      total_active:        enriched.length,
    };

    res.json({ threads: enriched, summary });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
