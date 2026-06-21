'use strict';

// utils/responseUtils.js — Consistent HTTP response formatting
//
// Wraps Express res.json() calls in a consistent envelope shape.
//
// Functions to implement:
//   ok(res, data)           — HTTP 200, body: { success: true, data }
//   created(res, data)      — HTTP 201, body: { success: true, data }
//   noContent(res)          — HTTP 204, no body
//   paginated(res, data, pagination)
//     — HTTP 200, body: { success: true, data, pagination: { page, limit, total } }
//
// Controllers call these instead of res.json() directly.
//
// Phase 1 — Project Skeleton
