'use strict';

// controllers/dashboardController.js — HTTP handlers for dashboard routes
//
// Handlers:
//   getAttention    — grouped attention view (OVERDUE, DUE_TODAY, etc.)
//   getActiveOrders — full active order list, sorted by updated_at desc
//   getClosedOrders — closed orders, paginated
//   getCancelledOrders — cancelled orders, paginated
//
// Rule: no try/catch here. All errors propagate to middleware/errorHandler.js.
//
// Phase 5 — Dashboard API
