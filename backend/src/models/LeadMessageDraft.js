'use strict';

// models/LeadMessageDraft.js — a proposed OUTBOUND message to a social-media lead,
// awaiting operator release. The Lead Conversion Agent NEVER sends autonomously: even the
// spec's "automatic replies allowed" categories (pricing ranges, timelines, required docs,
// PI/TN VED explanations, reminders) are generated here as drafts and a human releases them.
// `auto_allowed` records that the spec permits auto-release for this kind — a future toggle
// could one-click/auto-release those — but the default is operator-in-the-loop, consistent
// with the system-wide never-auto-send rule.
//
// Operator-gated kinds (exact pricing, calculation, payment, order creation, status, lab
// email, document edits) are auto_allowed:false and always require a decision.
//
// state machine:
//   pending_approval → approved → sent      (sent = operator/adapter-performed)
//        ├─ changes_requested ─► pending_approval
//        └─ rejected

const mongoose = require('mongoose');
const { Schema } = mongoose;

const DRAFT_KINDS = [
  'greeting',              // Stage 1 — first response
  'education',             // Stage 3 — pricing ranges / timelines / docs / PI / TN VED
  'application_link',      // Stage 4 — send the application link + how to fill
  'reminder',              // Stage 5 — 24h / 72h / 7d follow-up
  'calculation_offer',     // Stage 7 — preliminary calc (GATED: operator approves)
  'payment_instructions',  // Stage 8 — amount + how to pay (GATED: follows approved calc)
  'whatsapp_request',      // Stage 10 — ask for the primary WhatsApp number
  'recovery',              // Stage 11 — 30/60/90-day recovery (GATED: operator approves)
];

const DRAFT_STATES    = ['pending_approval', 'changes_requested', 'approved', 'sent', 'rejected'];
const DRAFT_DECISIONS = ['approve', 'reject', 'request_changes'];

const leadMessageDraftSchema = new Schema({
  lead_id:   { type: Schema.Types.ObjectId, ref: 'Lead', required: true },
  platform:  { type: String, required: true },
  to_handle: { type: String, required: true, trim: true },

  kind:          { type: String, enum: DRAFT_KINDS, required: true },
  auto_allowed:  { type: Boolean, default: false },  // spec permits auto-release (still drafted)
  proposed_text: { type: String, required: true },
  language:      { type: String },

  // Operator-facing contract.
  reason: { type: String, required: true },
  impact: { type: String, required: true },
  // Optional structured payload (e.g. the PI calc behind a calculation_offer).
  payload: { type: Schema.Types.Mixed, default: null },

  // Idempotency: one open draft per (lead + kind + window).
  dedupe_key: { type: String, required: true },

  // State machine + operator decision.
  state:      { type: String, enum: DRAFT_STATES, default: 'pending_approval' },
  decision:   { type: String, enum: [...DRAFT_DECISIONS, null], default: null },
  decided_by: { type: String, default: null },
  decided_at: { type: Date,   default: null },
  released_at:{ type: Date,   default: null },  // when the adapter actually delivered it
  change_request_note: { type: String },
  revision:   { type: Number, default: 1 },

  created_at: { type: Date, default: Date.now },
}, {
  collection: 'lead_message_drafts',
  versionKey: false,
});

leadMessageDraftSchema.index({ lead_id: 1, created_at: -1 });
leadMessageDraftSchema.index({ state: 1, created_at: -1 });
leadMessageDraftSchema.index({ dedupe_key: 1 }, { unique: true });

const LeadMessageDraft = mongoose.model('LeadMessageDraft', leadMessageDraftSchema);

module.exports = { LeadMessageDraft, DRAFT_KINDS, DRAFT_STATES, DRAFT_DECISIONS };
