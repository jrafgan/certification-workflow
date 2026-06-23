'use strict';

// services/mockupTemplateRegistry.js — Mockup template registry + gated generation (Phase 4).
//
// Connects the classification result (doc_type) → the OFFICIAL template file → a rendered
// draft DOCX. The official operator templates are «Макет_ДС.docx» / «Макет_СС.docx» (the
// existing engine looked for declaration.docx/certificate.docx — this routes by the real
// names). Rendering reuses mockupAgentService (fill/attachment/file-naming) unchanged.
//
// OUTPUT-ONLY and fully gated: it writes draft files to an output dir and returns a proposal
// with auto_send:false. It NEVER sends to the client or the lab and never writes to
// Declaration / Google Sheets / Email / WhatsApp.

const fs = require('fs');
const os = require('os');
const path = require('path');
const mockup = require('./mockupAgentService');

// doc_type → official template filename. The single source of truth for template selection.
const TEMPLATE_REGISTRY = { 'ДС': 'Макет_ДС.docx', 'СС': 'Макет_СС.docx' };

// Where the official templates live. Override with MOCKUP_TEMPLATE_DIR; defaults to backend/templates.
function templateDir(opts = {}) {
  return opts.templateDir || process.env.MOCKUP_TEMPLATE_DIR || path.resolve(__dirname, '../../templates');
}

// resolveTemplate(docType) → { ok, doc_type, file, path } | { ok:false, reason }
function resolveTemplate(docType, opts = {}) {
  const file = TEMPLATE_REGISTRY[docType];
  if (!file) return { ok: false, reason: 'unknown_doc_type', doc_type: docType || null };
  const full = path.join(templateDir(opts), file);
  if (!fs.existsSync(full)) return { ok: false, reason: 'template_not_found', doc_type: docType, file, path: full };
  return { ok: true, doc_type: docType, file, path: full };
}

// listTemplates() — registry status (which official templates are present). Read-only.
function listTemplates(opts = {}) {
  return Object.keys(TEMPLATE_REGISTRY).map(dt => resolveTemplate(dt, opts));
}

// generate(application, { docType, outDir }) → OUTPUT-ONLY draft proposal. Never sends.
//   docType — 'ДС' | 'СС' (from the classification engine). When absent/unknown or the
//             template is missing, returns rendered:false + render_blocked reason.
//   application — the mapped application object (mockupAgentService field shape).
function generate(application = {}, { docType = null, outDir, templateDir: tdir } = {}) {
  const fields = mockup.resolveFields(application);
  const applicant = fields.APPLICANT_L_E_NAME;
  const attachment = mockup.buildAttachment(application);

  const result = {
    doc_type: docType,
    template_registry: { ...TEMPLATE_REGISTRY },
    fields,
    mockup_file_name: mockup.mockupFileName(applicant),
    attachment_file_name: attachment ? mockup.attachmentFileName(applicant) : null,
    status: 'draft',
    auto_send: false,
    requires: { operator_approval: true, client_approval: true },
    rendered: false,
  };

  const tpl = resolveTemplate(docType, { templateDir: tdir });
  if (!tpl.ok) { result.render_blocked = tpl.reason; if (tpl.path) result.template_expected = tpl.path; return result; }
  result.template_used = tpl.path;

  const out = outDir || process.env.MOCKUP_OUTPUT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-out-'));
  fs.mkdirSync(out, { recursive: true });

  const filled = mockup.fillTemplate(tpl.path, fields, path.join(out, result.mockup_file_name));
  result.rendered = true;
  result.document_path = filled.out_path;
  result.missing_placeholders = filled.missing_placeholders;

  if (attachment) {
    result.attachment_path = mockup.renderAttachmentDocx(attachment, path.join(out, result.attachment_file_name));
  }
  return result;
}

// generateFromClassification(application, classification, opts) — convenience: take the
// Phase-3 classification result and use its doc_type. When the classifier flagged
// needs_operator (doc_type null), generation is blocked pending the operator's DS/SS decision.
function generateFromClassification(application, classification = {}, opts = {}) {
  if (classification.needs_operator || !classification.doc_type) {
    return {
      rendered: false,
      render_blocked: 'classification_needs_operator',
      doc_type: classification.doc_type || null,
      auto_send: false,
      requires: { operator_approval: true, client_approval: true },
    };
  }
  return generate(application, { ...opts, docType: classification.doc_type });
}

module.exports = {
  TEMPLATE_REGISTRY,
  templateDir,
  resolveTemplate,
  listTemplates,
  generate,
  generateFromClassification,
};
