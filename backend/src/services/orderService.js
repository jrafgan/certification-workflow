'use strict';

// services/orderService.js — Order business logic
//
// Owns the complete Order lifecycle. Full implementation: Phase 3.
//
// ─── PHASE L1 INTEGRATION POINT ───────────────────────────────────────────────
// When implementing the deadline-update function (the one that sets
// deadlines.lab_response_due or deadlines.original_expected and fires
// ORDER_DEADLINE_SET), add this call after the event is fired:
//
//   const labCommService = require('./labCommService');
//   await labCommService.updateTimeoutAfterDeadlineChange(orderId, deadlineField);
//
// Where deadlineField is 'lab_response_due' or 'original_expected'.
// See: docs/PHASE_L1_SPEC.md Section 11.10
// ──────────────────────────────────────────────────────────────────────────────
//
// Responsibilities (Phase 3):
//   createOrder / updateOrder / transitionStatus
//   recordPayment / voidPayment
//   addLabInteraction / recordLabReminder
//   recordLayoutReceived / recordLayoutSentToClient / recordClientDecision
//   recordOriginalReceived / recordOriginalSentToClient
//   cancelOrder / completeOrder
