'use strict';

// services/whatsappDraftService.js — build Draft Packages and apply operator
// decisions. The agent NEVER sends; it produces a package and transitions state
// on operator decision only.
//
// `applyDecisionTransition` is a PURE function (no DB) describing the legal state
// transitions, exported for testing. `buildDraftPackage` assembles the
// reason/evidence/impact payload. `decideDraft` is the DB-backed wrapper.

const errorUtils = require('../utils/errorUtils');

// ─── Pure: legal decision transitions ────────────────────────────────────────
// Given the current state and a decision, return the next state — or throw on an
// illegal transition. Decisions: approve | reject | request_changes.
//
// Only a draft awaiting the operator (pending_approval | changes_requested) can
// be decided. Approval NEVER auto-sends — it moves to 'approved'; the actual
// send is operator-performed and recorded separately.
function applyDecisionTransition(currentState, decision) {
  const DECIDABLE = ['pending_approval', 'changes_requested'];
  if (!DECIDABLE.includes(currentState)) {
    throw errorUtils.conflictError(
      `Draft in state "${currentState}" cannot be decided (must be pending_approval or changes_requested)`
    );
  }
  switch (decision) {
    case 'approve':         return 'approved';          // does NOT send
    case 'reject':          return 'rejected';
    case 'request_changes': return 'changes_requested';
    default:
      throw errorUtils.validationError(`Unknown decision "${decision}" (use approve|reject|request_changes)`);
  }
}

// ─── Build a Draft Package from a confirmed match ─────────────────────────────
// `match` is the matched order context; `opts` carries draft_type, proposed_text,
// and the evidence items. Enforces the reason/evidence/impact contract and the
// match-confidence provenance.
function buildDraftPackage({ match, draft_type, proposed_text, reason, evidence = [], impact }) {
  if (!match || !match.order_id) {
    throw errorUtils.validationError('Draft must be bound to a matched order (order_id required)');
  }
  if (!draft_type)    throw errorUtils.validationError('draft_type is required');
  if (!proposed_text) throw errorUtils.validationError('proposed_text is required');
  if (!reason)        throw errorUtils.validationError('reason is required');
  if (!impact)        throw errorUtils.validationError('impact is required');

  return {
    order_id:       match.order_id,
    declaration_id: match.declaration_id || null,
    sheet_row_id:   match.sheet_row_id || null,
    client_name:    match.client_name || null,
    to_phone:       match.to_phone || null,
    draft_type,
    proposed_text,
    reason,
    evidence,
    impact,
    match_confidence: match.match_confidence || 'LOW',
    state: 'pending_approval',
    revision: 1,
  };
}

// ─── DB-backed: apply an operator decision to a stored draft ──────────────────
async function decideDraft(draftId, decision, { decidedBy = 'operator', changeNote } = {}, deps = {}) {
  const { WhatsAppDraft } = deps.WhatsAppDraft ? deps : require('../models/WhatsAppDraft');

  const draft = await WhatsAppDraft.findById(draftId);
  if (!draft) throw errorUtils.notFoundError('Draft not found');

  const nextState = applyDecisionTransition(draft.state, decision);

  draft.state      = nextState;
  draft.decision   = decision;
  draft.decided_by = decidedBy;
  draft.decided_at = new Date();

  if (decision === 'request_changes') {
    draft.change_request_note = changeNote || '';
    draft.revision = (draft.revision || 1) + 1;
  }
  // NOTE: 'approved' does not send. Transmission is operator-performed (V1).

  await draft.save();
  return draft;
}

module.exports = { applyDecisionTransition, buildDraftPackage, decideDraft };
