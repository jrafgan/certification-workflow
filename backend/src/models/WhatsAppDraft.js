'use strict';

// models/WhatsAppDraft.js — an outbound WhatsApp "Draft Package" awaiting an
// operator decision. The agent NEVER sends; it prepares a package and waits.
//
// A Draft Package always carries the three operator-facing fields required by
// the spec: reason, evidence, impact. It is bound to a specific matched order
// (a Declaration row) — never to a bare phone/contact.
//
// state machine (V1):
//   drafted → pending_approval → approved → sent           (sent = operator-performed)
//                     │              │
//                     ├─ changes_requested ─► (revised) ─► pending_approval
//                     └─ rejected
//   pending_approval → expired   (stale, never sent)
//
// Decisions: approve | reject | request_changes. Approval authorizes THIS exact
// text; any edit returns it to pending_approval and requires re-approval.

const mongoose = require('mongoose');
const { Schema } = mongoose;

const WHATSAPP_DRAFT_TYPES = [
  'missing_info',        // request missing application/order info
  'layout_notification', // notify client a layout is ready / ask approval
  'status_update',       // inform client of a status change
  'answer',              // drafted answer to a client question
];

const WHATSAPP_DRAFT_STATES = [
  'drafted',
  'pending_approval',
  'changes_requested',
  'approved',
  'sent',
  'rejected',
  'expired',
];

const WHATSAPP_DECISIONS = ['approve', 'reject', 'request_changes'];

// A single evidence item shown to the operator (what justifies this draft).
const evidenceSchema = new Schema({
  kind:   { type: String, trim: true },  // e.g. 'whatsapp_message', 'gmail_event', 'missing_field'
  ref:    { type: String, trim: true },  // id/pointer to the source record
  detail: { type: String },              // human-readable snippet
}, { _id: false });

const whatsAppDraftSchema = new Schema({
  // Binding — always to one order / Declaration row (never a bare contact)
  order_id:        { type: Schema.Types.ObjectId, ref: 'Order', required: true },
  declaration_id:  { type: Schema.Types.ObjectId, ref: 'Declaration' },
  sheet_row_id:    { type: String },
  client_name:     { type: String },
  to_phone:        { type: String, trim: true }, // matched order's client phone

  // What kind of message and the proposed text the operator will review
  draft_type:    { type: String, enum: WHATSAPP_DRAFT_TYPES, required: true },
  proposed_text: { type: String, required: true },

  // The three required operator-facing fields
  reason:   { type: String, required: true }, // why the agent proposes this
  evidence: { type: [evidenceSchema], default: [] },
  impact:   { type: String, required: true }, // what happens if approved (e.g. "message sent to client; no status change")

  // Match provenance — a draft is only as reliable as the match behind it
  match_confidence: { type: String, enum: ['HIGH', 'MEDIUM', 'LOW'], required: true },

  // State machine + operator decision
  state:      { type: String, enum: WHATSAPP_DRAFT_STATES, default: 'pending_approval' },
  decision:   { type: String, enum: [...WHATSAPP_DECISIONS, null], default: null },
  decided_by: { type: String, default: null },
  decided_at: { type: Date,   default: null },
  change_request_note: { type: String }, // operator's requested changes
  revision:   { type: Number, default: 1 },

  created_at: { type: Date, default: Date.now },
}, {
  collection: 'whatsapp_drafts',
  versionKey: false,
});

whatsAppDraftSchema.index({ order_id: 1 });
whatsAppDraftSchema.index({ state: 1 });

const WhatsAppDraft = mongoose.model('WhatsAppDraft', whatsAppDraftSchema);

module.exports = {
  WhatsAppDraft,
  WHATSAPP_DRAFT_TYPES,
  WHATSAPP_DRAFT_STATES,
  WHATSAPP_DECISIONS,
};
