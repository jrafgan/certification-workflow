'use strict';

// services/draftPackageService.js — Draft Package Generator.
//
// Reads the inputs (New Form / New Applications submissions, existing Declarations,
// and WhatsApp signals WHEN ENABLED) and, where there is sufficient evidence,
// produces a Draft Package: a proposed action for operator review carrying the
// six-field contract (proposed_action, reason, evidence, confidence, impact,
// proposed_data). See models/DraftPackage.js.
//
// HARD RULE — OUTPUT ONLY. This module never executes a proposal:
//   • no Google Sheet writes,
//   • no Declaration create/update,
//   • no Gmail sends,
//   • no WhatsApp sends.
// It only reads sources and writes its OWN proposal store (draft_packages), then
// waits for operator approval. Approval (decide) records intent; it does NOT
// perform the write either — execution is a separate, gated step (future sprint).
//
// The only action generated today is CREATE_DECLARATION_ROW — promoting a matured
// application to a Declaration row at status «Запустить» (the promotion gate in
// docs/APPLICATION_TO_ORDER_WORKFLOW.md). Promotion stays an operator action; this
// generator only prepares and recommends it.
//
// The evaluation/build/score functions are PURE (no I/O) and exported for testing.

const { normalizeLocal, matchKey, phonesMatch } = require('../utils/phoneUtils');
const { ORDER_STATUSES } = require('../config/constants');
const errorUtils = require('../utils/errorUtils');

// New Declaration rows are created at the first business status.
const PROMOTION_STATUS = ORDER_STATUSES[0]; // 'Запустить'

// Confidence weights (0..100). A "sufficient" proposal (entity + valid phone) starts
// at `base`; each additional completeness signal raises it; a possible duplicate
// against an existing Declaration lowers it (warn, never block — entities legitimately
// recur across separate orders, per the order-identity model).
const CONF = {
  base:           60, // application found (entity) + normalizable client phone
  payment:        20, // payment evidence (e.g. WhatsApp receipt) — when enabled
  certificate:    15, // IP/LLC registration certificate detected — when enabled
  document_type:   5, // DS vs SS known
  duplicate_penalty: 25,
};

// ─── Pure: text normalization for entity comparison ──────────────────────────────
const ORG = new Set(['ип', 'осоо', 'оао', 'тоо', 'ооо', 'зао', 'llc', 'чп']);
function normEntity(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^0-9a-zа-яё]+/gi, ' ')
    .split(' ')
    .filter(t => t && !ORG.has(t))
    .join(' ')
    .trim();
}

// ─── Pure: confidence band ────────────────────────────────────────────────────
function confidenceBand(score) {
  return score >= 80 ? 'HIGH' : score >= 60 ? 'MEDIUM' : 'LOW';
}

// ─── Pure: possible-duplicate detection ─────────────────────────────────────────
// Warn (don't block) when an existing Declaration shares this application's phone
// AND normalized entity name. A repeat order for the same entity is legitimate, so
// this is an operator-confirm signal, never an auto-reject. Returns an evidence-style
// descriptor or null. `declarations` is a small pre-loaded list of {client_name, phone}.
function findPossibleDuplicate(declarations = [], application = {}) {
  const appEntity = normEntity(application.legal_entity);
  if (!appEntity) return null;
  for (const d of declarations) {
    if (!phonesMatch(application.phone, d.phone)) continue;
    if (normEntity(d.client_name) !== appEntity) continue;
    return {
      ref:    d.sheet_row_id ? `declaration_row:${d.sheet_row_id}` : `declaration:${d._id}`,
      detail: `An existing Declaration matches «${(application.legal_entity || '').trim()}» on the same phone — confirm this is a separate order, not a duplicate.`,
    };
  }
  return null;
}

// ─── Pure: evaluate one application against the promotion requirements ────────────
// Returns { sufficient, evidence, missing, confidence, band }. `signals` carries
// optional cross-source evidence (payment / certificate / document_type) and an
// optional possible_duplicate descriptor — all absent by default (only the New Form
// reader is wired today; WhatsApp/doc-classification inject the rest when enabled).
function evaluateApplication(application = {}, signals = {}) {
  const evidence = [];
  const missing  = [];

  const entity   = String(application.legal_entity || '').trim();
  const phoneKey = matchKey(application.phone);
  const rowRef   = `application_row:${application.row}`;

  if (entity) {
    evidence.push({ kind: 'application', ref: rowRef, detail: `Application found for «${entity}».` });
  } else {
    missing.push({ field: 'legal_entity', reason: 'No legal entity name to anchor the Declaration row.' });
  }

  if (phoneKey) {
    evidence.push({ kind: 'application', ref: rowRef, detail: `Client phone present (${String(application.phone).trim()}).` });
  } else {
    missing.push({ field: 'phone', reason: 'No normalizable client phone (WhatsApp channel) — needed for follow-up/delivery.' });
  }

  // Sufficiency gate: an entity anchor + a usable client phone are the minimum to
  // propose creating the row. Everything else only adjusts confidence.
  const sufficient = !!entity && !!phoneKey;
  if (!sufficient) {
    return { sufficient: false, evidence, missing, confidence: 0, band: confidenceBand(0) };
  }

  let confidence = CONF.base;

  if (signals.payment) {
    confidence += CONF.payment;
    evidence.push({ kind: 'payment', ref: signals.payment.ref || 'whatsapp', detail: signals.payment.detail || 'Payment detected.' });
  } else {
    missing.push({ field: 'payment', reason: 'No payment evidence yet (Запустить presumes payment received).' });
  }

  if (signals.certificate) {
    confidence += CONF.certificate;
    evidence.push({ kind: 'certificate', ref: signals.certificate.ref || 'attachment', detail: signals.certificate.detail || 'IP/LLC registration certificate received.' });
  } else {
    missing.push({ field: 'certificate', reason: 'IP/LLC registration certificate not detected.' });
  }

  if (signals.document_type) {
    confidence += CONF.document_type;
    evidence.push({ kind: 'document_type', ref: rowRef, detail: `Document type: ${signals.document_type}.` });
  } else {
    missing.push({ field: 'document_type', reason: 'DS/SS document type unknown.' });
  }

  if (signals.possible_duplicate) {
    confidence = Math.max(0, confidence - CONF.duplicate_penalty);
    evidence.push({
      kind:   'duplicate_warning',
      ref:    signals.possible_duplicate.ref || '',
      detail: signals.possible_duplicate.detail || 'A similar Declaration already exists — confirm this is a separate order.',
    });
  }

  confidence = Math.min(100, confidence);
  return { sufficient: true, evidence, missing, confidence, band: confidenceBand(confidence) };
}

// ─── Pure: compose the human-readable reason from the evidence ────────────────────
function composeReason(evidence = []) {
  const parts = evidence
    .filter(e => e.kind !== 'duplicate_warning')
    .map(e => e.detail);
  return parts.join(' ');
}

// ─── Pure: build a CREATE_DECLARATION_ROW Draft Package ───────────────────────────
// Returns { generated:false, reason, missing } when evidence is insufficient, or the
// full six-field package object when it is. NEVER writes anything.
function buildCreateDeclarationDraft(application = {}, signals = {}) {
  const ev = evaluateApplication(application, signals);
  if (!ev.sufficient) {
    return { generated: false, reason: 'insufficient_evidence', missing: ev.missing };
  }

  // proposed_data = the exact Declaration row that WOULD be written on promotion.
  const proposed_data = {
    status:         PROMOTION_STATUS,
    client_name:    String(application.legal_entity).trim(),
    phone:          normalizeLocal(application.phone),
    document_type:  signals.document_type || (signals.pi && signals.pi.doc_type) || null,
    payment_date:   signals.payment?.date   || null,
    payment_amount: signals.payment?.amount ?? null,
    source:         'google_sheets',
    notes:          null,
  };

  // PI engine output (piCalculationService) enriches the proposal with the protocol
  // count and estimated cost (estimate only — operator confirms price per KB rule #18).
  if (signals.pi) {
    proposed_data.pi_count       = signals.pi.pi_count;
    proposed_data.additional_pi  = signals.pi.additional_pi;
    proposed_data.estimated_cost = signals.pi.total_estimate;
    proposed_data.laboratory     = signals.pi.laboratory;
    ev.evidence.push({ kind: 'pi', ref: 'pi_engine', detail: `ПИ: ${signals.pi.pi_count} (доп. ${signals.pi.additional_pi}); оценка стоимости ${signals.pi.total_estimate} ${signals.pi.currency} (требует подтверждения оператора).` });
  }

  return {
    generated:       true,
    proposed_action: 'CREATE_DECLARATION_ROW',
    reason:          composeReason(ev.evidence),
    evidence:        ev.evidence,
    confidence:      ev.confidence,
    confidence_band: ev.band,
    impact:          `Would create a new Declaration row at status «${PROMOTION_STATUS}». No sheet write, no Declaration update, no message is performed — output only, pending operator approval.`,
    proposed_data,
    missing:         ev.missing,
  };
}

// ─── Pure: idempotency key for an application's promotion proposal ────────────────
// Keys on the application IDENTITY (phone + entity + submission time + row), NOT the
// entity alone — one entity legitimately recurs across many separate orders.
function dedupeKey(application = {}) {
  const ts = application.submitted_at
    ? new Date(application.submitted_at).toISOString()
    : 'na';
  return [
    'CREATE_DECLARATION_ROW',
    matchKey(application.phone) || 'no_phone',
    normEntity(application.legal_entity) || 'no_entity',
    ts,
    `row:${application.row ?? 'na'}`,
  ].join('|');
}

// ─── DB-backed: generate Draft Packages from the current inputs ───────────────────
// Reads applications (read-only) + existing Declarations (read-only, for the
// duplicate warning), builds proposals where evidence is sufficient, and persists
// them as PENDING. Idempotent via dedupe_key. Returns a summary; performs no
// external (sheet/Gmail/WhatsApp) writes.
//
// deps (all optional, for testing/wiring):
//   applicationsReader — { readApplications() } (default: newApplicationsClient)
//   DraftPackage       — model (default: models/DraftPackage)
//   Declaration        — model (default: models/Declaration)
//   signalsFor(app)    — async → { payment?, certificate?, document_type? }
//                        (default: () => ({}); WhatsApp/doc-classification plug in here)
async function generate(deps = {}) {
  const reader      = deps.applicationsReader || require('../integrations/newApplicationsClient');
  const DraftPackage = deps.DraftPackage     || require('../models/DraftPackage').DraftPackage;
  const Declaration  = deps.Declaration      || require('../models/Declaration').Declaration;
  const signalsFor   = deps.signalsFor       || (async () => ({}));

  const { applications = [], reason } = await reader.readApplications();
  const summary = { generated: 0, skipped: 0, packages: [], reasons: {} };
  const bump = (key) => { summary.reasons[key] = (summary.reasons[key] || 0) + 1; };

  if (!applications.length) {
    summary.reason = reason || 'no_applications';
    return summary;
  }

  // Pre-load existing declarations once for the duplicate-warning check (read-only).
  const declarations = await Declaration.find({})
    .select('client_name phone sheet_row_id')
    .limit(2000)
    .lean();

  for (const app of applications) {
    let signals = await signalsFor(app);
    if (!('possible_duplicate' in signals)) {
      const dup = findPossibleDuplicate(declarations, app);
      if (dup) signals = { ...signals, possible_duplicate: dup };
    }

    const draft = buildCreateDeclarationDraft(app, signals);
    if (!draft.generated) { summary.skipped++; bump(draft.reason); continue; }

    const dedupe_key = dedupeKey(app);
    // Idempotency: skip if a proposal for this application identity already exists
    // (in any state). The unique index is the backstop; this avoids the create race.
    if (await DraftPackage.exists({ dedupe_key })) {
      summary.skipped++; bump('duplicate_package'); continue;
    }

    const doc = {
      proposed_action: draft.proposed_action,
      reason:          draft.reason,
      evidence:        draft.evidence,
      confidence:      draft.confidence,
      confidence_band: draft.confidence_band,
      impact:          draft.impact,
      proposed_data:   draft.proposed_data,
      missing:         draft.missing,
      source: {
        application_row: app.row,
        legal_entity:    app.legal_entity,
        phone:           app.phone,
        submitted_at:    app.submitted_at || undefined,
      },
      dedupe_key,
      status:     'pending',
    };

    try {
      const created = await DraftPackage.create(doc);
      summary.generated++;
      summary.packages.push(created);
    } catch (err) {
      if (err && (err.code === 11000 || err.code === 'E11000')) {
        summary.skipped++; bump('duplicate_package');
      } else {
        throw err;
      }
    }
  }

  return summary;
}

// ─── Read: pending proposals for operator review ─────────────────────────────────
async function listPending(limit = 50, deps = {}) {
  const DraftPackage = deps.DraftPackage || require('../models/DraftPackage').DraftPackage;
  const docs = await DraftPackage
    .find({ status: 'pending' })
    .sort({ confidence: -1, created_at: -1 })
    .limit(limit)
    .lean();

  return docs.map(d => ({
    id:              d._id,
    proposed_action: d.proposed_action,
    reason:          d.reason,
    evidence:        d.evidence || [],
    confidence:      d.confidence,
    confidence_band: d.confidence_band,
    impact:          d.impact,
    proposed_data:   d.proposed_data,
    missing:         d.missing || [],
    source:          d.source,
    created_at:      d.created_at,
  }));
}

// ─── Operator decision ───────────────────────────────────────────────────────────
// Records the operator's decision on a pending proposal. IMPORTANT: neither outcome
// executes the action — 'approve' only records intent (the row is NOT created and the
// sheet is NOT written; that gated step lives in a future sprint), 'reject' dismisses
// it. No external system is touched here.
async function decide(packageId, decision, { decidedBy = 'operator' } = {}, deps = {}) {
  const DraftPackage = deps.DraftPackage || require('../models/DraftPackage').DraftPackage;

  const pkg = await DraftPackage.findById(packageId);
  if (!pkg) throw errorUtils.notFoundError('Draft package not found');
  if (pkg.status !== 'pending') {
    throw errorUtils.conflictError(`Draft package already ${pkg.status}`);
  }

  let nextStatus;
  if (decision === 'approve')      nextStatus = 'approved';
  else if (decision === 'reject')  nextStatus = 'rejected';
  else throw errorUtils.validationError(`Unknown decision "${decision}" (use approve|reject)`);

  pkg.status     = nextStatus;
  pkg.decision   = decision;
  pkg.decided_by = decidedBy;
  pkg.decided_at = new Date();
  await pkg.save();

  return pkg;
}

// ─── Pure: before/after preview for a CREATE_DECLARATION_ROW execution ────────────
// Describes the change the operator is about to authorize. `before` is the current
// state (no row exists yet for a create); `after` is the row that WOULD be written.
// Pure — no I/O. Exported for the read-only preview endpoint and reused in the result.
function buildExecutionPreview(pkg) {
  const data = (pkg && pkg.proposed_data) || {};
  return {
    action: pkg && pkg.proposed_action,
    before: { declaration: null, sheet_row_id: null },
    after:  { declaration: { ...data }, sheet_row_id: '(assigned on append)' },
  };
}

// ─── Read-only: preview an approved package's execution (no writes) ───────────────
async function previewExecution(packageId, deps = {}) {
  const DraftPackage = deps.DraftPackage || require('../models/DraftPackage').DraftPackage;
  const pkg = await DraftPackage.findById(packageId).lean();
  if (!pkg) throw errorUtils.notFoundError('Draft package not found');
  if (pkg.proposed_action !== 'CREATE_DECLARATION_ROW') {
    throw errorUtils.validationError(`Only CREATE_DECLARATION_ROW can be previewed (got "${pkg.proposed_action}")`);
  }
  return { draft_id: pkg._id, status: pkg.status, preview: buildExecutionPreview(pkg) };
}

// ─── Execute an APPROVED CREATE_DECLARATION_ROW package ───────────────────────────
// The single, gated execution path. It:
//   • runs ONLY on a package already moved to 'approved' by the Approval flow,
//   • handles ONLY CREATE_DECLARATION_ROW,
//   • appends a NEW row to the Declaration sheet (never updates an existing row),
//   • creates the linked Declaration replica only after the sheet append verifies,
//   • records an immutable execution log (operator, timestamp, draft id, row created),
//   • returns the execution result with a before/after preview.
//
// Safety: no approval ⇒ no execution; the sheet append is the only write and it is
// append-only; on append failure nothing is created and the package stays 'approved'
// (retryable). deps inject the model / sheetsSync / Declaration for testing.
async function executeApprovedPackage(packageId, { executedBy = 'operator' } = {}, deps = {}) {
  const DraftPackage = deps.DraftPackage || require('../models/DraftPackage').DraftPackage;
  const Declaration  = deps.Declaration  || require('../models/Declaration').Declaration;
  const sheetsSync   = deps.sheetsSync   || require('../integrations/sheetsSync');

  const pkg = await DraftPackage.findById(packageId);
  if (!pkg) throw errorUtils.notFoundError('Draft package not found');

  // Safety gate 1 — only the in-scope action.
  if (pkg.proposed_action !== 'CREATE_DECLARATION_ROW') {
    throw errorUtils.validationError(`Only CREATE_DECLARATION_ROW is executable (got "${pkg.proposed_action}")`);
  }
  // Safety gate 2 — no execution without explicit approval from the Approval flow.
  if (pkg.status !== 'approved') {
    throw errorUtils.conflictError(
      pkg.status === 'executed'
        ? 'Draft package already executed'
        : `Draft package must be "approved" before execution (is "${pkg.status}")`
    );
  }

  const before  = { declaration: null, sheet_row_id: null };
  const rowData = pkg.proposed_data || {};

  // The ONLY write: append a new row to the sheet (append-only; never updates).
  const append = await sheetsSync.appendDeclarationRow(rowData);
  if (append.skipped) {
    throw errorUtils.validationError(`Sheet append skipped: ${append.reason}`);
  }
  if (!append.written || append.verified === false) {
    // Nothing created; package stays 'approved' and can be retried.
    return {
      ok:        false,
      draft_id:  pkg._id,
      error:     append.error || 'sheet append did not verify',
      append,
    };
  }

  const sheetRowId = String(append.rowId);

  // Mongo replica of the new sheet row (sheet is source of truth; this mirrors it).
  const declaration = await Declaration.create({
    source:         'google_sheets',
    sheet_row_id:   sheetRowId,
    status:         rowData.status,                 // canonical capitalized form
    client_name:    rowData.client_name || undefined,
    phone:          rowData.phone || undefined,
    document_type:  rowData.document_type || undefined,
    payment_date:   rowData.payment_date || undefined,
    payment_amount: rowData.payment_amount ?? undefined,
    notes:          rowData.notes || undefined,
    sync_status:    'synced',
    last_synced_at: new Date(),
  });

  const executedAt = new Date();
  pkg.status    = 'executed';
  pkg.execution = {
    executed_by:    executedBy,
    executed_at:    executedAt,
    declaration_id: declaration._id,
    sheet_row_id:   sheetRowId,
  };
  await pkg.save();

  const after = {
    declaration: {
      _id:         declaration._id,
      status:      declaration.status,
      client_name: declaration.client_name,
      phone:       declaration.phone,
    },
    sheet_row_id: sheetRowId,
  };

  // Audit log (requirement #5): operator, timestamp, draft id, row created.
  console.log(`[draft-execution] operator=${executedBy} at=${executedAt.toISOString()} draft=${pkg._id} sheet_row=${sheetRowId} declaration=${declaration._id}`);

  return {
    ok:             true,
    draft_id:       pkg._id,
    declaration_id: declaration._id,
    sheet_row_id:   sheetRowId,
    operator:       executedBy,
    executed_at:    executedAt,
    append_range:   append.range,
    preview:        { before, after },
  };
}

module.exports = {
  // pure
  normEntity,
  confidenceBand,
  findPossibleDuplicate,
  evaluateApplication,
  composeReason,
  buildCreateDeclarationDraft,
  dedupeKey,
  buildExecutionPreview,
  // db-backed
  generate,
  listPending,
  decide,
  previewExecution,
  executeApprovedPackage,
  // constants
  PROMOTION_STATUS,
  CONF,
};
