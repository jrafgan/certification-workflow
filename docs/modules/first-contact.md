# Module: First-Contact Verification (новые номера из заявок)

- **Status:** built
- **Owner:** maksatovy
- **Code:** `backend/src/services/firstContactService.js`,
  `backend/src/models/FirstContactProposal.js`, `backend/src/routes/firstContact.js`,
  `sendTemplate` in `backend/src/services/whatsappCloudService.js`; UI «Новые номера» in
  `frontend/control-center.html` + `frontend/js/control-center.js`.
- **Last updated:** 2026-06-30

---

## 1. Functional Specification
When a New Form application carries a WhatsApp number we have **never** received a message
from, the agent proposes contacting it to verify "оставляли ли вы заявку?". Purpose: catch
applications whose phone never reached our WhatsApp. Non-goals: it does not create orders,
change status, or send on its own.

## 2. Workflow Description
1. Operator clicks «Найти новые номера» → `POST /api/first-contact/scan`.
2. Scan reads New Form applications (`newFormClient.readApplications`), and for each phone
   with **no inbound** `WhatsAppMessage` and no existing proposal, creates a
   `FirstContactProposal` (state `pending_approval`).
3. Operator reviews on «Новые номера»; **Подтвердить** → `decide(approve)` sends the
   Meta-approved template (`whatsappCloudService.sendTemplate`) → state `sent`. **Отклонить**
   → `rejected`. Send failure keeps it `approved` with the error (retryable).

```
New Form app → matchKey(phone) → no inbound? + no proposal? → pending_approval
   approve → sendTemplate → ok? sent : approved(+error)
   reject  → rejected
```

## 3. Business Rules
- **Cold-contact = template only.** Business-initiated messages outside the 24h window MUST
  use a Meta-approved template (free text is rejected). Template name/lang are env-configured
  (`FIRST_CONTACT_TEMPLATE_NAME`, `FIRST_CONTACT_TEMPLATE_LANG`) — волатильные значения → env.
- **Agent never auto-sends.** Output-only until the operator approves; the approve action is
  what triggers the send (operator-gated, recommendation mode).
- WhatsApp is the only client channel. Empty/short phones are skipped and **flagged**
  (`no_phone`), never silently assumed.
- Idempotent: one proposal per number (unique `phone_key`).

## 4. Data Model
Writes only `first_contact_proposals` (own store). Reads New Form applications (read-only)
and `whatsapp_messages` (inbound existence check — must not be wiped; it is what defines
"never wrote us", память `whatsapp-inbox-operator-visibility`). Idempotency key = `phone_key`
(unique index).

## 5. API Contract
- `GET /api/first-contact` (authed) — **read** — pending/approved proposals.
- `POST /api/first-contact/scan` (authed) — **mutating** (writes proposals) — `{generated,
  skipped, reasons, count}`.
- `POST /api/first-contact/:id/decision` (authed) — **mutating** — `{decision:'approve'|'reject'}`
  → `{id, state, decision, send_result}`. `approve` performs the template send.

## 6. Approval
- Approved by: maksatovy (plan approved 2026-06-30) — option «Гейт-черновик + шаблон».
- Conditions: template `first_contact_check` registered + Approved in WhatsApp Manager before
  approvals can actually send (see runbook).

## 7. Implementation
`buildProposal()` pure (testable); `scanUnknownApplicants()` / `listPending()` / `decide()`
DB-backed with injectable deps (mirrors `leadRecoveryService`). `sendTemplate()` added to the
Cloud transport (injectable `fetch`). Depends on the template existing in Meta (runbook
`docs/runbooks/CONNECT_WHATSAPP_NUMBER_508391773.md`).

## 8. Tests
`backend/tests/first-contact.test.js` (`npm run test:first-contact`) — pure `buildProposal`,
scan filtering/idempotency (cold/known/existing/empty/duplicate), and `decide`
approve/reject/terminal with injected fakes. `sendTemplate` payload covered in
`whatsapp-cloud.test.js`. Both in the CI unit-test loop. Gap: no live Graph/Mongo e2e.
