'use strict';

// scripts/verify-sheets.js — live, READ-ONLY verification of Google Sheets
// integration. Proves end-to-end that authentication works, the Declaration
// spreadsheet is reachable, and a status cell can be read.
//
// It NEVER writes to the spreadsheet (the Declaration sheet is the primary
// business artifact). The write path is exercised by tests with a fake client;
// to verify a real write, do it deliberately, not from this script.
//
// Usage:
//   node scripts/verify-sheets.js              # auth + spreadsheet metadata
//   node scripts/verify-sheets.js <rowNumber>  # also read the Status cell of that row

require('dotenv').config();

const sheetsSync = require('../src/integrations/sheetsSync');

(async () => {
  console.log('── Google Sheets integration verification (read-only) ──\n');

  // 1. Authentication — dedicated Sheets Service Account (not the Gmail OAuth client)
  const auth = await sheetsSync.verifyAuth();
  if (!auth.ok) {
    console.log('AUTH: FAIL (service account)');
    if (auth.reason)  console.log('  reason:', auth.reason);
    if (auth.keyFile) console.log('  key file:', auth.keyFile);
    if (auth.error)   console.log('  error:', auth.error);
    process.exit(1);
  }
  console.log('AUTH: OK (service account access token obtained)');
  console.log('  service account:', auth.clientEmail);
  console.log('  key project:    ', auth.projectId);

  // 2. Spreadsheet reachability
  if (!process.env.DECLARATION_SHEET_ID) {
    console.log('\nSHEET: SKIPPED — DECLARATION_SHEET_ID is not set in .env');
    console.log('Set DECLARATION_SHEET_ID and DECLARATION_SHEET_NAME to verify the sheet.');
    process.exit(0);
  }

  const meta = await sheetsSync.verifySpreadsheet();
  if (!meta.ok) {
    console.log('\nSHEET: FAIL');
    console.log('  error:', meta.error || meta.reason);
    process.exit(1);
  }
  console.log(`\nSHEET: OK — "${meta.title}"`);
  console.log('  tabs:', meta.tabs.join(', '));
  console.log('  status column (configured):', require('../src/config/constants').DECLARATION_SHEET_STATUS_COLUMN);
  console.log('  active tab:', process.env.DECLARATION_SHEET_NAME || '(default Sheet1)');

  // Header row — identify which column actually holds the status.
  const sheetName = process.env.DECLARATION_SHEET_NAME || 'Sheet1';
  try {
    const header = await sheetsSync.readHeaderRow(sheetName);
    console.log('\nHEADER ROW (set DECLARATION_STATUS_COLUMN to the status column letter):');
    for (const cell of header) {
      if (cell.value) console.log(`  ${cell.column}: ${cell.value}`);
    }
  } catch (err) {
    console.log('\nHEADER ROW: could not read —', err.message || err);
  }

  // 3. Read a Status cell (optional)
  const row = process.argv[2];
  if (row) {
    const sheetName = process.env.DECLARATION_SHEET_NAME || 'Sheet1';
    const value = await sheetsSync.readStatusCell(sheetName, row);
    console.log(`\nREAD: row ${row} status cell = ${value === null ? '(empty)' : `"${value}"`}`);
  }

  console.log('\nAll checks passed.');
  process.exit(0);
})().catch(err => {
  console.error('\nUNEXPECTED ERROR:', err.message || err);
  process.exit(1);
});
