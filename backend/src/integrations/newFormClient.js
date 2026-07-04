'use strict';

// integrations/newFormClient.js — READ-ONLY reader for the "Новая форма"
// spreadsheet (the Google Form submissions feed).
//
// It only reads: lists worksheets, classifies them, auto-identifies the ACTIVE
// Form-responses tab, reads submissions, and maps columns. It NEVER writes any
// sheet, never moves rows, never writes MongoDB, never creates orders, never
// sends messages.
//
// Worksheet roles
//   active_responses — the live Google Form responses tab (primary source).
//   archive          — "Завершенные"/"Завршенные": historical applications that
//                      were MANUALLY MOVED out of the active area because the
//                      sheet grew too large. Rules:
//                        • archive is historical/reference only,
//                        • it is NEVER a primary source for current matching,
//                        • a row here does NOT indicate an active order,
//                        • if the same entity is in both, ACTIVE takes precedence.
//   other            — helper/working tabs (e.g. "Столб"); not a submissions source.
//
// The spreadsheet is identified by NEW_FORM_SHEET_ID. Optionally pin the active
// responses tab with NEW_FORM_RESPONSES_TAB.

const { google } = require('googleapis');
const { mapHeader } = require('./newApplicationsClient');

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

// Active Google-Form response tab names.
const RESPONSES_TAB_PATTERNS = [
  /form\s*responses/i, /ответы\s*на\s*форму/i, /ответы\s*формы/i, /ответы/i, /responses/i,
];

// Archive tab markers (matched on a normalized title). Covers the correct
// "завершенные" AND the real misspelled tab "завршенные", plus EN variants.
const ARCHIVE_MARKERS = ['заверш', 'заврш', 'архив', 'archiv', 'completed', 'history'];

function normalizeTitle(t) { return String(t || '').toLowerCase().replace(/[^a-zа-яё]/g, ''); }

// classifyTab(title) → 'archive' | 'active_responses' | 'other'. Archive is
// checked FIRST so an archive tab can never be treated as an active source.
// Pure — exported for testing.
function classifyTab(title) {
  const n = normalizeTitle(title);
  if (ARCHIVE_MARKERS.some(m => n.includes(m))) return 'archive';
  if (RESPONSES_TAB_PATTERNS.some(p => p.test(title))) return 'active_responses';
  return 'other';
}

function quoteName(n) { return /^[A-Za-z0-9_]+$/.test(n) ? n : `'${String(n).replace(/'/g, "''")}'`; }

let _sheets = null;
function getSheets() {
  if (!_sheets) {
    const auth = new google.auth.GoogleAuth({ keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE, scopes: [SCOPE] });
    _sheets = google.sheets({ version: 'v4', auth });
  }
  return _sheets;
}
function _setSheetsClient(c) { _sheets = c; } // test seam

// pickResponsesTab — choose the ACTIVE responses worksheet. NEVER returns an
// archive tab. 1) explicit override (if not archive), 2) name pattern among
// active tabs, 3) the non-archive tab with the most header cells.
// Pure — exported for testing.
function pickResponsesTab(tabs, override, headerByTab = {}) {
  const nonArchive = tabs.filter(t => classifyTab(t.title) !== 'archive');
  if (override) {
    const t = nonArchive.find(x => x.title === override);
    if (t) return t;
  }
  const active = nonArchive.find(t => classifyTab(t.title) === 'active_responses');
  if (active) return active;
  let best = null, bestN = -1;
  for (const t of nonArchive) {
    const n = (headerByTab[t.title] || []).filter(c => String(c || '').trim()).length;
    if (n > bestN) { bestN = n; best = t; }
  }
  return best;
}

// ─── internal: read one tab's rows (read-only) ────────────────────────────────
async function _readTab(spreadsheetId, tabTitle) {
  const dataRes = await getSheets().spreadsheets.values.get({
    spreadsheetId, range: `${quoteName(tabTitle)}!A1:AZ`,
  });
  const rows = dataRes.data.values || [];
  const header = rows[0] || [];
  const dataRows = rows.slice(1).filter(r => r && r.some(c => String(c || '').trim()));
  return { header, dataRows, columns: header.map((name, index) => ({ index, name })), detected: mapHeader(header) };
}

// inspect() — full read-only inspection used by the verify command. Reports tab
// ROLES, identifies the ACTIVE responses tab, and reads ONLY that tab. Archive
// tabs are listed but NOT read into the primary submissions/rowCount.
async function inspect() {
  const spreadsheetId = process.env.NEW_FORM_SHEET_ID;
  if (!spreadsheetId) return { ok: false, reason: 'sheet_not_configured' };

  let meta;
  try {
    meta = await getSheets().spreadsheets.get({ spreadsheetId, fields: 'properties.title,sheets.properties(title,gridProperties)' });
  } catch (err) {
    return { ok: false, reason: 'fetch_failed', error: err.message || String(err) };
  }

  const title = meta.data.properties.title;
  const tabs = (meta.data.sheets || []).map(s => ({
    title: s.properties.title,
    rows:  s.properties.gridProperties.rowCount,
    cols:  s.properties.gridProperties.columnCount,
    role:  classifyTab(s.properties.title),
  }));

  const headerByTab = {};
  for (const t of tabs) {
    try {
      const r = await getSheets().spreadsheets.values.get({ spreadsheetId, range: `${quoteName(t.title)}!1:1` });
      headerByTab[t.title] = r.data.values?.[0] || [];
    } catch { headerByTab[t.title] = []; }
  }

  const archiveTabs = tabs.filter(t => t.role === 'archive').map(t => t.title);
  const responsesTab = pickResponsesTab(tabs, process.env.NEW_FORM_RESPONSES_TAB, headerByTab);
  if (!responsesTab) {
    return { ok: true, title, tabs, responsesTab: null, archiveTabs, reason: 'no_active_responses_tab' };
  }

  const { header, dataRows, columns, detected } = await _readTab(spreadsheetId, responsesTab.title);
  return {
    ok: true,
    title,
    tabs,
    responsesTab: responsesTab.title,       // ACTIVE source (never archive)
    archiveTabs,                            // historical/reference only — NOT read here
    columns,
    detected,
    rowCount: dataRows.length,              // ACTIVE submissions only
    latest5: dataRows.slice(-5).reverse(),
    header,
  };
}

// readActiveResponses() — the PRIMARY source for current matching: the active
// Form-responses tab only, archive excluded. Read-only.
async function readActiveResponses() {
  const r = await inspect();
  if (!r.ok || !r.responsesTab) return { ok: false, reason: r.reason || 'no_active_responses_tab', source: 'active' };
  return { ok: true, source: 'active', tab: r.responsesTab, columns: r.columns, detected: r.detected, rowCount: r.rowCount, header: r.header };
}

// readApplications() — row-level applications from the ACTIVE responses tab, in the
// same shape as newApplicationsClient.readApplications ({ applications, reason, ... }).
// This bridges the New Form spreadsheet to applicationMatchService (which expects that
// interface). Read-only; archive excluded.
async function readApplications() {
  const spreadsheetId = process.env.NEW_FORM_SHEET_ID;
  if (!spreadsheetId) return { applications: [], reason: 'sheet_not_configured' };
  const r = await inspect();
  if (!r.ok || !r.responsesTab) return { applications: [], reason: r.reason || 'no_active_responses_tab' };
  const { header, dataRows } = await _readTab(spreadsheetId, r.responsesTab);
  const { rowsToApplications } = require('./newApplicationsClient');
  const mapped = rowsToApplications([header, ...dataRows]);
  return { tab: r.responsesTab, row_count: dataRows.length, ...mapped };
}

// readFormRows() — RAW header + dataRows of the ACTIVE responses tab (read-only, archive
// excluded). Needed by newApplicationProposalService, which maps each row via
// formFieldMapper.mapRow to classify (ДС/СС), count ПИ and draft a client reply.
async function readFormRows() {
  const spreadsheetId = process.env.NEW_FORM_SHEET_ID;
  if (!spreadsheetId) return { ok: false, reason: 'sheet_not_configured' };
  const r = await inspect();
  if (!r.ok || !r.responsesTab) return { ok: false, reason: r.reason || 'no_active_responses_tab' };
  const { header, dataRows } = await _readTab(spreadsheetId, r.responsesTab);
  return { ok: true, tab: r.responsesTab, header, dataRows };
}

// readArchive() — EXPLICIT historical reference only. Reads the "Завершенные"
// archive tab(s). Rows are flagged is_active:false / source:'archive'. Must NOT
// be used as a primary matching source; a row here is not an active order.
async function readArchive() {
  const spreadsheetId = process.env.NEW_FORM_SHEET_ID;
  if (!spreadsheetId) return { ok: false, reason: 'sheet_not_configured', source: 'archive' };
  const meta = await getSheets().spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
  const tabs = (meta.data.sheets || []).map(s => s.properties.title);
  const archive = tabs.filter(t => classifyTab(t) === 'archive');
  const out = [];
  for (const t of archive) {
    const { columns, dataRows, detected } = await _readTab(spreadsheetId, t);
    out.push({ tab: t, columns, detected, rowCount: dataRows.length });
  }
  return { ok: true, source: 'archive', is_active: false, historical: true, archiveTabs: archive, results: out };
}

// activeTakesPrecedence(activeCandidates, archiveCandidates) — Rule 5 helper.
// Returns active candidates (unchanged) plus any archive candidates whose entity
// is NOT already present among active ones, each flagged is_active:false. Active
// always shadows archive for the same legal entity. Pure — for future matching.
function activeTakesPrecedence(activeCandidates = [], archiveCandidates = []) {
  const norm = s => String(s || '').toLowerCase().replace(/[^0-9a-zа-яё]+/gi, ' ').trim();
  const activeKeys = new Set(activeCandidates.map(c => norm(c.legal_entity || c.client || c.client_name)));
  const archiveOnly = archiveCandidates
    .filter(c => !activeKeys.has(norm(c.legal_entity || c.client || c.client_name)))
    .map(c => ({ ...c, is_active: false, source: 'archive' }));
  return [...activeCandidates.map(c => ({ ...c, is_active: true, source: 'active' })), ...archiveOnly];
}

module.exports = {
  inspect, readActiveResponses, readArchive, readApplications, readFormRows,
  classifyTab, pickResponsesTab, activeTakesPrecedence,
  _setSheetsClient,
};
