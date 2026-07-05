# Module: WhatsApp Auto-Responder

- **Status:** MVP (shadow-mode by default; auto-send off until operator flips it)
- **Owner:** —
- **Code:** `services/whatsappAutoResponderService.js`, `models/WaAutoReply.js`, hook in `routes/gowa.js`
- **Last updated:** 2026-07-05

---

## 1. Functional Specification
When a **client** writes us on WhatsApp, the auto-responder answers the common, safe questions
**automatically** — but **only** with the operator-approved answers already in the Knowledge Base
(`client_faq`, `client_template`, `application_form_url`). It **never invents** prices, timelines
or facts, and it **never** quotes a client's exact final price or reveals lab/authority names.

It is the executor of the KB policy `first_contact_autoreply_policy`
(`operatorMasterKbV2.js`): auto is allowed **only** for five kinds —
`service_info`, `pricing_from_kb`, `timelines_from_kb`, `application_link`,
`application_instructions`. **Everything else stays gated** (drafted for the operator, never sent).

Three global modes (env `WA_AUTORESPONDER_MODE`):
- `off` — do nothing.
- `shadow` — **default.** Classify + compose the answer, **record what it WOULD send, send NOTHING.**
  Lets the operator watch the agent's judgement before trusting it.
- `auto` — auto-eligible questions with a grounded KB answer are **sent**; everything else is
  drafted for the operator.

## 2. Workflow Description
```
gowa webhook: inbound DIRECT message (not group, not from_me)
  → ingest (existing) → autoResponder.handleInbound(msg)
     → GUARDS: has text? not a group? no recent human outbound in thread? not already handled?
     → CLASSIFY topic (regex-first): map to a client_faq topic / kind, or 'other'
     → COMPOSE: pull the APPROVED KB answer for that topic (deterministic; no LLM invention)
        · matched auto-eligible kind + grounded answer → candidate = auto
        · no confident match / needs the client's order / complaint / status → candidate = gated
     → ACT by mode:
        · off    → nothing
        · shadow → record { would_send, kind, decision } — send nothing
        · auto   → auto  → outboundWhatsappService.send(); record decision='auto_sent'
                   gated → record decision='gated' (operator picks it up via reply-draft)
```

## 3. Business Rules
- **KB-approved-only.** Answers come from `getApprovedKnowledge()` entries
  (`value.kind` ∈ `client_faq` | `client_template` | `business_setting`). No approved match → gated.
- **Auto-allowed kinds only** (`first_contact_autoreply_policy.auto_allowed_kinds`). Anything about
  the client's **specific order/status/payment**, complaints, or unclear intent → **gated**.
- **Never** quote an exact final price — KB answers already say «от …, точную сумму подтвердит
  специалист». **Never** reveal lab/authority names/emails (internal).
- **Don't step on the operator:** if a human sent an outbound in this thread within
  `WA_AUTORESPONDER_HUMAN_QUIET_MIN` (default 30) minutes → do not auto-send (operator is handling
  it); still record as shadow/observed.
- **One decision per inbound message** (idempotent by `provider_message_id`).
- Groups (`@g.us`) and our own outbound (`from_me`) are never auto-answered.
- Anti-ban / 24h window are enforced downstream by `outboundWhatsappService` (GOWA).

## 4. Data Model
`wa_autoreplies` (model `WaAutoReply`), one doc per handled inbound message:
`provider_message_id` (unique), `phone_key`, `to_phone`, `inbound_text`, `kind`, `topic`,
`matched_kb_ref`, `answer_text`, `decision` (`auto_sent` | `gated` | `shadow` | `skipped`),
`mode`, `skip_reason`, `send_result`, timestamps. Read-only toward the sheet/Gmail.

## 5. API Contract
Not an HTTP route of its own — invoked from the GOWA webhook (`routes/gowa.js`) after ingest.
Panel read (future): `GET /api/control-center/autoreplies` to review shadow/auto decisions.
Env: `WA_AUTORESPONDER_MODE` (`off`|`shadow`|`auto`, default `shadow`),
`WA_AUTORESPONDER_HUMAN_QUIET_MIN` (default 30).

## 6. Approval
- Policy approved by operator: KB `first_contact_autoreply_policy` (2026-06/07). Auto-send stays
  **off** (shadow) until the operator reviews shadow decisions and flips `WA_AUTORESPONDER_MODE=auto`.

## 7. Implementation
`classifyTopic(text)` and `composeAnswer(topic, kb)` are **PURE** (no I/O) and exported for tests.
`handleInbound(msg, deps)` is the DB-backed orchestrator (guards → classify → compose → act/record).
Pulls answers from `knowledgeBaseService.getApprovedKnowledge()` and
`getBusinessSetting('application_form_url')`; sends via `outboundWhatsappService.send`.
Gated drafts are left for the existing operator reply-draft flow (`whatsappReplyDraftService`).

## 8. Tests
`npm run test:wa-autoresponder` — pure classifier + composer table, guard/skip logic, and the
mode matrix (off/shadow/auto) with a stubbed outbound + KB. No live sends in tests.
