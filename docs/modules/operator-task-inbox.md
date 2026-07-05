# Module: Operator Task Inbox (WhatsApp-style To-Do)

- **Status:** DEPLOYED 2026-07-01 (Hetzner Helsinki) — awaiting sign-off + live GOWA group-payload verification
- **Owner:** jrafgan
- **Code:** `backend/src/services/taskInboxService.js`, `backend/src/models/InboxThreadState.js`, `backend/src/models/ApplicationOverride.js`, `frontend/js/control-center.js` (screen «Задачи»)
- **Last updated:** 2026-07-05

> **2026-07-05 — operator override on «новая заявка».** The agent's new/old guess is imperfect
> (it can't see replies made outside the system, offline deals, duplicates). The operator can now
> mark an application **«не новая»** with a reason (`already_replied` | `not_relevant` | `duplicate`
> | `spam_wrong` | `handled_offline` | `already_client` | `other` + note). Stored in
> `application_overrides` (model `ApplicationOverride`), keyed by phone match key or `row:<n>`.
> `buildTasks` hides any application with a `not_new` override **before** classification — the human
> beats the agent (highest priority). Reversible via reopen (deletes the doc). Routes:
> `POST /api/control-center/applications/mark` + `/applications/reopen` (audited).
> Also fixed: the New-Form date lives in **column 0** (header mislabeled «А»); `parseFormDate`
> now parses «ДД.ММ.ГГГГ ЧЧ:ММ:СС», which revived the age>50д backstop (was a no-op on real data).

---

## 1. Functional Specification

The single primary screen an operator sees when opening the panel. It answers one
question at a glance: **what do I need to do right now, and with whom?**

It is a WhatsApp-style list of threads (one row per client phone / entity) fused with
the non-chat work the operator owns (emails to labs, new applications without a price
calc). Clicking a row opens a two-pane detail: the last 10 messages with that client,
their Declaration info, a short email/lab status, and any agent-drafted reply (gated).

**In scope**
- Group inbound WhatsApp into per-entity threads (phone → entity, see
  [[client-entity-model]]).
- Show ONLY group messages that are **addressed to the operator** (rule in §3).
  1:1 direct messages always show.
- Unify non-WhatsApp tasks (lab email needs reply, new application without calc) into
  the same prioritized list.
- Per-thread read / done / snooze so the list clears.

**Non-goals**
- Not a new transport. Reads the existing `whatsapp_messages` replica + engines.
- Never sends. All replies remain drafts through each engine's existing gate
  ([[recommendation-mode]], [[order-activation-trigger]]).
- Does not write the Declaration sheet ([[declaration-source-of-truth]]).
- Does not replace the specialized screens — they move under an «Ещё» menu.

## 2. Workflow Description

```
GOWA webhook ─► gowaClient.toIngestRaw (now keeps chat_id, is_group,
                 mentioned_jids, quoted_author, group_subject, from_name)
      │
      ▼
routes/gowa.js
   ├─ direct (1:1)  ─────────────► ingest ALWAYS
   └─ group (@g.us) ─ addressed_me? ─┬─ yes ─► ingest (addressed_reason)
                                     └─ no  ─► skip inbox (interest→first-contact only, unchanged)
      │
      ▼
whatsapp_messages  (+ addressed_me, addressed_reason, chat_id, is_group)
      │
      ▼
taskInboxService.tasks()  ── groups by phone_key/entity, fuses lab-email &
      │                        new-application tasks, applies InboxThreadState
      ▼
GET /api/control-center/tasks     → list rows (WhatsApp style)
GET /api/control-center/thread?phone=…  → last 10 msgs + Declaration + email/lab + draft
POST /api/control-center/thread/seen    → mark read / done / snooze
```

Triggers: inbound WhatsApp (webhook), pending lab-email draft, new application row with
no PI calc. Outcome: a prioritized to-do the operator clears by acting (approve draft,
reply, mark done).

## 3. Business Rules

**"Addressed to me" in a GROUP** (operator-confirmed 2026-07-01). A group message
enters the inbox if ANY holds:
- **mention** — a `me` number is in `mentioned_jids`;
- **reply** — the message quotes/answers a message authored by a `me` number;
- **keyword** — `interestDetectionService.detect()` flags certification interest
  (declaration / certificate / price, etc.).

`addressed_reason` records which fired (`mention|reply|keyword`); direct messages get
`direct`. All other group chatter is ignored (not stored to inbox), preserving today's
behavior in `routes/gowa.js`.

**"me" set** — `OPERATOR_WHATSAPP_NUMBERS` (CSV of numbers, default `507391773`),
compared via `phoneUtils.matchKey` (last 9 local digits). 507 is the operator's own
number per [[whatsapp-test-vs-combat-numbers]]; the env lets a dedicated bot number be
added later without code change.

**Identity / dedup** — one row per client = phone (1st ID) + legal entity (2nd ID),
per [[client-entity-model]]. A client writing both in DM and in a group is ONE row.

**Gating** — output-only. Rows surface work; replies are drafts approved through the
existing engine gates. Nothing here auto-sends or writes the sheet.

**Empty fields** — missing Declaration / phone is shown and flagged, never silently
assumed ([[empty-fields-always-question]]).

## 4. Data Model

**`whatsapp_messages`** (extend, replica only — never source of truth):
- `chat_id` (String) — JID of the chat (group `…@g.us` or contact).
- `is_group` (Bool).
- `group_subject` (String, optional).
- `addressed_me` (Bool) — did this reach the operator per §3.
- `addressed_reason` (enum `mention|reply|keyword|direct|null`).

**`InboxThreadState`** (new, small, keyed by `phone_key`):
- `phone_key` (String, unique), `last_seen_at` (Date), `snoozed_until` (Date),
  `done` (Bool), `updated_by` (String).
- Purpose: unread counts + clearing the list. Pure UI/operator state; carries no
  business truth.

Reads (no writes): Orders, Declaration (via `orderWorkspaceService`), EmailDraft /
lab interactions, New Form applications, agent drafts.

Idempotency: message insert stays keyed on `provider_message_id` (unchanged).

## 5. API Contract

All under `/api/control-center` (auth required; operator + administrator).

- `GET /tasks` → `{ db_connected, tasks:[{ kind, phone, phone_key, title, subtitle,
  last_message, channel, age_ms, unread, priority, order_id?, addressed_reason? }] }`.
  `kind` ∈ `whatsapp_reply | lab_email | new_application | calc | payment | critical`.
  READ.
- `GET /thread?phone=<num>` → the client DOSSIER: `{ db_connected, entity, payment:{paid,
  debt,is_paid}, origin, next_step:{status,actor_ru}, messages:[…last 10],
  email_history:[…lab+draft], proposed_reply:{text,kind,reason,draft_id?} }`. READ.
  Payment is «Сумма» col G (paid; parentheses = remaining debt). `proposed_reply` is ALWAYS
  present — a stored agent draft if one exists, else generated (debt→remind / active
  stage→status update / new→application link / else greeting). Lab history is matched by
  client NAME (matched_order_id is unreliable — see the known gap).
- `POST /thread/seen` `{ phone, action: seen|done|snooze, until? }` → `{ ok }`.
  Mutates only `InboxThreadState` (operator UI state), AUDITED like other decisions.
- Sending the reply reuses the existing `POST /api/whatsapp/send { to, body }` (operator-
  confirmed, anti-ban safety-gated, attributed to the operator) — no new send path.

UI (frontend only): the list has a search box + filter chips with live counts (Все /
Непрочитанные / Ответить / Оплатившие / Письма / Заявки), urgency colouring by age
(≥4h amber, ≥24h red), kind tags, and 30s auto-refresh. The reply is an editable textarea
with «Отправить клиенту» (calls the send endpoint) + «Скопировать».

## 6. Approval

- Approved by: _pending_
- Date: _pending_
- Notes / conditions: GOWA webhook field names for mentions/quoted to be confirmed on
  a live payload; `toIngestRaw` parses defensively (multiple candidate keys) until then.

## 7. Implementation

- **Phase 1** — `integrations/gowaClient.js` (`toIngestRaw` keeps `chat_id`/`is_group`/
  `group_subject`/`mentioned_jids`/`quoted_author`/`from_name`; `extractMentions`,
  `extractQuotedAuthor`); `models/WhatsAppMessage.js` (+`chat_id`, `is_group`,
  `group_subject`, `addressed_me`, `addressed_reason`); `services/whatsappIngestService.js`
  (`computeAddressing`, `operatorMeKeys`).
- **Phase 2** — `routes/gowa.js`: DM always ingested; `ingestIncoming` self-filters group
  chatter (stores only `addressed_me`).
- **Phase 3** — `services/taskInboxService.js` (`buildTasks` pure; `tasks`, `thread`,
  `markThread`); wrappers in `services/controlCenterService.js`; routes `GET /tasks`,
  `GET /thread`, `POST /thread/seen` in `routes/controlCenter.js`.
- **Phase 4** — `models/InboxThreadState.js` (read/done/snooze; only mutation, audited).
- **Phase 5** — `frontend/control-center.html` (nav «Задачи» primary + «Ещё» dropdown,
  `#screen-tasks` two-pane), `frontend/js/control-center.js` (`loadTasks`, `openThread`,
  `openTask`, done/snooze), `frontend/css/control-center.css`.

Config: `OPERATOR_WHATSAPP_NUMBERS` (default `507391773`).

## 8. Tests

- `tests/gowa.test.js` — group/mention/reply extraction (11 passed).
- `tests/whatsapp-ingest.test.js` — `computeAddressing` (direct/mention/reply/keyword/
  ignored) + group-field mapping (11 passed).
- `tests/task-inbox.test.js` — grouping/dedup, unread vs last_seen, done/snooze hiding,
  fusion of lab-email + new-application, priority ordering (6 passed).
- No live GOWA/Graph/DB calls in tests (pure functions / injected deps).

**Known gap:** GOWA webhook field names for mentions/quoted are parsed defensively across
candidate keys; confirm against a real group payload from the boevoy 507 and tighten if
needed.
