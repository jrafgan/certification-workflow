# Module: Operator Work Counter (статистика операторов)

- **Status:** built
- **Owner:** maksatovy
- **Code:** `backend/src/services/operatorStatsService.js`, `backend/src/routes/stats.js`,
  attribution write in `backend/src/routes/whatsappSend.js`, fields in
  `backend/src/models/WhatsAppMessage.js`; UI screen «Статистика» in
  `frontend/control-center.html` + `frontend/js/control-center.js`.
- **Last updated:** 2026-06-30

---

## 1. Functional Specification
Counts how much each operator handles and **what kind of questions** — "какой сотрудник
какие вопросы и сколько". The unit of work (operator's decision) is a **sent reply** to a
client. NOT a productivity-policing tool: it is a read-only counter over already-sent
replies. Non-goals: it does not assign work, score quality, or change anything in the
Declaration.

## 2. Workflow Description
1. Operator sends a WhatsApp reply from the panel → `POST /api/whatsapp/send`.
2. On a successful send, the route records an **outbound** `WhatsAppMessage` attributed to
   the operator (`handled_by`), classifying the **last inbound** message from that client
   via `leadIntentService.classify` → `question_intent` + `question_category`.
3. The «Статистика» screen calls `GET /api/stats/operators?from=&to=`, which aggregates
   those outbound records per operator × question type/topic.

Attribution is **best-effort**: a metric-write failure never breaks or delays the send.

## 3. Business Rules
- Unit = one sent reply (`direction:'outbound'` with `handled_by`).
- Question type from the **inbound** message being answered (the client's question), not the
  operator's text. Missing intent/category → `unknown` (empty values are flagged, not hidden —
  память `empty-fields-always-question`).
- Read-only/output: recording the metric never sends and never writes Declaration/Gmail.

## 4. Data Model
Writes/extends `whatsapp_messages` (replica, not source of truth): new fields `to_phone`,
`handled_by` (→ `users`), `handled_at`, `question_intent`, `question_category`; index
`{handled_by, handled_at}`. Reads `users` for display names. No idempotency key — each sent
reply is its own event.

## 5. API Contract
- `GET /api/stats/operators?from=&to=` (authed) — **read**. `from`/`to` optional ISO dates,
  `to` exclusive. → `{ operators:[{operator_id, display_name, total, by_intent, by_category}],
  totals:{total, by_intent, by_category}, from, to }`.
- Attribution side-effect lives in the existing `POST /api/whatsapp/send` (mutating).

## 6. Approval
- Approved by: maksatovy (plan approved 2026-06-30)
- Notes: unit = sent reply; category from `leadIntentService`.

## 7. Implementation
`operatorStatsService.aggregate()` is pure (testable); `compute()` queries + joins user
names; `recordOutboundReply()` finds the last inbound, classifies, and persists the
attributed outbound. Reuses `phoneUtils.matchKey` and `leadIntentService`.

## 8. Tests
`backend/tests/operator-stats.test.js` (`npm run test:operator-stats`) — pure aggregation
(grouping, totals, unassigned/unknown buckets) + `recordOutboundReply` with injected fakes.
In CI unit-test loop. Gap: no live end-to-end against Mongo (covered by manual verification).
