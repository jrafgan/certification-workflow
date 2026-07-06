'use strict';

// models/EmailLink.js — persistent, fast-lookup link between a Gmail thread (lab correspondence)
// and a client's WhatsApp number, bridged through the «Декларация» table.
//
// Why this exists: email is a LAB-only channel — clients never write to it. So «this letter belongs
// to that WhatsApp client» is INDIRECT: письмо → ЗАКАЗ (строка «Декларации») → номер (col J). The
// deep-match engine (taskInboxService.clientEmails) scores that chain by name/phone/lab/body; this
// collection caches the CONFIRMED links so the client card resolves a client's emails in one indexed
// read instead of a live Gmail round-trip, and both directions (phone→emails, email→phone) are O(index).
//
// Decision rule (operator-approved): auto-confirm ONLY when confidence is high AND the thread maps to
// exactly one phone; everything else becomes a `proposed` review item the operator confirms/rejects.
// The operator is authoritative — a re-scan never overwrites a link whose source is 'operator'.
//
// Keyed by the pair (gmail_thread_id, phone_key): one link per (letter, client number). The Declaration
// rows that justified it are kept in `sheet_rows` (the bridge, for audit / re-verification).

const mongoose = require('mongoose');
const { Schema } = mongoose;

const EMAIL_LINK_STATUSES  = ['confirmed', 'proposed', 'rejected'];
const EMAIL_LINK_SOURCES   = ['auto', 'operator'];
const EMAIL_LINK_CONFIDENCE = ['high', 'medium', 'low'];

const emailLinkSchema = new Schema({
  gmail_thread_id: { type: String, trim: true, required: true },  // the letter (thread)
  phone_key:       { type: String, trim: true, required: true },  // normalized WhatsApp number (col J)

  // The bridge: «Декларация» rows of this phone that justified the link + the client name (col D).
  sheet_rows:      { type: [String], default: [] },
  order_id:        { type: Schema.Types.ObjectId, ref: 'Order', default: null }, // if materialized
  client_name:     { type: String, trim: true },

  // Snapshot of the letter — lets the card/review render without another Gmail call.
  subject:         { type: String, trim: true },
  from_addr:       { type: String, trim: true },
  to_addr:         { type: String, trim: true },
  last_message_at: { type: Date },

  // Why we linked it (from the deep-match) — evidence for the operator + audit.
  confidence:      { type: String, enum: EMAIL_LINK_CONFIDENCE },
  signals:         { type: [String], default: [] },              // ['лаборатория','имя в теме',…]
  // Other phones the same thread also matched (populated when >1 → why it is `proposed`, not auto).
  ambiguous_phones: { type: [String], default: [] },

  status:          { type: String, enum: EMAIL_LINK_STATUSES, default: 'proposed', required: true },
  source:          { type: String, enum: EMAIL_LINK_SOURCES, default: 'auto', required: true },
  set_by:          { type: String, trim: true, default: 'agent' },

  reverified_at:   { type: Date },
}, {
  collection: 'email_links',
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  versionKey: false,
});

// One link per (letter, client number) — idempotent upsert key.
emailLinkSchema.index({ gmail_thread_id: 1, phone_key: 1 }, { unique: true });
// Fast lookups: phone → its emails (card), letter → its client (reverse), review queue.
emailLinkSchema.index({ phone_key: 1, status: 1 });
emailLinkSchema.index({ gmail_thread_id: 1 });
emailLinkSchema.index({ status: 1, updated_at: -1 });

const EmailLink = mongoose.models.EmailLink || mongoose.model('EmailLink', emailLinkSchema);

module.exports = { EmailLink, EMAIL_LINK_STATUSES, EMAIL_LINK_SOURCES, EMAIL_LINK_CONFIDENCE };
