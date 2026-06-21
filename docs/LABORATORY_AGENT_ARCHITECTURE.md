# LABORATORY COMMUNICATION AGENT ARCHITECTURE
## Gmail-Based Laboratory Thread Monitoring for the Certification Workflow System

**Supersedes:** `docs/GMAIL_AGENT_ARCHITECTURE.md`
**Status:** Architecture approved — not yet implemented

---

## What Changed From the Previous Architecture

This document replaces `GMAIL_AGENT_ARCHITECTURE.md` following an architectural review. Key changes:

| Area | Previous | This Document |
|------|----------|---------------|
| Conceptual name | Gmail Agent | Laboratory Communication Agent |
| Thread contexts | 4 (`lab_request`, `lab_reminder`, `client_layout`, `lab_print_order`) | 2 (`lab_interaction`, `lab_print_order`) |
| Client email tracking | In scope (Phase G5) | Removed — client communication is not email-based |
| Reply detection | Message count comparison (primary) | UNREAD label + sender check (primary), count as fallback |
| Historical thread initialization | Undefined behavior | Explicit initialization strategy with `initialized_message_count` |
| `recipient_email` on thread record | Not present | Required field (set at link time) |
| Historical thread search | `recent-threads` endpoint (inadequate) | Dedicated `search-threads` endpoint from day one |
| Order search fields | `phone` only (indexed) | `applicantName`, `companyName`, `phone`, `email` |
| Risk classification | No formal system | `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` (computed at read time) |
| Dashboard | Routed through task system only | 4-question Laboratory Communications panel |

---

## Purpose of This Document

This document defines the architecture for the Laboratory Communication Agent — a Gmail-based monitoring system that tracks the operator's email communication with certification laboratories.

The agent answers one operational question at all times: **"What is the current state of every active laboratory communication?"**

**The agent never sends email automatically.** Every send action remains a human decision. This is a non-negotiable constraint of Design Principle 7.

This agent is architecturally planned and documented here for implementation after Architecture Freeze v1. It does not change any V1 state machine rules, status catalog, or existing collection schemas except for additive, backward-compatible extensions noted in Section 5 and Section 6.

---

## 1. Business Goals

### 1.1 Communication Paths Covered

The Laboratory Communication Agent covers one communication path: **operator to laboratory.**

| Step | What Happens | Risk Without Monitoring |
|------|-------------|------------------------|
| Lab request sent | Operator emails lab with certification details | Lab ignores request; no reply arrives; deadline passes unnoticed |
| Lab non-response | Lab goes silent for days | System tracks deadline but not the specific thread; reminder is generated blind |
| Lab reply — layout | Lab replies with layout PDF attached | Reply buried in inbox; layout not downloaded; order stalls |
| Lab reply — questions | Lab replies to clarify details | Operator misses reply; lab waits; order stalls from both sides |
| Reminder sent | Operator sends follow-up in same thread | Second reply also buried; escalation loop invisible |
| Print order sent | Operator sends print instruction after client approval | Lab misses instruction; original delayed |
| Dispatch notification | Lab replies to confirm original is on the way | Reply missed; operator doesn't know when to expect original |

**What the agent prevents:**

1. Any qualifying reply from a laboratory generates an immediate task within the next poll interval.
2. A monitored thread with no reply escalates automatically when its deadline is reached.
3. Replies with attachments are explicitly flagged: "Layout likely received by email."
4. The operator can see the state and age of every active laboratory thread without opening Gmail.
5. Historical threads can be linked retroactively from day one of deployment.

### 1.2 Communication Path Explicitly Not Covered

| Path | Why Not Covered |
|------|----------------|
| Operator to client | Client contact is via WhatsApp, Telegram, Instagram, or phone — not email. Gmail thread tracking does not apply. |
| Inbound form submissions | Covered by Sheets Sync / Forms Intake modules. |
| Non-Gmail email clients | Out of scope. The operator's Gmail account is the system of record. |

---

## 2. Integration Architecture

### 2.1 Position in the System

The Laboratory Communication Agent is a fourth integration module, alongside Sheets Sync and Forms Intake, using the same `googleAuth.js` authentication infrastructure.

```
┌─────────────────────────────────────────────────────────────────┐
│                     APPLICATION SOURCES                          │
│                                                                  │
│   Google Form ──────────▶ Google Sheets (Declaration Sheet)     │
│                                    │                            │
│                         ┌──────────▼──────────┐                 │
│                         │   SHEETS SYNC        │                 │
│                         └──────────┬──────────┘                 │
└────────────────────────────────────│────────────────────────────┘
                                     │ new row detected
                                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                         API SERVER                               │
│                                                                  │
│   Order CRUD           State Machine Engine                      │
│   Declaration Sync     Event Logger                              │
│   Task Manager         Deadline Field Manager                    │
│   Lab Thread Manager ◀── NEW                                     │
└────────────┬──────────────────────────────────┬────────────────┘
             │                                  │
┌────────────▼───────────┐          ┌───────────▼───────────────┐
│       DATABASE          │          │   SCHEDULER / POLLER       │
│                         │          │                            │
│   orders                │          │  Attention Engine          │
│   declarations          │          │  Lab Comm Poller ◀── NEW   │
│   tasks                 │          │  Sheets Sync               │
│   lab_comm_threads ◀─ NEW│          │                            │
└─────────────────────────┘          └────────────────────────────┘
```

### 2.2 Authentication Scope Extension

The existing `googleAuth.js` handles OAuth2 for Google Sheets. The Laboratory Communication Agent adds one scope:

| Scope | Purpose |
|-------|---------|
| `https://www.googleapis.com/auth/gmail.readonly` | Read messages and thread metadata. No send, compose, or modify permissions. |

Read-only scope is a technical enforcement of Design Principle 7. It is not a simplification — it is a constraint. The scope is expanded only with explicit justification and user approval.

### 2.3 API Methods Used

| Gmail API Method | Purpose |
|-----------------|---------|
| `users.threads.list` | Search for threads matching a query — used for thread selector and historical search |
| `users.threads.get` | Fetch thread metadata and message list for reply detection |
| `users.messages.get` | Read message headers (`From`, `Subject`, `Date`, `labelIds`) and check for attachments |

No write methods (`labels.modify`, `messages.send`, `drafts.create`) are used.

### 2.4 Module Structure

```
backend/src/integrations/
├── googleAuth.js           ← existing; scope extended to include gmail.readonly
├── formsIntake.js          ← existing; unchanged
├── sheetsSync.js           ← existing; unchanged
├── gmailClient.js          ← NEW: thin wrapper over googleapis Gmail API
└── labCommPoller.js        ← NEW: thread monitoring and reply detection loop

backend/src/services/
├── labCommService.js       ← NEW: CRUD for lab_comm_threads; thread linking logic; risk computation

backend/src/models/
├── LabCommThread.js        ← NEW: Mongoose model for lab_comm_threads collection
```

### 2.5 Polling vs Push

**V1 (polling):** The Lab Comm Poller runs on a configurable cron interval — recommended every 15–30 minutes. It iterates all `waiting` threads in `lab_comm_threads` and calls `threads.get` to check for new messages.

**Future (push):** Gmail's `users.watch` API + Google Cloud Pub/Sub delivers near-real-time notifications. The detection logic in `labCommPoller.js` is decoupled from the polling trigger so it can be invoked by either cron or a Pub/Sub webhook without modification.

### 2.6 Quota Considerations

Gmail API quota: 250 units per user per second, 1 billion units per day.

At 30-minute intervals with 20 active monitored threads: 20 × 5 units = 100 units per run, ~4,800 units per day. Well within quota at the expected scale of this business.

---

## 3. Thread Tracking Strategy

### 3.1 Core Concept

When the operator sends a laboratory email and confirms it in the system, they link the Gmail thread to the Order's `lab_interactions` entry. The agent monitors that thread for replies.

Linking is **optional but strongly encouraged.** If no thread is linked, deadline-based attention continues working normally. Thread linking adds a second, faster layer of detection.

### 3.2 Thread Contexts

Each monitored thread has one of two contexts:

| Context | What It Covers | What a Reply Means |
|---------|---------------|-------------------|
| `lab_interaction` | The complete communication chain for one `lab_interactions` version: initial request, any reminders, and the lab's eventual layout reply. All messages between the operator and lab for this iteration share one Gmail thread. | Lab sent a response — may be acknowledgment, question, or layout attachment |
| `lab_print_order` | The print instruction sent after client approval, and the lab's dispatch confirmation reply | Original document is on the way |

One `lab_interactions[n]` entry = one `lab_comm_threads` record = one Gmail thread.

When the operator sends a reminder (same Gmail thread as the original request), no new `lab_comm_threads` record is created. The existing record continues to monitor the same thread. The `reminder_count` and `last_reminder_at` fields on the `lab_interactions` entry capture reminder activity independently.

### 3.3 How Threads Are Linked

**Automatic linking (preferred):** After the operator records `LAB_REQUEST_SENT` or `LAB_PRINT_ORDER_SENT`, the UI presents a thread selector pre-filtered by `laboratory.laboratoryEmail`. The operator picks the thread. The thread ID is stored immediately and polling begins.

**Historical linking:** For threads sent before system deployment, the operator uses the historical search UI (available from day one — see Section 7.2). The operator finds the thread by subject, date range, or lab contact, and links it to the appropriate Order and `lab_interactions` version.

**Thread ID stored in two places:**
1. `lab_comm_threads` collection — for efficient cross-order polling queries
2. `orders.lab_interactions[n].gmail_thread_id` — for audit trail and direct access from the Order detail view

**SLA snapshot at link time:** When the thread is linked, `labCommService.linkThread()` reads `orders.laboratory.expectedLayoutDays` and `orders.laboratory.expectedOriginalDays` and stores them as `sla_layout_days` and `sla_original_days` on the new thread record. These values drive `timeout_at` computation and SLA-aware risk calculation. Snapshotting at link time ensures that subsequent changes to the order's laboratory SLA values do not retroactively alter the risk posture of an already-monitored thread.

### 3.4 Thread Lifecycle

```
Operator sends lab email
         │
         ▼
   Thread linked to Order
   lab_comm_threads: status = 'waiting'
   initialized_message_count = current count
         │
   ┌─────┴────────────────────────────┐
   │                                  │
   ▼                                  ▼
Reply detected                  No reply after timeout_at
(UNREAD message from lab)              │
   │                        ┌─────────┴──────────┐
   ▼                        ▼                    ▼
'replied'              'timed_out'         'unreachable'
Task: HIGH             Task: HIGH          Task: MEDIUM
"Lab replied —         "No lab reply —     "Thread error —
 check email"          deadline passed"     re-link or verify"
   │
   │ Operator completes task
   │ and records outcome in system
   ▼
'closed'
No further polling.
```

### 3.5 Link Modes

Each thread is created in one of two modes, which controls how the first poll is handled:

| Mode | When Used | Initialization | First Poll Behavior |
|------|-----------|---------------|---------------------|
| `live` | Thread linked at time of sending. Count should be 1 (only the operator's outbound message). | `initialized_message_count` = 1 | Normal — wait for count to exceed 1 |
| `historical` | Thread linked after the fact (pre-deployment, or operator forgot to link). Count may be > 1. | `initialized_message_count` = current count at link time | Create a review task: "Historical thread linked — verify current state manually" |

Historical mode prevents the agent from generating spurious "lab replied" tasks for replies that were already handled before the thread was linked.

---

## 4. Reply Detection

### 4.1 Detection Method — Primary and Secondary

**Primary detection (UNREAD label):**

1. Fetch the thread via `threads.get` with `format: 'metadata'`
2. For each message in the thread: check `labelIds` for `UNREAD`
3. Check `From` header: must not match operator email address
4. If an UNREAD message exists from a non-operator sender: qualifying reply detected

UNREAD detection is more reliable than message count because:
- It directly represents "arrived since operator last read inbox" — not a count that can drift
- It is unaffected by the operator sending follow-up messages in the same thread
- It does not require state comparison across poll runs to be meaningful

**Secondary detection (message count — fallback):**

If no UNREAD messages are found but `last_known_message_count` has increased since last poll, a secondary check runs. This catches cases where the operator read the email in Gmail but did not record the reply in the system (UNREAD was cleared by reading, but system was not updated).

Secondary detection creates a lower-priority task: *"Lab may have replied — email was read in Gmail but not recorded in system. Check and record."*

### 4.2 Auto-Reply Filtering

Before any task creation, apply these filters in order. If any filter matches, the message is logged but does not create a task:

| Filter | Rule |
|--------|------|
| Standard auto-reply header | `Auto-Submitted: auto-replied` header present |
| X-Autoreply header | `X-Autoreply: yes` header present |
| Subject prefix | Subject starts with `Auto:`, `Automatic reply:`, `Out of office:`, `Re: Auto` |
| No-reply sender | From address contains `noreply`, `no-reply`, `donotreply`, `mailer-daemon` |
| Empty content | Message body is empty AND no attachments |

Filtered messages are recorded in the `auto_reply_count` field on the thread record. They do not generate tasks. Thread status remains `waiting`.

### 4.3 Attachment Detection

When a qualifying reply is detected, check each new message's parts for attachments:

- Any message part with `filename` attribute set
- MIME types: `application/pdf`, `image/jpeg`, `image/png`, `image/tiff`

Attachment detection does not download the file. It sets `reply_has_attachment = true` on the thread record and escalates task priority to `HIGH`.

### 4.4 Historical Thread Initialization

When a thread is linked in `historical` mode:

1. `initialized_message_count` is set to the current message count at link time.
2. A review task is created immediately (type `manual`, priority `MEDIUM`): *"Historical thread linked to Order — verify current state and close if already resolved."*
3. On subsequent polls: only messages arriving AFTER the link time are evaluated for reply detection. Messages with timestamps before `linked_at` are ignored.
4. The operator must mark the review task as done before the thread transitions to normal `waiting` monitoring.

### 4.5 Timeout Thresholds

`timeout_at` is computed at link time using this priority order. First available value wins:

| Priority | `lab_interaction` context | `lab_print_order` context |
|----------|--------------------------|--------------------------|
| 1 — Operator deadline | `deadlines.lab_response_due` (if set) | `deadlines.original_expected` (if set) |
| 2 — SLA-derived | `sent_at + sla_layout_days` | `sent_at + sla_original_days` |
| 3 — System default | `sent_at + LAB_COMM_DEFAULT_LAYOUT_SLA_DAYS` | `sent_at + LAB_COMM_DEFAULT_ORIGINAL_SLA_DAYS` |
| 4 — No timeout | `null` — thread monitored indefinitely | `null` |

The system always populates `timeout_at` when SLA defaults are configured in `constants.js`. A `null` value only occurs when `sent_at` is absent and both SLA snapshot and system defaults are missing.

**Operator-set deadlines always take precedence.** An explicit deadline from the Order's `deadlines.*` object overrides any SLA-derived value. SLA exists to provide a deadline when the operator has not set one, not to override the operator's judgment.

When the operator sets or updates `deadlines.lab_response_due` or `deadlines.original_expected` (via a new `ORDER_DEADLINE_SET` event), the `orderService` recalculates and updates `timeout_at` on all associated `waiting` or `timed_out` threads for that order at the same time.

---

## 5. MongoDB Collections

### 5.1 `lab_comm_threads` Collection

This is the fourth MongoDB collection, added by the Laboratory Communication Agent.

**Rationale for a separate collection:** The polling engine must efficiently query all `waiting` threads regardless of which Order they belong to. This cross-order query is expensive on embedded arrays. Thread operational state (poll timestamps, error counts, initialization metadata) has no business meaning in the Order's event history and has an independent lifecycle.

| Field | Type | Required | Purpose |
|-------|------|----------|---------|
| `_id` | ObjectId | Yes | System identifier |
| `order_id` | ObjectId | Yes | The Order this thread is monitoring |
| `thread_id` | String | Yes | Gmail thread ID — used in all API calls |
| `context` | String | Yes | `lab_interaction` or `lab_print_order` |
| `lab_interaction_version` | Number | No | Which `lab_interactions` entry version this thread covers |
| `recipient_email` | String | Yes | Email address of the laboratory. Set at link time. Never updated. |
| `status` | String | Yes | `waiting`, `replied`, `timed_out`, `unreachable`, `closed`, `unlinked` |
| `link_mode` | String | Yes | `live` or `historical` — controls first-poll behavior |
| `linked_at` | Date | Yes | When the thread was linked to this Order |
| `sent_at` | Date | No | When the operator sent the originating email |
| `sla_layout_days` | Number | No | Snapshot of `laboratory.expectedLayoutDays` at link time. Used for `timeout_at` and SLA-aware risk. Null if lab has no SLA configured. |
| `sla_original_days` | Number | No | Snapshot of `laboratory.expectedOriginalDays` at link time. Used for `timeout_at` on `lab_print_order` threads. Null if lab has no SLA configured. |
| `initialized_message_count` | Number | Yes | Message count at the moment of linking. Baseline for detection. |
| `last_checked_at` | Date | No | When the poller last fetched this thread from Gmail API |
| `last_known_message_count` | Number | Yes | Message count at last poll — secondary detection fallback |
| `auto_reply_count` | Number | Yes | Count of filtered auto-replies detected (default: 0) |
| `reply_detected_at` | Date | No | When the first qualifying reply was detected |
| `reply_has_attachment` | Boolean | No | Whether the detected reply contains at least one attachment |
| `reply_sender` | String | No | From address of the detected reply (for display) |
| `timeout_at` | Date | No | When this thread should be considered timed out |
| `error_count` | Number | Yes | Consecutive API errors on this thread (default: 0) |
| `last_error_at` | Date | No | When the most recent API error occurred |
| `last_error_message` | String | No | Last error message for diagnostics |
| `created_at` | Date | Yes | When this record was created (default: Date.now) |

**Status values:**

| Status | Meaning |
|--------|---------|
| `waiting` | Thread sent; no qualifying reply detected yet |
| `replied` | Qualifying reply detected; operator task created |
| `timed_out` | `timeout_at` passed with no qualifying reply |
| `unreachable` | Thread returned 404 three consecutive times |
| `closed` | Thread monitoring ended normally (task completed, outcome recorded) |
| `unlinked` | Operator removed the link (data correction). Can be relinked. |

**Indexes on `lab_comm_threads`:**

| Index | Fields | Options | Reason |
|-------|--------|---------|--------|
| Primary | `_id` | — | Default |
| Polling query | `{ status: 1, last_checked_at: 1 }` | — | Poller fetches `waiting` threads sorted by least-recently-checked |
| Order lookup | `{ order_id: 1 }` | — | Order detail view loads all threads for an order |
| Thread identity | `{ thread_id: 1 }` | unique | One thread record per thread ID (within a running monitoring lifecycle) |
| Timeout scan | `{ status: 1, timeout_at: 1 }` | sparse | Scheduled scan for timed-out threads |
| Recipient lookup | `{ recipient_email: 1, status: 1 }` | — | Dashboard grouping by laboratory (see Section 9) |

**Uniqueness note:** The unique index on `thread_id` enforces that the same Gmail thread cannot be monitored twice simultaneously. `unlinked` and `closed` records are excluded from this constraint because a thread may be unlinked and re-linked (the old record has status `unlinked`; the new record is a fresh document with the same `thread_id`). The unique index must be a partial index: `{ thread_id: 1 }` where `status NOT IN ['unlinked', 'closed']`.

### 5.2 Order Schema Extensions

These fields are added to the existing `orders` collection. All are optional. Existing Order documents without these fields continue to work without migration.

**`laboratory` embedded object — new fields:**

| Field | Type | Purpose |
|-------|------|---------|
| `laboratory.expectedLayoutDays` | Number | How many days this laboratory typically takes to deliver a layout draft. Drives `timeout_at` on `lab_interaction` threads when no explicit deadline is set. Set by the operator when assigning the lab to an order. |
| `laboratory.expectedOriginalDays` | Number | How many days this laboratory typically takes to produce and dispatch the original document after receiving a print order. Drives `timeout_at` on `lab_print_order` threads. |

Both fields are optional. If absent, `timeout_at` falls back to the system default constants (`LAB_COMM_DEFAULT_LAYOUT_SLA_DAYS`, `LAB_COMM_DEFAULT_ORIGINAL_SLA_DAYS`).

**`client` embedded object — new fields:**

| Field | Type | Purpose |
|-------|------|---------|
| `client.email` | String | Client's email address. Optional. Used for order search. Not used for Gmail tracking. |
| `client.companyName` | String | Company or organization name. Optional. Used for order search. |

**`lab_interactions[n]` — new fields:**

| Field | Type | Purpose |
|-------|------|---------|
| `gmail_thread_id` | String | Gmail thread ID of the lab communication thread for this version |
| `gmail_linked_at` | Date | When this thread was linked to this lab_interactions entry |

**`layouts[n]` — no changes.** The previously proposed `gmail_thread_id` on layouts is removed because client email tracking is not in scope.

**New indexes on `orders`:**

| Index | Fields | Options | Reason |
|-------|--------|---------|--------|
| Client name search | `{ 'client.name': 1 }` | collation: `{ locale: 'en', strength: 2 }` | Case-insensitive name search |
| Company name search | `{ 'client.companyName': 1 }` | collation: `{ locale: 'en', strength: 2 }` | Company search |
| Client email search | `{ 'client.email': 1 }` | sparse | Email lookup |
| Lab name search | `{ 'laboratory.laboratoryName': 1 }` | sparse | Dashboard grouping by lab name |
| Lab email search | `{ 'laboratory.laboratoryEmail': 1 }` | sparse | Thread selector pre-filter |

---

## 6. Order and Thread Search

### 6.1 Why Search Is Required

The Laboratory Communication Agent creates two situations where the operator needs to search for an Order by something other than phone:

1. **Thread linking:** The operator is looking at a Gmail thread from a lab and needs to find which Order it belongs to. The lab email identifies the lab, not the client. The operator must search by client name or company.
2. **Historical linking at go-live:** The operator has active Orders from before the system was deployed. They need to find the right Order to link a historical thread to.

### 6.2 Order Search API

`GET /api/orders/search`

Query parameters (all optional, at least one required):

| Parameter | Searches | MongoDB Query |
|-----------|---------|---------------|
| `name` | `client.name` | Case-insensitive regex |
| `company` | `client.companyName` | Case-insensitive regex |
| `phone` | `client.phone` | Exact or prefix match |
| `email` | `client.email` | Case-insensitive exact match |
| `status` | `status` | Enum match (optional filter) |

Response: array of Order summaries — `_id`, `status`, `client.name`, `client.companyName`, `client.phone`, `laboratory.laboratoryName`, `created_at`.

Maximum 50 results. No pagination in V1.

### 6.3 Gmail Thread Search API

`GET /api/integrations/gmail/search-threads`

Query parameters:

| Parameter | Purpose |
|-----------|---------|
| `q` | Gmail search query string passed directly to `users.threads.list`. Supports any Gmail search syntax: `from:`, `to:`, `subject:`, `after:`, `before:`, `has:attachment`. |
| `maxResults` | Maximum threads to return (default: 20, max: 50) |

Response: array of thread summaries — `threadId`, `subject`, `from`, `to`, `date`, `messageCount`, `hasAttachment`, `isAlreadyLinked` (boolean, set if `thread_id` exists in `lab_comm_threads` with active status).

This endpoint is available from Phase L1 (Foundation). It handles both live thread selection (operator just sent email and is linking it) and historical import (operator searching back through months of Gmail).

**Common queries the operator will use:**

| Use Case | Gmail Query |
|----------|-------------|
| Find threads to a specific lab | `to:lab@labname.com` |
| Find threads from a lab | `from:lab@labname.com` |
| Find threads about a client | `subject:ClientName` |
| Find old threads with attachments | `from:lab@labname.com has:attachment before:2026/01/01` |

---

## 7. Risk Classification

### 7.1 Design Principle

Risk is **computed at read time**, not stored. Computing it at read time means it is always current — no stale risk flags, no background jobs to update it, no possibility of stored risk diverging from actual state.

The risk computation takes as inputs:
- Thread `status`, `reply_detected_at`, `timeout_at`, `sent_at`, `error_count`, `context`
- Thread `sla_layout_days`, `sla_original_days` (SLA snapshots — taken from Order at link time, not re-read live)
- Order `deadlines.*` (current deadline values, used to detect explicit-deadline vs SLA-derived `timeout_at`)
- Current timestamp

### 7.2 Risk Levels

| Level | Color Code | Meaning |
|-------|-----------|---------|
| `CRITICAL` | Red | Immediate action required. Order is blocked or communication has failed. |
| `HIGH` | Orange | Action required today. Deadline is close or reply has been waiting. |
| `MEDIUM` | Yellow | Action required soon. Situation is deteriorating but not yet critical. |
| `LOW` | Grey | Within normal parameters. No immediate action needed. |

### 7.3 Risk Computation Rules for `lab_comm_threads`

Rules are evaluated in order. First match wins.

| Risk Level | Condition |
|------------|-----------|
| `CRITICAL` | Thread `status = 'unreachable'` AND `error_count >= GMAIL_MAX_CONSECUTIVE_ERRORS` |
| `CRITICAL` | Thread `status = 'timed_out'` AND deadline is 3+ days past |
| `CRITICAL` | Thread `status = 'replied'` AND `reply_detected_at` is 48h+ ago (unactioned) |
| `HIGH` | Thread `status = 'timed_out'` AND deadline is 1–2 days past |
| `HIGH` | Thread `status = 'replied'` AND `reply_detected_at` is 12–48h ago |
| `HIGH` | Thread `status = 'replied'` AND `reply_has_attachment = true` (regardless of age) |
| `HIGH` | Thread `status = 'waiting'` AND deadline is tomorrow |
| `MEDIUM` | Thread `status = 'replied'` AND `reply_detected_at` is < 12h ago |
| `MEDIUM` | Thread `status = 'waiting'` AND deadline is 2–4 days away |
| `MEDIUM` | Thread `status = 'timed_out'` AND deadline passed today |
| `LOW` | Thread `status = 'waiting'` AND deadline is 5+ days away |
| `LOW` | Thread `status = 'waiting'` AND no deadline set yet |

**SLA-aware rules** (evaluated independently; apply only when `sla_layout_days` is set and context = `lab_interaction`)

These rules fire based on elapsed waiting time relative to the lab's SLA — even when an explicit operator deadline has not been reached yet. They signal that the lab is performing outside their expected pattern, regardless of the operator's deadline choice.

| Risk Level | Condition |
|------------|-----------|
| `CRITICAL` | `status = 'waiting'` AND `(now − sent_at) > sla_layout_days × 1.5` days |
| `HIGH` | `status = 'waiting'` AND `(now − sent_at) > sla_layout_days × 1.0` days |
| `MEDIUM` | `status = 'waiting'` AND `(now − sent_at) ≥ sla_layout_days × 0.8` days |

The final thread risk is `MAX(deadline_based_risk, sla_based_risk)`. SLA rules do not apply when `sla_layout_days` is null.

**Dashboard display for SLA status:**

Every `lab_interaction` thread in the WAITING FOR LAB section shows an SLA indicator when `sla_layout_days` is set:
- `"SLA exceeded (5d / 3d SLA)"` — waiting time exceeds SLA
- `"SLA: 2d left (1d / 3d SLA)"` — within SLA, N days remaining
- `"1d waiting / 5d SLA"` — well within SLA, minimal concern

### 7.4 Risk Computation for Orders

An Order's laboratory communication risk is the highest risk level across all its active `lab_comm_threads` records.

```
order.labCommRisk = MAX(risk of each waiting/replied/timed_out thread for this order)
```

This is a virtual field — not stored in MongoDB. Computed by `labCommService.computeOrderRisk(orderId)` which is called by the dashboard API endpoint.

### 7.5 Risk in API Responses

Every endpoint that returns an Order or a thread in a dashboard context includes the computed risk level:

```
orders.labCommRisk: 'HIGH'
lab_comm_threads[n].risk: 'HIGH'
```

The `labCommService` exposes a `computeThreadRisk(thread, order)` function used by all dashboard and detail view endpoints.

---

## 8. Dashboard Design

### 8.1 Four Questions

The Laboratory Communications dashboard panel must be able to answer these four questions at a glance:

| Question | Dashboard Section | Source |
|----------|------------------|--------|
| Which laboratories are waiting for me? | WAITING FOR ME | Threads with `status = 'replied'` + open task |
| Which laboratories am I waiting for? | WAITING FOR LAB | Threads with `status = 'waiting'` |
| Which orders are overdue? | OVERDUE | Threads with `status = 'timed_out'` OR `deadline < today` with no reply |
| Which communications require attention? | REQUIRES ATTENTION | Threads with `status = 'unreachable'` OR errors OR secondary detection flags |

### 8.2 Laboratory Communications Panel

This is a new dashboard panel, separate from the general task attention panel. Both panels are visible simultaneously. The task panel remains the action driver; the communications panel provides the communication-state overview.

```
┌──────────────────────────────────────────────────────────────────┐
│  LABORATORY COMMUNICATIONS                                        │
│                                                                   │
│  WAITING FOR ME [2]          WAITING FOR LAB [4]                 │
│  ──────────────────          ──────────────────                  │
│  ● CRITICAL  Smirnov, A.     ● CRITICAL  Petrov, I.             │
│    Lab replied 2d ago           SLA exceeded (5d / 3d SLA)       │
│    [Lab A] ✉ attachment         [Lab A]                          │
│                                                                   │
│  ○ HIGH  Fedorov, B.          ○ HIGH  Kozlov, M.                │
│    Lab replied 14h ago           Due tomorrow                    │
│    [Lab B]                       [Lab B]                         │
│                                                                   │
│                               ○ MED   Ivanov, S.                │
│                                  SLA: 1d left (2d / 3d SLA)     │
│                                  [Lab A]                         │
│                                                                   │
│                               ○ LOW   Novak, R.                 │
│                                  1d waiting / 5d SLA             │
│                                  [Lab C]                         │
│                                                                   │
│  OVERDUE [1]                 REQUIRES ATTENTION [1]              │
│  ──────────────              ──────────────────────              │
│  ● CRITICAL  Kuznets, V.    ○ MED  Belov, D.                    │
│    Deadline 5d ago            Thread unreachable (3 errors)      │
│    [Lab C]                    [Lab A]                            │
└──────────────────────────────────────────────────────────────────┘
```

Each card shows:
- Risk indicator (`●` CRITICAL/HIGH, `○` MEDIUM/LOW)
- Client name
- Lab name in brackets
- Thread age or deadline distance
- SLA status line for WAITING FOR LAB cards when `sla_layout_days` is set: `"SLA exceeded"`, `"SLA: Nd left"`, or `"Nd waiting / Nd SLA"`
- Attachment flag (`✉ attachment`) on any WAITING FOR ME card with `reply_has_attachment = true`

### 8.3 Grouping by Laboratory

The "WAITING FOR LAB" section supports a secondary view: **grouped by laboratory**. When two orders both use Lab A, they appear under a single Lab A header:

```
WAITING FOR LAB — BY LABORATORY

  Lab A (labA@example.com)
    ○ HIGH   Petrov, I.    due tomorrow
    ○ LOW    Ivanov, S.    4 days left

  Lab B (labB@example.com)
    ○ MED    Kozlov, M.    2d waiting
```

This view is supported by the `{ recipient_email: 1, status: 1 }` index on `lab_comm_threads`. It answers: "What do I need to follow up on with Lab A today?"

### 8.4 API Endpoints for Dashboard

| Method | Path | Returns |
|--------|------|---------|
| `GET` | `/api/lab-comm/dashboard` | All 4 sections with risk levels, grouped by section |
| `GET` | `/api/lab-comm/dashboard?groupBy=lab` | Same but WAITING_FOR_LAB section grouped by `recipient_email` |
| `GET` | `/api/lab-comm/dashboard?risk=CRITICAL,HIGH` | Filter to specific risk levels |

### 8.5 Sort Order Within Sections

Within each dashboard section, threads are sorted:
1. Risk level descending: `CRITICAL → HIGH → MEDIUM → LOW`
2. Within same risk level: by age descending (oldest first — most neglected gets priority)

"Age" means:
- WAITING FOR ME: `(now - reply_detected_at)` — how long the reply has been sitting
- WAITING FOR LAB: `(now - linked_at)` — how long the operator has been waiting
- OVERDUE: `(now - timeout_at)` — how far past the deadline
- REQUIRES ATTENTION: `(now - last_error_at)` or `(now - reply_detected_at)`

### 8.6 Integration with Existing Task Panel

The existing task-based attention panel (OVERDUE, DUE_TODAY, ACTION_NEEDED, DEBT, STALE, TASKS) continues to work unchanged. The Laboratory Communications panel is **additive** — it does not replace the task panel.

Relationship between the two panels:
- Task panel: *what do I need to do?* (action-oriented)
- Lab Communications panel: *what is the state of each lab communication?* (state-oriented)

A `replied` thread appears in both: as "WAITING FOR ME" in the communications panel, and as an open `remind_lab` task in the task panel.

---

## 9. Automatic Task Creation Rules

All task creation goes through `taskService.createTask()` and respects the same deduplication rules as scheduler-generated tasks.

### 9.1 Reply Detected — Lab Interaction Thread

| Condition | Task Type | Risk | Priority | Description |
|-----------|-----------|------|----------|-------------|
| Qualifying reply, no attachment | `remind_lab` | HIGH | high | "Lab replied — check email and record response" |
| Qualifying reply, attachment detected | `remind_lab` | HIGH | high | "Lab replied with attachment — download layout and record in system" |
| Secondary detection (count increased, no UNREAD) | `manual` | MEDIUM | medium | "Lab may have replied — email was read in Gmail but not recorded. Check and record." |

### 9.2 Reply Detected — Print Order Thread

| Condition | Task Type | Risk | Priority | Description |
|-----------|-----------|------|----------|-------------|
| Qualifying reply | `remind_lab` | MEDIUM | medium | "Lab confirmed print order — check for dispatch details" |
| Reply with attachment | `remind_lab` | HIGH | high | "Lab sent dispatch notification with attachment — check and record" |

### 9.3 Thread Timeout

| Condition | Task Type | Risk | Priority | Description |
|-----------|-----------|------|----------|-------------|
| `lab_interaction` deadline passed, no reply | `remind_lab` | HIGH | high | "Lab overdue — deadline passed; send reminder" |
| `lab_print_order` deadline passed, no reply | `remind_lab` | HIGH | high | "No dispatch confirmation from lab — follow up" |

If a `remind_lab` task already exists for the order from the deadline scanner, the description is updated to note the thread timeout. No duplicate task created.

### 9.4 Thread Errors

| Condition | Task Type | Risk | Priority | Description |
|-----------|-----------|------|----------|-------------|
| `error_count >= GMAIL_MAX_CONSECUTIVE_ERRORS` | `manual` | CRITICAL | high | "Lab thread unreachable — re-link or verify manually" |
| Gmail auth failure | `manual` | CRITICAL | high | "Gmail authentication failed — re-authorize Google account" |
| Historical thread linked | `manual` | MEDIUM | medium | "Historical thread linked — verify current state and close if already resolved" |

### 9.5 New Event Codes

**Order-level events** (added to `WORKFLOW_EVENTS.md` Category 6):

| Event Code | Description | Trigger | Actor |
|------------|-------------|---------|-------|
| `LAB_THREAD_LINKED` | A Gmail thread was linked to a lab_interactions entry for monitoring | Operator links thread | operator |
| `LAB_THREAD_REPLY_DETECTED` | A qualifying reply was detected. Sender and attachment flag recorded in description. | Lab Comm Poller | system |
| `LAB_THREAD_ATTACHMENT_DETECTED` | A reply in a monitored lab thread contains one or more attachments | Lab Comm Poller | system |
| `LAB_THREAD_TIMED_OUT` | A monitored lab thread reached its timeout without a detected reply | Lab Comm Poller | system |
| `LAB_THREAD_CLOSED` | A monitored lab thread was closed after outcome was recorded | Operator | system |

**Global operational events** (server log only):

| Event Code | Description |
|------------|-------------|
| `SYS_LAB_COMM_POLL_COMPLETED` | Poll run completed. Threads checked, replies detected, tasks created counts logged. |
| `SYS_LAB_COMM_AUTH_ERROR` | Gmail API authentication failed. Token may need refresh. |
| `SYS_LAB_COMM_RATE_LIMITED` | Gmail API returned 429. Poller backed off. |

---

## 10. Failure Scenarios

### 10.1 Gmail API Authentication Failure

**Cause:** OAuth2 refresh token expired, revoked, or Google account password changed.

**Response:**
1. All polling stops immediately.
2. `SYS_LAB_COMM_AUTH_ERROR` logged.
3. `manual` CRITICAL task created: *"Gmail authentication failed — re-authorize Google account."*
4. Polling resumes after re-authorization is confirmed.

---

### 10.2 Thread Deleted or 404

**Cause:** Operator permanently deletes a Gmail thread, or Gmail archives it in a way that makes it inaccessible.

**Response:**
1. `error_count` incremented.
2. After `GMAIL_MAX_CONSECUTIVE_ERRORS` consecutive 404s: status → `unreachable`, `manual` CRITICAL task created.
3. Order data is unaffected. The `lab_comm_threads` record is retained as audit history.

---

### 10.3 Lab Replies from Unexpected Email Address

**Cause:** Lab's reply comes from a different address than `recipient_email`. The monitored thread receives no reply, because the reply is a new thread.

**Detection:** Thread times out normally. Deadline scanner fires independently.

**Mitigation:**
1. Deadline-based attention still fires on schedule.
2. Operator sees the missed reply, uses the historical search to find it, and links it.
3. Going forward: update `laboratory.laboratoryEmail` so future thread selector pre-filters correctly.

---

### 10.4 Auto-Reply False Positive

**Cause:** Lab has a custom OOO format that passes all auto-reply filters.

**Response:** Task created. Operator opens Gmail, sees it is OOO, dismisses the task. Thread status remains `waiting` — monitoring continues.

**Mitigation:** Auto-reply filter subject patterns are configurable in `constants.js`. The operator can add lab-specific OOO patterns.

---

### 10.5 API Rate Limit

**Cause:** Unusual spike in active threads or shared quota usage.

**Response:**
1. `SYS_LAB_COMM_RATE_LIMITED` logged.
2. Exponential backoff: 30s → 60s → 120s.
3. After 3 consecutive rate-limited runs: `manual` task created.

**Prevention:** Batch polling with `GMAIL_BATCH_DELAY_MS` between calls. At run start, project call volume; defer non-urgent threads if volume exceeds 80% of available quota.

---

### 10.6 Multiple Orders at the Same Laboratory

**Cause:** Two active Orders use the same lab. Lab replies to Order A's thread but operator accidentally links the reply to Order B.

**Prevention:** The thread selector shows `isAlreadyLinked: true` for any thread already linked to another order. The linking UI warns: *"This thread is already linked to [Client Name] — Order #XXX. Are you sure?"*

The partial unique index prevents the same thread from being linked to two orders simultaneously (while status is active). A clear validation error is returned to the UI if attempted.

---

### 10.7 Wrong Thread Linked to Order

**Cause:** Operator links the wrong Gmail thread to an Order. The unique index doesn't catch this — it only prevents same-thread-to-two-orders.

**Recovery:**
1. Operator navigates to Order detail → Email Threads section.
2. Clicks "Unlink" on the incorrect thread.
3. Thread status → `unlinked`. No task is generated; `LAB_THREAD_CLOSED` event is NOT fired (unlink is a data correction, not a closure).
4. Operator links the correct thread. A new `lab_comm_threads` record is created.

The partial unique index allows the same `thread_id` to appear in `unlinked` and a new `waiting` record simultaneously, because the uniqueness constraint covers only active statuses.

---

### 10.8 Historical Threads — Message Count Already > 1

**Cause:** Operator links a historical thread where the lab already replied. `initialized_message_count = 2` (request + reply). The operator already handled the reply before the system was deployed.

**Response:**
1. Thread linked in `historical` mode.
2. `initialized_message_count` = 2.
3. On first poll: current count = 2. No new messages. No reply task.
4. Review task created: *"Historical thread linked — verify current state and close if already resolved."*
5. Operator confirms everything is resolved → marks review task done → thread → `closed`.

If the lab sends a NEW reply after the historical thread is linked (count increases to 3), the agent detects it normally.

---

## 11. Future AI Extensions

These extensions are anticipated but out of scope for the current implementation. Documented to ensure the present design does not block them.

### 11.1 Reply Intent Classification

When a `lab_interaction` reply is detected, pass the email body to Claude to classify intent: `layout_sent`, `question_asked`, `delay_notified`, `unclear`.

**Boundary:** Advisory only. Operator confirms before recording.

### 11.2 Deadline Extraction from Lab Reply

When the lab replies confirming receipt and mentions a delivery date, Claude extracts it and suggests it as `lab_response_due`.

**Boundary:** Suggestion only. One click to confirm or dismiss.

### 11.3 Correction Instruction Drafting

Operator clicks "Draft correction email to lab." Claude generates a draft from the client's correction notes. Operator reviews, edits, copies into Gmail manually, and confirms it was sent.

**Boundary:** Draft text only. System never sends via API.

### 11.4 Lab Response Pattern Analysis

Claude analyzes historical thread data across multiple orders for a given lab to estimate typical turnaround times. System suggests a realistic deadline when the operator records a new lab request.

**Boundary:** Suggestion only. Operator sets the deadline.

### 11.5 Real-Time Push Notifications

Replace polling with Gmail push via Google Cloud Pub/Sub. Detection logic in `labCommPoller.js` is invoked by a Pub/Sub webhook instead of a cron trigger. Zero impact on thread records or detection logic.

---

## 12. Implementation Roadmap

Phases are numbered L1–L5 (L for Laboratory Communication Agent) following the V1 Phase 1–8 numbering convention. These phases execute after V1 is complete.

---

### Phase L1 — Foundation

**Objective:** Schema extensions, Gmail API connectivity, thread model, historical search, and link/unlink API. No active monitoring yet.

**Order Schema Extensions**

| Change | Fields | Type |
|--------|--------|------|
| Add to `client` | `email`, `companyName` | String, optional |
| Add to `lab_interactions[n]` | `gmail_thread_id`, `gmail_linked_at` | String, Date, optional |
| Add indexes | See Section 5.2 | — |

**Files to Create**

| File | Purpose |
|------|---------|
| `src/models/LabCommThread.js` | Mongoose schema for `lab_comm_threads` as defined in Section 5.1 |
| `src/integrations/gmailClient.js` | Thin wrapper: `getThread()`, `listThreads()`, `getMessage()`, quota backoff |
| `src/services/labCommService.js` | `linkThread()`, `unlinkThread()`, `closeThread()`, `getThreadsForOrder()`, `computeThreadRisk()`, `computeOrderRisk()` |

**API Endpoints**

| Method | Path | Action |
|--------|------|--------|
| `POST` | `/api/orders/:id/lab-interactions/:version/lab-thread` | Link a Gmail thread to a lab_interactions entry |
| `DELETE` | `/api/orders/:id/lab-threads/:threadId` | Unlink a thread (status → `unlinked`) |
| `GET` | `/api/orders/:id/lab-threads` | List all threads for an order with status and risk |
| `GET` | `/api/integrations/gmail/search-threads` | Search Gmail threads by query string (historical and live) |
| `GET` | `/api/orders/search` | Search orders by name, company, phone, email |

**Acceptance Criteria**

- Thread can be linked to a `lab_interactions` entry in both `live` and `historical` modes
- `historical` mode creates an immediate review task
- `search-threads` returns results with `isAlreadyLinked` flag
- `orders/search` searches across all four fields with partial match
- Unlink sets status to `unlinked`, not `closed`
- Same thread cannot be linked to two orders simultaneously (partial unique index enforced with clear UI error)
- `laboratory.expectedLayoutDays` and `laboratory.expectedOriginalDays` are accepted on Order create and update operations; absent values are treated as null (no SLA configured)
- `sla_layout_days` and `sla_original_days` are snapshotted correctly from `orders.laboratory` at link time; they do not change if the order's laboratory SLA is updated later
- `timeout_at` follows the priority: operator deadline → SLA-derived → system default; null only when `sent_at` is absent and no SLA or default is available
- Risk computation returns correct levels for all 12 deadline-based conditions
- SLA-aware risk rules fire correctly when `sla_layout_days` is set and `context = 'lab_interaction'`
- SLA risk rules do not fire when `sla_layout_days` is null (graceful absence)
- `computeEffectiveDeadline()` returns the correct value for all four priority cases

---

### Phase L2 — Polling Engine

**Objective:** Active reply detection, auto-reply filtering, task creation.

**Files to Create**

| File | Purpose |
|------|---------|
| `src/integrations/labCommPoller.js` | Poll loop: iterate `waiting` threads, call `checkThread()`, create tasks |
| `src/scheduler/index.js` | Extended to register lab comm poll cron |

**Detection Logic per Thread**

1. Fetch thread with `format: 'metadata'`
2. PRIMARY: find messages with `UNREAD` label where `From` ≠ operator email
3. Apply auto-reply filters (Section 4.2)
4. If qualifying UNREAD: mark `replied`, create task, check attachments
5. SECONDARY: if no UNREAD but `messageCount > last_known_message_count`: secondary detection task
6. Update `last_checked_at` and `last_known_message_count`

**`constants.js` additions**

| Constant | Default | Purpose |
|----------|---------|---------|
| `LAB_COMM_POLL_CRON` | `"*/30 * * * *"` | Poll interval |
| `LAB_COMM_POLL_TIMEZONE` | Same as `SCHEDULER_TIMEZONE` | Timezone |
| `LAB_COMM_MAX_CONSECUTIVE_ERRORS` | `3` | Errors before `unreachable` |
| `LAB_COMM_BATCH_DELAY_MS` | `200` | Delay between API calls |
| `LAB_COMM_ATTACHMENT_MIMETYPES` | `['application/pdf','image/jpeg','image/png','image/tiff']` | Attachment types |
| `LAB_COMM_AUTO_REPLY_SUBJECTS` | `['Auto:','Automatic reply:','Out of office:']` | Configurable OOO prefixes |

**Acceptance Criteria**

- Poll logs `SYS_LAB_COMM_POLL_COMPLETED` with thread counts and reply counts
- UNREAD message from lab → exactly one `remind_lab` task (deduplication verified)
- Attachment → `reply_has_attachment = true`, HIGH priority task
- Auto-reply → `auto_reply_count` incremented, no task
- Secondary detection → `manual` MEDIUM task with distinct description
- Concurrent poll prevention: second trigger skipped and logged

---

### Phase L3 — Timeout Detection and Risk

**Objective:** Thread timeout logic and risk level computation across all endpoints.

**Timeout Scan**

Added to end of each poll run:
1. Query `lab_comm_threads` where `status = 'waiting'` AND `timeout_at <= now`
2. For each: `status → 'timed_out'`, fire `LAB_THREAD_TIMED_OUT`, create task
3. Respect deduplication with existing deadline-overdue tasks

**Risk Integration**

`labCommService.computeThreadRisk()` is wired into:
- `GET /api/orders/:id/lab-threads` response
- `GET /api/orders/:id` response (summary `labCommRisk` field)
- All dashboard endpoints

**Acceptance Criteria**

- Thread past `timeout_at` is marked `timed_out` within one poll
- No duplicate task when deadline-overdue task already exists
- Every thread API response includes `risk` field
- Every order summary response includes `labCommRisk` field

---

### Phase L4 — Dashboard Integration

**Objective:** Laboratory Communications panel with 4 questions answered.

**New API Endpoints**

| Method | Path | Returns |
|--------|------|---------|
| `GET` | `/api/lab-comm/dashboard` | 4 sections: WAITING_FOR_ME, WAITING_FOR_LAB, OVERDUE, REQUIRES_ATTENTION |
| `GET` | `/api/lab-comm/dashboard?groupBy=lab` | WAITING_FOR_LAB grouped by `recipient_email` |

**Frontend Changes**

- New Laboratory Communications panel on dashboard (above or alongside existing attention panel)
- Risk indicators on each card: `●` CRITICAL/HIGH, `○` MEDIUM/LOW
- Thread age display: "Lab replied 2h ago", "Waiting 4d"
- Attachment flag: explicit label "has attachment" on any replied thread with `reply_has_attachment = true`
- By-laboratory group toggle in WAITING FOR LAB section

**Acceptance Criteria**

- Dashboard panel loads in under 500ms for up to 50 active threads
- All 4 sections populated correctly from live `lab_comm_threads` data
- Risk levels match Section 7.3 computation rules
- Sort order within sections matches Section 8.5
- Existing task attention panel is unaffected

---

### Phase L5 — Thread Linking UI

**Objective:** Frictionless thread linking during normal workflow.

**UI Integration Points**

1. After recording `LAB_REQUEST_SENT`: display thread selector pre-filtered by `laboratory.laboratoryEmail`, showing recent outbound threads. Toggle to show inbound threads from same address.
2. After recording `LAB_PRINT_ORDER_SENT`: same selector, context = `lab_print_order`.
3. On Order detail view: "Link historical thread" option under Email Threads section, opens full search UI.
4. Thread selector shows `isAlreadyLinked` warning for threads already linked to other orders.
5. Unlink button visible on any `waiting` or `replied` thread in the Email Threads section.

**Acceptance Criteria**

- Thread selector loads within 2 seconds
- `isAlreadyLinked` warning shown before operator can proceed
- Historical search supports free-form Gmail query syntax
- Unlinking a thread sets status to `unlinked` and shows confirmation
- If operator skips linking, workflow continues normally

---

### Phase Summary

| Phase | Scope | Key Deliverable |
|-------|-------|----------------|
| L1 | Foundation | Model, search APIs, link/unlink, Order schema |
| L2 | Polling Engine | UNREAD-primary detection, task creation |
| L3 | Timeout + Risk | Timeout scan, computed risk on all endpoints |
| L4 | Dashboard | 4-question communications panel |
| L5 | Linking UI | Thread selector, historical search UI |

Phases L1–L3 are backend-only and testable via API without frontend work.

---

## Appendix A — Configuration Reference

| Constant | Default | Description |
|----------|---------|-------------|
| `LAB_COMM_POLL_CRON` | `"*/30 * * * *"` | Cron expression for poll interval |
| `LAB_COMM_POLL_TIMEZONE` | `SCHEDULER_TIMEZONE` | Timezone for poll schedule |
| `LAB_COMM_MAX_CONSECUTIVE_ERRORS` | `3` | Errors before thread marked unreachable |
| `LAB_COMM_BATCH_DELAY_MS` | `200` | Milliseconds between successive API calls |
| `LAB_COMM_ATTACHMENT_MIMETYPES` | `['application/pdf','image/jpeg','image/png','image/tiff']` | MIME types treated as layout attachments |
| `LAB_COMM_AUTO_REPLY_SUBJECTS` | `['Auto:','Automatic reply:','Out of office:']` | Subject prefixes filtered as auto-replies |
| `LAB_COMM_RISK_HIGH_REPLY_HOURS` | `12` | Hours before unactioned reply escalates to HIGH |
| `LAB_COMM_RISK_CRITICAL_REPLY_HOURS` | `48` | Hours before unactioned reply escalates to CRITICAL |
| `LAB_COMM_RISK_CRITICAL_OVERDUE_DAYS` | `3` | Days past deadline before timeout escalates to CRITICAL |
| `LAB_COMM_DEFAULT_LAYOUT_SLA_DAYS` | `5` | System fallback when `laboratory.expectedLayoutDays` is not set; used for `timeout_at` computation |
| `LAB_COMM_DEFAULT_ORIGINAL_SLA_DAYS` | `10` | System fallback when `laboratory.expectedOriginalDays` is not set; used for `timeout_at` computation |

---

## Appendix B — Architecture Freeze v1 Compatibility

| V1 Element | Impact |
|------------|--------|
| Order status catalog (8 statuses) | No change |
| State machine transitions | No change |
| `orders` collection | Additive only: 2 new fields on `client`, 2 new fields on `lab_interactions[n]`, 5 new indexes |
| `declarations` collection | No change |
| `tasks` collection | No change |
| `WORKFLOW_EVENTS.md` | 5 new event codes appended to Category 6; all existing codes unchanged |
| Design Principle 7 (human approval) | Strictly respected — agent is read-only |
| Design Principle 5 (extensible by design) | This agent is the extensibility mechanism in action |

The `lab_comm_threads` collection is a fourth collection beyond the V1 three-collection baseline. This is intentional and documented. The three-collection rule applies to V1 operational data. Lab thread state is monitoring infrastructure with an independent lifecycle and access pattern.

---

## Appendix C — Superseded Architecture

`docs/GMAIL_AGENT_ARCHITECTURE.md` is superseded by this document. It should be retained for reference but is no longer the active specification. The following elements of the superseded document are explicitly invalidated:

- Thread contexts `lab_request`, `lab_reminder`, `client_layout` — replaced by `lab_interaction`
- `layouts[n].gmail_thread_id` and `layouts[n].gmail_linked_at` Order extensions — removed
- `layout_version` field on thread record — removed
- Phase G5 client thread selector — removed
- Message count as primary detection method — demoted to secondary
- `gmail_threads` collection name — renamed to `lab_comm_threads`
- Module names `gmailPoller.js`, `gmailThreadService.js` — replaced by `labCommPoller.js`, `labCommService.js`
