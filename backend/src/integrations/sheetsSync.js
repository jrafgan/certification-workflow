'use strict';

// integrations/sheetsSync.js — Google Sheets read/write for Declaration status
//
// Authentication is provided by integrations/googleAuth (OAuth2 + refresh token,
// scope spreadsheets). The Google Sheets client is created lazily from that shared
// auth client. _setSheetsClient() is a test seam for injecting a fake client.
//
// Outbound (System → Sheets): writeDeclarationRow() writes the Declaration's
// current status into the sheet's Status column, then reads it back to VERIFY the
// write landed. On success the declaration is marked 'synced'; on failure or a
// failed verify it is marked 'error' and remains eligible for retry.
//
// Order.status IS the sheet value, so no translation is needed.

const { google }         = require('googleapis');
const fs                 = require('fs');
const { Declaration }    = require('../models/Declaration');
const declarationService = require('../services/declarationService');
const errorUtils         = require('../utils/errorUtils');
const {
  DECLARATION_SHEET_STATUS_COLUMN,
  DECLARATION_SHEET_COLUMNS,
} = require('../config/constants');

// Sheets authenticates with its OWN credentials — a Google Service Account keyed by
// GOOGLE_SERVICE_ACCOUNT_KEY_FILE — independent of the Gmail OAuth client in
// googleAuth.js. The Declaration spreadsheet must be shared with the service
// account's email as Editor. Gmail auth is deliberately not touched here.
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

let _auth   = null;
let _sheets = null;

function getAuth() {
  if (!_auth) {
    _auth = new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
      scopes:  [SHEETS_SCOPE],
    });
  }
  return _auth;
}

function getSheets() {
  if (!_sheets) _sheets = google.sheets({ version: 'v4', auth: getAuth() });
  return _sheets;
}

// Test seam — inject a fake sheets client. Pass null to reset to the real client.
function _setSheetsClient(client) { _sheets = client; }

// verifyAuth — confirms the service account authenticates by obtaining an access
// token. Returns { ok, clientEmail, projectId } or { ok:false, reason|error }.
async function verifyAuth() {
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
  if (!keyFile)              return { ok: false, reason: 'no_key_file' };
  if (!fs.existsSync(keyFile)) return { ok: false, reason: 'key_file_not_found', keyFile };

  let clientEmail, projectId;
  try {
    const sa = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    clientEmail = sa.client_email;
    projectId   = sa.project_id;
  } catch (err) {
    return { ok: false, reason: 'key_file_invalid', error: err.message };
  }

  try {
    const client = await getAuth().getClient();
    const token  = await client.getAccessToken();
    const hasToken = !!(typeof token === 'string' ? token : token?.token);
    return { ok: hasToken, clientEmail, projectId };
  } catch (err) {
    return { ok: false, error: err.message || String(err), clientEmail, projectId };
  }
}

function sheetConfig() {
  return {
    spreadsheetId: process.env.DECLARATION_SHEET_ID,
    sheetName:     process.env.DECLARATION_SHEET_NAME || 'Sheet1',
  };
}

// Sheet names that aren't a bare [A-Za-z0-9_]+ token (spaces, Cyrillic, etc.) must
// be single-quoted in A1 notation.
function quoteName(sheetName) {
  return /^[A-Za-z0-9_]+$/.test(sheetName)
    ? sheetName
    : `'${String(sheetName).replace(/'/g, "''")}'`;
}

// Zero-based column index → spreadsheet column letter (0→A, 25→Z, 26→AA…).
function colLetter(index) {
  let n = index, s = '';
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

// Builds the A1 range for the Status cell.
function statusRange(sheetName, rowId) {
  return `${quoteName(sheetName)}!${DECLARATION_SHEET_STATUS_COLUMN}${rowId}`;
}

// The live Declaration sheet stores statuses in lowercase. Order.status and the
// Declaration mirror keep the canonical capitalized form (e.g. "Завершен"); only
// the sheet cell is written lowercase ("завершен"), to stay consistent with the
// rows already in the sheet.
function toSheetStatus(status) {
  return String(status).toLowerCase();
}

// Normalizes a status for read-after-write comparison: strips stray padding
// (existing cells can carry leading whitespace) and lowercases.
function normalizeStatus(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

// Reads the header row (row 1) and returns [{ column, value }, …] so an operator
// can identify which column holds the status before configuring the write-back.
async function readHeaderRow(sheetName) {
  const { spreadsheetId } = sheetConfig();
  const range = `${quoteName(sheetName)}!1:1`;
  const res = await getSheets().spreadsheets.values.get({ spreadsheetId, range });
  const row = res?.data?.values?.[0] || [];
  return row.map((value, i) => ({ column: colLetter(i), value }));
}

// ─── Read ───────────────────────────────────────────────────────────────────────

// verifySpreadsheet — confirms the configured spreadsheet is reachable and returns
// its title and tab names. Returns { ok, title, tabs } or { ok:false, ... }.
async function verifySpreadsheet() {
  const { spreadsheetId } = sheetConfig();
  if (!spreadsheetId) return { ok: false, reason: 'sheet_not_configured' };
  try {
    const res = await getSheets().spreadsheets.get({
      spreadsheetId,
      fields: 'properties.title,sheets.properties.title',
    });
    return {
      ok:    true,
      title: res?.data?.properties?.title,
      tabs:  (res?.data?.sheets || []).map(s => s.properties.title),
    };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// Reads the current value of a declaration's Status cell. Returns the string value,
// or null if the cell is empty.
async function readStatusCell(sheetName, rowId) {
  const { spreadsheetId } = sheetConfig();
  const range = statusRange(sheetName, rowId);
  const res = await getSheets().spreadsheets.values.get({ spreadsheetId, range });
  const value = res?.data?.values?.[0]?.[0];
  return value == null ? null : String(value);
}

// ─── Write (with read-after-write verification) ─────────────────────────────────

// Writes one declaration's status to its sheet row and verifies the write by
// reading the cell back. Returns:
//   { written:true, verified:true, range, status }            on success
//   { written:true, verified:false, range, sheetValue }       write landed but mismatch
//   { skipped:true, reason }                                  nothing to write
//   { written:false, error }                                  API failure
async function writeDeclarationRow(declarationId, { verify = true } = {}) {
  const declaration = await Declaration.findById(declarationId);
  if (!declaration) throw errorUtils.notFoundError('Declaration not found');

  // Manual records (no linked sheet row) are not written back.
  if (!declaration.sheet_row_id) {
    return { skipped: true, reason: 'no_sheet_row' };
  }

  const { spreadsheetId, sheetName } = sheetConfig();
  if (!spreadsheetId) {
    return { skipped: true, reason: 'sheet_not_configured' };
  }

  const range       = statusRange(sheetName, declaration.sheet_row_id);
  const sheetStatus = toSheetStatus(declaration.status); // sheet stores lowercase

  try {
    await getSheets().spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: 'RAW',
      requestBody:      { values: [[sheetStatus]] },
    });

    if (verify) {
      const sheetValue = await readStatusCell(sheetName, declaration.sheet_row_id);
      if (normalizeStatus(sheetValue) !== normalizeStatus(sheetStatus)) {
        await declarationService.markError(
          declarationId, `verify mismatch: sheet="${sheetValue}" expected="${sheetStatus}"`
        );
        return { written: true, verified: false, range, status: sheetStatus, sheetValue };
      }
    }

    await declarationService.markSynced(declarationId);
    return { written: true, verified: verify, range, status: sheetStatus };
  } catch (err) {
    await declarationService.markError(declarationId, String(err.message || err).slice(0, 200));
    return { written: false, range, error: err.message || String(err) };
  }
}

// ─── Append a new declaration row (Approved Draft Execution) ────────────────────

// Formats one cell value for the sheet. Status is lowercased to match existing rows;
// Dates are written as YYYY-MM-DD; null/undefined become ''.
function formatCell(field, value) {
  if (value == null) return '';
  if (field === 'status') return toSheetStatus(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

// Parses the 1-based row number from an A1 range like "'Декларация'!A42:G42".
function parseAppendedRow(updatedRange) {
  const m = String(updatedRange || '').match(/(\d+)(?:\D*)$/);
  return m ? m[1] : null;
}

// appendDeclarationRow — APPENDS a brand-new row to the Declaration sheet from a
// proposed-data object (the columns named in DECLARATION_SHEET_COLUMNS, A→G). It
// NEVER updates an existing row. Reads the status cell back to VERIFY the append
// landed. This is the only sheet-write path used by Approved Draft Execution.
// Returns:
//   { written:true, verified:true, rowId, range, values }      on success
//   { written:true, verified:false, rowId, sheetValue }        append landed but verify mismatch
//   { skipped:true, reason }                                    nothing to write
//   { written:false, error }                                   API failure
async function appendDeclarationRow(rowData = {}, { verify = true } = {}) {
  const { spreadsheetId, sheetName } = sheetConfig();
  if (!spreadsheetId) return { skipped: true, reason: 'sheet_not_configured' };

  const values     = DECLARATION_SHEET_COLUMNS.map(field => formatCell(field, rowData[field]));
  const lastCol     = DECLARATION_SHEET_STATUS_COLUMN; // status is the final column
  const appendRange = `${quoteName(sheetName)}!A:${lastCol}`;

  try {
    const res = await getSheets().spreadsheets.values.append({
      spreadsheetId,
      range:            appendRange,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody:      { values: [values] },
    });

    const updatedRange = res?.data?.updates?.updatedRange || '';
    const rowId        = parseAppendedRow(updatedRange);
    if (!rowId) {
      return { written: true, verified: false, error: 'could not determine appended row', updatedRange, values };
    }

    if (verify) {
      const sheetValue = await readStatusCell(sheetName, rowId);
      if (normalizeStatus(sheetValue) !== normalizeStatus(toSheetStatus(rowData.status))) {
        return { written: true, verified: false, rowId, range: updatedRange, sheetValue, values };
      }
    }

    return { written: true, verified: verify, rowId, range: updatedRange, values };
  } catch (err) {
    return { written: false, error: err.message || String(err) };
  }
}

// ─── Retry ────────────────────────────────────────────────────────────────────

// Retries every declaration that has a sheet row and is not synced (pending OR a
// previously failed write). Used by the scheduler and after transient failures.
async function retryPendingDeclarations() {
  const stuck = await Declaration.find({
    sync_status:  { $in: ['pending', 'error'] },
    sheet_row_id: { $exists: true, $ne: null },
  });

  let written = 0, errors = 0;
  for (const declaration of stuck) {
    const result = await writeDeclarationRow(declaration._id);
    if (result.written && result.verified !== false) written++;
    else if (result.error || result.verified === false) errors++;
  }
  return { attempted: stuck.length, written, errors };
}

module.exports = {
  verifyAuth,
  verifySpreadsheet,
  readStatusCell,
  readHeaderRow,
  writeDeclarationRow,
  appendDeclarationRow,
  retryPendingDeclarations,
  statusRange,
  colLetter,
  toSheetStatus,
  _setSheetsClient,
};
