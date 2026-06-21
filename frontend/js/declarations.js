// js/declarations.js — Declarations view page logic
//
// Loaded by views/declarations.html.
//
// On page load:
//   1. Call api.declarations.getAll()
//   2. Render declarations table with sync status badges
//
// Sync status filter tabs: All | Synced | Pending | Conflict | Error
//
// Conflict resolution UI:
//   For declarations with sync_status = 'conflict':
//     - Show system value vs sheet value side by side
//     - "Keep system" button → api.declarations.resolveConflict(id, 'system')
//     - "Keep sheet" button  → api.declarations.resolveConflict(id, 'sheet')
//
// Manual sync trigger:
//   "Sync now" button → calls api.integrations.syncSheets(),
//   shows result count, refreshes the list.
