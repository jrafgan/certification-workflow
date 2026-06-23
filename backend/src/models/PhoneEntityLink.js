'use strict';

// models/PhoneEntityLink.js — Phone ↔ Legal Entity Registry (Phase 2).
//
// A first-class, persisted mapping between a WhatsApp number and a legal entity
// (ИП / ОсОО / ООО). KB §2: "store this relationship." The business invariant is
// ONE WhatsApp number → ONE CONFIRMED legal entity; this is enforced by a partial
// unique index on phone_key for status='confirmed'.
//
// Lifecycle is operator-gated and recommend-only — creating a link only PROPOSES it;
// it never writes to Declaration / Google Sheets / Email / WhatsApp. An operator
// confirms (or rejects) proposals. Resolution (resolve by phone, find by entity) is
// what order / application / email matching and status verification consume.

const mongoose = require('mongoose');
const { Schema } = mongoose;

// Where the proposed link came from (evidence provenance, not a trust ranking).
const LINK_SOURCES = ['application', 'conversation', 'certificate', 'declaration', 'operator'];

// proposed  → awaiting operator review
// confirmed → operator-approved; the authoritative number↔entity binding (unique per number)
// rejected  → operator dismissed it
// superseded→ a previously confirmed link replaced by a new confirmed entity for the number
const LINK_STATUSES = ['proposed', 'confirmed', 'rejected', 'superseded'];

const evidenceSchema = new Schema({
  kind:   { type: String },   // e.g. 'whatsapp_message', 'application_row', 'ip_certificate'
  detail: { type: String },
  at:     { type: Date, default: Date.now },
}, { _id: false });

const phoneEntityLinkSchema = new Schema({
  // Canonical match key (phoneUtils.matchKey) — the join key used by all matchers.
  phone_key:    { type: String, required: true, trim: true },
  phone_raw:    { type: String, trim: true },

  legal_entity: { type: String, required: true, trim: true },  // e.g. "ОсОО Мегуми"
  client_name:  { type: String, trim: true },                  // optional contact person

  // Optional links to the records this binding was derived from / applies to.
  order_id:       { type: Schema.Types.ObjectId, ref: 'Order' },
  declaration_id: { type: Schema.Types.ObjectId, ref: 'Declaration' },

  source: { type: String, enum: LINK_SOURCES, required: true },
  status: { type: String, enum: LINK_STATUSES, required: true, default: 'proposed' },

  // Set when a proposal is created against a number that already has a DIFFERENT confirmed
  // entity — surfaces the row for operator review instead of silently competing.
  conflict:         { type: Boolean, default: false },
  conflict_detail:  { type: String },

  evidence: { type: [evidenceSchema], default: [] },
  notes:    { type: String },

  created_at:   { type: Date, default: Date.now },
  confirmed_by: { type: String },
  confirmed_at: { type: Date },
  rejected_by:  { type: String },
  rejected_at:  { type: Date },
}, {
  collection: 'phone_entity_links',
  versionKey: false,
});

// ─── Indexes ──────────────────────────────────────────────────────────────────

// All matchers look up by phone_key.
phoneEntityLinkSchema.index({ phone_key: 1 });

// The invariant: at most ONE confirmed entity per number. Partial unique index so
// proposed/rejected/superseded rows never collide.
phoneEntityLinkSchema.index(
  { phone_key: 1 },
  { unique: true, partialFilterExpression: { status: 'confirmed' } }
);

// Reverse lookup: entity → numbers (entity-based matching).
phoneEntityLinkSchema.index({ legal_entity: 1 }, { collation: { locale: 'en', strength: 2 } });

// Operator review queues scan by status / conflict.
phoneEntityLinkSchema.index({ status: 1, conflict: 1 });

const PhoneEntityLink = mongoose.model('PhoneEntityLink', phoneEntityLinkSchema);

module.exports = { PhoneEntityLink, LINK_SOURCES, LINK_STATUSES };
