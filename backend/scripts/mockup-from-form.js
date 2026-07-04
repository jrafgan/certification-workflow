#!/usr/bin/env node
'use strict';

// scripts/mockup-from-form.js — REAL data flow: Google Form → Mapper → DOCX → Lab Package.
// Reads a real row from the live "Ответы на форму (1)" tab, maps the 11 fields, renders the DS
// draft + attachment against the real template, and builds the lab package preview. Sends nothing.
//
// Run: node scripts/mockup-from-form.js [rowNumber]

require('dotenv').config();
const path = require('path');
const cp = require('child_process');
const { google } = require('googleapis');
const mapper = require('../src/services/formFieldMapper');
const mockup = require('../src/services/mockupAgentService');

const TEMPLATE_DIR = path.join(__dirname, '..', 'templates', 'mockup');
const OUT_DIR = path.join(__dirname, '..', 'tmp', 'mockup-from-form');

function a1(tab) { return /^[A-Za-z0-9_]+$/.test(tab) ? tab : `'${tab.replace(/'/g, "''")}'`; }

(async () => {
  const auth = new google.auth.GoogleAuth({ keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  const sheets = google.sheets({ version: 'v4', auth });
  const id = process.env.NEW_FORM_SHEET_ID;
  const tab = process.env.NEW_FORM_RESPONSES_TAB || 'Ответы на форму (1)';

  const res = await sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${a1(tab)}!A1:BA200` });
  const rows = res.data.values || [];
  const header = rows[0] || [];
  const data = rows.slice(1);

  const cols = mapper.detectColumns(header);
  console.log('\n=== DETECTED COLUMN MAPPING (form header → canonical field) ===');
  for (const [field, idx] of Object.entries(cols)) {
    const colLetter = idx < 0 ? '—' : String.fromCharCode(65 + idx);
    console.log(`  ${field.padEnd(22)} ${idx < 0 ? '(not found)' : `col ${colLetter}: ${JSON.stringify(String(header[idx]).slice(0, 44))}`}`);
  }

  // Pick: explicit row arg (sheet row number), else first row with applicant name + INN + a TN VED.
  const argRow = parseInt(process.argv[2], 10);
  let pickIdx = -1;
  if (argRow >= 2) pickIdx = argRow - 2;
  else pickIdx = data.findIndex(r => {
    const m = mapper.mapRow(header, r, { docType: 'ДС' });
    return m.applicant.name && m.applicant.inn && (m.tnved_text || m.items.some(i => i.tnved));
  });
  if (pickIdx < 0) pickIdx = 0;
  const sheetRow = pickIdx + 2;
  const row = data[pickIdx] || [];

  const application = mapper.mapRow(header, row, { docType: 'ДС' });
  console.log(`\n=== MAPPED APPLICATION (sheet row ${sheetRow}) ===`);
  console.log(JSON.stringify({ applicant: application.applicant, manufacturer: application.manufacturer, brand: application.brand, legal_entity: application.legal_entity, items_text: application.items_text, composition_text: application.composition_text, tnved_text: application.tnved_text }, null, 2));
  console.log('items[] (for §6/§7):', JSON.stringify(application.items));
  console.log('field_warnings     :', JSON.stringify(application._meta.field_warnings));

  const proposal = mockup.proposeMockup(application, { templateDir: TEMPLATE_DIR, outDir: OUT_DIR });
  console.log('\n=== RENDER ===');
  console.log('rendered           :', proposal.rendered, proposal.render_blocked ? `(blocked: ${proposal.render_blocked})` : '');
  console.log('draft file         :', proposal.mockup_file_name);
  console.log('attachment file    :', proposal.attachment_file_name || '(none — single TN VED)');
  console.log('§6 warnings        :', proposal.warnings.length ? proposal.warnings : 'none');
  console.log('unmapped tokens    :', proposal.missing_placeholders);

  const pkg = mockup.buildLabPackage(proposal, {
    clientCertPath: '(operator attaches client IP/OsOO certificate)',
    standardEmailText: `Тема: ${application.applicant.name}\n\nЗдравствуйте! Просьба оформить ДС. Приложены: макет, приложение, свидетельство клиента.`,
  });
  console.log('\n=== LABORATORY PACKAGE PREVIEW (nothing sent) ===');
  console.log(JSON.stringify(pkg, null, 2));

  if (proposal.rendered) {
    const text = cp.execFileSync('unzip', ['-p', proposal.document_path, 'word/document.xml']).toString().replace(/<[^>]+>/g, '');
    console.log('\n=== VERIFY real values landed in DOCX ===');
    for (const probe of [application.applicant.name, application.applicant.inn].filter(Boolean)) {
      console.log(`  ${text.includes(probe) ? '✓' : '✗'} ${JSON.stringify(probe)}`);
    }
  }
  console.log('\nDONE — artifacts in', OUT_DIR, '\n');
})().catch(e => { console.log('ERR:', e.message.split('\n')[0]); process.exit(1); });
