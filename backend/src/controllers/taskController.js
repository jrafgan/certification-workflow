'use strict';

// controllers/taskController.js — HTTP handlers for task routes
//
// Handlers:
//   getTasks, getTasksByOrder, createTask,
//   completeTask, snoozeTask, dismissTask
//
// completeTask requires confirmed = true in the request body.
// This is validated by orderValidator before reaching the service.
//
// Rule: no try/catch here. All errors propagate to middleware/errorHandler.js.
//
// Phase 4 — Tasks Engine
