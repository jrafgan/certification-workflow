'use strict';

// models/AuditPackage.js — a Workflow Auditor finding awaiting operator review.
//
// The auditor compares the order's CURRENT status (the Declaration is the source of
// truth) against the status the EVIDENCE implies — payment receipts, WhatsApp, Gmail /
// laboratory correspondence, generated documents — and packages the discrepancy for the
// operator. It treats status as an OPERATIONAL indicator: besides proposing a corrected
// status it surfaces stale statuses, missing transitions, delayed/forgotten orders, and
// contradictory states (business visibility, bottleneck detection, workload control).
//
// HARD RULE — OUTPUT ONLY. The auditor NEVER changes status. It reads evidence and writes
// only its OWN store (audit_packages). 'approve' records the operator's authorization of a
// proposed status change; it does NOT perform the change (that stays an operator action —
// no automatic status updates). Statuses are the 7 canonical Russian values, used verbatim.
//
// state machine:
//   pending → approved      (operator authorizes the proposed change — does NOT apply it)
//           → rejected       (operator dismisses the finding)
//           → acknowledged   (health flag noted; no status change proposed)
//           → superseded     (a newer audit replaced it)

const mongoose = require('mongoose');
const { Schema } = mongoose;

// What the audit is about.
const AUDIT_KINDS = ['status_recommendation', 'health_flag', 'in_sync'];

// Operational findings (status as an indicator). Orthogonal to the status proposal.
const FINDING_TYPES = [
  'stale_status',        // no activity for too long while still active
  'missing_transition',  // evidence shows a later stage than the current status
  'delayed_order',       // a deadline/SLA for the current waiting status has passed
  'forgotten_order',     // very long inactivity — likely dropped
  'contradictory_state', // current status claims more progress than evidence supports
  'unrecognized_status', // current status is not one of the 7 canonical values
];

const AUDIT_STATES    = ['pending', 'approved', 'rejected', 'acknowledged', 'superseded'];
const AUDIT_DECISIONS = ['approve', 'reject', 'acknowledge'];
const CONFIDENCE_BANDS = ['HIGH', 'MEDIUM', 'LOW'];

// One piece of supporting evidence, tagged by its source (the required evidence sources).
const evidenceSchema = new Schema({
  source: { type: String, trim: true },  // declaration|whatsapp|gmail|payment_receipt|generated_document|lab_correspondence
  detail: { type: String },
  at:     { type: Date },
}, { _id: false });

const findingSchema = new Schema({
  type:     { type: String, enum: FINDING_TYPES },
  detail:   { type: String },
  severity: { type: String, enum: ['LOW', 'MEDIUM', 'HIGH'], default: 'MEDIUM' },
}, { _id: false });

const auditPackageSchema = new Schema({
  proposed_action: { type: String, default: 'AUDIT_ORDER_STATUS' },
  audit_kind:      { type: String, enum: AUDIT_KINDS, required: true },

  // Binding — the matched order / Declaration row this audit is about.
  order_id:       { type: Schema.Types.ObjectId, ref: 'Order' },
  declaration_id: { type: Schema.Types.ObjectId, ref: 'Declaration' },
  sheet_row_id:   { type: String },
  client_name:    { type: String },

  // ── The AUDIT PACKAGE contract ───────────────────────────────────────────────
  current_status:  { type: String, required: true },   // canonical RU status (as declared)
  proposed_status: { type: String, default: null },    // canonical RU status, or null = no change
  confidence:      { type: Number, min: 0, max: 100, required: true },
  confidence_band: { type: String, enum: CONFIDENCE_BANDS, required: true },
  // Whether confidence is high enough to actively RECOMMEND the change (vs. observe only).
  // Low-confidence / ambiguous audits never auto-recommend.
  recommend:       { type: Boolean, default: false },
  evidence:        { type: [evidenceSchema], default: [] },
  reasoning:       { type: String, required: true },
  findings:        { type: [findingSchema], default: [] },
  impact:          { type: String, required: true },

  // Idempotency: one open audit per (order + current_status + proposed_status).
  dedupe_key: { type: String, required: true },

  // State machine + operator decision.
  state:      { type: String, enum: AUDIT_STATES, required: true, default: 'pending' },
  decision:   { type: String, enum: [...AUDIT_DECISIONS, null], default: null },
  decided_by: { type: String, default: null },
  decided_at: { type: Date,   default: null },

  created_at: { type: Date, default: Date.now },
}, {
  collection: 'audit_packages',
  versionKey: false,
});

auditPackageSchema.index({ state: 1, confidence: -1, created_at: -1 });
auditPackageSchema.index({ dedupe_key: 1 }, { unique: true });

const AuditPackage = mongoose.model('AuditPackage', auditPackageSchema);

module.exports = {
  AuditPackage,
  AUDIT_KINDS,
  FINDING_TYPES,
  AUDIT_STATES,
  AUDIT_DECISIONS,
};
