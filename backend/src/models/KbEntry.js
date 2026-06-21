'use strict';

// models/KbEntry.js — one piece of extracted knowledge (a rule / fact / price /
// timeline / FAQ / open question) awaiting operator review.
//
// GATING RULES (hard):
//   • Every entry is created needs_review:true, status:'pending'. Nothing extracted
//     from YouTube is ever auto-activated.
//   • Only status:'approved' entries may be used by the WhatsApp agent. The query
//     helper getApprovedKnowledge returns approved-only.
//   • Operator knowledge ALWAYS overrides YouTube knowledge: an operator can reject
//     or supersede any entry, and approved entries reflect operator-blessed content.
//
// This is research/replica data; it never writes the Declaration, Gmail, or WhatsApp.

const mongoose = require('mongoose');
const { Schema } = mongoose;

// The Knowledge Base categories (requirement).
const KB_CATEGORIES = [
  'Certificates',
  'Declarations',
  'TN VED',
  'PI Calculations',
  'Laboratories',
  'Payments',
  'Samples',
  'Client Communication',
  'FAQ',
];

const KB_ENTRY_TYPES = ['rule', 'fact', 'price', 'timeline', 'faq', 'question'];
const KB_CONFIDENCE   = ['HIGH', 'MEDIUM', 'LOW'];
const KB_STATUSES     = ['pending', 'approved', 'rejected', 'superseded'];

const kbEntrySchema = new Schema({
  category: { type: String, enum: KB_CATEGORIES, required: true },
  type:     { type: String, enum: KB_ENTRY_TYPES, default: 'rule' },

  text: { type: String, required: true },           // the rule/fact text
  // Optional structured value for price/timeline entries (for later normalization).
  value: { type: Schema.Types.Mixed },

  // Origin of the knowledge: 'youtube' (extracted, needs review) or 'operator'
  // (authored/approved by the operator — highest-priority source).
  source: { type: String, default: 'youtube' },

  // Provenance (requirement: source video + source date).
  source_video_id:    { type: String, trim: true },
  source_video_title: { type: String, trim: true },
  source_date:        { type: Date },               // video publication date

  confidence:        { type: String, enum: KB_CONFIDENCE, default: 'LOW' },
  needs_review:      { type: Boolean, default: true },
  possibly_outdated: { type: Boolean, default: false },

  // Review lifecycle — only 'approved' is active.
  status:     { type: String, enum: KB_STATUSES, default: 'pending' },
  decided_by: { type: String, default: null },
  decided_at: { type: Date,   default: null },
  review_note: { type: String },

  // Idempotency for re-ingest: one entry per (category + video + normalized text).
  dedupe_key: { type: String, required: true },

  created_at: { type: Date, default: Date.now },
}, {
  collection: 'kb_entries',
  versionKey: false,
});

kbEntrySchema.index({ dedupe_key: 1 }, { unique: true });
kbEntrySchema.index({ status: 1, category: 1 });
kbEntrySchema.index({ source_video_id: 1 });
kbEntrySchema.index({ possibly_outdated: 1 });

const KbEntry = mongoose.model('KbEntry', kbEntrySchema);

module.exports = { KbEntry, KB_CATEGORIES, KB_ENTRY_TYPES, KB_CONFIDENCE, KB_STATUSES };
