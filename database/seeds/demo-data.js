'use strict';

// database/seeds/demo-data.js — Development seed data
//
// Creates a set of demo orders in different lifecycle states for
// development and frontend testing.
//
// NEVER run against a production database.
// Clears existing demo orders (identified by client.notes = 'DEMO') before inserting.
//
// Usage:
//   node database/seeds/demo-data.js
//
// Demo orders created:
//   1. NEW                     — new application from form, no quote yet
//   2. NEW                     — stale (created > 3 days ago, no movement) → triggers stale alert
//   3. IN_LAB                  — lab contacted, deadline tomorrow
//   4. IN_LAB                  — lab overdue by 2 days → triggers overdue alert
//   5. WAITING_CLIENT_APPROVAL — layout sent, client response due today
//   6. WAITING_CLIENT_APPROVAL — client response overdue → triggers overdue alert
//   7. WAITING_ORIGINAL        — client approved, original expected in 3 days
//   8. READY_FOR_DELIVERY      — original received, balance_due > 0 → triggers debt alert
//   9. COMPLETED               — completed order (for history view)
//  10. CANCELLED               — cancelled order (for history view)
