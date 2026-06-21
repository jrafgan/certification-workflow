# Module: Lead Recovery

- **Status:** built
- **Owner:** —
- **Code:** `backend/src/services/leadRecoveryService.js`; `models/LeadRecovery.js`; `routes/leadRecoveries.js`
- **Last updated:** 2026-06-21

---

## 1. Functional Specification
Detects leads/orders that have **stalled on the client side** and proposes a re-engagement
message for operator review. A lead is an Order awaiting a client action (layout approval,
payment/info) that has gone idle, or an intake application that never progressed.
**Not responsible for** sending, changing status, or marking chats read.

## 2. Workflow Description
```
scan Orders (На согласовании / Запустить) + optional applications
  → normalize to a lead → assessLead(now)
  → if stalled: buildRecoveryProposal → LeadRecovery (pending)
  → operator approve/reject (approve authorizes; send is operator-performed)
```

## 3. Business Rules
- Client channel is **WhatsApp only** (never email) — proposed_text is a WhatsApp follow-up.
- Idle thresholds: stalled after **3 days** idle; severity MEDIUM ≥ 7d, HIGH ≥ 14d; a missed
  `client_response_due` always bumps severity.
- Skips leads with no WhatsApp phone (can't recover) and leads that already responded.
- Output-only: never sends, never changes order status, never marks chats read.
- One open recovery per (lead + stage) — idempotent.

## 4. Data Model
`lead_recoveries` (model `LeadRecovery`): source(order|application), order_id/application_ref,
client_name, to_phone, channel='whatsapp', lead_stage(awaiting_client_approval|awaiting_payment|stale_application),
severity, days_idle, proposed_text, reason, evidence[], impact, confidence_band, dedupe_key(unique),
state(pending|changes_requested|approved|sent|rejected|superseded). Reads Orders (read-only).

## 5. API Contract
- `GET  /api/lead-recoveries` — pending (most severe first).
- `POST /api/lead-recoveries/scan` — scan → build pending proposals.
- `POST /api/lead-recoveries/:id/decision` — `{ decision, decidedBy?, changeNote? }`.

## 6. Approval
- Approved by: operator. Date: 2026-06-21.

## 7. Implementation
Pure: `leadFromOrder`/`leadFromApplication`, `assessLead`, `severityFor`, `recoveryMessage` (RU),
`buildRecoveryProposal`, `dedupeKey`, `applyDecisionTransition`. DB: `scan`/`listPending`/`decide`.
Note: this is the **order-side** recovery; the **lead-side** 30/60/90-day recovery lives in the
Lead Conversion Agent (Stage 11).

## 8. Tests
`npm run test:lead-recovery` (12). Covers stage detection, idle/severity thresholds, missed
deadline bump, no-phone skip, proposal build, decision transitions, dedupe.
