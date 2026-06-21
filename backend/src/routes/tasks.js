'use strict';

// routes/tasks.js — Task API routes
//
// GET    /api/tasks                    getTasks (filter: ?status= &order_id= &type=)
// POST   /api/orders/:id/tasks         createTask (also in orders.js, duplicated for clarity)
// PATCH  /api/tasks/:id/complete       completeTask (requires confirmed: true)
// PATCH  /api/tasks/:id/snooze         snoozeTask   (requires until: ISODate)
// PATCH  /api/tasks/:id/dismiss        dismissTask
//
// Phase 4 — Tasks Engine
