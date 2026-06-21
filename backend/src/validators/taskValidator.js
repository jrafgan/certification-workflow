'use strict';

// validators/taskValidator.js — Request validation for task routes
//
// Validates:
//   - createTask: order_id (valid ObjectId), type (enum), description (non-empty),
//                 priority (enum), due_date (valid ISO date)
//   - completeTask: confirmed (must be true)
//   - snoozeTask: until (valid ISO date, must be in the future)
//
// Phase 4 — Tasks Engine
