// js/dashboard.js — Dashboard page logic
//
// Loaded by views/dashboard.html.
//
// On page load:
//   1. Call api.dashboard.getAttention()
//   2. Render each attention section (OVERDUE, DUE_TODAY, ACTION_NEEDED,
//      DEBT, STALE, OPEN_TASKS) using the data returned
//   3. Show "All clear" state if no sections have items
//
// Inline task actions (without navigating away):
//   - Complete task: calls api.tasks.complete(), shows confirm dialog first
//   - Snooze task: shows date picker, calls api.tasks.snooze()
//
// Each order row links to views/order-detail.html?id=<orderId>.
//
// Auto-refresh: page reloads attention data every 5 minutes.
