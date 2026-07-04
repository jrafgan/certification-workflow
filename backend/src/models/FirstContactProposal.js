'use strict';

// models/FirstContactProposal.js — a GATED proposal to make FIRST contact with a number
// that appears in a New Form application but has NEVER messaged us.
//
// Why this exists: a new application can carry a WhatsApp number we've never heard from.
// The agent proposes verifying it ("оставляли ли вы заявку?"), but NEVER sends on its own —
// the operator approves, and the send goes out as a Meta-approved TEMPLATE (free text to a
// cold number is rejected by WhatsApp). See services/firstContactService.js.
//
// HARD RULE — OUTPUT ONLY until approved. The scan writes only this store; 'approve'
// authorizes (and performs, operator-triggered) the template send.
//
// state machine:
//   pending_approval → approved → sent      (sent = template delivered after approval)
//        │
//        └─ rejected
//   pending_approval → superseded            (e.g. the client wrote us first → no longer cold)

const mongoose = require('mongoose');
const { Schema } = mongoose;

const FIRST_CONTACT_STATES    = ['pending_approval', 'approved', 'sent', 'rejected', 'superseded'];
const FIRST_CONTACT_DECISIONS = ['approve', 'reject'];

const evidenceSchema = new Schema({
  kind:   { type: String, trim: true },  // 'application' | 'no_inbound'
  ref:    { type: String, trim: true },
  detail: { type: String },
}, { _id: false });

const firstContactProposalSchema = new Schema({
  proposed_action: { type: String, default: 'FIRST_CONTACT_CHECK' },

  // Source of the proposal: a New Form applicant we've never heard from, or someone who
  // showed certification INTEREST in a chat/group (interestDetectionService).
  source:  { type: String, enum: ['new_form_application', 'chat_interest'], default: 'new_form_application' },
  context: { type: String },                      // e.g. group name, or 'личка', for chat_interest

  // Provenance — the New Form application row this number came from (new_form_application).
  application_ref: { type: String, trim: true },  // e.g. 'application_row:42'
  client_name:     { type: String },
  display_name:    { type: String },              // sender pushname (chat_interest)

  // For chat_interest: a free-text first-contact message to send via the active channel
  // (GOWA) through the anti-ban gate. When set, decide() sends THIS instead of a template.
  proposed_text:   { type: String },

  // Who to contact (WhatsApp only) — phone_key is the idempotency key (one proposal/number).
  to_phone:  { type: String, trim: true },
  phone_key: { type: String, trim: true, required: true },

  // What will be sent on approval — a pre-approved template (env-configured).
  template_name: { type: String, trim: true },
  template_lang: { type: String, trim: true, default: 'ru' },

  // Operator-facing contract.
  reason:   { type: String, required: true },
  evidence: { type: [evidenceSchema], default: [] },
  impact:   { type: String, required: true },

  // State machine + operator decision.
  state:      { type: String, enum: FIRST_CONTACT_STATES, default: 'pending_approval' },
  decision:   { type: String, enum: [...FIRST_CONTACT_DECISIONS, null], default: null },
  decided_by: { type: String, default: null },
  decided_at: { type: Date,   default: null },
  sent_at:    { type: Date },
  send_result: { type: Schema.Types.Mixed }, // Graph API result on send (message_id / error)

  created_at: { type: Date, default: Date.now },
}, {
  collection: 'first_contact_proposals',
  versionKey: false,
});

// One open proposal per number — idempotent scans.
firstContactProposalSchema.index({ phone_key: 1 }, { unique: true });
firstContactProposalSchema.index({ state: 1 });

const FirstContactProposal = mongoose.model('FirstContactProposal', firstContactProposalSchema);

module.exports = { FirstContactProposal, FIRST_CONTACT_STATES, FIRST_CONTACT_DECISIONS };
