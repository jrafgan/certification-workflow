'use strict';

// validators/orderValidator.js — Request validation for order routes
//
// Validates incoming request body and parameters before they reach
// the controller. Throws a VALIDATION_ERROR if any required field
// is missing, the wrong type, or contains an invalid value.
//
// Validates:
//   - createOrder: client.name, client.phone, client.contact_channel
//   - updateOrder: allowed fields only (no status, no balance_due)
//   - transitionStatus: to (valid status string), confirmed (must be true)
//   - recordClientDecision: decision (approved|corrections_requested), confirmed
//   - cancelOrder: confirmed (must be true)
//   - closeOrder: confirmed (must be true)
//
// Phase 3 — Order Service
