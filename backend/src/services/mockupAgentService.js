'use strict';

// services/mockupAgentService.js — Mockup Agent (MVP).
//
// Generates DRAFT Declaration (ДС) / Certificate (СС) documents from Google-Form data
// (the source of truth — KB rule `draft_source_of_truth`). OUTPUT-ONLY and fully gated:
// it never sends anything to the client or the lab. Workflow (KB §4):
//   application → payment → receipt → create order → GENERATE DRAFT → operator review →
//   send to client (operator) → client approval → lab package (operator).
//
// This module is the template-INDEPENDENT core + a placeholder-fill engine:
//   • resolveFields        — §1/§5 canonical fields → {{PLACEHOLDER}} values
//   • compositionWarnings  — §6 "4 per composition" rule → operator warning (never auto-decide)
//   • buildAttachment      — §7 multi-TN VED → application table; main doc references it
//   • fillTemplate         — fill a provided .docx template via system zip/unzip (no npm dep)
//   • proposeMockup        — assemble the output-only draft proposal (status:'draft', no send)
//   • buildLabPackage      — §9 lab submission package assembly (auto_generate, never auto_send)
//
// NOTE: real DS/SS rendering needs the operator-supplied template .docx files
// (MOCKUP_TEMPLATE_DIR/declaration.docx|certificate.docx). Without them the proposal still
// returns fields/warnings/attachment, with rendered:false + a render_blocked reason.

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

// §1 canonical fields ↔ §5 placeholders. Each maps an application object → a string value.
const PLACEHOLDER_MAP = {
  APPLICANT_L_E_NAME:    a => a.applicant?.name,
  LEGAL_ENTITY:          a => a.legal_entity,
  INN:                   a => a.applicant?.inn,
  L_E_ADRESS:            a => a.applicant?.address,
  PHONE_NUMBER:          a => a.applicant?.phone,
  EMAIL:                 a => a.applicant?.email,
  MANUFACTURER_L_E_NAME: a => a.manufacturer?.name,
  MANUFACTURER_COUNTRY:  a => a.manufacturer?.country,
  MANUFACTURER_ADRESS:   a => a.manufacturer?.address,
  BRAND_NAME:            a => a.brand,
  // Prefer the verbatim form text (faithful to what the client wrote) when the mapper supplies
  // it; otherwise derive from the structured items[].
  ITEMS:                 a => (a.items_text ? a.items_text : items(a).map(i => i.name).filter(Boolean).join(', ')),
  ITEM_COMPOSITION:      a => (a.composition_text ? a.composition_text : uniqueCompositions(a).join('; ')),
  TNVED:                 a => tnvedField(a),
};

function items(a) { return Array.isArray(a && a.items) ? a.items : []; }
function uniqueTnved(a) { return [...new Set(items(a).map(i => String(i.tnved || '').trim()).filter(Boolean))]; }
function uniqueCompositions(a) { return [...new Set(items(a).map(i => String(i.composition || '').trim()).filter(Boolean))]; }

// normalize doc type to the canonical 'ДС' | 'СС' (declaration | certificate), else null.
function normDocType(t) {
  const s = String(t || '').toLowerCase();
  if (/(^|[^а-я])сс|серт|cert|\bss\b/.test(s)) return 'СС';
  if (/(^|[^а-я])дс|деклар|decl|\bds\b/.test(s)) return 'ДС';
  return null;
}

// Main-document TN VED cell: the single code, or "см. приложение" when there are several (§7).
function tnvedField(a) {
  const t = uniqueTnved(a);
  return t.length <= 1 ? (t[0] || '') : 'см. приложение';
}

// §6 — "4 per composition": for ONE composition, >4 product names OR >4 TN VED codes inside one
// DS may require additional test protocols (ПИ). Emit a warning per offending composition.
// NEVER decides — operator review required.
function compositionWarnings(a) {
  const byComp = new Map();
  for (const it of items(a)) {
    const comp = String(it.composition || '').trim() || '(без состава)';
    if (!byComp.has(comp)) byComp.set(comp, { names: new Set(), tnved: new Set() });
    const g = byComp.get(comp);
    if (it.name)  g.names.add(String(it.name).trim());
    if (it.tnved) g.tnved.add(String(it.tnved).trim());
  }
  const warnings = [];
  for (const [composition, g] of byComp) {
    if (g.names.size > 4 || g.tnved.size > 4) {
      warnings.push({
        code: 'possible_additional_pi',
        composition,
        product_count: g.names.size,
        tnved_count: g.tnved.size,
        message: 'Possible additional PI required. Operator review needed.',
        auto_decide: false,
      });
    }
  }
  return warnings;
}

// §7 — multiple TN VED codes → build the application-table attachment. Returns null for ≤1 code.
function buildAttachment(a) {
  if (uniqueTnved(a).length <= 1) return null;
  return {
    columns: ['product_name', 'composition', 'tnved'],
    rows: items(a).map(i => ({
      product_name: String(i.name || '').trim(),
      composition:  String(i.composition || '').trim(),
      tnved:        String(i.tnved || '').trim(),
    })),
    main_doc_references_attachment: true,
  };
}

// resolveFields(application) → { PLACEHOLDER: stringValue }. Empty string when a field is absent.
function resolveFields(a) {
  const out = {};
  for (const [key, fn] of Object.entries(PLACEHOLDER_MAP)) {
    const v = fn(a || {});
    out[key] = v == null ? '' : String(v);
  }
  return out;
}

function xmlEscape(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// fillTemplate(templatePath, values, outPath?) — replace {{PLACEHOLDER}} tokens in the .docx's
// word/document.xml using the system zip/unzip (no npm dependency). Returns
// { buffer, out_path, missing_placeholders }. CAVEAT: a {{TOKEN}} split across Word runs won't
// match — author templates with each placeholder in a single run.
function fillTemplate(templatePath, values, outPath) {
  if (!fs.existsSync(templatePath)) throw new Error('template not found: ' + templatePath);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-'));
  const out = outPath || path.join(tmp, 'out.docx');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.copyFileSync(templatePath, out);
  cp.execFileSync('unzip', ['-o', out, 'word/document.xml', '-d', tmp], { stdio: 'ignore' });
  const xmlPath = path.join(tmp, 'word', 'document.xml');
  let xml = fs.readFileSync(xmlPath, 'utf8');
  const missing = [];
  // Word frequently SPLITS a placeholder across runs (e.g. <APPLICANT_L_E_NAME> becomes
  // &lt; … </w:t><w:t>APPLICANT_ … </w:t><w:t>L_E_NAME&gt;). Pre-pass: rejoin any delimited
  // ALL-CAPS token whose inner fragments (after stripping run markup) form a valid KEY, back
  // into a single contiguous token. XML stays balanced (equal run open/close tags removed).
  const rejoin = (open, close, openEsc, closeEsc) =>
    new RegExp(`${openEsc}((?:<[^>]+>|[A-Za-z0-9_])*?)${closeEsc}`, 'g');
  xml = xml.replace(rejoin('<', '>', '&lt;', '&gt;'), (m, inner) => {
    const key = inner.replace(/<[^>]+>/g, '');
    return /^[A-Z][A-Z0-9_]*$/.test(key) ? `&lt;${key}&gt;` : m;
  });
  xml = xml.replace(/\{\{((?:<[^>]+>|[A-Za-z0-9_])*?)\}\}/g, (m, inner) => {
    const key = inner.replace(/<[^>]+>/g, '');
    return /^[A-Z][A-Z0-9_]*$/.test(key) ? `{{${key}}}` : m;
  });
  // Support BOTH placeholder styles the real templates use: {{FIELD}} and <FIELD>
  // (the latter appears XML-escaped as &lt;FIELD&gt; inside document.xml). Unknown/unmapped
  // tokens (e.g. <LEGAL_ENTITY>, <PROTOCOL_NUMBER>) are LEFT INTACT and reported — the engine
  // is never restricted to a fixed placeholder set (operator clarification #2).
  xml = xml.replace(/\{\{([A-Z_]+)\}\}|&lt;([A-Z_]+)&gt;/g, (m, k1, k2) => {
    const key = k1 || k2;
    if (Object.prototype.hasOwnProperty.call(values, key) && values[key] !== '' && values[key] != null) {
      return xmlEscape(String(values[key]));
    }
    missing.push(key);
    return m;
  });
  fs.writeFileSync(xmlPath, xml);
  // Update the entry back into the docx zip (entry path relative to cwd=tmp).
  cp.execFileSync('zip', [out, 'word/document.xml'], { cwd: tmp, stdio: 'ignore' });
  return { buffer: fs.readFileSync(out), out_path: out, missing_placeholders: [...new Set(missing)] };
}

// §7 file naming — exactly «макет_<APPLICANT_L_E_NAME>.docx» / «приложение_<APPLICANT_L_E_NAME>.docx».
// Only filesystem-illegal characters are stripped; the applicant name is otherwise preserved
// (e.g. «макет_ОсОО Мегуми.docx», «макет_ИП Айбашева Карина Айбашевна.docx»).
function safeApplicant(name) { return String(name || 'без_имени').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function mockupFileName(name)     { return `макет_${safeApplicant(name)}.docx`; }
function attachmentFileName(name) { return `приложение_${safeApplicant(name)}.docx`; }

// renderAttachmentDocx(attachment, outPath, title?) — build a minimal valid .docx containing the
// application table (§7). Assembles OOXML from scratch via system zip (no npm dep).
function renderAttachmentDocx(attachment, outPath, title = 'Приложение к заявке') {
  const HEAD = { product_name: 'Наименование товара', composition: 'Состав', tnved: 'ТН ВЭД' };
  const cell = (txt) => `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr><w:p><w:r><w:t xml:space="preserve">${xmlEscape(txt)}</w:t></w:r></w:p></w:tc>`;
  const row  = (cells) => `<w:tr>${cells.join('')}</w:tr>`;
  const header = row(attachment.columns.map(c => cell(HEAD[c] || c)));
  const body   = attachment.rows.map(r => row(attachment.columns.map(c => cell(r[c] || '')))).join('');
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${xmlEscape(title)}</w:t></w:r></w:p>` +
    `<w:tbl><w:tblPr><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(s => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`).join('')}</w:tblBorders></w:tblPr>` +
    header + body + '</w:tbl></w:body></w:document>';
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-'));
  fs.mkdirSync(path.join(tmp, '_rels')); fs.mkdirSync(path.join(tmp, 'word'));
  fs.writeFileSync(path.join(tmp, '[Content_Types].xml'), contentTypes);
  fs.writeFileSync(path.join(tmp, '_rels', '.rels'), rels);
  fs.writeFileSync(path.join(tmp, 'word', 'document.xml'), documentXml);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  cp.execFileSync('zip', ['-r', outPath, '[Content_Types].xml', '_rels', 'word'], { cwd: tmp, stdio: 'ignore' });
  return outPath;
}

// proposeMockup(application, opts) → OUTPUT-ONLY draft proposal. Never sends.
// opts.templateDir (or env MOCKUP_TEMPLATE_DIR): dir holding declaration.docx / certificate.docx.
// opts.outDir (or env MOCKUP_OUTPUT_DIR): where макет_/приложение_ files are written.
function proposeMockup(application = {}, opts = {}) {
  const doc_type   = normDocType(application.doc_type);
  const fields     = resolveFields(application);
  const warnings   = compositionWarnings(application);
  const attachment = buildAttachment(application);
  const applicant  = fields.APPLICANT_L_E_NAME;

  const result = {
    doc_type,
    fields,
    warnings,
    attachment,
    mockup_file_name: mockupFileName(applicant),
    attachment_file_name: attachment ? attachmentFileName(applicant) : null,
    status: 'draft',
    auto_send: false,
    requires: { operator_approval: true, client_approval: true },
    rendered: false,
  };

  const templateDir = opts.templateDir || process.env.MOCKUP_TEMPLATE_DIR;
  const outDir = opts.outDir || process.env.MOCKUP_OUTPUT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-out-'));
  if (!doc_type) { result.render_blocked = 'unknown_doc_type'; return result; }
  if (!templateDir) { result.render_blocked = 'no_template_dir'; return result; }
  const tpl = path.join(templateDir, doc_type === 'СС' ? 'certificate.docx' : 'declaration.docx');
  if (!fs.existsSync(tpl)) { result.render_blocked = 'template_not_found'; result.template_expected = tpl; return result; }

  const filled = fillTemplate(tpl, fields, path.join(outDir, result.mockup_file_name));
  result.rendered = true;
  result.document_path = filled.out_path;
  result.missing_placeholders = filled.missing_placeholders;

  if (attachment) {
    result.attachment_path = renderAttachmentDocx(attachment, path.join(outDir, result.attachment_file_name));
  }
  return result;
}

// §9 — assemble the lab submission package (auto-generate, NEVER auto-send; operator approves).
// standardEmailText is sourced separately (draftEmailService / KB lab rule); referenced here.
function buildLabPackage(proposal = {}, { clientCertPath = null, standardEmailText = null } = {}) {
  return {
    contents: {
      draft_document: proposal.document_path || null,                 // макет_<applicant>.docx
      attachment: proposal.attachment_path || null,                   // приложение_<applicant>.docx (if any)
      client_registration_certificate: clientCertPath,                // client IP/OsOO/LLC certificate
      laboratory_email_draft: standardEmailText,                      // from draftEmailService / KB
    },
    auto_send: false,
    operator_approval_required: true,
  };
}

module.exports = {
  PLACEHOLDER_MAP,
  normDocType,
  tnvedField,
  resolveFields,
  compositionWarnings,
  buildAttachment,
  fillTemplate,
  mockupFileName,
  attachmentFileName,
  renderAttachmentDocx,
  proposeMockup,
  buildLabPackage,
};
