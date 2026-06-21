'use strict';

// services/whatsappLiveTestService.js — the READ-ONLY analysis pipeline run during
// live WhatsApp testing for the single allowed contact. It maps each of the nine
// testing goals to an existing read-only capability and returns a structured result.
//
// HARD GUARANTEE: this performs NO writes, NO messages, NO status changes, NO Gmail
// sends. Every step is a read or a pure computation:
//   1. receive text          → echo body                       (pure)
//   2–4. receive PDF/JPG/DOCX → list received attachments       (from client)
//   5. classify files         → fileClassifierService           (pure)
//   6. explain file contents  → fileClassifierService           (pure)
//   7. search Declaration      → whatsappMatchService.lookupOrdersByPhone (DB READ)
//   8. search New Form         → applicationMatchService.matchConversation (Sheet READ)
//   9. generate Draft Package  → draftPackageService.buildCreateDeclarationDraft
//                                (PURE build — DRY RUN, nothing persisted)
//
// Any step that needs an unavailable resource (no DB, no Sheets creds, capability not
// built) is caught and reported as a { blocker } rather than throwing — so a live run
// degrades gracefully and the report stays honest.

const { phoneFromJid } = require('./whatsappIngestService');

async function analyzeMessage(raw = {}, deps = {}) {
  const classifier             = deps.classifier             || require('./fileClassifierService');
  const matchService           = deps.matchService           || require('./whatsappMatchService');
  const applicationMatchService = deps.applicationMatchService || require('./applicationMatchService');
  const draftPackageService    = deps.draftPackageService    || require('./draftPackageService');

  const phone = phoneFromJid(raw.from);
  const contactName = raw.contact?.name || raw.contact?.pushname || raw.contact?.number || phone;
  const result = { id: raw.id || null, contact: contactName, phone, goals: {} };

  // ── Goal 1: receive text ──
  result.goals.text = { ok: true, body: raw.body || '', length: (raw.body || '').length };

  // ── Goals 2–6: receive + classify + explain attachments ──
  const atts = Array.isArray(raw.attachments) ? raw.attachments : [];
  result.goals.attachments = atts.map(a => {
    const ex = classifier.explainAttachment(a);
    return {
      file_name:   a.file_name,
      mime_type:   a.mime_type,
      kind:        ex.kind,
      supported:   ex.supported,   // goals #2–#4 file-type coverage
      category:    ex.category,    // goal #5
      confidence:  ex.confidence,
      explanation: ex.explanation, // goal #6
    };
  });

  // ── Goal 7: search Declaration (read-only) ──
  try {
    result.goals.declaration_search = await matchService.lookupOrdersByPhone(phone, deps);
  } catch (e) {
    result.goals.declaration_search = { blocker: e.message };
  }

  // ── Goal 8: search New Form (read-only) ──
  try {
    const conversation = {
      phone,
      text:      raw.body || '',
      timestamp: raw.timestamp ? new Date(raw.timestamp * 1000) : new Date(),
    };
    result.goals.new_form_search = await applicationMatchService.matchConversation(conversation, deps);
  } catch (e) {
    result.goals.new_form_search = { blocker: e.message };
  }

  // ── Goal 9: generate Draft Package (DRY — pure build, nothing persisted) ──
  try {
    const nf  = result.goals.new_form_search || {};
    const top = Array.isArray(nf.candidates) ? nf.candidates[0] : null;
    if (nf.blocker) {
      result.goals.draft_package = { generated: false, reason: 'new_form_unavailable' };
    } else if (top && nf.status === 'matched') {
      const application = { row: top.row, legal_entity: top.legal_entity, phone, submitted_at: top.submitted_at };
      const draft = draftPackageService.buildCreateDeclarationDraft(application, {});
      result.goals.draft_package = draft.generated
        ? { generated: true, dry_run: true, proposed_action: draft.proposed_action, confidence: draft.confidence, reason: draft.reason }
        : { generated: false, dry_run: true, reason: draft.reason, missing: draft.missing };
    } else {
      result.goals.draft_package = { generated: false, reason: 'no_matched_application' };
    }
  } catch (e) {
    result.goals.draft_package = { blocker: e.message };
  }

  return result;
}

module.exports = { analyzeMessage };
