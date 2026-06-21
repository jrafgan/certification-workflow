// js/utils.js — Shared frontend helpers
//
// Pure utility functions used across all page scripts.
// No API calls, no DOM manipulation beyond creating elements.
//
// Functions to implement:
//   formatDate(isoString)          — "12 Jun 2026"
//   formatDateTime(isoString)      — "12 Jun 2026, 09:41"
//   formatCurrency(amount)         — "1 500,00 ₸" (adapt to business locale)
//   daysSince(isoString)           — integer, positive = past
//   statusLabel(statusCode)        — "New", "Waiting Payment", "In Lab", "Waiting Client Approval", "Waiting Original", "Ready for Delivery", "Completed", "Cancelled"
//   statusBadgeClass(statusCode)   — CSS class for status badge
//   priorityBadgeClass(priority)   — CSS class for priority badge
//   syncStatusBadgeClass(syncStatus) — CSS class for sync status badge
//   createElement(tag, className, text) — shorthand DOM helper
//   showToast(message, type)       — temporary notification (success/error/warning)
//   showConfirm(message)           — returns Promise<boolean>, used before confirmed actions
