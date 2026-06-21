// js/api.js — Central HTTP client
//
// Wraps fetch() for all API calls to the backend.
// All other JS files call functions from this module — never fetch() directly.
//
// Responsibilities:
//   - Set base URL (reads from a config constant or window.location.origin)
//   - Set Content-Type: application/json on all requests
//   - Parse JSON responses
//   - Normalise error responses into a consistent { code, message } shape
//   - Expose typed functions for each API endpoint group:
//
//   api.orders.*        — order CRUD and lifecycle actions
//   api.tasks.*         — task operations
//   api.declarations.*  — declaration queries and conflict resolution
//   api.dashboard.*     — attention and order list queries
//   api.integrations.*  — manual sync triggers
