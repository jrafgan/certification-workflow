'use strict';

// scripts/live-write-roundtrip.js — one-off LIVE verification of Sheets write-back.
//
// Safely proves the real write path end-to-end against the live Declaration sheet:
//   1. read the current value of the row's status cell (column N)
//   2. drive the REAL sheetsSync.writeDeclarationRow() (lowercase + read-after-write verify)
//   3. confirm the new value landed
//   4. RESTORE the original value byte-for-byte (in a finally block)
//
// A throwaway local mongod backs the Declaration record so the production code
// path runs unchanged. Nothing is left mutated in the sheet.
//
// Usage: node scripts/live-write-roundtrip.js <rowNumber>

require('dotenv').config();

const os    = require('os');
const fs    = require('fs');
const path  = require('path');
const { spawn } = require('child_process');
const mongoose  = require('mongoose');
const { google } = require('googleapis');

const sheetsSync = require('../src/integrations/sheetsSync');

const ROW = process.argv[2];
if (!ROW) { console.error('Usage: node scripts/live-write-roundtrip.js <rowNumber>'); process.exit(1); }

const SHEET_NAME = process.env.DECLARATION_SHEET_NAME || 'Sheet1';
const SPREADSHEET_ID = process.env.DECLARATION_SHEET_ID;

// Independent raw client (same SA auth) used only to restore the original value.
function rawSheets() {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
    scopes:  ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function startMongo() {
  const dbpath = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-mongo-'));
  const port   = 27034;
  const proc = spawn('mongod', ['--dbpath', dbpath, '--port', String(port), '--bind_ip', '127.0.0.1'], { stdio: 'ignore' });
  const uri = `mongodb://127.0.0.1:${port}/rt_test`;
  for (let i = 0; i < 40; i++) {
    try { await mongoose.connect(uri, { serverSelectionTimeoutMS: 500 }); return { proc, dbpath }; }
    catch (_) { await new Promise(r => setTimeout(r, 250)); }
  }
  throw new Error('mongod did not become ready');
}
async function stopMongo(h) {
  try { await mongoose.disconnect(); } catch (_) {}
  if (h?.proc) try { h.proc.kill('SIGKILL'); } catch (_) {}
  if (h?.dbpath) try { fs.rmSync(h.dbpath, { recursive: true, force: true }); } catch (_) {}
}

(async () => {
  if (!SPREADSHEET_ID) { console.error('DECLARATION_SHEET_ID not set'); process.exit(1); }
  console.log(`── LIVE write round-trip on ${SHEET_NAME}!N${ROW} ──\n`);

  const range = sheetsSync.statusRange(SHEET_NAME, ROW);

  // 1. Original value (verbatim, including any padding)
  const original = await sheetsSync.readStatusCell(SHEET_NAME, ROW);
  console.log('1. original value:', original === null ? '(empty)' : JSON.stringify(original));

  // Choose a distinct test status
  const norm = s => String(s ?? '').trim().toLowerCase();
  const TEST_STATUS = norm(original) === 'ждем макет' ? 'Запустить' : 'Ждем макет';
  console.log('   test status to write (canonical):', TEST_STATUS, '→ sheet:', sheetsSync.toSheetStatus(TEST_STATUS));

  let mongo, restored = false;
  try {
    mongo = await startMongo();
    const { Declaration } = require('../src/models/Declaration');
    const decl = await Declaration.create({ source: 'google_sheets', sheet_row_id: String(ROW), status: TEST_STATUS, sync_status: 'pending' });

    // 2. Real write-back (no mock injected → hits the live sheet)
    const result = await sheetsSync.writeDeclarationRow(decl._id);
    console.log('\n2. writeDeclarationRow result:', JSON.stringify(result));

    // 3. Confirm landed
    const after = await sheetsSync.readStatusCell(SHEET_NAME, ROW);
    console.log('3. value after write:', JSON.stringify(after));
    const ok = norm(after) === norm(TEST_STATUS);
    console.log('   live write verified:', ok ? 'YES' : 'NO');

    const declAfter = await Declaration.findById(decl._id).lean();
    console.log('   declaration sync_status:', declAfter.sync_status);
  } finally {
    // 4. Restore original value byte-for-byte (empty string if it was empty)
    try {
      await rawSheets().spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID, range, valueInputOption: 'RAW',
        requestBody: { values: [[original === null ? '' : original]] },
      });
      const back = await sheetsSync.readStatusCell(SHEET_NAME, ROW);
      restored = (original === null ? back === null || back === '' : back === original);
      console.log('\n4. restored original:', JSON.stringify(back), '— match:', restored ? 'YES' : 'NO');
    } catch (e) {
      console.log('\n4. RESTORE FAILED — manual check needed:', e.message);
    }
    if (mongo) await stopMongo(mongo);
  }

  console.log(`\nRound-trip ${restored ? 'COMPLETE (sheet unchanged)' : 'FINISHED — verify restore manually'}.`);
  process.exit(0);
})().catch(err => { console.error('ERROR:', err.message || err); process.exit(1); });
