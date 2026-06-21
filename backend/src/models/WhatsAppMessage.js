'use strict';

// models/WhatsAppMessage.js — inbound (and recorded outbound) WhatsApp messages.
//
// This is REPLICA / working data only. WhatsApp is the client communication
// channel; this collection is a read-only-from-source copy used for matching and
// evidence. It is NOT a source of truth and never drives a Declaration write on
// its own (see WHATSAPP_AGENT_V1_SPEC.md, recommendation mode).
//
// match_status state machine (V1):
//   received → matched            (phone resolved to exactly one order)
//   received → needs_review       (phone resolved to multiple candidate orders)
//   received → unmatched          (phone matched no order / unknown contact)

const mongoose = require('mongoose');
const { Schema } = mongoose;

const WHATSAPP_DIRECTIONS    = ['inbound', 'outbound'];
const WHATSAPP_MATCH_STATUSES = ['received', 'matched', 'needs_review', 'unmatched'];

// Attachment metadata only — V1 records what came in; it does not forward files.
const attachmentSchema = new Schema({
  file_name: { type: String, trim: true },
  mime_type: { type: String, trim: true },
  size:      { type: Number, min: 0 },
  // provider-side reference (e.g. media id); the binary is not stored in V1
  media_ref: { type: String, trim: true },
}, { _id: false });

// One candidate order produced by phone matching (kept for operator review).
const candidateSchema = new Schema({
  order_id:     { type: Schema.Types.ObjectId, ref: 'Order' },
  declaration_id: { type: Schema.Types.ObjectId, ref: 'Declaration' },
  sheet_row_id: { type: String },
  client_name:  { type: String },
  document_type: { type: String },
  status:       { type: String }, // raw Declaration status (may be dirty)
}, { _id: false });

const whatsAppMessageSchema = new Schema({
  // Provider-agnostic identifiers (transport decided at integration time)
  provider_message_id: { type: String, trim: true },
  provider:            { type: String, trim: true }, // e.g. 'cloud_api', 'import'
  conversation_ref:    { type: String, trim: true },

  direction: { type: String, enum: WHATSAPP_DIRECTIONS, default: 'inbound' },

  // Raw + normalized phone (normalized via phoneUtils.matchKey at ingest)
  from_phone:     { type: String, trim: true },
  phone_key:      { type: String, trim: true }, // canonical match key (last 9 local digits)

  // WhatsApp LID (Linked Identity) — set when the sender is addressed by "<digits>@lid"
  // instead of a phone. from_phone/phone_key above are then either the RESOLVED phone
  // (live or stored) or empty (LID-only). See services/whatsappLidService.js.
  lid:               { type: String, trim: true },
  lid_key:           { type: String, trim: true },
  phone_resolution:  { type: String, enum: ['phone', 'resolved_lid', 'stored_lid', 'lid_only', null], default: null },
  phone_resolved_at: { type: Date },

  body:        { type: String },
  attachments: { type: [attachmentSchema], default: [] },
  sent_at:     { type: Date },

  // Matching outcome
  match_status:  { type: String, enum: WHATSAPP_MATCH_STATUSES, default: 'received' },
  matched_order_id: { type: Schema.Types.ObjectId, ref: 'Order' }, // set only when uniquely matched
  candidates:    { type: [candidateSchema], default: [] },
  match_confidence: { type: String, enum: ['HIGH', 'MEDIUM', 'LOW', null], default: null },

  received_at: { type: Date, default: Date.now },
}, {
  collection: 'whatsapp_messages',
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  versionKey: false,
});

// Indexes — match by canonical phone key; dedupe by provider id.
whatsAppMessageSchema.index({ phone_key: 1 });
whatsAppMessageSchema.index({ lid: 1 });
whatsAppMessageSchema.index({ provider_message_id: 1 }, { unique: true, sparse: true });
whatsAppMessageSchema.index({ match_status: 1 });

const WhatsAppMessage = mongoose.model('WhatsAppMessage', whatsAppMessageSchema);

module.exports = { WhatsAppMessage, WHATSAPP_DIRECTIONS, WHATSAPP_MATCH_STATUSES };
