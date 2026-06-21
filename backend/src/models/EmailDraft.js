'use strict';

// models/EmailDraft.js — an outbound LAB email draft awaiting an operator decision.
//
// Email is a LAB-ONLY channel (per the business charter: clients are reached on
// WhatsApp, never email). The Draft Email Engine prepares a complete email — recipient,
// subject, body — bound to a specific Order, and waits. It NEVER sends: gmailClient has
// no send path here, and 'approved' does not transmit. The send is operator-performed and
// recorded separately.
//
// Carries the same operator-facing contract as the other draft packages:
//   reason / evidence / impact, plus a confidence band.
//
// state machine (mirrors WhatsAppDraft):
//   pending_approval → approved → sent            (sent = operator-performed)
//        │                │
//        ├─ changes_requested ─► (revised) ─► pending_approval
//        └─ rejected
//   pending_approval → expired

const mongoose = require('mongoose');
const { Schema } = mongoose;

const EMAIL_DRAFT_TYPES = [
  'lab_request',            // initial request to the lab (send the order)
  'lab_reminder_layout',    // reminder: layout (макет) overdue
  'lab_reminder_original',  // reminder: original document overdue
  'lab_corrections',        // send corrections back to the lab
];

const EMAIL_DRAFT_STATES = [
  'pending_approval',
  'changes_requested',
  'approved',
  'sent',
  'rejected',
  'expired',
];

const EMAIL_DECISIONS = ['approve', 'reject', 'request_changes'];
const CONFIDENCE_BANDS = ['HIGH', 'MEDIUM', 'LOW'];

const evidenceSchema = new Schema({
  kind:   { type: String, trim: true },  // e.g. 'order_status', 'sla_overdue', 'lab_interaction'
  ref:    { type: String, trim: true },
  detail: { type: String },
}, { _id: false });

const emailDraftSchema = new Schema({
  // Binding — always to one order (lab communication is per-order).
  order_id:     { type: Schema.Types.ObjectId, ref: 'Order', required: true },
  sheet_row_id: { type: String },
  client_name:  { type: String },

  // The lab recipient + the proposed message the operator will review.
  to_email:      { type: String, trim: true, lowercase: true, required: true },
  lab_name:      { type: String, trim: true },
  draft_type:    { type: String, enum: EMAIL_DRAFT_TYPES, required: true },
  subject:       { type: String, required: true },
  body:          { type: String, required: true },

  // Operator-facing contract.
  reason:          { type: String, required: true },
  evidence:        { type: [evidenceSchema], default: [] },
  impact:          { type: String, required: true },
  confidence_band: { type: String, enum: CONFIDENCE_BANDS, default: 'MEDIUM' },

  // Idempotency: one open draft per (order + draft_type).
  dedupe_key: { type: String, required: true },

  // State machine + operator decision.
  state:      { type: String, enum: EMAIL_DRAFT_STATES, default: 'pending_approval' },
  decision:   { type: String, enum: [...EMAIL_DECISIONS, null], default: null },
  decided_by: { type: String, default: null },
  decided_at: { type: Date,   default: null },
  change_request_note: { type: String },
  revision:   { type: Number, default: 1 },

  created_at: { type: Date, default: Date.now },
}, {
  collection: 'email_drafts',
  versionKey: false,
});

emailDraftSchema.index({ order_id: 1 });
emailDraftSchema.index({ state: 1, created_at: -1 });
// One open draft per order + type (the generator skips when an open one already exists).
emailDraftSchema.index({ dedupe_key: 1 }, { unique: true });

const EmailDraft = mongoose.model('EmailDraft', emailDraftSchema);

module.exports = {
  EmailDraft,
  EMAIL_DRAFT_TYPES,
  EMAIL_DRAFT_STATES,
  EMAIL_DECISIONS,
};
