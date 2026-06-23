'use strict';

// routes/payments.js — payment reconciliation → debt proposal (read-only, never writes).
//   POST /api/payments/reconcile
//     body: { phone?, legal_entity?, agreed_total?, total_paid? }  — direct numbers, or
//           { phone?, legal_entity?, messages:[{direction,body,attachments}] } — analyze a chat
//   → gated proposal { agreed_total, total_paid, debt, status, declaration_update, ... }

const express = require('express');
const router  = express.Router();
const pr = require('../services/paymentReconciliationService');

router.post('/reconcile', (req, res, next) => {
  try {
    const b = req.body || {};
    const analysis = Array.isArray(b.messages)
      ? pr.analyzeConversation(b.messages)
      : { ...pr.reconcile({ agreed_total: b.agreed_total, total_paid: b.total_paid }), candidate_quotes: [], candidate_payments: [], receipts: 0, confidence: 'LOW', needs_operator_confirmation: true };
    res.status(200).json(pr.buildProposal({ phone: b.phone, legal_entity: b.legal_entity, analysis }));
  } catch (err) { next(err); }
});

module.exports = router;
