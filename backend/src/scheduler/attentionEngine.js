'use strict';

// scheduler/attentionEngine.js — Deadline and attention condition evaluator
//
// Core scheduler logic. Evaluates all active orders against the 9 attention
// conditions defined in docs/WORKFLOW_EVENTS.md — How Events Create Tasks.
//
// For each active order (NEW, WAITING_PAYMENT, IN_LAB, WAITING_CLIENT_APPROVAL, WAITING_ORIGINAL, READY_FOR_DELIVERY):
//   1. SYS_NEW_ORDER_STALE       → task: stale_intake    (medium)
//   2. SYS_LAB_DEADLINE_TODAY     → task: remind_lab      (medium)
//   3. SYS_LAB_DEADLINE_MISSED    → task: remind_lab      (high)
//   4. SYS_LAYOUT_NOT_SENT        → task: send_layout     (high)
//   5. SYS_CLIENT_RESPONSE_DUE_TODAY → task: follow_up_client (medium)
//   6. SYS_CLIENT_RESPONSE_OVERDUE   → task: follow_up_client (high)
//   7. SYS_ORIGINAL_OVERDUE       → task: remind_lab      (high)
//   8. SYS_ORIGINAL_NOT_SENT      → task: send_original   (high)
//   9. SYS_DEBT_FLAGGED (READY_FOR_DELIVERY + balance_due > 0) → task: check_payment (high)
//
// SYS events are appended to the order only when newly detected (not on every run).
// Task creation uses taskService.createTask() which handles deduplication.
// taskService.unsnoozeStaleTasks() is called at the start of each run.
//
// Exports:
//   run()  — executes one full evaluation pass, returns run summary object
//
// SCHEDULER_FIRST_RUN=true limits first run to high-priority tasks only
// to prevent dashboard flood on initial deployment.
//
// Phase 8 — Attention Engine
