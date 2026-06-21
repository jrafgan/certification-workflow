#!/usr/bin/env node
'use strict';

// scripts/verify-new-form.js — live, READ-ONLY verification of the "Новая форма"
// Google Sheet (Google Form submissions feed). Mirrors verify-sheets.js.
//
// It NEVER writes the sheet, never writes MongoDB, never creates orders, never
// sends messages. It only reads and reports:
//   worksheet names · responses tab · column names · row count · latest 5 rows
//
// Usage:
//   NEW_FORM_SHEET_ID=<spreadsheetId> node scripts/verify-new-form.js
//   (or set NEW_FORM_SHEET_ID in backend/.env)

require('dotenv').config();
const newFormClient = require('../src/integrations/newFormClient');

function truncate(s, n = 40) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

(async () => {
  console.log('── "Новая форма" verification (read-only) ──\n');

  if (!process.env.NEW_FORM_SHEET_ID) {
    console.log('NOT CONFIGURED — set NEW_FORM_SHEET_ID (the spreadsheet ID from the sheet URL).');
    console.log('  Example: NEW_FORM_SHEET_ID=1AbC...XyZ node scripts/verify-new-form.js');
    console.log('  Optional: NEW_FORM_RESPONSES_TAB="Ответы на форму (1)" to pin the responses tab.');
    process.exit(0);
  }

  const r = await newFormClient.inspect();
  if (!r.ok) {
    console.log('FAIL —', r.reason, r.error ? `(${r.error})` : '');
    process.exit(1);
  }

  console.log('SPREADSHEET:', r.title);
  console.log('\nWORKSHEETS (' + r.tabs.length + '):');
  r.tabs.forEach(t => console.log(`  - ${t.title}  [${t.rows}×${t.cols}]  role=${t.role}`));

  if (r.archiveTabs && r.archiveTabs.length) {
    console.log('\nARCHIVE TABS (historical/reference only — EXCLUDED from active matching):');
    r.archiveTabs.forEach(t => console.log(`  - ${t}  (a row here does NOT indicate an active order)`));
  }

  if (!r.responsesTab) {
    console.log('\nACTIVE RESPONSES TAB: not identified (no active Form-responses tab found).');
    process.exit(0);
  }

  console.log('\nIDENTIFIED ACTIVE RESPONSES TAB:', r.responsesTab, '(primary source)');
  console.log('ROW COUNT (active submissions only):', r.rowCount);

  console.log('\nCOLUMNS (' + r.columns.length + '):');
  r.columns.forEach(c => console.log(`  [${c.index}] ${c.name}`));

  const d = r.detected;
  console.log('\nDETECTED FIELD MAPPING:');
  console.log('  phone        →', d.phone >= 0 ? `[${d.phone}] ${r.columns[d.phone].name}` : '(not found)');
  console.log('  legal_entity →', d.legal_entity >= 0 ? `[${d.legal_entity}] ${r.columns[d.legal_entity].name}` : '(not found)');
  console.log('  submitted_at →', d.submitted_at >= 0 ? `[${d.submitted_at}] ${r.columns[d.submitted_at].name}` : '(not found)');

  console.log('\nLATEST 5 SUBMISSIONS:');
  if (!r.latest5.length) {
    console.log('  (none — sheet has no submissions yet)');
  } else {
    r.latest5.forEach((row, i) => {
      const cells = r.columns.map(c => `${truncate(c.name, 18)}=${truncate(row[c.index], 30)}`).join(' | ');
      console.log(`  ${i + 1}. ${cells}`);
    });
  }

  console.log('\nRead-only verification complete. No data was modified.');
  process.exit(0);
})().catch(err => {
  console.error('\nUNEXPECTED ERROR:', err.message || err);
  process.exit(1);
});
