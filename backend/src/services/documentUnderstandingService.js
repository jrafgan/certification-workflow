'use strict';

// services/documentUnderstandingService.js — read ACTUAL file contents and extract
// structured fields (payment amount/date/time, legal entity, ИНН, document number).
//
// Two layers:
//   • extractText(file)   — turn a file into text. PDF → `pdftotext` (poppler, present
//                           on this host). Images / scanned PDFs → an OCR adapter
//                           (deps.ocr, or system `tesseract` when installed). If no
//                           engine is available it returns ok:false with a clear reason.
//   • extractFields(text) — PURE, deterministic RU regex extraction of the requested
//                           fields. Fully unit-testable independent of any engine.
//
// READ-ONLY: reads local files only; no writes, no sends, no Declaration changes.
// All extracted values are candidates with confidence and need operator confirmation.

const { execFileSync } = require('child_process');
const fs = require('fs');
const fileClassifier = require('./fileClassifierService');

// ─── PURE: structured field extraction ─────────────────────────────────────────
const CURRENCY_AMOUNT_RE = /(\d[\d\s.,]*\d|\d)\s*(сом(?:ов|а)?|руб(?:лей|\.)?|₽|тенге|тг|usd|\$|доллар[а-яё]*|евро|€)/gi;
const LABELED_AMOUNT_RE  = /(?:сумма|итого|к\s*оплате|оплачено|всего)\D{0,12}(\d[\d\s.,]*\d|\d)/i;
const DATE_RE = /\b(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})\b|\b(\d{4})-(\d{2})-(\d{2})\b/;
const TIME_RE = /\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/;
// NOTE: \b is ASCII-only — do NOT use it around Cyrillic. Match the labels directly.
const INN_RE  = /ИНН[:\s№-]*([0-9]{8,14})/i;
const ENTITY_RE = /(ОсОО|ООО|ОАО|ЗАО|ТОО|ЧП|ИП)\s+[«"']?([A-ZА-ЯЁ0-9][^\n,;«»"']{1,60})/i;
// Document number: optional label word, then a token that MUST contain a digit
// (so a Cyrillic label like "операции" is not mistaken for the number).
const DOCNUM_RE = /(?:№|номер[а]?|N[оo]?\.?)\s*[A-Za-zА-Яа-яЁё]*\s*[:#]?\s*([A-ZА-ЯЁ0-9][A-ZА-ЯЁ0-9\/.\-]*\d[A-ZА-ЯЁ0-9\/.\-]*)/i;

// Parties on a receipt / counterparty lines. Capture the rest of the label's line.
const PAYER_RE     = /(?:Плательщик|Отправитель|От\s+кого|Со\s+счёта|Со\s+счета|С\s+карты)\s*[:№.\-]?\s*([^\n]{2,80})/i;
const RECIPIENT_RE = /(?:Получатель|Кому|Бенефициар|Наименование\s+получателя|Зачислено\s+на|На\s+счёт|На\s+счет)\s*[:№.\-]?\s*([^\n]{2,80})/i;

// Applicant on a declaration / certificate.
const APPLICANT_RE = /(?:Заявитель|Изготовитель|Заявителем\s+является)\s*[:№.\-]?\s*([^\n]{2,80})/i;

// Labeled dates — capture a short window after the label, then pull a date out of it.
const ISSUE_DATE_RE  = /(?:Дата\s+выдачи|Дата\s+регистрации|Дата\s+оформления|Дата\s+внесения\s+записи|Зарегистрирован[оаы]?|Выдан[оаы]?)\s*[:№.\-]?\s*([^\n]{0,40})/i;
const EXPIRY_DATE_RE = /(?:Действителен\s+до|Действительна\s+до|Действует\s+до|Срок\s+действия\s+до|Срок\s+действия|Годен\s+до|Срок\s+годности)\s*[:№.\-]?\s*([^\n]{0,40})/i;

// Registration identifiers for IP / OsOO documents (ОГРН/ОГРНИП, рег. №, свидетельство №).
const REG_ID_RE = /(?:ОГРНИП|ОГРН|Регистрационный\s+номер|Рег\.?\s*№|Свидетельств[оа]\s*(?:о\s+регистрации)?\s*№?|Номер\s+записи|За\s+номером)\s*[:№.\-]?\s*([0-9][0-9\/.\-]{4,})/i;

// Content-based document-type hints (independent of the filename classifier).
const DOC_TYPE_RULES = [
  { type: 'declaration',  re: /деклараци[яи]\s+о\s+соответствии/i },
  { type: 'certificate',  re: /сертификат\s+соответствия/i },
  { type: 'receipt',      re: /квитанц|чек\b|об\s+оплате|платёжное|платежное\s+поручение/i },
  { type: 'registration', re: /ОГРНИП|ОГРН|свидетельств[оа]\s+о\s+(?:государственной\s+)?регистрации|единый\s+государственный\s+реестр/i },
];

function num(s) { const n = parseFloat(String(s).replace(/[\s.]/g, '').replace(',', '.')); return isNaN(n) ? null : n; }

// Pull the first date out of an arbitrary fragment → ISO yyyy-mm-dd (or null).
function findDateIso(fragment) {
  const d = DATE_RE.exec(String(fragment || ''));
  if (!d) return null;
  return d[4]
    ? `${d[4]}-${d[5]}-${d[6]}`
    : `${(d[3].length === 2 ? '20' + d[3] : d[3])}-${String(d[2]).padStart(2, '0')}-${String(d[1]).padStart(2, '0')}`;
}

// Clean a captured label value (trim surrounding quotes/punctuation noise).
function cleanValue(s) {
  return String(s || '').trim().replace(/[,;]\s*$/, '').trim();
}

// inferDocType(text) → 'receipt' | 'registration' | 'declaration' | 'certificate' | 'unknown'.
// Content-based; complements fileClassifierService (which works from the filename).
function inferDocType(text = '') {
  const t = String(text || '');
  for (const r of DOC_TYPE_RULES) if (r.re.test(t)) return r.type;
  return 'unknown';
}

function extractFields(text = '') {
  const t = String(text || '');
  const fields = {};

  // amount — prefer a labeled amount ("Итого: 15000"), else the largest currency amount.
  const labeled = LABELED_AMOUNT_RE.exec(t);
  if (labeled) {
    fields.payment_amount = { value: num(labeled[1]), raw: labeled[0].trim(), confidence: 'MEDIUM' };
  } else {
    let best = null; let m; CURRENCY_AMOUNT_RE.lastIndex = 0;
    while ((m = CURRENCY_AMOUNT_RE.exec(t)) !== null) { const v = num(m[1]); if (v != null && (!best || v > best.value)) best = { value: v, raw: m[0].trim() }; }
    if (best) fields.payment_amount = { ...best, confidence: 'LOW' };
  }

  const d = DATE_RE.exec(t);
  if (d) {
    fields.payment_date = { value: findDateIso(d[0]), raw: d[0], confidence: 'MEDIUM' };
  }

  const tm = TIME_RE.exec(t);
  if (tm) fields.payment_time = { value: `${tm[1].padStart(2,'0')}:${tm[2]}${tm[3] ? ':' + tm[3] : ''}`, raw: tm[0], confidence: 'MEDIUM' };

  const payer = PAYER_RE.exec(t);
  if (payer) fields.payer = { value: cleanValue(payer[1]), raw: payer[0].trim(), confidence: 'MEDIUM' };

  const recipient = RECIPIENT_RE.exec(t);
  if (recipient) fields.recipient = { value: cleanValue(recipient[1]), raw: recipient[0].trim(), confidence: 'MEDIUM' };

  const inn = INN_RE.exec(t);
  if (inn) fields.inn = { value: inn[1], raw: inn[0].trim(), confidence: 'HIGH' };

  const ent = ENTITY_RE.exec(t);
  if (ent) fields.legal_entity = { value: `${ent[1]} ${ent[2].trim()}`.trim(), raw: ent[0].trim(), confidence: 'MEDIUM' };

  const reg = REG_ID_RE.exec(t);
  if (reg) fields.registration_id = { value: reg[1].trim(), raw: reg[0].trim(), confidence: 'HIGH' };

  const applicant = APPLICANT_RE.exec(t);
  if (applicant) fields.applicant = { value: cleanValue(applicant[1]), raw: applicant[0].trim(), confidence: 'MEDIUM' };

  const issue = ISSUE_DATE_RE.exec(t);
  if (issue) { const iso = findDateIso(issue[1]); if (iso) fields.issue_date = { value: iso, raw: issue[0].trim(), confidence: 'MEDIUM' }; }

  const expiry = EXPIRY_DATE_RE.exec(t);
  if (expiry) { const iso = findDateIso(expiry[1]); if (iso) fields.expiry_date = { value: iso, raw: expiry[0].trim(), confidence: 'MEDIUM' }; }

  const dn = DOCNUM_RE.exec(t);
  if (dn) fields.document_number = { value: dn[1], raw: dn[0].trim(), confidence: 'LOW' };

  const found = Object.keys(fields);
  return {
    fields,
    found,
    doc_type: inferDocType(t),
    confidence: found.length >= 4 ? 'HIGH' : found.length >= 2 ? 'MEDIUM' : found.length ? 'LOW' : 'NONE',
    needs_operator_confirmation: true,
  };
}

// Which fields matter for each document type (per the business requirement). Used by the
// Review Package to surface the relevant subset; extraction itself stays type-agnostic.
const FIELDS_BY_DOC_TYPE = {
  receipt:      ['payment_amount', 'payment_date', 'payment_time', 'payer', 'recipient'],
  registration: ['legal_entity', 'inn', 'registration_id'],
  declaration:  ['document_number', 'issue_date', 'expiry_date', 'applicant'],
  certificate:  ['document_number', 'issue_date', 'expiry_date', 'applicant'],
  unknown:      null, // null → show everything found
};

// ─── Text extraction (engine layer) ─────────────────────────────────────────────
function pdfToText(filePath) {
  // poppler `pdftotext`; -layout preserves columns; '-' → stdout.
  return execFileSync('pdftotext', ['-layout', filePath, '-'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function tesseractAvailable() {
  try { execFileSync('tesseract', ['--version'], { stdio: 'ignore' }); return true; } catch (_) { return false; }
}
function ocrImage(filePath, lang = 'rus+eng') {
  return execFileSync('tesseract', [filePath, 'stdout', '-l', lang], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

// extractText(file, deps) → { ok, method, text } | { ok:false, reason }
// file = { media_ref|path, mime_type, file_name }. deps.pdfText / deps.ocr are test seams.
function extractText(file = {}, deps = {}) {
  const path = file.media_ref || file.path;
  if (!path) return { ok: false, reason: 'no_file_path' };
  if (!deps.pdfText && !deps.ocr && !fs.existsSync(path)) return { ok: false, reason: 'file_not_found' };

  const kind = fileClassifier.fileKind(file);

  if (kind === 'pdf') {
    try {
      const text = (deps.pdfText || pdfToText)(path);
      if (text && text.trim().length >= 10) return { ok: true, method: 'pdftotext', text };
      // Empty → likely a scanned PDF; fall through to OCR.
    } catch (e) { return { ok: false, reason: 'pdf_extract_failed', error: e.message }; }
  }

  if (kind === 'image' || kind === 'pdf') {
    const ocr = deps.ocr || (tesseractAvailable() ? (p) => ocrImage(p) : null);
    if (!ocr) return { ok: false, reason: 'ocr_not_available', note: 'Install tesseract (rus+eng) or pass deps.ocr to read scanned images.' };
    try {
      const text = ocr(path);
      return { ok: !!(text && text.trim()), method: 'ocr', text: text || '' };
    } catch (e) { return { ok: false, reason: 'ocr_failed', error: e.message }; }
  }

  return { ok: false, reason: `unsupported_kind_${kind}` };
}

// understandDocument(file, deps) → read contents + extract fields. Read-only.
function understandDocument(file = {}, deps = {}) {
  const t = extractText(file, deps);
  if (!t.ok) return { ok: false, reason: t.reason, note: t.note, file_name: file.file_name || null };
  const extraction = extractFields(t.text);
  return {
    ok: true,
    method: t.method,
    file_name: file.file_name || null,
    text_excerpt: t.text.slice(0, 300),
    ...extraction,
  };
}

module.exports = {
  extractFields,
  extractText,
  understandDocument,
  inferDocType,
  findDateIso,
  pdfToText,
  tesseractAvailable,
  FIELDS_BY_DOC_TYPE,
};
