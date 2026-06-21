# Module: Social / Lead Conversion Agent

- **Status:** built (V1; platforms stubbed)
- **Owner:** —
- **Code:** `backend/src/services/leadConversionService.js`, `leadIntentService.js`, `leadReplyTemplates.js`; `models/Lead.js`, `LeadMessageDraft.js`; `integrations/platformAdapter.js`; `routes/leads.js`
- **Last updated:** 2026-06-21

---

## 1. Functional Specification
Converts inbound social-media inquiries (Instagram/Facebook/Telegram) into submitted
applications and paid orders, or hands them to the main WhatsApp workflow. Drives a lead
through an 8-state machine so **no lead disappears silently**. **Not responsible for** lab
comms, document approval, status management, final pricing, or document edits.

## 2. Workflow Description
States: `new → educating → waiting_application → waiting_calculation → waiting_payment →
transferred_whatsapp`; any active → `dormant` → `recovered`. Stages: greet (Stage 1) →
classify intent/language (2) → educate (3) → application link (4) → follow-ups 24h/72h/7d (5)
→ application detected (6) → calculation (7, gated) → payment instructions (8) → payment
detected (9, gated) → WhatsApp transfer (10) → recovery 30/60/90d (11, gated).

## 3. Business Rules
- **Never auto-sends.** Every outbound is a `LeadMessageDraft` the operator releases — even the
  spec's "auto-allowed" replies (pricing ranges/timelines/docs/PI/TN VED/reminders). `auto_allowed`
  marks what *could* be auto-released later; the V1 decision is operator-in-the-loop.
- Operator-gated kinds: calculation, payment instructions, recovery, exact pricing.
- Education content sourced from the operator KB (ranges only, never an exact final price):
  ДС от 15 000 сом/~2 нед/3 года; СС от 35 000/1–1.5 мес/1 год; отказное 5 000; ПИ first included,
  доп. ДС +7 000 / СС +9 000; ТН ВЭД 61 трикотаж / 62 швейка.

## 4. Data Model
`leads` (model `Lead`): platform, handle (unique per platform), language, intent, service_category,
state, application_row, whatsapp_phone, timers (first_contact/last_inbound/last_outbound/application_link/dormant_at),
follow_up_count, recovery_count, history[]. `lead_message_drafts` (model `LeadMessageDraft`):
lead_id, kind, auto_allowed, proposed_text, reason, impact, payload, dedupe_key(unique), state, decision.

## 5. API Contract
- `GET  /api/leads` (?state) · `GET /api/leads/drafts`
- `POST /api/leads/ingest` — `{ platform, handle, text }` → classify + propose greeting/education.
- `POST /api/leads/:id/advance` — run the next state-machine action.
- `POST /api/leads/:id/calculation` — `{ doc_type, compositions|pi_count }` → gated calc proposal.
- `POST /api/leads/drafts/:id/decision` — approve|reject|request_changes.
- `POST /api/leads/drafts/:id/release` — deliver an APPROVED draft via the platform adapter.

## 6. Approval
- Approved by: operator. Date: 2026-06-21. Decisions: core engine + platforms stubbed; all
  replies operator-released (never auto-sent).

## 7. Implementation
`leadIntentService` (pure ru/ky/en language + intent + service classifier — explicit Cyrillic
boundaries, `\b` is ASCII-only). `leadConversionService` (pure state machine + 24/72h/7d follow-up
+ 30/60/90d recovery timing; DB ingest/advance/calc/payment/decide/release; reuses piCalculation +
paymentRecognition). `platformAdapter` = StubAdapter (no live IG/FB/Telegram — gated follow-up).

## 8. Tests
`npm run test:lead-intent` (22) + `test:lead-conversion` (29). Covers classification, state
transitions, follow-up/recovery timing, auto-allowed-vs-gated boundary, KB-grounded templates.
E2E dry-run verified ingest→draft→approve→release(stub)→gated calc→payment, nothing transmitted.
