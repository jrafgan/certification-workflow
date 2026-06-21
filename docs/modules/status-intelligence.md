# Module: Status Intelligence (Workflow Auditor)

- **Status:** built
- **Owner:** —
- **Code:** `backend/src/services/workflowAuditService.js`; `models/AuditPackage.js`; `routes/auditPackages.js`
- **Last updated:** 2026-06-21

---

## 1. Functional Specification
Determines the **real stage** of an order from evidence and compares it to the **declared**
status, producing an AUDIT PACKAGE (current status · proposed status · confidence · evidence ·
reasoning + operational findings). Treats status as an operational indicator (visibility,
bottleneck/forgotten-order detection). **Not responsible for** changing status — ever.

## 2. Workflow Description
```
order → collectEvidence (from the Order doc: payments/lab_interactions/layouts/originals/events)
      → impliedStatusFromEvidence (milestone ladder) → compare to declared
      → auditOrder → AuditPackage (pending) → operator approve/reject/acknowledge
```
Ladder: Запустить → Ждем макет → На согласовании → Ждем оригинал → Оригинал получен → Завершен (Отменен special).
Milestones: payment / lab_request / layout / layout_approved / original / delivered / cancelled.

## 3. Business Rules
- The 7 canonical Russian statuses are used **verbatim** (never translated/renamed).
- Match the order first; recommendations carry the matched order + evidence + confidence.
- `recommend=true` only when confidence ≥ 70; low-confidence/ambiguous never auto-recommend.
- Status **ahead** of evidence → `contradictory_state` health flag, **not** an auto-downgrade
  (absence of evidence isn't proof of a negative).
- Findings: stale_status, missing_transition, delayed_order, forgotten_order, contradictory_state, unrecognized_status.
- `approve` records authorization only; applying the status change is a separate operator action — no auto status updates.

## 4. Data Model
`audit_packages` (model `AuditPackage`): audit_kind, order_id, current_status, proposed_status,
confidence(+band), recommend, evidence[{source,detail,at}], reasoning, findings[], impact,
dedupe_key(unique per order+current→proposed), state(pending|approved|rejected|acknowledged|superseded).
Reads Orders (read-only).

## 5. API Contract
- `GET  /api/audit-packages` — pending (recommended + most confident first).
- `POST /api/audit-packages/run` — audit active orders → pending packages.
- `POST /api/audit-packages/:id/decision` — `{ decision: approve|reject|acknowledge, decidedBy? }`.

## 6. Approval
- Approved by: operator (status accuracy is the highest business priority). Date: 2026-06-21.

## 7. Implementation
Pure: `statusIndex`, `impliedStatusFromEvidence`, `computeFindings`, `auditOrder`, `collectEvidenceFromOrder`
(injectable for WhatsApp/Gmail corroboration). Measured findings (see evals): reliable when **inbound
lab evidence** exists; blind to client-approval (WhatsApp) and completion/delivery; latest-state vs
highest-milestone and phone-vs-name matching are known improvement areas.

## 8. Tests
`npm run test:workflow-audit` (11). Covers ladder inference, recommend gating, contradiction
handling, cancellation, findings. Live evals (`scripts/eval-status-intelligence.js`) measured real
status drift on production data.
