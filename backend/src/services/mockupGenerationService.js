'use strict';

// services/mockupGenerationService.js — first production workflow orchestrator.
//
//   Новая форма row → formFieldMapper → newFormClassificationService → mockupTemplateRegistry
//   → real DOCX written to a persistent, downloadable location.
//
// Output-only/gated: it produces a draft DOCX for the operator to download; it sends nothing.
// generateFromApplication() is the testable core (no network). generateFromLatestForm() reads
// the live sheet. resolveDownload() backs the download endpoint.

const fs = require('fs');
const path = require('path');
const classifier = require('./newFormClassificationService');
const registry = require('./mockupTemplateRegistry');

// Persistent output root (compose mounts uploads/ as a volume → survives restarts).
function baseDir(opts = {}) {
  return opts.baseDir || process.env.MOCKUP_OUTPUT_DIR || path.resolve(__dirname, '../../uploads/mockups');
}

function newGenId() {
  return `gen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// generateFromApplication(application, opts) → full result incl. download URLs. The application
// is a mapped object (formFieldMapper.mapRow shape): needs .age + .items_text for classification
// and the mockup field shape (applicant{}, manufacturer{}, items[]) for rendering.
function generateFromApplication(application = {}, opts = {}) {
  const classification = classifier.classify({
    age: application.age,
    items_text: application.items_text,
    composition_text: application.composition_text,
    tnved_text: application.tnved_text,
  });

  // No DS/SS without an operator decision → do not guess, do not render.
  if (classification.needs_operator || !classification.doc_type) {
    return { generated: false, blocked: 'classification_needs_operator', classification };
  }

  const genId = opts.genId || newGenId();
  const outDir = path.join(baseDir(opts), genId);
  const gen = registry.generate(application, { docType: classification.doc_type, outDir, templateDir: opts.templateDir });

  if (!gen.rendered) {
    return { generated: false, blocked: gen.render_blocked || 'render_failed', classification, template_expected: gen.template_expected };
  }

  // Subject name = «<юр.форма> <название>». The legal-form prefix (ИП/ОсОО/ООО/ТОО) is MANDATORY
  // and never dropped (operator rule). Always prepend the form's legal-entity value as-is.
  const lf = String(application.legal_entity || '').trim();
  const client_name = [lf, application.applicant && application.applicant.name]
    .filter(Boolean).map(s => String(s).trim()).join(' ').trim() || applicant;

  return {
    generated: true,
    generation_id: genId,
    client_name,                                              // «ИП Иванов» — for the lab-email subject
    classification: {
      age: classification.age.value,
      category: classification.category,                       // sewing | knitwear | mixed
      doc_type: classification.doc_type,                        // ДС | СС
      composition_groups: classification.composition_group_count,
      protocol_groups: classification.estimated_protocol_count,
      samples_required: classification.samples_required,
      laboratory: classification.laboratory,
      confidence: classification.determination.confidence,
      warnings: classification.warnings,
    },
    doc_type: classification.doc_type,
    template_used: gen.template_used,                           // …/Макет_ДС.docx | Макет_СС.docx
    mockup_file_name: gen.mockup_file_name,                     // макет_<applicant>.docx
    document_path: gen.document_path,
    missing_placeholders: gen.missing_placeholders,
    attachment_file_name: gen.attachment_file_name,            // приложение_<applicant>.docx | null
    attachment_path: gen.attachment_path || null,
    download_url: `/api/mockups/${genId}/download`,
    attachment_download_url: gen.attachment_path ? `/api/mockups/${genId}/download?kind=attachment` : null,
    auto_send: false,
    requires: { operator_approval: true, client_approval: true },
  };
}

// generateFromLatestForm(opts, deps) — read the live "Новая форма", take the LATEST row with an
// applicant, map → classify → generate. deps.readRows injectable for tests.
async function generateFromLatestForm(opts = {}, deps = {}) {
  const mapper = deps.mapper || require('./formFieldMapper');
  const readRows = deps.readRows || defaultReadRows;

  const { header, rows } = await readRows();
  let pick = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (mapper.mapRow(header, rows[i], { docType: null }).applicant.name) { pick = i; break; }
  }
  if (pick < 0) return { generated: false, blocked: 'no_application_rows' };

  const sheetRow = pick + 2;
  const application = mapper.mapRow(header, rows[pick], { docType: null });
  return { sheet_row: sheetRow, ...generateFromApplication(application, opts) };
}

// generateFromForm(sheetRow, opts, deps) — generate for a SPECIFIC «Новая форма» row (the
// work-queue replacement for "latest row"). sheetRow is the 1-based sheet row number.
async function generateFromForm(sheetRow, opts = {}, deps = {}) {
  const mapper = deps.mapper || require('./formFieldMapper');
  const readRows = deps.readRows || defaultReadRows;

  const { header, rows } = await readRows();
  const idx = Number(sheetRow) - 2;                          // row 2 = first data row
  if (!Number.isInteger(idx) || idx < 0 || idx >= rows.length) {
    return { generated: false, blocked: 'row_not_found', sheet_row: sheetRow };
  }
  const application = mapper.mapRow(header, rows[idx], { docType: null });
  if (!application.applicant.name) return { generated: false, blocked: 'empty_row', sheet_row: Number(sheetRow) };
  return { sheet_row: Number(sheetRow), ...generateFromApplication(application, opts) };
}

// defaultReadRows — live Google Sheets reader for "Новая форма" (read-only). Requires
// GOOGLE_SERVICE_ACCOUNT_KEY_FILE + NEW_FORM_SHEET_ID in the environment.
async function defaultReadRows() {
  const { google } = require('googleapis');
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const tab = process.env.NEW_FORM_RESPONSES_TAB || 'Ответы на форму (1)';
  const a1 = /^[A-Za-z0-9_]+$/.test(tab) ? tab : `'${tab.replace(/'/g, "''")}'`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.NEW_FORM_SHEET_ID, range: `${a1}!A1:BA1000` });
  const values = res.data.values || [];
  return { header: values[0] || [], rows: values.slice(1) };
}

// resolveDownload(genId, kind) → { path, filename } | null. Backs the download endpoint.
// kind: 'mockup' (макет_…) | 'attachment' (приложение_…). Path-traversal safe.
function resolveDownload(genId, kind = 'mockup', opts = {}) {
  if (!/^gen_[A-Za-z0-9_]+$/.test(String(genId || ''))) return null;
  const dir = path.join(baseDir(opts), genId);
  if (!fs.existsSync(dir)) return null;
  const prefix = kind === 'attachment' ? 'приложение_' : 'макет_';
  const file = fs.readdirSync(dir).find(f => f.startsWith(prefix) && f.endsWith('.docx'));
  if (!file) return null;
  return { path: path.join(dir, file), filename: file };
}

module.exports = { generateFromApplication, generateFromLatestForm, generateFromForm, resolveDownload, baseDir, defaultReadRows };
