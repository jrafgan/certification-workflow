'use strict';

// models/WaAutoReply.js — one record per inbound WhatsApp message the auto-responder handled.
//
// Why this exists: the auto-responder must be AUDITABLE. In shadow mode it records what it WOULD
// have sent without sending; in auto mode it records what it actually sent (or that it deferred
// to the operator). One doc per inbound message (idempotent by provider_message_id) so a webhook
// retry never double-answers.
//
// decision:
//   auto_sent — auto-eligible KB answer was SENT (mode=auto)
//   gated     — not auto-eligible / no grounded answer → left for the operator (never sent)
//   shadow    — mode=shadow: an answer was composed but deliberately NOT sent (observe-only)
//   skipped   — a guard tripped (group, from_me, no text, recent human reply, duplicate)

const mongoose = require('mongoose');
const { Schema } = mongoose;

const WA_AUTOREPLY_DECISIONS = ['auto_sent', 'gated', 'shadow', 'skipped'];
const WA_AUTOREPLY_MODES     = ['off', 'shadow', 'auto'];

// The five KB-approved auto-eligible kinds + 'other' (everything else → gated).
const WA_AUTOREPLY_KINDS = [
  'service_info', 'pricing_from_kb', 'timelines_from_kb',
  'application_link', 'application_instructions', 'other',
];

const waAutoReplySchema = new Schema({
  // Idempotency — one decision per inbound message. Unique.
  provider_message_id: { type: String, trim: true, required: true, unique: true },

  phone_key:  { type: String, trim: true, index: true },
  to_phone:   { type: String, trim: true },
  inbound_text: { type: String },

  // Classification + composition.
  kind:          { type: String, enum: WA_AUTOREPLY_KINDS, default: 'other' },
  topic:         { type: String, trim: true },   // e.g. client_faq q-key or 'application'
  matched_kb_ref: { type: String, trim: true },  // provenance of the answer (KB q / setting key)
  answer_text:   { type: String },               // what was (or would be) sent

  // Outcome.
  mode:        { type: String, enum: WA_AUTOREPLY_MODES, default: 'shadow' },
  decision:    { type: String, enum: WA_AUTOREPLY_DECISIONS, required: true },
  skip_reason: { type: String, trim: true },
  send_result: { type: Schema.Types.Mixed },     // outboundWhatsappService result on auto_sent
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

const WaAutoReply = mongoose.models.WaAutoReply || mongoose.model('WaAutoReply', waAutoReplySchema);

module.exports = { WaAutoReply, WA_AUTOREPLY_DECISIONS, WA_AUTOREPLY_MODES, WA_AUTOREPLY_KINDS };
