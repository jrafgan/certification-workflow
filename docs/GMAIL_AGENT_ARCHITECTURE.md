# GMAIL AGENT ARCHITECTURE
## Email Thread Monitoring for the Certification Workflow System

---

## Purpose of This Document

This document defines the architecture for Gmail integration in the certification workflow system. The Gmail Agent is a monitoring and attention system. It reads the operator's Gmail inbox, tracks outbound threads waiting for replies, detects incoming responses, and generates tasks when operator attention is required.

**The Gmail Agent never sends email automatically.** Every send action remains a human decision. This is a non-negotiable constraint of Design Principle 7.

This integration is architecturally planned and documented here for implementation after Architecture Freeze v1. It does not change any V1 data models or state machine rules.

---

## 1. Business Goals

The certification workflow depends on email as the primary channel for two critical communication paths:

**Path 1 — Operator to Laboratory:**
- The operator sends a certification request to the laboratory
- The laboratory replies with a layout draft (PDF attachment)
- The operator sends correction instructions if the client requests changes
- The operator sends a print order after client approval
- The laboratory sends a dispatch notification when the original document is ready

**Path 2 — Operator to Client:**
- The operator forwards the layout draft to the client for approval
- The client replies with approval or correction requests

Both paths are currently managed entirely in the operator's head. The risks:

| Risk | What Goes Wrong |
|------|----------------|
| Lab reply missed | Operator does not notice the layout arrived. Order stalls. Client waits. |
| Lab reply lost | Gmail inbox grows; reply buried under other mail. No task reminds operator. |
| Lab non-response undetected | Lab ignores request. No reply arrives. System tracks deadline but not the thread. |
| Client reply missed | Client approves or requests corrections. Operator does not see it. Order stalls. |
| Attachment not downloaded | Lab reply arrives with layout. Operator sees the email but forgets to record it in the system. |
| Wrong thread linked to wrong order | Operator is managing multiple orders simultaneously. Email from Lab A processed under Order B. |

**What the Gmail Agent prevents:**

1. Any email reply from the lab or client to a monitored thread generates an immediate task.
2. A monitored thread that receives no reply within a configurable window escalates to a visible attention item.
3. Replies that contain attachments are flagged explicitly — "layout likely received by email."
4. The operator can see the age and status of every monitored thread from the dashboard without opening Gmail.
5. Emails sent outside the system can be retroactively linked to an order so their reply status is tracked.

**What the Gmail Agent does not prevent:**

- Emails sent from non-Gmail accounts (out of scope)
- Client communication via WhatsApp or phone (separate future integration)
- Errors in email content (operator reads and acts; system only detects and alerts)

---

## 2. Gmail Integration Architecture

### 2.1 Position in the System

The Gmail Agent is a fourth integration module, alongside the existing Sheets Sync and Forms Intake modules. It connects to the same `googleAuth.js` authentication infrastructure already planned for V1.

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
│   Gmail Thread Manager ◀── NEW                                   │
└────────────┬──────────────────────────────────┬────────────────┘
             │                                  │
┌────────────▼───────────┐          ┌───────────▼───────────────┐
│       DATABASE          │          │   SCHEDULER / POLLER       │
│                         │          │                            │
│   orders                │          │  Attention Engine          │
│   declarations          │          │  Gmail Poller ◀── NEW      │
│   tasks                 │          │  Sheets Sync               │
│   gmail_threads ◀── NEW │          │                            │
│                         │          │  Runs on configurable      │
│   MongoDB               │          │  interval                  │
└─────────────────────────┘          └────────────────────────────┘
```

### 2.2 Authentication Scope Extension

The existing `googleAuth.js` already handles OAuth2 for Google Sheets. Adding Gmail requires one additional scope:

| Scope | Purpose |
|-------|---------|
| `https://www.googleapis.com/auth/gmail.readonly` | Read messages and thread metadata. No send permission. |

Read-only scope is intentional and matches the monitoring-only design. Even if a future version needed to compose drafts, a separate `gmail.compose` scope would be added explicitly. The readonly scope is a technical enforcement of Design Principle 7.

### 2.3 API Methods Used

| Gmail API Method | Purpose |
|-----------------|---------|
| `users.threads.list` | Poll for new threads matching a query (e.g., from a lab email address) |
| `users.threads.get` | Fetch full thread to count messages and check for replies |
| `users.messages.get` | Read message headers (From, Subject, Date) and check for attachments |

No write methods are used.

### 2.4 Module Structure

```
backend/src/integrations/
├── googleAuth.js          ← existing; scope extended to include gmail.readonly
├── formsIntake.js         ← existing; unchanged
├── sheetsSync.js          ← existing; unchanged
├── gmailClient.js         ← NEW: thin wrapper over googleapis Gmail API
└── gmailPoller.js         ← NEW: thread monitoring and reply detection loop

backend/src/services/
├── gmailThreadService.js  ← NEW: CRUD for gmail_threads collection; thread linking logic

backend/src/models/
├── GmailThread.js         ← NEW: Mongoose model for gmail_threads collection
```

### 2.5 Polling vs Push

**V1 (polling):** The Gmail Poller runs on a configurable cron interval — recommended every 15–30 minutes. It iterates all `waiting` threads in the `gmail_threads` collection and calls `threads.get` to check for new messages.

**Future (push):** Gmail supports push notifications via Google Cloud Pub/Sub. When a new message arrives in any watched label, Gmail publishes an event to a Pub/Sub topic. The server subscribes to that topic and is notified in near-real-time. This eliminates polling delay and reduces API quota usage. Migration from polling to push requires no changes to the thread detection logic — only the trigger mechanism changes.

The polling implementation is written with this migration in mind: detection logic is decoupled from the polling loop so the same logic can be invoked by either a cron trigger or a Pub/Sub callback.

### 2.6 Quota Considerations

Gmail API quota: 250 units per user per second, 1 billion units per day.

| Operation | Cost |
|-----------|------|
| `threads.get` | 5 units |
| `messages.get` | 5 units |
| `threads.list` | 5 units |

At a 30-minute poll interval with 20 active monitored threads: 20 × 5 = 100 units per run, ~4,800 units per day. Well within quota. The quota becomes relevant only if the business scales to hundreds of simultaneous active orders with multiple monitored threads each.

---

## 3. Thread Tracking Strategy

### 3.1 Core Concept

Every time the operator sends a significant email and confirms it in the system, they have the option to link the Gmail thread to the Order. The Gmail Agent then monitors that thread for replies and generates attention tasks accordingly.

Thread linking is **optional but strongly encouraged**. If no thread is linked, the existing deadline-based attention system continues to work as before. Thread linking adds a second layer of detection on top of deadline tracking.

### 3.2 Thread Contexts

Each monitored thread belongs to one of four contexts that determine what a reply means:

| Context | Sent By | Sent To | Waiting For | Reply Means |
|---------|---------|---------|-------------|-------------|
| `lab_request` | Operator | Laboratory | Layout draft | Lab responded — may have layout attachment |
| `lab_reminder` | Operator | Laboratory | Layout draft | Lab acknowledged or sent layout |
| `client_layout` | Operator | Client | Client decision | Client responded — approval or corrections |
| `lab_print_order` | Operator | Laboratory | Dispatch notification | Original is on the way |

### 3.3 How Threads Are Linked

**Automatic linking (preferred):** When the operator records a lab request or a layout-sent action in the system, the UI presents the matching Gmail thread selector. The operator chooses the thread from a list of recent outbound threads to that email address. The thread ID is stored immediately.

**Manual linking:** The operator can manually link a thread at any time by navigating to the Order and using the thread management UI. This handles emails sent outside the system before the agent was deployed.

**Thread ID storage:**

Thread IDs are stored in two places:
1. In the `gmail_threads` collection — for efficient cross-order polling queries
2. On the Order's relevant sub-document — for audit trail and direct access from the Order detail view

Order schema extensions (additive, non-breaking):

```
orders.lab_interactions[]:
  + gmail_thread_id    String   Gmail thread ID of the outbound lab request for this version
  + gmail_linked_at   Date     When the thread was linked to this interaction entry

orders.layouts[]:
  + gmail_thread_id    String   Gmail thread ID of the email through which this layout was sent to client
  + gmail_linked_at   Date     When the thread was linked to this layout entry
```

### 3.4 Thread Lifecycle

```
        Operator sends email
               │
               ▼
        Thread linked to Order
        gmail_threads: status = 'waiting'
               │
    ┌──────────┼──────────────────────┐
    │          │                      │
    ▼          ▼                      ▼
Reply      No reply             Thread gone
detected   after                (deleted /
           deadline             bounced)
    │          │                      │
    ▼          ▼                      ▼
'replied'  'timed_out'         'unreachable'
Task:      Task:               Task:
"Check     "No reply —         "Thread error —
 email"    follow up"           investigate"
```

Once an operator marks the linked task as done and records the outcome in the system (layout received, client approved, etc.), the thread status advances to `closed`. Closed threads are no longer polled.

---

## 4. Waiting State Detection

### 4.1 Detection Matrix

The Gmail Agent monitors threads in the context of the Order's current status. Monitoring is active only when the thread context is consistent with the Order's current state:

| Order Status | Active Thread Context | Detection Active |
|---|---|---|
| `IN_LAB` | `lab_request`, `lab_reminder` | Yes |
| `WAITING_CLIENT_APPROVAL` | `client_layout` | Yes |
| `WAITING_ORIGINAL` | `lab_print_order` | Yes |
| Any other status | Any | No — thread monitoring paused |

If an Order transitions away from the expected status (e.g., cancelled while a thread is waiting), all `waiting` threads for that Order are moved to `closed` automatically by the order service.

### 4.2 Reply Detection Logic

A reply is detected when the thread's message count increases compared to the last recorded count. Specifically:

1. Fetch the thread via `threads.get` with `format: 'metadata'`
2. Count messages where the `From` header does not match the operator's own email address
3. Compare against `last_known_message_count` stored on the `gmail_threads` record
4. If count increased: a new message from the other party has arrived

Message count (not timestamp) is used to avoid timezone comparison errors and to handle delayed message delivery correctly.

### 4.3 Auto-Reply Filtering

Not every reply warrants operator attention. The following are filtered before task creation:

| Indicator | Filter Rule |
|-----------|-------------|
| `Auto-Submitted: auto-replied` header present | Skip |
| `X-Autoreply: yes` header present | Skip |
| Subject starts with "Auto:" or "Automatic reply:" | Skip |
| From address is a no-reply address (`noreply@`, `donotreply@`) | Skip |
| Message body is empty and has no attachments | Skip |

Auto-replies are logged in the thread record but do not generate tasks.

### 4.4 Attachment Detection

When a reply is detected and passes auto-reply filters, the agent checks for attachments. This is important for the `lab_request` context where the lab's response should include a layout file.

Detection: check message parts for `mimeType` of `application/pdf`, `image/jpeg`, `image/png`, or any `filename` attribute present in the message body.

Attachment detection does not download the file. It alerts the operator that an attachment exists so they can open Gmail, download it, and record it in the system.

### 4.5 Timeout Thresholds

Thread timeout thresholds are configurable in `constants.js`:

| Context | Default Timeout | Logic |
|---------|----------------|-------|
| `lab_request` | Uses `deadlines.lab_response_due` | Already deadline-tracked; thread timeout fires if deadline passes with no reply |
| `lab_reminder` | 2 days | If no reply to reminder within 2 days, escalate |
| `client_layout` | Uses `deadlines.client_response_due` | Already deadline-tracked; thread timeout fires if deadline passes with no reply |
| `lab_print_order` | Uses `deadlines.original_expected` | Thread timeout fires if original expected date passes with no reply |

The thread timeout does not create a new task if a deadline-overdue task already exists for the same order. The task deduplication rules in `taskService` apply here too.

---

## 5. MongoDB Collections

### 5.1 Rationale for a Fourth Collection

DATABASE_DESIGN.md establishes three collections. The Gmail Agent adds a fourth: `gmail_threads`.

The decision to use a separate collection rather than embedding thread state in Order sub-documents:

- The polling engine must efficiently iterate all `waiting` threads regardless of which Order they belong to. This requires a cross-order query that is expensive on embedded arrays.
- Thread state (polling timestamps, reply detection flags, error counts) is operational metadata that has no business meaning in the Order's event history.
- Thread records can be purged or archived independently of Orders. A closed thread from six months ago has no operational value; its Order must be retained.
- The thread lifecycle (waiting → replied → closed) is independent of the Order lifecycle.

### 5.2 `gmail_threads` Collection

| Field | Type | Purpose |
|-------|------|---------|
| `_id` | ObjectId | System identifier |
| `order_id` | ObjectId | The Order this thread is monitoring |
| `thread_id` | String | Gmail thread ID — used in all API calls |
| `context` | String | `lab_request`, `lab_reminder`, `client_layout`, `lab_print_order` |
| `lab_interaction_version` | Number | For lab contexts: which `lab_interactions` version this thread covers |
| `layout_version` | Number | For `client_layout` context: which `layouts` version this thread covers |
| `status` | String | `waiting`, `replied`, `timed_out`, `unreachable`, `closed` |
| `linked_at` | Date | When the thread was linked to this Order |
| `sent_at` | Date | When the operator sent the originating email |
| `last_checked_at` | Date | When the poller last fetched this thread from Gmail API |
| `last_known_message_count` | Number | Message count at last poll — used to detect new replies |
| `reply_detected_at` | Date | When the first qualifying reply was detected |
| `reply_has_attachment` | Boolean | Whether the detected reply contains at least one attachment |
| `reply_sender` | String | From address of the detected reply (for display) |
| `timeout_at` | Date | When this thread should be considered timed out if no reply arrives |
| `error_count` | Number | Consecutive API errors on this thread |
| `last_error_at` | Date | When the most recent API error occurred |
| `last_error_message` | String | Last error message for diagnostics |
| `created_at` | Date | When this record was created |

**Indexes on `gmail_threads`:**

| Index | Fields | Reason |
|-------|--------|--------|
| Primary | `_id` | Default |
| Polling query | `status`, `last_checked_at` | Poller fetches all `waiting` threads sorted by least-recently-checked |
| Order lookup | `order_id` | Order detail view loads all threads for an order |
| Thread dedup | `thread_id` | Prevents the same Gmail thread being linked twice |
| Timeout scan | `status`, `timeout_at` | Scheduled check for threads that have crossed their timeout |

### 5.3 Order Schema Extensions

These fields are added to existing embedded arrays. They are optional — their absence means no thread was linked for that interaction. Backward-compatible: existing Order documents without these fields continue to work.

```
orders.lab_interactions[n]:
  gmail_thread_id    String   — Gmail thread ID of the lab request email
  gmail_linked_at   Date     — When the thread was associated with this entry

orders.layouts[n]:
  gmail_thread_id    String   — Gmail thread ID of the layout email to the client
  gmail_linked_at   Date     — When the thread was associated with this entry
```

These additions add 2 optional fields per array element. No existing indexes are affected. No schema migration is required — MongoDB handles new optional fields transparently on read.

---

## 6. Dashboard Integration

### 6.1 Design Principle

Thread monitoring results surface through the existing task system. No new dashboard section is added for the Gmail Agent. This keeps the operator's attention model unified: everything requiring action is a task, regardless of whether it was generated by the deadline scanner or the Gmail poller.

The dashboard's existing attention categories cover all Gmail Agent scenarios:

| Gmail Event | Maps To |
|-------------|---------|
| Reply received — needs recording | ACTION NEEDED |
| No reply before deadline | OVERDUE |
| Thread timed out before deadline | OVERDUE |
| Reply received with attachment | ACTION NEEDED (high priority) |
| Thread unreachable (error) | ACTION NEEDED |

### 6.2 Order Detail View Enhancement

The Order detail view gains a new **Email Threads** section that shows:

- All linked threads for the order
- Thread status (`waiting`, `replied`, `timed_out`, `closed`)
- Last checked timestamp
- Context label (e.g., "Lab request — v1", "Layout sent to client — v2")
- Reply indicator: whether a reply has been detected and whether it has attachments
- Thread age: days since sent

This section is read-only from the dashboard. Thread linking is done through the lab interaction and layout record forms.

### 6.3 Thread Age Indicator

Thread age is displayed on any order card in the attention panel that has a `waiting` thread:

```
┌──────────────────────────────────────────────────────┐
│  ACTION NEEDED                                 [2]   │
│  ────────────────────────────────────────────────── │
│  Petrov, S.  │  IN_LAB  │  Reply in inbox — dl layout│
│              │          │  ✉ Lab replied 2h ago       │
├──────────────────────────────────────────────────────┤
│  Ivanov, I.  │  WAIT.APPROV │ Client replied — record│
│              │              │ ✉ Client replied 4h ago │
└──────────────────────────────────────────────────────┘
```

The `✉` indicator and reply age are pulled from the gmail_threads record, not from the email itself. The operator must open Gmail to read the content.

---

## 7. Automatic Task Creation Rules

These rules are evaluated by the Gmail Poller on every run. All task creation goes through `taskService.createTask()` and is subject to the same deduplication rules as scheduler-generated tasks.

### 7.1 Reply Detected

| Condition | Task Type | Priority | Description |
|-----------|-----------|----------|-------------|
| `lab_request` or `lab_reminder` thread receives a non-auto reply, no attachment | `remind_lab` | medium | "Lab replied — check email and record response" |
| `lab_request` or `lab_reminder` thread receives a reply with attachment | `remind_lab` | high | "Lab replied with attachment — download layout and record in system" |
| `client_layout` thread receives a reply | `follow_up_client` | high | "Client replied — check email and record approval or correction request" |
| `lab_print_order` thread receives a reply | `remind_lab` | medium | "Lab confirmed print order — check for dispatch details" |

### 7.2 Thread Timeout

| Condition | Task Type | Priority | Description |
|-----------|-----------|----------|-------------|
| `lab_request` thread times out (deadline passed, no reply) | `remind_lab` | high | "No lab reply — deadline passed; send reminder" |
| `lab_reminder` thread times out (2 days, no reply) | `remind_lab` | high | "Lab did not reply to reminder — follow up required" |
| `client_layout` thread times out (deadline passed, no reply) | `follow_up_client` | high | "No client reply — deadline passed; follow up" |
| `lab_print_order` thread times out (original expected, no reply) | `remind_lab` | high | "No dispatch confirmation from lab — follow up" |

### 7.3 Thread Errors

| Condition | Task Type | Priority | Description |
|-----------|-----------|----------|-------------|
| Thread unreachable for 3 consecutive polls | `manual` | medium | "Gmail thread error — re-link or verify manually" |
| Gmail API authentication failure | `manual` | high | "Gmail authentication error — re-authorize Google account" |

### 7.4 New System Events

These event codes are added to the existing event catalog in `WORKFLOW_EVENTS.md` under Category 6 (System Events):

**Order-level events** (stored in `orders.events[]`):

| Event Code | Description | Trigger | Created By |
|------------|-------------|---------|------------|
| `GMAIL_THREAD_LINKED` | A Gmail thread was linked to this order for monitoring | Operator links thread | operator |
| `GMAIL_REPLY_DETECTED` | A qualifying reply was detected in a monitored thread. Reply sender and attachment flag recorded. | Gmail Poller | system |
| `GMAIL_ATTACHMENT_DETECTED` | A reply in a monitored thread contains one or more attachments | Gmail Poller | system |
| `GMAIL_THREAD_TIMED_OUT` | A monitored thread reached its timeout without a detected reply | Gmail Poller | system |
| `GMAIL_THREAD_CLOSED` | A monitored thread was closed after its associated task was completed | Operator completes linked task | system |

**Global operational events** (server log only):

| Event Code | Description |
|------------|-------------|
| `SYS_GMAIL_POLL_COMPLETED` | Gmail poll run completed. Threads checked, replies detected, tasks created counts logged. |
| `SYS_GMAIL_AUTH_ERROR` | Gmail API authentication failed. Token may need refresh. |
| `SYS_GMAIL_RATE_LIMITED` | Gmail API returned 429. Poller backed off. |

### 7.5 Task Deduplication

The Gmail Agent respects the existing deduplication rule: before creating any task, `taskService.createTask()` checks for an open task of the same type for the same order. Specific deduplication scenarios:

- A deadline-overdue task for `remind_lab` already exists → Gmail thread timeout does not create a duplicate. The existing task's description is updated to note the thread timeout.
- A reply is detected in a `lab_request` thread → `remind_lab` task created. If a deadline overdue task of the same type already exists → the description is updated; no second task created.

---

## 8. Failure Scenarios

### 8.1 Gmail API Authentication Failure

**Cause:** OAuth2 refresh token expired, revoked, or Google account password changed.

**Detection:** Any Gmail API call returns 401 or 403.

**Response:**
1. All polling stops immediately. No task creation attempts.
2. `SYS_GMAIL_AUTH_ERROR` is logged to the server log.
3. A `manual` task of high priority is created: *"Gmail authentication failed — re-authorize Google account."*
4. Polling resumes automatically once the authentication task is completed and re-authorization is confirmed.

**Prevention:** `googleAuth.js` handles token refresh proactively. The Gmail Agent checks token validity at the start of each poll run before making any thread queries.

---

### 8.2 Thread Deleted by Operator

**Cause:** Operator permanently deletes an email thread from Gmail.

**Detection:** `threads.get` returns 404 for the thread ID.

**Response:**
1. Thread status set to `unreachable`.
2. `error_count` incremented.
3. After 3 consecutive 404 responses on separate poll runs: create a `manual` task — *"Gmail thread no longer accessible — re-link or verify manually."*

The Order record and all its data are unaffected. The gmail_threads record is retained as an audit entry.

---

### 8.3 Lab Replies from a Different Email Address

**Cause:** Lab uses a different email address than the one stored on `laboratory.laboratoryEmail`. The reply arrives in a new thread, not the monitored one.

**Detection:** The monitored thread receives no reply. The new email sits in the inbox unrecognized.

**Mitigation:**
1. The deadline-based attention system still fires when `lab_response_due` passes.
2. The operator, seeing the missed reply, manually links the new thread to the Order.
3. Going forward: when recording `LAB_REQUEST_SENT`, the system displays the actual From address of the reply so the operator can update `laboratory.laboratoryEmail`.

---

### 8.4 Auto-Reply Creates False Positive

**Cause:** Lab or client has an out-of-office auto-reply that passes the auto-reply filter (e.g., a custom subject line that doesn't match known patterns).

**Detection:** Task is created — *"Lab replied — check email."* Operator opens Gmail, sees it is an OOO reply, dismisses the task.

**Response:**
1. Operator dismisses the task with a reason.
2. Thread remains in `waiting` status — monitoring continues.
3. No duplicate task is created until the operator dismisses the current one.

**Mitigation:** Auto-reply filter patterns are configurable in `constants.js`. The operator can add custom patterns based on known lab or client OOO formats.

---

### 8.5 API Rate Limit Exceeded

**Cause:** Unusual spike in monitored threads (e.g., end-of-month batch) or external process sharing the same API quota.

**Detection:** Gmail API returns 429 (Too Many Requests) or `rateLimitExceeded` error.

**Response:**
1. `SYS_GMAIL_RATE_LIMITED` is logged.
2. Current poll run is paused.
3. Exponential backoff applied: retry after 30s, then 60s, then 120s.
4. If three consecutive poll runs fail due to rate limits: `manual` task created — *"Gmail API rate limited — check quota usage."*

**Prevention:** The poller fetches threads in batches with 200ms delays between calls. Total call volume is calculated at poll start; if projected volume exceeds 80% of available quota, non-urgent threads are deferred to the next run.

---

### 8.6 Multiple Orders with the Same Lab Contact

**Cause:** Two or more active Orders use the same laboratory. A lab reply in thread A is potentially confused with expected reply for thread B.

**Response:** Thread ID is the unit of identity, not the lab email address. Each `lab_interactions` entry has its own `gmail_thread_id`. There is no risk of cross-order confusion at the thread level.

**Risk:** If the operator accidentally links the same Gmail thread to two different Orders, the deduplication index on `gmail_threads.thread_id` prevents this at the database level with a unique index error returned to the UI as a clear validation message.

---

### 8.7 Historical Emails (Pre-System Deployment)

**Cause:** The operator has been sending lab and client emails for months or years before this system was deployed. These threads are not tracked.

**Response:** Historical thread linking. For any active Order, the operator can manually search for and link an existing Gmail thread. The `linked_at` and `sent_at` fields are set retroactively. The poller then begins monitoring from that point forward.

There is no automated historical backfill. The risk of incorrectly matching old threads to current orders outweighs the benefit.

---

## 9. Future AI Extensions

These extensions are architecturally anticipated but not part of V1 or the immediate Gmail Agent implementation. They are documented here to ensure the current design does not inadvertently block them.

### 9.1 Reply Intent Classification

**What:** When a reply is detected in a `client_layout` thread, pass the email body to Claude to classify the intent: `approved`, `corrections_requested`, or `unclear`.

**How:** `gmailPoller.js` passes the message body to a `classifyClientReply(text)` service function. The result is stored on the `gmail_threads` record as `ai_detected_intent`. The operator sees: *"Client replied — AI reads: likely approval. Confirm and record."*

**Boundary:** The AI classification is advisory only. The operator must still confirm the decision in the system. Design Principle 7 is preserved.

---

### 9.2 Layout Attachment Auto-Detection and Naming

**What:** When a lab reply with an attachment is detected, Claude reads the attachment filename and (optionally) the email subject to suggest the layout version name and lab interaction version number.

**How:** The file name from the message part is parsed. Claude is asked: *"This file was received from the laboratory in response to a certification request for [document_type]. The file is named [filename]. What version does this appear to be?"*

**Boundary:** The operator still clicks "Record layout received" and confirms version number. The AI suggestion pre-fills the form field.

---

### 9.3 Correction Instruction Drafting

**What:** When a client requests corrections and the operator needs to forward those instructions to the lab, Claude drafts the correction email based on the client's correction notes stored on the layout record.

**How:** Operator clicks "Draft correction email to lab." Claude receives the correction notes and the lab's contact name and generates a professional email draft. The draft is displayed for operator review. The operator edits it, copies it into Gmail manually, and confirms it was sent.

**Boundary:** The system generates a draft text. It does not compose or send via the Gmail API. The operator copies and sends manually. The `LAB_CORRECTIONS_SENT` event is recorded only after the operator confirms.

---

### 9.4 Lab Deadline Extraction

**What:** When the lab sends a reply confirming receipt of a request and states an expected delivery date in the email body, Claude extracts the date and suggests it as the `lab_response_due` deadline.

**How:** Message body text is passed to Claude with the prompt: *"Extract any date mentioned as a delivery or completion deadline for the attached certification work. Return ISO date or null."*

**Boundary:** The extracted date is a suggestion. The operator sees: *"AI detected deadline: 18 Jun 2026. Set as lab response deadline?"* One click to confirm or dismiss.

---

### 9.5 Real-Time Push Notifications

**What:** Replace the polling interval with Gmail Push Notifications via Google Cloud Pub/Sub. When any new message arrives matching the operator's account, a webhook fires and the system processes only the affected thread.

**How:** Gmail `users.watch` API registers a Pub/Sub topic. The server exposes a webhook endpoint `POST /api/integrations/gmail/webhook`. The thread detection logic is identical — only the trigger changes from cron to webhook.

**Impact on current design:** None. The polling loop and the webhook handler call the same `checkThread(threadId)` function. The `gmail_threads` collection and all detection logic remain identical.

---

## 10. Detailed Implementation Roadmap

This roadmap is organized as discrete phases following the V1 Phase numbering convention. These phases execute after V1 (Phases 1–8) is complete.

---

### Phase G1 — Foundation

**Objective:** Establish Gmail API connectivity, create the `gmail_threads` collection, and implement the thread management service. No monitoring logic yet.

**Dependencies:** Phase 1 (server skeleton), Phase 6 (`googleAuth.js`), Phase 2 (Mongoose models pattern)

**Files to Create**

| File | Purpose |
|------|---------|
| `src/integrations/gmailClient.js` | Thin wrapper: `getThread(threadId)`, `listThreads(query)`, `getMessage(messageId)`. Handles quota backoff. |
| `src/models/GmailThread.js` | Mongoose schema for `gmail_threads` collection as defined in Section 5.2 |
| `src/services/gmailThreadService.js` | `linkThread()`, `closeThread()`, `getThreadsForOrder()`, `markReplied()` |

**Order Schema Extension**

Add `gmail_thread_id` and `gmail_linked_at` to `lab_interactions` and `layouts` sub-schemas in `Order.js`. Both fields are optional String/Date. No existing documents are affected.

**API Endpoints**

| Method | Path | Action |
|--------|------|--------|
| POST | `/api/orders/:id/lab-interactions/:version/gmail-thread` | Link a Gmail thread ID to a lab interaction entry |
| POST | `/api/orders/:id/layouts/:version/gmail-thread` | Link a Gmail thread ID to a layout entry |
| DELETE | `/api/orders/:id/gmail-threads/:gmailThreadId` | Unlink a thread (closes it, does not delete the record) |
| GET | `/api/orders/:id/gmail-threads` | List all threads for an order with their status |

**Acceptance Criteria**

- A Gmail thread can be linked to a `lab_interactions` entry and the link is stored in both the Order sub-document and the `gmail_threads` collection
- The same thread ID cannot be linked to two different Orders (unique index enforced)
- `GET /api/orders/:id/gmail-threads` returns all threads with status, context, and reply detection fields
- Unlinking a thread sets its status to `closed` and fires `GMAIL_THREAD_CLOSED` on the Order

---

### Phase G2 — Polling Engine

**Objective:** Implement the poller that iterates all `waiting` threads and detects replies.

**Dependencies:** Phase G1 complete; `taskService.createTask()` available (Phase 4)

**Files to Create**

| File | Purpose |
|------|---------|
| `src/integrations/gmailPoller.js` | Main polling loop: fetch waiting threads, call `checkThread()` for each, create tasks on reply |
| `src/scheduler/index.js` | Extended to register Gmail poll cron alongside the attention engine |

**`constants.js` additions**

| Constant | Default | Purpose |
|----------|---------|---------|
| `GMAIL_POLL_CRON` | `"*/30 * * * *"` (every 30 min) | Poll interval |
| `GMAIL_REMINDER_THREAD_TIMEOUT_DAYS` | `2` | Days before a `lab_reminder` thread times out |
| `GMAIL_MAX_ERROR_COUNT` | `3` | Consecutive errors before thread is marked unreachable |
| `GMAIL_BATCH_DELAY_MS` | `200` | Delay between API calls in a poll batch |

**Reply Detection Logic**

For each `waiting` thread:
1. Call `gmailClient.getThread(thread_id)` with `format: 'metadata'`
2. Filter messages where `From` ≠ operator email
3. Filter auto-replies per Section 4.3
4. If qualifying new messages found: call `gmailThreadService.markReplied()` and create task
5. Check attachments: call `gmailClient.getMessage()` for each new message, inspect parts
6. Update `last_checked_at` and `last_known_message_count` on the thread record

**Acceptance Criteria**

- Poll runs on configured interval and logs `SYS_GMAIL_POLL_COMPLETED` with thread counts
- A thread that receives a reply generates exactly one task (deduplication verified)
- A thread that receives an auto-reply does not generate a task; `last_checked_at` is updated
- A reply with a PDF attachment generates a high-priority task with "attachment" in description
- Concurrent poll prevention: if a poll is already running, the new trigger is skipped and logged
- Poll failure does not crash the server; error is logged and next run proceeds normally

---

### Phase G3 — Timeout Detection

**Objective:** Detect threads that have exceeded their timeout without a reply.

**Dependencies:** Phase G2 complete

**Implementation**

Add a timeout scan to the end of each poll run:

1. Query `gmail_threads` for records where `status = 'waiting'` AND `timeout_at <= now`
2. For each: set status to `timed_out`, fire `GMAIL_THREAD_TIMED_OUT` on the Order, create task
3. Respect deduplication: if a deadline-overdue task already exists for the same order and type, update description rather than creating duplicate

**Acceptance Criteria**

- A thread whose `timeout_at` has passed is marked `timed_out` within one poll run
- If a `remind_lab` task already exists for the order, no duplicate is created; description is updated to note thread timeout
- Timed-out threads are excluded from future polls (status ≠ `waiting`)

---

### Phase G4 — Dashboard Integration

**Objective:** Surface thread status in the Order detail view and attention panel.

**Dependencies:** Phase G3 complete; Phase 5 (dashboard API) complete; Phase 8 (attention engine) complete

**API Changes**

Extend `GET /api/dashboard/attention` response to include `gmail_reply_pending` flag on each order card where a thread has a detected reply but no associated task has been completed.

Extend `GET /api/orders/:id` response to include a `gmail_threads` array with thread status, context, age, reply detection, and attachment flags.

**Frontend Changes**

- Add Email Threads panel to Order detail view (read-only)
- Add `✉` reply indicator on dashboard order cards where `gmail_reply_pending: true`
- Thread age displayed as "Lab replied 2h ago" or "Waiting 4d — no reply"

**Acceptance Criteria**

- Order detail view shows all linked threads with correct status
- Dashboard order cards show reply indicator when a reply has been detected but not yet actioned
- No new top-level dashboard section; all alerts route through existing task categories

---

### Phase G5 — Thread Linking UI

**Objective:** Make thread linking frictionless for the operator during normal workflow.

**Dependencies:** Phase G4 complete; `googleAuth.js` with `gmail.readonly` scope

**New API Endpoint**

`GET /api/integrations/gmail/recent-threads?to=email@address.com` — Returns up to 10 recent Gmail threads sent to the given email address. Used to populate the thread selector in the UI.

**UI Integration Points**

1. After recording `LAB_REQUEST_SENT`: display thread selector pre-filtered by `laboratory.laboratoryEmail`
2. After recording `CLIENT_LAYOUT_SENT`: display thread selector pre-filtered by `client.phone`/email
3. On any Order detail view: manual thread linking option under "Email Threads"

**Acceptance Criteria**

- Thread selector shows threads with subject, date, and recipient
- Linking a thread from the selector stores the ID and fires `GMAIL_THREAD_LINKED`
- If no thread is selected, the workflow continues normally (linking is optional)
- A thread already linked to another order is excluded from the selector

---

### Phase Summary

| Phase | Scope | Deliverable |
|-------|-------|-------------|
| G1 | Foundation | `gmail_threads` model, thread service, link/unlink API |
| G2 | Polling Engine | Reply detection, task creation, auto-reply filtering |
| G3 | Timeout Detection | Deadline-aware thread timeout, escalation tasks |
| G4 | Dashboard | Reply indicators, thread status in order detail |
| G5 | Thread Linking UI | Frictionless thread association during workflow |

Phases G1–G3 can be completed without any frontend changes and tested entirely via API. Phases G4–G5 require frontend work and should follow in sequence.

---

## Appendix A — Configuration Reference

All constants defined in `src/config/constants.js`. No value is hardcoded in service or scheduler logic.

| Constant | Default | Description |
|----------|---------|-------------|
| `GMAIL_POLL_CRON` | `"*/30 * * * *"` | Cron expression for Gmail poll interval |
| `GMAIL_POLL_TIMEZONE` | Same as `SCHEDULER_TIMEZONE` | Timezone for poll schedule |
| `GMAIL_REMINDER_TIMEOUT_DAYS` | `2` | Days before lab_reminder thread times out |
| `GMAIL_BATCH_DELAY_MS` | `200` | Milliseconds between successive `threads.get` calls |
| `GMAIL_MAX_CONSECUTIVE_ERRORS` | `3` | Errors before thread marked unreachable |
| `GMAIL_ATTACHMENT_TYPES` | `['pdf','jpg','jpeg','png']` | File extensions treated as layout/document attachments |

---

## Appendix B — Relationship to Architecture Freeze v1

The Gmail Agent is a planned extension. It does not change any V1 state machine rules, status catalog, or existing collection schemas. Its relationship to the frozen architecture:

| V1 Element | Impact |
|------------|--------|
| Order status catalog (8 statuses) | No change |
| State machine transitions | No change |
| `orders`, `declarations`, `tasks` collections | Two optional fields added to Order sub-arrays; no structural change |
| `WORKFLOW_EVENTS.md` event codes | 5 new event codes appended; existing codes unchanged |
| Design Principle 7 (human approval) | Strictly respected — Gmail Agent is read-only |
| Design Principle 5 (extensible by design) | This is the extensibility mechanism in action |

The addition of the `gmail_threads` collection extends DATABASE_DESIGN.md's "Three collections" baseline. This is documented and intentional: the three-collection constraint applies to the V1 operational data model. Gmail thread state is infrastructure metadata with a different access pattern and lifecycle.
