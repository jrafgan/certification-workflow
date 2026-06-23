'use strict';

// services/formFieldMapper.js — Google Form → Mockup Agent field mapper.
//
// Maps the REAL "Ответы на форму (1)" columns (headers in Russian) onto the 11 canonical
// mockup fields (§1). Header→field is by synonym CONTAINMENT with greedy left-to-right
// assignment (each column used once), so the combined "товары — состав — ТН ВЭД" column (P)
// is claimed by ITEMS before COMPOSITION/TNVED scan, leaving the dedicated composition (Q)
// and TN VED (R) columns to map correctly.
//
// PURE: header[] + row[] → application object (no I/O). doc_type is NOT in the form — the
// operator selects ДС/СС; the mapper leaves it null and flags it.

const FIELD_SYNONYMS = {
  APPLICANT_L_E_NAME:    ['название вашего юр', 'юр лица или организации'],
  LEGAL_ENTITY:          ['ваше юр лицо'],
  L_E_COUNTRY:           ['страна регистрации'],
  AGE:                   ['детский или взрослый', 'детская или взрослая', 'детский взрослый'],
  INN:                   ['огрн', 'инн', 'иин', 'бин'],
  L_E_ADRESS:            ['юридический адрес'],
  PHONE_NUMBER:          ['номер телефона'],
  PHONE_WHATSAPP:        ['номер ватсап', 'ватсап'],
  EMAIL:                 ['e mail', 'email', 'электронной почты'],
  MANUFACTURER_L_E_NAME: ['юр лица производителя', 'лица производителя', 'производителя'],
  MANUFACTURER_COUNTRY:  ['страна производства'],
  MANUFACTURER_ADRESS:   ['адрес производства'],
  BRAND_NAME:            ['наименование бренда', 'марка продукции', 'название магазина'],
  ITEMS:                 ['список ваших товаров', 'список товаров'],
  ITEM_COMPOSITION:      ['состав ткани', 'состав'],
  TNVED:                 ['тнвэд', 'тн вэд', 'тнвед'],
};

// Order matters: ITEMS must be assigned (claims combined column P) before COMPOSITION/TNVED.
const FIELD_ORDER = [
  'APPLICANT_L_E_NAME', 'LEGAL_ENTITY', 'L_E_COUNTRY', 'AGE', 'INN', 'L_E_ADRESS', 'PHONE_NUMBER', 'PHONE_WHATSAPP',
  'EMAIL', 'MANUFACTURER_L_E_NAME', 'MANUFACTURER_COUNTRY', 'MANUFACTURER_ADRESS', 'BRAND_NAME',
  'ITEMS', 'ITEM_COMPOSITION', 'TNVED',
];

// Minimum fields a DS draft needs; absence is flagged for the operator (not invented).
const REQUIRED = ['APPLICANT_L_E_NAME', 'INN', 'L_E_ADRESS', 'ITEMS', 'TNVED'];

function normalize(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^0-9a-zа-яё]+/gi, ' ').replace(/\s+/g, ' ').trim();
}

// detectColumns(header) → { FIELD: columnIndex (or -1) }. Greedy, each column used once.
function detectColumns(header = []) {
  const normHeaders = header.map(normalize);
  const used = new Set();
  const map = {};
  for (const field of FIELD_ORDER) {
    map[field] = -1;
    for (const syn of FIELD_SYNONYMS[field]) {
      const idx = normHeaders.findIndex((h, i) => !used.has(i) && h.includes(syn));
      if (idx !== -1) { map[field] = idx; used.add(idx); break; }
    }
  }
  return map;
}

const cell = (row, idx) => (idx >= 0 && row[idx] != null ? String(row[idx]).trim() : '');

// Extract distinct 10-digit TN VED codes from free text (digits may be space/comma separated).
function extractTnved(text) {
  const codes = (String(text || '').match(/\b\d[\d\s.]{8,14}\d\b/g) || [])
    .map(c => c.replace(/\D/g, ''))
    .filter(c => c.length === 10);
  return [...new Set(codes)];
}

// mapRow(header, row, opts) → application object for mockupAgentService.proposeMockup, plus
// _meta { columns, field_warnings, missing_required }.
function mapRow(header = [], row = [], { docType = null } = {}) {
  const cols = detectColumns(header);
  const g = (f) => cell(row, cols[f]);

  const items_text       = g('ITEMS');
  const composition_text = g('ITEM_COMPOSITION');
  const tnved_text       = g('TNVED');

  // TN VED codes drive §6/§7. Prefer the dedicated column; fall back to scanning the item list.
  const tnvedCodes = extractTnved(tnved_text).length ? extractTnved(tnved_text) : extractTnved(items_text);

  // Best-effort items[]: one entry per detected TN VED code (product text kept verbatim from the
  // form). When >1 code shares one free-text product blob, structuring is flagged for the operator.
  const items = tnvedCodes.length
    ? tnvedCodes.map(code => ({ name: items_text || '(см. список товаров)', composition: composition_text, tnved: code }))
    : [{ name: items_text, composition: composition_text, tnved: '' }];

  const application = {
    doc_type: docType,
    applicant: {
      name:    g('APPLICANT_L_E_NAME'),
      inn:     g('INN'),
      address: g('L_E_ADRESS'),
      phone:   g('PHONE_NUMBER') || g('PHONE_WHATSAPP'),
      email:   g('EMAIL'),
    },
    manufacturer: {
      name:    g('MANUFACTURER_L_E_NAME'),
      country: g('MANUFACTURER_COUNTRY'),
      address: g('MANUFACTURER_ADRESS'),
    },
    brand: g('BRAND_NAME'),
    legal_entity: g('LEGAL_ENTITY'),
    l_e_country: g('L_E_COUNTRY'),
    // AGE (col O «Товар детский или взрослый») — primary DS/SS driver for the classifier.
    age: g('AGE'),
    // verbatim form text for the document placeholders (faithful to the form, not reconstructed)
    items_text, composition_text, tnved_text,
    items,
  };

  const field_warnings = [];
  const missing_required = REQUIRED.filter(f => cols[f] === -1 || !g(f));
  if (missing_required.length) field_warnings.push({ code: 'missing_required_fields', fields: missing_required });
  if (!docType) field_warnings.push({ code: 'doc_type_not_in_form', message: 'Operator must select ДС or СС — not present in the form.' });
  if (tnvedCodes.length > 1) field_warnings.push({ code: 'product_structuring_needed', message: 'Multiple TN VED codes share one free-text product list — operator should confirm product↔TN VED pairing for the attachment.', tnved_count: tnvedCodes.length });

  application._meta = { columns: cols, field_warnings, missing_required };
  return application;
}

module.exports = { FIELD_SYNONYMS, FIELD_ORDER, REQUIRED, normalize, detectColumns, extractTnved, mapRow };
