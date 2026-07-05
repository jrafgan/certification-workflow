'use strict';

// integrations/newApplicationsClient.js — READ-ONLY reader for the "New
// Applications" sheet (Google Form submissions awaiting processing).
//
// In this workspace the source is the "Необработанные" ("Unprocessed") tab of
// the Declaration spreadsheet (override via env). This module ONLY reads — it
// never writes any sheet, never modifies Declaration, never creates orders.
//
// Columns are mapped by fuzzy header name (Google Form layouts vary), so the
// reader keeps working if column order changes. The three fields the matcher
// needs are: phone, legal entity name, application timestamp.

const { google } = require('googleapis');

const SHEET_ID   = () => process.env.NEW_APPLICATIONS_SHEET_ID   || process.env.DECLARATION_SHEET_ID;
const SHEET_NAME = () => process.env.NEW_APPLICATIONS_SHEET_NAME || 'Необработанные';
const SCOPE      = 'https://www.googleapis.com/auth/spreadsheets.readonly';

// Header synonyms (prefix-of-token match) → logical field.
const HEADER_MAP = {
  phone:        ['тел', 'телефон', 'номер', 'phone', 'whatsapp', 'ватсап'],
  legal_entity: ['клиент', 'ип', 'осоо', 'оао', 'тоо', 'ооо', 'юр', 'компан', 'назван', 'организац', 'entity', 'client'],
  submitted_at: ['отметка', 'время', 'времени', 'дата', 'timestamp', 'submitted', 'created'],
};

function quoteName(name) {
  return /^[A-Za-z0-9_]+$/.test(name) ? name : `'${String(name).replace(/'/g, "''")}'`;
}

let _sheets = null;
function getSheets() {
  if (!_sheets) {
    const auth = new google.auth.GoogleAuth({ keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE, scopes: [SCOPE] });
    _sheets = google.sheets({ version: 'v4', auth });
  }
  return _sheets;
}
// Test seam — inject a fake sheets client (or a rows array via readApplications deps).
function _setSheetsClient(c) { _sheets = c; }

// Tokenize a header cell into lowercase word tokens (Cyrillic/Latin/digits).
function headerTokens(cell) {
  return String(cell || '').toLowerCase().split(/[^0-9a-zа-яё]+/i).filter(Boolean);
}

// mapHeader(headerRow) → { phone: idx|-1, legal_entity: idx|-1, submitted_at: idx|-1 }
// A field matches a column when any synonym is a PREFIX of any token in that
// column's header. Prefix-on-token avoids substring false positives like the
// phone synonym "тел" matching "оТправиТЕЛя" in "Имя отправителя чека".
// Pure — exported for testing.
function mapHeader(headerRow = []) {
  const find = (syns) => headerRow.findIndex(cell =>
    headerTokens(cell).some(tok => syns.some(s => tok.startsWith(s)))
  );
  return {
    phone:        find(HEADER_MAP.phone),
    legal_entity: find(HEADER_MAP.legal_entity),
    submitted_at: find(HEADER_MAP.submitted_at),
  };
}

// parseFormDate(v) → Date | null. Handles the Google-Forms Russian timestamp
// «ДД.ММ.ГГГГ[ ЧЧ:ММ[:СС]]» (which new Date() does NOT parse) plus ISO strings and Date
// objects. Pure — exported for testing.
function parseFormDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const dt = new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    return isNaN(dt.getTime()) ? null : dt;
  }
  // ISO / other — require a 4-digit year to avoid false positives on plain numbers/names.
  if (!/\d{4}/.test(s)) return null;
  const t = Date.parse(s);
  return isNaN(t) ? null : new Date(t);
}

// rowsToApplications(rows) → [{ row, phone, legal_entity, submitted_at, raw }]
// Pure — exported for testing. rows[0] is the header.
function rowsToApplications(rows = []) {
  if (!rows.length) return { applications: [], reason: 'empty' };
  const header = rows[0];
  const cols = mapHeader(header);
  if (cols.phone === -1 && cols.legal_entity === -1) {
    return { applications: [], reason: 'no_recognizable_header', header };
  }
  const applications = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.every(c => !String(c || '').trim())) continue; // skip blank rows
    // Timestamp: the mapped column if the header named it; else FALL BACK to column 0 —
    // a Google-Forms responses tab always carries the submission time in column 0, even when
    // its header cell is mislabeled (this form's is literally «А», so the synonym map missed it).
    let submitted = cols.submitted_at >= 0 ? parseFormDate(r[cols.submitted_at]) : null;
    if (!submitted) submitted = parseFormDate(r[0]);
    applications.push({
      row:          i + 1,
      phone:        cols.phone >= 0 ? String(r[cols.phone] || '').trim() : '',
      legal_entity: cols.legal_entity >= 0 ? String(r[cols.legal_entity] || '').trim() : '',
      submitted_at: submitted,
      raw:          r,
    });
  }
  return { applications, reason: 'ok', columns: cols };
}

// readApplications() — read-only fetch + map. Returns { applications, reason, tab, ... }.
async function readApplications() {
  const spreadsheetId = SHEET_ID();
  const tab = SHEET_NAME();
  if (!spreadsheetId) return { applications: [], reason: 'sheet_not_configured' };
  const range = `${quoteName(tab)}!A1:Z`;
  const res = await getSheets().spreadsheets.values.get({ spreadsheetId, range });
  const rows = res?.data?.values || [];
  return { tab, row_count: Math.max(0, rows.length - 1), ...rowsToApplications(rows) };
}

module.exports = { readApplications, mapHeader, rowsToApplications, parseFormDate, _setSheetsClient, SHEET_NAME };
