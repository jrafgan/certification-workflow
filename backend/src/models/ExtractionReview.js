'use strict';

// models/ExtractionReview.js — a Review Package for ONE document extraction.
//
// Whenever the OCR / Document-Understanding layer reads a file (payment receipt, IP /
// OsOO registration, declaration, certificate, scanned document, WhatsApp photo), it
// produces ONE of these records: the structured fields it extracted, each with its own
// confidence and the raw text it came from, packaged for operator review.
//
// HARD RULE — OUTPUT ONLY. Creating a review NEVER writes anything else: no Declaration
// create/update, no Google Sheet write, no Gmail send, no WhatsApp send. The extracted
// values are CANDIDATES. Operator approval (with optional corrections) records the
// confirmed values — it still does not propagate them anywhere. Any downstream use is a
// separate, explicitly gated step.
//
// Distinct from DraftPackage (a proposed workflow ACTION, e.g. CREATE_DECLARATION_ROW)
// and from WhatsAppDraft (an outbound message draft). This models a read result awaiting
// human verification.
//
// state machine:
//   pending  → approved   (operator confirms the extraction, optionally with corrections)
//            → rejected   (operator dismisses it — bad scan, wrong document, noise)
//            → superseded (a newer extraction of the same source replaced it)

const mongoose = require('mongoose');
const { Schema } = mongoose;

const REVIEW_DOC_TYPES = ['receipt', 'registration', 'declaration', 'certificate', 'unknown'];
const REVIEW_STATUSES  = ['pending', 'approved', 'rejected', 'superseded'];
const REVIEW_DECISIONS = ['approve', 'reject'];
const CONFIDENCE_BANDS = ['HIGH', 'MEDIUM', 'LOW'];

// One extracted field, with the raw text it came from and its own confidence.
const extractedFieldSchema = new Schema({
  field:      { type: String, trim: true },   // 'payment_amount' | 'inn' | 'applicant' | …
  value:      { type: Schema.Types.Mixed },   // normalized value (number / ISO date / string)
  raw:        { type: String },               // the source snippet it was parsed from
  confidence: { type: String, enum: CONFIDENCE_BANDS },
}, { _id: false });

// One expected-but-missing field (transparency — why confidence isn't higher).
const missingSchema = new Schema({
  field:  { type: String, trim: true },
  reason: { type: String },
}, { _id: false });

const extractionReviewSchema = new Schema({
  // The action is always the same: a human must review this extraction.
  proposed_action: { type: String, default: 'REVIEW_DOCUMENT_EXTRACTION' },

  // What the document is (content-inferred) and how the text was obtained.
  doc_type: { type: String, enum: REVIEW_DOC_TYPES, default: 'unknown' },
  method:   { type: String },   // 'ocr' | 'pdftotext'

  // ── The review contract shown to the operator ────────────────────────────────
  reason:          { type: String, required: true },           // plain-language summary
  evidence:        { type: [extractedFieldSchema], default: [] }, // per-field, with raw + confidence
  extracted_fields:{ type: Schema.Types.Mixed, default: {} },   // { field: value } candidate map
  confidence:      { type: Number, min: 0, max: 100, required: true },
  confidence_band: { type: String, enum: CONFIDENCE_BANDS, required: true },
  impact:          { type: String, required: true },
  expected_fields: { type: [String], default: [] },            // fields relevant to this doc_type
  missing:         { type: [missingSchema], default: [] },
  text_excerpt:    { type: String },                            // first chars of extracted text

  // ── Provenance — where the file came from ────────────────────────────────────
  source: {
    file_name:  { type: String, trim: true },
    media_ref:  { type: String, trim: true },   // local path / media reference
    mime_type:  { type: String, trim: true },
    origin:     { type: String, trim: true },   // 'whatsapp' | 'upload' | 'gmail' | …
    message_id: { type: String, trim: true },   // linked WhatsAppMessage, when applicable
  },

  // Idempotency: re-reading the same source must not duplicate the review.
  dedupe_key: { type: String, required: true },

  // ── State machine + operator decision ────────────────────────────────────────
  status:     { type: String, enum: REVIEW_STATUSES, required: true, default: 'pending' },
  decision:   { type: String, enum: [...REVIEW_DECISIONS, null], default: null },
  // Operator-confirmed values (extracted_fields overlaid with any corrections). Set on
  // approve. Recorded only — NOT written to any other system.
  confirmed_fields: { type: Schema.Types.Mixed, default: null },
  corrections:      { type: Schema.Types.Mixed, default: null },
  decided_at: { type: Date,   default: null },
  decided_by: { type: String, default: null },

  created_at: { type: Date, default: Date.now },
}, {
  collection: 'extraction_reviews',
  versionKey: false,
});

// Operator review queue: pending first, highest confidence first.
extractionReviewSchema.index({ status: 1, confidence: -1, created_at: -1 });
// Idempotency: one review per source document.
extractionReviewSchema.index({ dedupe_key: 1 }, { unique: true });

const ExtractionReview = mongoose.model('ExtractionReview', extractionReviewSchema);

module.exports = {
  ExtractionReview,
  REVIEW_DOC_TYPES,
  REVIEW_STATUSES,
  REVIEW_DECISIONS,
};
