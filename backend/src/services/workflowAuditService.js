'use strict';

// services/workflowAuditService.js — Workflow Auditor.
//
// Determines whether an order's CURRENT status matches the status its EVIDENCE implies,
// and treats status as an operational indicator (visibility, speed, bottleneck/forgotten-
// order detection). For each order it produces an AUDIT PACKAGE:
//   current_status · proposed_status · confidence · evidence · reasoning · findings.
//
// Evidence sources: Declaration (current status), payment receipts, WhatsApp, Gmail /
// laboratory correspondence, generated documents. In this build the evidence trail is read
// from the Order document (payments / lab_interactions / layouts / originals / events),
// which mirrors those sources; `collectEvidence` is injectable so WhatsApp/Gmail/receipt
// corroboration can raise confidence without changing the pure reasoning.
//
// HARD RULE — OUTPUT ONLY. NEVER changes status. Reads evidence, writes only the
// audit_packages store. 'approve' records the operator's authorization; applying the
// status change stays a separate, operator-performed step (no automatic status updates).
// Statuses are the 7 canonical Russian values, used verbatim (never translated/renamed).
//
// The reasoning functions are PURE (no I/O) and exported for testing.

const { ORDER_STATUSES } = require('../config/constants');
const errorUtils = require('../utils/errorUtils');

const MS_PER_DAY = 86_400_000;

// Active progression ladder (terminal Завершен/Отменен handled specially).
const LADDER = ['Запустить', 'Ждем макет', 'На согласовании', 'Ждем оригинал', 'Оригинал получен', 'Завершен'];
const CANCELLED = 'Отменен';
const TERMINAL  = ['Завершен', CANCELLED];

// Evidence milestone → the status the order should be AT once it is reached (ascending).
const MILESTONE_STATUS = [
  ['payment',         'Запустить'],
  ['lab_request',     'Ждем макет'],
  ['layout',          'На согласовании'],
  ['layout_approved', 'Ждем оригинал'],
  ['original',        'Оригинал получен'],
  ['delivered',       'Завершен'],
];

// Thresholds (days) for the operational findings.
const STALE_DAYS     = parseInt(process.env.AUDIT_STALE_DAYS, 10)     || 7;
const FORGOTTEN_DAYS = parseInt(process.env.AUDIT_FORGOTTEN_DAYS, 10) || 21;
// Confidence at/above which a proposed change is actively RECOMMENDED (not just observed).
const RECOMMEND_THRESHOLD = parseInt(process.env.AUDIT_RECOMMEND_THRESHOLD, 10) || 70;

const IMPACT =
  'If approved, the operator authorizes the proposed status change — the auditor does NOT ' +
  'apply it. No status is ever changed automatically. Statuses are operational indicators; ' +
  'apply only after confirming the evidence.';

// ─── Pure helpers ─────────────────────────────────────────────────────────────
function band(score) { return score >= 80 ? 'HIGH' : score >= 50 ? 'MEDIUM' : 'LOW'; }
function daysSince(date, now = Date.now()) { return date == null ? null : Math.floor((now - new Date(date).getTime()) / MS_PER_DAY); }

// Normalize a (possibly free-text) status to a ladder index. -1 = unrecognized; the
// special CANCELLED returns LADDER.length (past the active ladder, but not "ahead").
function statusIndex(status) {
  const s = String(status || '').trim();
  if (s === CANCELLED) return -2;        // terminal-cancelled sentinel
  const i = LADDER.indexOf(s);
  return i;                              // 0..5, or -1 if unrecognized
}

function isActive(status) {
  const s = String(status || '').trim();
  return ORDER_STATUSES.includes(s) && !TERMINAL.includes(s);
}

// ─── Pure: the highest milestone the evidence reached → implied status ─────────
// `evidence.milestones` is { name: { reached, at, confidence, items:[{source,detail,at}] } }.
function impliedStatusFromEvidence(evidence = {}) {
  const ms = evidence.milestones || {};
  let best = null;
  for (let i = 0; i < MILESTONE_STATUS.length; i++) {
    const [name, status] = MILESTONE_STATUS[i];
    const m = ms[name];
    if (m && m.reached) best = { milestone: name, status, ladderIndex: i, confidence: m.confidence ?? 60, items: m.items || [] };
  }
  return best;
}

// Flatten all reached-milestone evidence items into the AUDIT PACKAGE evidence list.
function collectEvidenceItems(evidence = {}) {
  const ms = evidence.milestones || {};
  const out = [];
  for (const [name] of MILESTONE_STATUS.concat([['cancelled']])) {
    const m = ms[name];
    if (m && m.reached && Array.isArray(m.items)) out.push(...m.items);
  }
  return out;
}

// ─── Pure: operational findings (status as an indicator) ──────────────────────
function computeFindings(current_status, evidence, now, { implied, curIdx } = {}) {
  const findings = [];
  const lastActivity = evidence.last_activity_at;
  const idle = daysSince(lastActivity, now);

  if (statusIndex(current_status) === -1) {
    findings.push({ type: 'unrecognized_status', detail: `Status «${current_status}» is not one of the 7 canonical values.`, severity: 'HIGH' });
  }

  if (isActive(current_status) && idle != null) {
    if (idle >= FORGOTTEN_DAYS) {
      findings.push({ type: 'forgotten_order', detail: `No activity for ${idle} days while status «${current_status}» is active — likely forgotten.`, severity: 'HIGH' });
    } else if (idle >= STALE_DAYS) {
      findings.push({ type: 'stale_status', detail: `No activity for ${idle} days in status «${current_status}».`, severity: 'MEDIUM' });
    }
  }

  const due = evidence.deadlines && evidence.deadlines.current_due;
  if (isActive(current_status) && due && now > new Date(due).getTime()) {
    findings.push({ type: 'delayed_order', detail: `The deadline for «${current_status}» passed on ${new Date(due).toISOString().slice(0, 10)}.`, severity: 'HIGH' });
  }

  // Completion integrity: «Завершен» must have zero debt AND a recorded delivery. Debt is not on
  // the milestone ladder, so it is checked here directly (Status Verification Engine, Example #1).
  if (current_status === 'Завершен') {
    const debt = Number(evidence.balance_due || 0);
    const delivered = !!(evidence.milestones && evidence.milestones.delivered && evidence.milestones.delivered.reached);
    if (debt > 0) {
      findings.push({ type: 'completed_with_debt', detail: `Status «Завершен» but a balance of ${debt} is still due — the original is not released until paid in full.`, severity: 'HIGH' });
    } else if (!delivered) {
      findings.push({ type: 'completed_not_delivered', detail: 'Status «Завершен» but no delivery of the original to the client is recorded.', severity: 'HIGH' });
    }
  }

  // Missing transition / contradictory are derived from the ladder comparison.
  if (implied && curIdx != null && curIdx >= 0) {
    if (implied.ladderIndex > curIdx) {
      findings.push({ type: 'missing_transition', detail: `Evidence supports «${implied.status}» but status is still «${current_status}».`, severity: 'HIGH' });
    } else if (implied.ladderIndex < curIdx) {
      findings.push({ type: 'contradictory_state', detail: `Status «${current_status}» claims more progress than the evidence shows (evidence reaches «${implied.status}»).`, severity: 'MEDIUM' });
    }
  }

  return findings;
}

// ─── Pure: audit one order against its evidence → AUDIT PACKAGE (or null) ──────
// input = { current_status, evidence }. Returns null when fully in sync with no findings
// (nothing for the operator to see). Otherwise returns the package object. NEVER writes.
function auditOrder(input = {}, now = Date.now()) {
  const current_status = String(input.current_status || '').trim();
  const evidence = input.evidence || {};
  const ms = evidence.milestones || {};

  const curIdx  = statusIndex(current_status);
  const implied = impliedStatusFromEvidence(evidence);
  const cancelledEv = ms.cancelled;

  let proposed_status = null;
  let confidence = 50;
  let audit_kind = 'in_sync';
  let reasoning;

  if (cancelledEv && cancelledEv.reached && current_status !== CANCELLED) {
    proposed_status = CANCELLED;
    confidence = cancelledEv.confidence ?? 80;
    audit_kind = 'status_recommendation';
    reasoning = 'Cancellation evidence found while the order is still active.';
  } else if (implied && curIdx >= 0 && implied.ladderIndex > curIdx) {
    proposed_status = implied.status;
    confidence = implied.confidence;
    audit_kind = 'status_recommendation';
    reasoning = `Evidence reaches the «${implied.status}» milestone, ahead of the current «${current_status}».`;
  } else if (implied && curIdx >= 0 && implied.ladderIndex < curIdx) {
    // Status claims more than evidence supports. Absence of evidence is not proof of a
    // negative, so we flag for investigation rather than proposing a downgrade.
    proposed_status = null;
    confidence = 40;
    audit_kind = 'health_flag';
    reasoning = `Current status «${current_status}» is ahead of the evidence (which reaches «${implied.status}»). Verify before relying on it.`;
  } else if (curIdx === -1) {
    proposed_status = implied ? implied.status : null;
    confidence = implied ? Math.min(implied.confidence, 60) : 30;
    audit_kind = implied ? 'status_recommendation' : 'health_flag';
    reasoning = `Current status «${current_status}» is not canonical${implied ? `; evidence suggests «${implied.status}»` : ''}.`;
  } else {
    // In sync on the ladder. Confidence reflects how well evidence corroborates it.
    confidence = implied ? implied.confidence : 50;
    reasoning = implied
      ? `Status «${current_status}» matches the evidence milestone.`
      : `Status «${current_status}» — no corroborating evidence collected yet.`;
  }

  const findings = computeFindings(current_status, evidence, now, { implied, curIdx });

  // Nothing to surface: in sync AND no findings → no package.
  if (audit_kind === 'in_sync' && findings.length === 0) return null;

  // Low-confidence / ambiguous proposals never auto-recommend (operator decides).
  const recommend = !!proposed_status && confidence >= RECOMMEND_THRESHOLD;

  // If there are only health findings (no status proposal), classify as health_flag.
  if (!proposed_status && audit_kind === 'in_sync' && findings.length) audit_kind = 'health_flag';

  return {
    audit_kind,
    current_status,
    proposed_status,
    confidence,
    confidence_band: band(confidence),
    recommend,
    evidence: collectEvidenceItems(evidence),
    reasoning,
    findings,
    impact: IMPACT,
  };
}

// ─── Pure: build the evidence bundle from an Order document ────────────────────
// Reads the order's own trail (the concrete mirror of the evidence sources). Returns the
// shape auditOrder expects. deps.corroborate(order, milestones) may raise confidences.
function collectEvidenceFromOrder(order = {}) {
  const ms = {};
  const ref = order.sheet_row_id ? `order_row:${order.sheet_row_id}` : `order:${order._id}`;
  const dates = [];
  const note = (d) => { if (d) dates.push(new Date(d).getTime()); };

  // Payment (Declaration / receipt evidence).
  const pays = (order.payments || []).filter(p => !p.voided && (p.amount || 0) > 0);
  if (pays.length) {
    const latest = pays.reduce((a, b) => (new Date(b.date || 0) > new Date(a.date || 0) ? b : a));
    note(latest.date);
    ms.payment = { reached: true, at: latest.date, confidence: 75,
      items: [{ source: 'payment_receipt', detail: `Payment recorded: ${latest.amount} (${latest.method || 'n/a'}).`, at: latest.date }] };
  }

  const lis = Array.isArray(order.lab_interactions) ? order.lab_interactions : [];
  const li  = lis.length ? lis[lis.length - 1] : null;
  if (li && li.sent_at) {
    note(li.sent_at);
    ms.lab_request = { reached: true, at: li.sent_at, confidence: 90,
      items: [{ source: 'lab_correspondence', detail: `Laboratory request sent (v${li.version || 1}).`, at: li.sent_at }] };
  }

  const layouts = Array.isArray(order.layouts) ? order.layouts : [];
  const layout  = layouts.length ? layouts[layouts.length - 1] : null;
  const layoutReceivedAt = li?.layout_received_at || layout?.received_at;
  if (layoutReceivedAt) {
    note(layoutReceivedAt);
    ms.layout = { reached: true, at: layoutReceivedAt, confidence: 85,
      items: [{ source: 'lab_correspondence', detail: 'Layout (макет) received from the laboratory.', at: layoutReceivedAt }] };
  }
  if (layout && (layout.client_decision === 'approved' || layout.sent_to_client_at)) {
    if (layout.client_decision === 'approved') {
      note(layout.decided_at);
      ms.layout_approved = { reached: true, at: layout.decided_at, confidence: 90,
        items: [{ source: 'whatsapp', detail: 'Client approved the layout.', at: layout.decided_at }] };
    } else if (layout.client_decision === 'corrections_requested') {
      // Corrections sent to the lab also moves the order to «Ждем оригинал».
      note(layout.decided_at);
      ms.layout_approved = { reached: true, at: layout.decided_at, confidence: 70,
        items: [{ source: 'whatsapp', detail: 'Client requested corrections (sent back to the lab).', at: layout.decided_at }] };
    }
  }

  const originals = Array.isArray(order.originals) ? order.originals : [];
  const original  = originals.length ? originals[originals.length - 1] : null;
  if (original && original.received_at) {
    note(original.received_at);
    ms.original = { reached: true, at: original.received_at, confidence: 90,
      items: [{ source: 'lab_correspondence', detail: 'Original document received from the laboratory.', at: original.received_at }] };
  }
  if (original && original.sent_to_client_at) {
    note(original.sent_to_client_at);
    ms.delivered = { reached: true, at: original.sent_to_client_at, confidence: 90,
      items: [{ source: 'generated_document', detail: `Original delivered to the client (${original.delivery_method || 'n/a'}).`, at: original.sent_to_client_at }] };
  }

  if (order.cancelled_reason) {
    ms.cancelled = { reached: true, at: order.updated_at, confidence: 85,
      items: [{ source: 'declaration', detail: `Cancellation reason recorded: ${order.cancelled_reason}.`, at: order.updated_at }] };
  }

  for (const e of (order.events || [])) note(e.timestamp);
  note(order.updated_at); note(order.created_at);

  const last_activity_at = dates.length ? new Date(Math.max(...dates)) : (order.updated_at || order.created_at || null);

  // Current waiting-deadline relevant to the status.
  const dl = order.deadlines || {};
  const current_due = order.status === 'Ждем макет' ? dl.lab_response_due
    : order.status === 'На согласовании' ? dl.client_response_due
    : order.status === 'Ждем оригинал' ? dl.original_expected
    : null;

  return { milestones: ms, last_activity_at, deadlines: { current_due }, balance_due: order.balance_due || 0, order_ref: ref };
}

// ─── Pure: idempotency key ─────────────────────────────────────────────────────
function dedupeKey(order = {}, current_status, proposed_status) {
  return ['AUDIT', String(order._id || order.sheet_row_id || 'na'), current_status || 'na', proposed_status || 'none'].join('|');
}

// ─── DB-backed: audit active orders → pending AUDIT PACKAGEs ───────────────────
// Reads Orders (read-only) and writes only audit_packages. Idempotent via dedupe_key
// (skips when an OPEN audit with the same current→proposed already exists). NEVER changes
// status. deps inject Order/AuditPackage/collectEvidence/corroborate/now for testing.
async function audit(deps = {}) {
  const Order        = deps.Order        || require('../models/Order').Order;
  const AuditPackage = deps.AuditPackage || require('../models/AuditPackage').AuditPackage;
  const collect      = deps.collectEvidence || collectEvidenceFromOrder;
  const now          = deps.now || Date.now();

  // Audit every non-cancelled status INCLUDING «Завершен» — completion integrity (debt /
  // undelivered) must be re-verified, not assumed because the order is marked done.
  const orders = await Order.find({ status: { $in: LADDER } })
    .select('status sheet_row_id client declaration_id payments lab_interactions layouts originals events deadlines balance_due cancelled_reason created_at updated_at')
    .limit(2000)
    .lean();

  const summary = { generated: 0, skipped: 0, packages: [], reasons: {} };
  const bump = (k) => { summary.reasons[k] = (summary.reasons[k] || 0) + 1; };

  for (const order of orders) {
    let evidence = collect(order);
    if (deps.corroborate) evidence = await deps.corroborate(order, evidence) || evidence;

    const pkg = auditOrder({ current_status: order.status, evidence }, now);
    if (!pkg) { summary.skipped++; bump('in_sync'); continue; }

    const dedupe_key = dedupeKey(order, pkg.current_status, pkg.proposed_status);
    const open = await AuditPackage.exists({ dedupe_key, state: { $in: ['pending', 'approved'] } });
    if (open) { summary.skipped++; bump('open_audit_exists'); continue; }

    const doc = {
      audit_kind:      pkg.audit_kind,
      order_id:        order._id,
      declaration_id:  order.declaration_id || undefined,
      sheet_row_id:    order.sheet_row_id || undefined,
      client_name:     order.client?.companyName || order.client?.name || undefined,
      current_status:  pkg.current_status,
      proposed_status: pkg.proposed_status,
      confidence:      pkg.confidence,
      confidence_band: pkg.confidence_band,
      recommend:       pkg.recommend,
      evidence:        pkg.evidence,
      reasoning:       pkg.reasoning,
      findings:        pkg.findings,
      impact:          pkg.impact,
      dedupe_key,
      state:           'pending',
    };

    try {
      const created = await AuditPackage.create(doc);
      summary.generated++;
      summary.packages.push(created);
    } catch (err) {
      if (err && (err.code === 11000 || err.code === 'E11000')) { summary.skipped++; bump('open_audit_exists'); }
      else throw err;
    }
  }

  return summary;
}

// ─── Read: pending audits for the operator queue (most confident first) ───────
async function listPending(limit = 50, deps = {}) {
  const AuditPackage = deps.AuditPackage || require('../models/AuditPackage').AuditPackage;
  const docs = await AuditPackage.find({ state: 'pending' })
    .sort({ recommend: -1, confidence: -1, created_at: -1 })
    .limit(limit)
    .lean();
  return docs.map(d => ({
    id:              d._id,
    audit_kind:      d.audit_kind,
    order_id:        d.order_id,
    client_name:     d.client_name,
    current_status:  d.current_status,
    proposed_status: d.proposed_status,
    confidence:      d.confidence,
    confidence_band: d.confidence_band,
    recommend:       d.recommend,
    evidence:        d.evidence || [],
    reasoning:       d.reasoning,
    findings:        d.findings || [],
    impact:          d.impact,
    created_at:      d.created_at,
  }));
}

// ─── DB-backed: operator decision (never changes status) ──────────────────────
// 'approve' authorizes the proposed change (records intent only); 'reject' dismisses it;
// 'acknowledge' notes a health flag. None of these write the order/Declaration status.
async function decide(auditId, decision, { decidedBy = 'operator' } = {}, deps = {}) {
  const AuditPackage = deps.AuditPackage || require('../models/AuditPackage').AuditPackage;

  const pkg = await AuditPackage.findById(auditId);
  if (!pkg) throw errorUtils.notFoundError('Audit package not found');
  if (pkg.state !== 'pending') throw errorUtils.conflictError(`Audit package already ${pkg.state}`);

  let nextState;
  if (decision === 'approve')          nextState = 'approved';
  else if (decision === 'reject')      nextState = 'rejected';
  else if (decision === 'acknowledge') nextState = 'acknowledged';
  else throw errorUtils.validationError(`Unknown decision "${decision}" (use approve|reject|acknowledge)`);

  if (decision === 'approve' && !pkg.proposed_status) {
    throw errorUtils.validationError('Cannot approve an audit with no proposed status change (use acknowledge)');
  }

  pkg.state      = nextState;
  pkg.decision   = decision;
  pkg.decided_by = decidedBy;
  pkg.decided_at = new Date();
  // NOTE: approval records authorization ONLY. The status change is operator-performed.
  await pkg.save();
  return pkg;
}

module.exports = {
  // pure
  statusIndex,
  isActive,
  impliedStatusFromEvidence,
  computeFindings,
  auditOrder,
  collectEvidenceFromOrder,
  dedupeKey,
  band,
  // db-backed
  audit,
  listPending,
  decide,
  // constants
  LADDER,
  MILESTONE_STATUS,
  STALE_DAYS,
  FORGOTTEN_DAYS,
  RECOMMEND_THRESHOLD,
  IMPACT,
};
