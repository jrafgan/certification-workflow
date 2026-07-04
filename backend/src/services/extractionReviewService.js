'use strict';

// services/extractionReviewService.js — turns every document extraction into a Review
// Package (models/ExtractionReview) for operator verification.
//
// Flow: a file (payment receipt, IP/OsOO registration, declaration, certificate, scanned
// document, WhatsApp photo) → documentUnderstandingService reads the text (pdftotext or
// tesseract OCR) and extracts structured fields → this service maps the result to the
// fields RELEVANT for the document type and packages them for review.
//
// HARD RULE — OUTPUT ONLY. Nothing here writes a Declaration, a sheet, a Gmail, or a
// WhatsApp message. Extracted values are candidates; the operator approves (optionally
// correcting) or rejects. Approval records confirmed values and STILL propagates nothing.
//
// The build/score functions are PURE (no I/O) and exported for testing. The DB-backed
// functions mirror draftPackageService's pending/decide pattern.

const du = require('./documentUnderstandingService');
const errorUtils = require('../utils/errorUtils');

const REVIEW_ACTION = 'REVIEW_DOCUMENT_EXTRACTION';
const IMPACT =
  'Extracted values are CANDIDATES for operator review only. Nothing is written to the ' +
  'Declaration, sheet, Gmail, or WhatsApp. The operator confirms or corrects before any use.';

const DOC_TYPE_LABEL = {
  receipt:      'платёжный документ (чек/квитанция)',
  registration: 'регистрационный документ (ИП/ОсОО)',
  declaration:  'декларация о соответствии',
  certificate:  'сертификат соответствия',
  unknown:      'документ (тип не определён)',
};

// ─── Pure: confidence band ────────────────────────────────────────────────────
function band(score) { return score >= 80 ? 'HIGH' : score >= 50 ? 'MEDIUM' : 'LOW'; }

// ─── Pure: which fields matter for this document type ─────────────────────────
// Returns the relevant field-name list (from documentUnderstandingService), or, for an
// unknown type, every field that was actually found.
function relevantFieldNames(docType, found = []) {
  return du.FIELDS_BY_DOC_TYPE[docType] || found;
}

// ─── Pure: score an extraction (0..100) ───────────────────────────────────────
// For a known doc type: share of the expected relevant fields that were detected.
// For unknown: a softer scale on the raw count of detected fields.
function scoreExtraction(docType, fields = {}) {
  const expected = du.FIELDS_BY_DOC_TYPE[docType];
  if (!expected) {
    const n = Object.keys(fields).length;
    return { expected: null, present: n, score: n ? Math.min(100, 30 + n * 12) : 0 };
  }
  const present = expected.filter(name => fields[name] != null).length;
  const score = expected.length ? Math.round((100 * present) / expected.length) : 0;
  return { expected: expected.length, present, score };
}

// ─── Pure: compose the human-readable reason ──────────────────────────────────
function composeReason(docType, extracted, file = {}) {
  const label = DOC_TYPE_LABEL[docType] || DOC_TYPE_LABEL.unknown;
  const name  = file.file_name || '(без имени)';
  const keys  = Object.keys(extracted);
  const head  = `Распознан ${label} «${name}». `;
  if (!keys.length) return `${head}Структурированные поля не извлечены — требуется проверка оператором.`;
  return `${head}Извлечено полей: ${keys.length} — требуется подтверждение оператора.`;
}

// ─── Pure: build a Review Package from a file (reads the file via du) ──────────
// Returns { generated:false, reason, ... } when the text could not be read, or the full
// review-package object when it could. NEVER writes anything. `deps.pdfText`/`deps.ocr`
// are test seams forwarded to documentUnderstandingService.
async function buildReviewPackage(file = {}, deps = {}) {
  const u = await du.understandDocument(file, deps);
  if (!u.ok) {
    return { generated: false, reason: u.reason, note: u.note, file_name: file.file_name || null };
  }

  const docType  = u.doc_type || 'unknown';
  const relevant = relevantFieldNames(docType, u.found);

  const extracted = {};
  const evidence  = [];
  const missing   = [];
  for (const name of relevant) {
    const f = u.fields[name];
    if (f && f.value != null && f.value !== '') {
      extracted[name] = f.value;
      evidence.push({ field: name, value: f.value, raw: f.raw, confidence: f.confidence });
    } else {
      missing.push({ field: name, reason: 'не обнаружено в тексте документа' });
    }
  }

  const sc = scoreExtraction(docType, u.fields);

  return {
    generated:        true,
    proposed_action:  REVIEW_ACTION,
    doc_type:         docType,
    method:           u.method,
    reason:           composeReason(docType, extracted, file),
    evidence,
    extracted_fields: extracted,
    confidence:       sc.score,
    confidence_band:  band(sc.score),
    impact:           IMPACT,
    expected_fields:  relevant,
    missing,
    text_excerpt:     u.text_excerpt,
  };
}

// ─── Pure: idempotency key for a source document ──────────────────────────────
function dedupeKey(file = {}, origin = 'upload') {
  const ref = file.media_ref || file.path || file.file_name || 'no_ref';
  return [REVIEW_ACTION, origin, ref].join('|');
}

// ─── DB-backed: create (or return existing) a Review Package for one file ──────
// deps: { ExtractionReview, pdfText, ocr } (all optional; pdfText/ocr are du test seams).
async function createFromFile(file = {}, { origin = 'upload', messageId = null, decidedBy } = {}, deps = {}) {
  const ExtractionReview = deps.ExtractionReview || require('../models/ExtractionReview').ExtractionReview;

  const pkg = await buildReviewPackage(file, deps);
  if (!pkg.generated) {
    return { created: false, reason: pkg.reason, note: pkg.note, file_name: pkg.file_name };
  }

  const dedupe_key = dedupeKey(file, origin);
  const existing = await ExtractionReview.findOne({ dedupe_key });
  if (existing) return { created: false, reason: 'duplicate_review', review: existing };

  const doc = {
    proposed_action:  pkg.proposed_action,
    doc_type:         pkg.doc_type,
    method:           pkg.method,
    reason:           pkg.reason,
    evidence:         pkg.evidence,
    extracted_fields: pkg.extracted_fields,
    confidence:       pkg.confidence,
    confidence_band:  pkg.confidence_band,
    impact:           pkg.impact,
    expected_fields:  pkg.expected_fields,
    missing:          pkg.missing,
    text_excerpt:     pkg.text_excerpt,
    source: {
      file_name:  file.file_name || undefined,
      media_ref:  file.media_ref || file.path || undefined,
      mime_type:  file.mime_type || undefined,
      origin,
      message_id: messageId || undefined,
    },
    dedupe_key,
    status: 'pending',
  };

  try {
    const review = await ExtractionReview.create(doc);
    return { created: true, review };
  } catch (err) {
    if (err && (err.code === 11000 || err.code === 'E11000')) {
      const review = await ExtractionReview.findOne({ dedupe_key });
      return { created: false, reason: 'duplicate_review', review };
    }
    throw err;
  }
}

// ─── Read: pending reviews for the operator queue ─────────────────────────────
async function listPending(limit = 50, deps = {}) {
  const ExtractionReview = deps.ExtractionReview || require('../models/ExtractionReview').ExtractionReview;
  const docs = await ExtractionReview
    .find({ status: 'pending' })
    .sort({ confidence: -1, created_at: -1 })
    .limit(limit)
    .lean();

  return docs.map(d => ({
    id:               d._id,
    proposed_action:  d.proposed_action,
    doc_type:         d.doc_type,
    method:           d.method,
    reason:           d.reason,
    evidence:         d.evidence || [],
    extracted_fields: d.extracted_fields || {},
    confidence:       d.confidence,
    confidence_band:  d.confidence_band,
    impact:           d.impact,
    expected_fields:  d.expected_fields || [],
    missing:          d.missing || [],
    text_excerpt:     d.text_excerpt,
    source:           d.source,
    created_at:       d.created_at,
  }));
}

// ─── Operator decision ─────────────────────────────────────────────────────────
// 'approve' confirms the extraction (optionally overlaying `corrections` onto the
// candidate values) and records confirmed_fields. 'reject' dismisses it. NEITHER outcome
// writes to any other system — confirmed values are recorded for a later, gated use.
async function decide(reviewId, decision, { corrections = null, decidedBy = 'operator' } = {}, deps = {}) {
  const ExtractionReview = deps.ExtractionReview || require('../models/ExtractionReview').ExtractionReview;

  const review = await ExtractionReview.findById(reviewId);
  if (!review) throw errorUtils.notFoundError('Extraction review not found');
  if (review.status !== 'pending') {
    throw errorUtils.conflictError(`Extraction review already ${review.status}`);
  }

  let nextStatus;
  if (decision === 'approve')     nextStatus = 'approved';
  else if (decision === 'reject') nextStatus = 'rejected';
  else throw errorUtils.validationError(`Unknown decision "${decision}" (use approve|reject)`);

  if (decision === 'approve') {
    const confirmed = { ...(review.extracted_fields || {}), ...(corrections || {}) };
    review.confirmed_fields = confirmed;
    review.corrections = corrections || null;
  }

  review.status     = nextStatus;
  review.decision   = decision;
  review.decided_by = decidedBy;
  review.decided_at = new Date();
  await review.save();

  return review;
}

module.exports = {
  // pure
  band,
  relevantFieldNames,
  scoreExtraction,
  composeReason,
  buildReviewPackage,
  dedupeKey,
  // db-backed
  createFromFile,
  listPending,
  decide,
  // constants
  REVIEW_ACTION,
  IMPACT,
};
