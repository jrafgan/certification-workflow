'use strict';

// controllers/orderController.js — HTTP handlers for order routes
//
// Extracts and validates request parameters, calls orderService,
// and formats the HTTP response. Contains no business logic.
//
// Handlers (one per route in routes/orders.js):
//   createOrder, getOrders, getOrderById, updateOrder,
//   transitionStatus, recordPayment, voidPayment,
//   addLabInteraction, recordLabReminder,
//   recordLayoutReceived, recordLayoutSentToClient, recordClientDecision,
//   recordOriginalReceived, recordOriginalSentToClient,
//   cancelOrder, closeOrder
//
// Rule: no try/catch here. All errors propagate to middleware/errorHandler.js.
//
// Phase 3 — Order Service
