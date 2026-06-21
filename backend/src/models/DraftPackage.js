'use strict';

// models/DraftPackage.js — a PROPOSED ACTION awaiting operator review.
//
// A Draft Package is pure OUTPUT. The generator (services/draftPackageService.js)
// reads the inputs (Declaration, New Form, WhatsApp when enabled), and when there
// is sufficient evidence it produces one of these records describing an action it
// proposes the operator take. It NEVER executes the action: no sheet write, no
// Declaration update, no Gmail send, no WhatsApp send. The record carries the full
// six-field contract the operator needs to decide:
//
//   1. proposed_action   — the action being proposed (e.g. CREATE_DECLARATION_ROW)
//   2. reason            — why the agent proposes it (plain language)
//   3. evidence          — the signals that justify it (each pointing at a source)
//   4. confidence        — 0..100 score + a HIGH/MEDIUM/LOW band
//   5. impact            — what would change if the operator executes it
//   6. proposed_data     — the exact data that WOULD be written (not written here)
//
// Distinct from WhatsAppDraft: that models an outbound *message* draft; this models
// a proposed *action* on the workflow (today: promoting a New Form application to a
// Declaration row — the promotion gate in docs/APPLICATION_TO_ORDER_WORKFLOW.md).
//
// state machine:
//   pending  → approved   (operator approves the proposal — does NOT execute it)
//            → rejected   (operator dismisses it)
//            → superseded (a newer package replaced it)
//   approved → executed   (operator-triggered execution creates the Declaration row)
// Approval records the operator's intent only. Execution is the separate, explicitly
// gated step that actually creates the row + appends to the sheet — and only runs on
// an already-approved package (see services/draftPackageService.executeApprovedPackage).

const mongoose = require('mongoose');
const { Schema } = mongoose;

// Extensible — only the promotion action is generated today.
const PROPOSED_ACTIONS  = ['CREATE_DECLARATION_ROW'];
const PACKAGE_STATUSES  = ['pending', 'approved', 'rejected', 'superseded', 'executed'];
const CONFIDENCE_BANDS  = ['HIGH', 'MEDIUM', 'LOW'];
const PACKAGE_DECISIONS = ['approve', 'reject'];

// One justifying signal shown to the operator.
const evidenceSchema = new Schema({
  kind:   { type: String, trim: true },  // 'application' | 'payment' | 'certificate' | 'document_type' | 'duplicate_warning'
  ref:    { type: String, trim: true },  // pointer to the source (row, message id, attachment…)
  detail: { type: String },              // human-readable snippet
}, { _id: false });

// One unmet/low-quality completeness item (transparency — why confidence isn't higher).
const missingSchema = new Schema({
  field:  { type: String, trim: true },
  reason: { type: String },
}, { _id: false });

const draftPackageSchema = new Schema({
  // ── The six-field contract ──────────────────────────────────────────────────
  proposed_action: { type: String, enum: PROPOSED_ACTIONS, required: true },
  reason:          { type: String, required: true },
  evidence:        { type: [evidenceSchema], default: [] },
  confidence:      { type: Number, min: 0, max: 100, required: true },
  confidence_band: { type: String, enum: CONFIDENCE_BANDS, required: true },
  impact:          { type: String, required: true },
  // The data that WOULD be written if executed (e.g. the Declaration row fields).
  // Shape varies by proposed_action, so it is stored as-is and never acted upon here.
  proposed_data:   { type: Schema.Types.Mixed, default: {} },

  // Completeness gaps that held confidence down (operator visibility).
  missing: { type: [missingSchema], default: [] },

  // ── Provenance — where the proposal came from ────────────────────────────────
  source: {
    application_row: { type: Number },
    legal_entity:    { type: String, trim: true },
    phone:           { type: String, trim: true },
    submitted_at:    { type: Date },
  },

  // Idempotency: re-running the generator must not duplicate the same proposal.
  dedupe_key: { type: String, required: true },

  // ── State machine + operator decision ────────────────────────────────────────
  status:     { type: String, enum: PACKAGE_STATUSES, required: true, default: 'pending' },
  decision:   { type: String, enum: [...PACKAGE_DECISIONS, null], default: null },
  decided_at: { type: Date,   default: null },
  decided_by: { type: String, default: null },

  // ── Execution audit log (set once, when the approved action is executed) ──────
  // Records operator, timestamp, and the row that was created — the immutable
  // proof that this proposal was carried out.
  execution: {
    executed_by:    { type: String },
    executed_at:    { type: Date },
    declaration_id: { type: Schema.Types.ObjectId, ref: 'Declaration' },
    sheet_row_id:   { type: String },
  },

  created_at: { type: Date, default: Date.now },
}, {
  collection: 'draft_packages',
  versionKey: false,
});

// ─── Indexes ──────────────────────────────────────────────────────────────────

// Operator review: list pending proposals newest-first.
draftPackageSchema.index({ status: 1, created_at: -1 });

// Idempotency: one proposal per (action + application identity).
draftPackageSchema.index({ dedupe_key: 1 }, { unique: true });

const DraftPackage = mongoose.model('DraftPackage', draftPackageSchema);

module.exports = {
  DraftPackage,
  PROPOSED_ACTIONS,
  PACKAGE_STATUSES,
  CONFIDENCE_BANDS,
  PACKAGE_DECISIONS,
};
