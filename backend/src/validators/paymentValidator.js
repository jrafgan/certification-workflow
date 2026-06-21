'use strict';

// validators/paymentValidator.js — Request validation for payment operations
//
// Validates:
//   - recordPayment: date (valid ISO date), amount (positive number), method (enum)
//   - voidPayment: voided_reason (non-empty string)
//
// Phase 3 — Order Service
