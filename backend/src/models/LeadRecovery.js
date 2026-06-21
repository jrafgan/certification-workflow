'use strict';

// models/LeadRecovery.js — a proposed action to recover a STALLED lead, awaiting an
// operator decision.
//
// A "lead" is an order or an intake application that has gone quiet on the CLIENT side
// (e.g. a layout was sent for approval and the client never responded; an order sits
// unpaid; a New Form application never progressed). The Lead Recovery Engine detects the
// stall and prepares a re-engagement message for operator review.
//
// HARD RULE — OUTPUT ONLY. Clients are reached on WhatsApp ONLY (never email); the
// proposed_text is a WhatsApp follow-up. The engine NEVER sends and never changes order
// status. 'approve' authorizes the text; the send is operator-performed.
//
// state machine:
//   pending → approved → sent          (sent = operator-performed)
//      │          │
//      ├─ changes_requested ─► pending
//      └─ rejected
//   pending → superseded

const mongoose = require('mongoose');
const { Schema } = mongoose;

const LEAD_STAGES = [
  'awaiting_client_approval', // layout sent for approval; no client decision
  'awaiting_payment',         // order launched; payment/info not received
  'stale_application',        // intake application never progressed
];

const LEAD_STATES     = ['pending', 'changes_requested', 'approved', 'sent', 'rejected', 'superseded'];
const LEAD_DECISIONS  = ['approve', 'reject', 'request_changes'];
const SEVERITIES      = ['LOW', 'MEDIUM', 'HIGH'];
const CONFIDENCE_BANDS = ['HIGH', 'MEDIUM', 'LOW'];

const evidenceSchema = new Schema({
  kind:   { type: String, trim: true },  // 'order_status' | 'idle' | 'deadline_passed' | 'application'
  ref:    { type: String, trim: true },
  detail: { type: String },
}, { _id: false });

const leadRecoverySchema = new Schema({
  proposed_action: { type: String, default: 'RECOVER_LEAD' },

  // Provenance — order-based or application-based lead.
  source:          { type: String, enum: ['order', 'application'], required: true },
  order_id:        { type: Schema.Types.ObjectId, ref: 'Order' },
  application_ref: { type: String, trim: true },   // e.g. 'application_row:42'

  // Who to re-engage (WhatsApp channel only).
  client_name: { type: String },
  to_phone:    { type: String, trim: true },
  channel:     { type: String, default: 'whatsapp' },

  // The stall + the proposed re-engagement.
  lead_stage:    { type: String, enum: LEAD_STAGES, required: true },
  severity:      { type: String, enum: SEVERITIES, default: 'LOW' },
  days_idle:     { type: Number },
  proposed_text: { type: String, required: true },

  // Operator-facing contract.
  reason:          { type: String, required: true },
  evidence:        { type: [evidenceSchema], default: [] },
  impact:          { type: String, required: true },
  confidence_band: { type: String, enum: CONFIDENCE_BANDS, default: 'MEDIUM' },

  // Idempotency: one open recovery per (lead + stage).
  dedupe_key: { type: String, required: true },

  // State machine + operator decision.
  state:      { type: String, enum: LEAD_STATES, default: 'pending' },
  decision:   { type: String, enum: [...LEAD_DECISIONS, null], default: null },
  decided_by: { type: String, default: null },
  decided_at: { type: Date,   default: null },
  change_request_note: { type: String },
  revision:   { type: Number, default: 1 },

  created_at: { type: Date, default: Date.now },
}, {
  collection: 'lead_recoveries',
  versionKey: false,
});

leadRecoverySchema.index({ state: 1, severity: 1, created_at: -1 });
leadRecoverySchema.index({ dedupe_key: 1 }, { unique: true });

const LeadRecovery = mongoose.model('LeadRecovery', leadRecoverySchema);

module.exports = {
  LeadRecovery,
  LEAD_STAGES,
  LEAD_STATES,
  LEAD_DECISIONS,
  SEVERITIES,
};
