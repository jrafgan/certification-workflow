'use strict';

// services/fileClassifierService.js — READ-ONLY classification + explanation of a
// received WhatsApp attachment, from its filename + MIME type only.
//
// This is the live-testing classifier for goals #5 (classify files) and #6 (explain
// file contents). It is PURE — no I/O, no network, no LLM, no file reads. It inspects
// metadata (name + mime) and maps to the document taxonomy from the business charter
// (layout, original declaration/certificate, payment receipt, IP/company registration,
// authorization letter, laboratory document). Deep content extraction (OCR / parsing
// the bytes) is intentionally out of scope here and reported as a limitation.

// MIME / extension → coarse file kind.
const KIND_BY_MIME = [
  { kind: 'pdf',   test: m => /pdf/.test(m) },
  { kind: 'image', test: m => /^image\/(jpe?g|png|tiff?)/.test(m) },
  { kind: 'word',  test: m => /word|msword|officedocument\.wordprocessingml/.test(m) },
  { kind: 'excel', test: m => /excel|spreadsheetml|ms-excel/.test(m) },
];
const KIND_BY_EXT = {
  pdf: 'pdf',
  jpg: 'image', jpeg: 'image', png: 'image', tif: 'image', tiff: 'image',
  doc: 'word', docx: 'word',
  xls: 'excel', xlsx: 'excel',
};

// Filename keyword → document category (case-insensitive substring). Ordered by
// specificity; first hit wins.
const CATEGORY_RULES = [
  { category: 'layout',                kw: ['макет', 'layout', 'draft'] },
  { category: 'original_declaration',  kw: ['деклараци', 'declaration', 'дс'] },
  { category: 'original_certificate',  kw: ['сертификат', 'certificate', 'сс'] },
  { category: 'payment_receipt',       kw: ['чек', 'квитанц', 'оплат', 'receipt', 'payment', 'invoice', 'счет', 'счёт'] },
  { category: 'ip_registration',       kw: ['ип', 'свидетельств', 'патент'] },
  { category: 'company_registration',  kw: ['осоо', 'оао', 'тоо', 'ооо', 'устав', 'регистрац', 'llc'] },
  { category: 'authorization_letter',  kw: ['доверенност', 'authorization', 'довер'] },
  { category: 'lab_document',          kw: ['протокол', 'испытани', 'лаборатор', 'protocol'] },
];

const HUMAN_KIND = { pdf: 'PDF document', image: 'image (JPG/PNG)', word: 'Word document (DOCX)', excel: 'Excel spreadsheet (XLSX)', unknown: 'file' };
const HUMAN_CATEGORY = {
  layout:               'a layout (макет) for client approval',
  original_declaration: 'an original declaration of conformity (ДС)',
  original_certificate: 'an original certificate of conformity (СС)',
  payment_receipt:      'a payment receipt / invoice',
  ip_registration:      'an IP (sole proprietor) registration document',
  company_registration: 'a company (ОсОО/LLC) registration document',
  authorization_letter: 'an authorization letter (доверенность)',
  lab_document:         'a laboratory document (test protocol)',
  unknown:              'an unrecognized document type',
};

function extOf(fileName) {
  const m = String(fileName || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

// fileKind({ mime_type, file_name }) → 'pdf'|'image'|'word'|'excel'|'unknown'.
function fileKind({ mime_type, file_name } = {}) {
  const mime = String(mime_type || '').toLowerCase();
  for (const r of KIND_BY_MIME) if (r.test(mime)) return r.kind;
  return KIND_BY_EXT[extOf(file_name)] || 'unknown';
}

// classifyAttachment({ file_name, mime_type }) → classification result.
// { category, kind, supported, confidence, matched }
function classifyAttachment(att = {}) {
  const kind = fileKind(att);
  const name = String(att.file_name || '').toLowerCase();

  let category = 'unknown';
  let matched  = null;
  for (const rule of CATEGORY_RULES) {
    const hit = rule.kw.find(k => name.includes(k));
    if (hit) { category = rule.category; matched = hit; break; }
  }

  // Confidence: HIGH when a known kind AND a name keyword both agree; MEDIUM when
  // only the kind is recognized; LOW when neither name nor kind is informative.
  let confidence = 'LOW';
  if (kind !== 'unknown' && category !== 'unknown') confidence = 'HIGH';
  else if (kind !== 'unknown') confidence = 'MEDIUM';

  return {
    category,
    kind,
    supported: ['pdf', 'image', 'word', 'excel'].includes(kind), // goals #2–#4 file types
    confidence,
    matched, // the filename keyword that triggered the category (or null)
  };
}

// explainAttachment(att) → a plain-language, READ-ONLY explanation derived from
// metadata + classification. Honestly notes that byte-level content was NOT parsed.
function explainAttachment(att = {}) {
  const c = classifyAttachment(att);
  const name = att.file_name || '(unnamed)';
  const size = typeof att.size === 'number' ? ` ${(att.size / 1024).toFixed(1)} KB` : '';
  const kindStr = HUMAN_KIND[c.kind] || 'file';
  const catStr  = HUMAN_CATEGORY[c.category] || HUMAN_CATEGORY.unknown;
  const certainty = c.confidence === 'HIGH'
    ? 'appears to be'
    : c.confidence === 'MEDIUM'
      ? 'is likely'
      : 'could not be confidently identified, but may be';
  return {
    ...c,
    explanation:
      `«${name}»${size} is a ${kindStr}. By filename/type it ${certainty} ${catStr}. ` +
      `(Read-only metadata classification — document contents were not parsed.)`,
  };
}

module.exports = {
  fileKind,
  classifyAttachment,
  explainAttachment,
  CATEGORY_RULES,
};
