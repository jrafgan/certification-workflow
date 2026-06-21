'use strict';

// services/dashboardService.js — Attention query aggregation
//
// Evaluates all active orders against the attention rules defined in
// PROCESS_STATES.md and returns results grouped by priority category.
//
// Attention categories (in priority order):
//   OVERDUE       — deadlines passed with no recorded action
//   DUE_TODAY     — deadlines hitting today
//   ACTION_NEEDED — required step not yet taken (lab not contacted, layout not sent, etc.)
//   DEBT          — READY_FOR_DELIVERY status with balance_due > 0
//   STALE         — NEW or WAITING_PAYMENT with no movement for > STALE_NEW_ORDER_DAYS
//
// Open tasks are fetched separately and included in the response.
//
// All thresholds (day counts, hour counts) come from config/constants.js.
// No threshold values are hardcoded in this file.
//
// An order with no flags is not included in the attention response.
//
// See: docs/PROCESS_STATES.md — Attention Dashboard Logic
//
// Phase 5 — Dashboard API
