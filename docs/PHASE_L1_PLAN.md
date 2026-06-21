# PHASE L1 — LABORATORY COMMUNICATION AGENT: FOUNDATION
## Implementation Plan

**Phase:** L1 of L5 (Laboratory Communication Agent)
**Prerequisite:** V1 Phases 1–8 complete
**Scope:** Models, schema extensions, Gmail API wrapper, service layer, routes
**No polling, no scheduled jobs in this phase** — that is Phase L2

---

## Overview

Phase L1 builds the foundation the polling engine will run on. At the end of this phase:
- The `lab_comm_threads` collection exists with full schema and indexes
- The `Order` model has all required new fields and indexes
- The Gmail API is callable via a thin authenticated wrapper
- Threads can be linked and unlinked to orders via API
- Risk can be computed for any thread and order
- Orders can be searched by name, company, phone, or email
- Gmail threads can be searched by any Gmail query string

Nothing runs automatically in Phase L1. The poller is Phase L2.

---

## 1. Prerequisites Checklist

Before starting Phase L1, confirm:

| Prerequisite | Where Defined |
|-------------|--------------|
| `Order.js` model exists and passes audit | Phase 2 complete |
| `Task.js` model exists | Phase 2 complete |
| `Declaration.js` model exists | Phase 2 complete |
| `taskService.createTask()` available | Phase 4 |
| `googleAuth.js` exists with Sheets scope | Phase 6 |
| Express server and routing infrastructure | Phase 1 |
| `constants.js` exists | Phase 1 |
| MongoDB connection established | Phase 1 |

---

## 2. Files to Create

| File | What It Is |
|------|-----------|
| `backend/src/models/LabCommThread.js` | Mongoose model for `lab_comm_threads` collection |
| `backend/src/integrations/gmailClient.js` | Authenticated Gmail API wrapper |
| `backend/src/services/labCommService.js` | Thread management, risk computation, SLA logic |
| `backend/src/routes/labCommRoutes.js` | Thread link/unlink/list routes on Order |
| `backend/src/routes/gmailIntegrationRoutes.js` | Gmail search endpoint |

## 3. Files to Modify

| File | What Changes |
|------|-------------|
| `backend/src/models/Order.js` | Add 4 new fields, 5 new indexes |
| `backend/src/config/constants.js` | Add LAB_COMM_* constants |
| `backend/src/integrations/googleAuth.js` | Add `gmail.readonly` to OAuth scope |
| `backend/src/server.js` (or route registration file) | Register 2 new route files |

---

## 4. Model: `LabCommThread.js`

### 4.1 Full Schema Specification

Collection name: `lab_comm_threads`
Options: `{ versionKey: false }`
No Mongoose-managed timestamps — `created_at` is set manually with `default: Date.now`.

| Field | Mongoose Type | Required | Default | Constraints |
|-------|--------------|----------|---------|-------------|
| `order_id` | `ObjectId, ref: 'Order'` | Yes | — | — |
| `thread_id` | `String` | Yes | — | `trim: true` |
| `context` | `String` | Yes | — | `enum: ['lab_interaction', 'lab_print_order']` |
| `lab_interaction_version` | `Number` | No | — | `min: 1` |
| `recipient_email` | `String` | Yes | — | `trim: true, lowercase: true` |
| `status` | `String` | Yes | `'waiting'` | `enum: ['waiting', 'replied', 'timed_out', 'unreachable', 'closed', 'unlinked']` |
| `link_mode` | `String` | Yes | — | `enum: ['live', 'historical']` |
| `linked_at` | `Date` | Yes | — | — |
| `sent_at` | `Date` | No | — | — |
| `sla_layout_days` | `Number` | No | — | `min: 1` |
| `sla_original_days` | `Number` | No | — | `min: 1` |
| `initialized_message_count` | `Number` | Yes | `0` | `min: 0` |
| `last_checked_at` | `Date` | No | — | — |
| `last_known_message_count` | `Number` | Yes | `0` | `min: 0` |
| `auto_reply_count` | `Number` | Yes | `0` | `min: 0` |
| `reply_detected_at` | `Date` | No | — | — |
| `reply_has_attachment` | `Boolean` | No | — | — |
| `reply_sender` | `String` | No | — | `trim: true` |
| `timeout_at` | `Date` | No | — | — |
| `error_count` | `Number` | Yes | `0` | `min: 0` |
| `last_error_at` | `Date` | No | — | — |
| `last_error_message` | `String` | No | — | `trim: true` |
| `created_at` | `Date` | Yes | `Date.now` | — |

### 4.2 Indexes

Define all indexes inside the schema. Do not use `ensureIndex` or `createIndex` calls — Mongoose schema index definitions are sufficient.

| Index Definition | Options | Purpose |
|-----------------|---------|---------|
| `{ status: 1, last_checked_at: 1 }` | — | Poller query: fetch `waiting` threads sorted by least-recently-checked |
| `{ order_id: 1 }` | — | Load all threads for an order |
| `{ thread_id: 1 }` | `unique: true, partialFilterExpression: { status: { $nin: ['unlinked', 'closed'] } }` | Prevent same thread linked to two active records |
| `{ status: 1, timeout_at: 1 }` | `sparse: true` | Timeout scan query |
| `{ recipient_email: 1, status: 1 }` | — | Dashboard grouping by laboratory |

### 4.3 Exports

```
module.exports = {
  LabCommThread,
  LAB_COMM_CONTEXTS,       // ['lab_interaction', 'lab_print_order']
  LAB_COMM_STATUSES,       // ['waiting', 'replied', 'timed_out', 'unreachable', 'closed', 'unlinked']
  LAB_COMM_LINK_MODES,     // ['live', 'historical']
};
```

Add these exports to `backend/src/models/index.js`.

---

## 5. Order.js Modifications

### 5.1 `laboratory` Sub-Schema — New Fields

Add to the existing `laboratorySchema` (the embedded object inside Order):

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `expectedLayoutDays` | `Number` | No | `min: 1` |
| `expectedOriginalDays` | `Number` | No | `min: 1` |

These are additive. No existing validation changes.

### 5.2 `client` Sub-Schema — New Fields

Add to the existing `clientSchema`:

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `email` | `String` | No | `trim: true, lowercase: true` |
| `companyName` | `String` | No | `trim: true` |

### 5.3 `lab_interactions` Sub-Schema — New Fields

Add to the existing `labInteractionSchema`:

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `gmail_thread_id` | `String` | No | `trim: true` |
| `gmail_linked_at` | `Date` | No | — |

### 5.4 New Indexes on `orders`

Add these alongside existing indexes in the `orderSchema.index()` calls:

| Index | Options | Purpose |
|-------|---------|---------|
| `{ 'client.name': 1 }` | `collation: { locale: 'en', strength: 2 }` | Case-insensitive applicant name search |
| `{ 'client.companyName': 1 }` | `sparse: true, collation: { locale: 'en', strength: 2 }` | Case-insensitive company name search |
| `{ 'client.email': 1 }` | `sparse: true` | Client email lookup |
| `{ 'laboratory.laboratoryName': 1 }` | `sparse: true` | Lab name grouping |
| `{ 'laboratory.laboratoryEmail': 1 }` | `sparse: true` | Thread selector pre-filter |

---

## 6. `constants.js` Additions

Add these constants in a clearly labelled `// LABORATORY COMMUNICATION AGENT` block:

| Constant | Value | Purpose |
|----------|-------|---------|
| `LAB_COMM_POLL_CRON` | `"*/30 * * * *"` | Poll interval (used in Phase L2) |
| `LAB_COMM_POLL_TIMEZONE` | same as `SCHEDULER_TIMEZONE` | Timezone |
| `LAB_COMM_MAX_CONSECUTIVE_ERRORS` | `3` | Errors before thread → `unreachable` |
| `LAB_COMM_BATCH_DELAY_MS` | `200` | Delay between API calls |
| `LAB_COMM_ATTACHMENT_MIMETYPES` | `['application/pdf', 'image/jpeg', 'image/png', 'image/tiff']` | Attachment detection types |
| `LAB_COMM_AUTO_REPLY_SUBJECTS` | `['Auto:', 'Automatic reply:', 'Out of office:']` | OOO filter patterns |
| `LAB_COMM_DEFAULT_LAYOUT_SLA_DAYS` | `5` | Fallback SLA for layout delivery |
| `LAB_COMM_DEFAULT_ORIGINAL_SLA_DAYS` | `10` | Fallback SLA for original document |
| `LAB_COMM_RISK_HIGH_REPLY_HOURS` | `12` | Hours before unactioned reply → HIGH |
| `LAB_COMM_RISK_CRITICAL_REPLY_HOURS` | `48` | Hours before unactioned reply → CRITICAL |
| `LAB_COMM_RISK_CRITICAL_OVERDUE_DAYS` | `3` | Days past deadline before timed_out → CRITICAL |
| `LAB_COMM_SEARCH_MAX_RESULTS` | `50` | Max results from Gmail search |

---

## 7. `googleAuth.js` Modification

Add `https://www.googleapis.com/auth/gmail.readonly` to the OAuth2 scopes array alongside the existing Sheets scope.

The scope list becomes:
```
[
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/gmail.readonly',
]
```

This requires the operator to re-authorize once after deployment. The re-authorization flow is unchanged — Google's consent screen will show the new scope.

---

## 8. Integration: `gmailClient.js`

### 8.1 Purpose

Thin authenticated wrapper over the Google Gmail API (`googleapis` SDK already in `package.json`). All Gmail API calls in the entire agent go through this module. Handles quota backoff internally.

### 8.2 Functions to Implement

**`getThread(threadId, format = 'metadata')`**
- Calls `gmail.users.threads.get({ userId: 'me', id: threadId, format })`
- Returns the thread object from the Gmail API
- On 404: throws a specific `ThreadNotFoundError` (not a generic Error)
- On 429 or rate limit: throws `RateLimitError`
- On 401/403: throws `AuthError`

**`searchThreads(query, maxResults = 20)`**
- Calls `gmail.users.threads.list({ userId: 'me', q: query, maxResults })`
- For each thread in results: calls `getMessage` on the first message to get subject, from, to, date
- Returns array of summaries: `{ threadId, subject, from, to, date, messageCount, hasAttachment }`
- `hasAttachment` is set if any message in the thread has a `MIME_TYPE` part with `filename` set
- Truncates results at `maxResults`

**`getMessage(messageId, format = 'metadata')`**
- Calls `gmail.users.messages.get({ userId: 'me', id: messageId, format })`
- Returns the message object with `labelIds`, `payload.headers`, and `payload.parts`

**`getOperatorEmail()`**
- Calls `gmail.users.getProfile({ userId: 'me' })`
- Returns the operator's email address string
- Result is cached in module scope for the process lifetime — this never changes

**Internal: `withBackoff(fn)`**
- Wraps any API call function
- On `RateLimitError`: waits `LAB_COMM_BATCH_DELAY_MS × 2^attempt` ms, retries up to 3 times
- On `AuthError`: re-throws immediately (no retry — auth must be fixed by the operator)
- On `ThreadNotFoundError`: re-throws immediately (no retry)

---

## 9. Service: `labCommService.js`

### 9.1 `computeEffectiveDeadline(thread, order)`

**Inputs:** a `LabCommThread` document, an `Order` document
**Output:** `Date` or `null`
**Logic:**
```
if context === 'lab_interaction':
  return order.deadlines.lab_response_due
      ?? (thread.sent_at + thread.sla_layout_days days)
      ?? (thread.sent_at + LAB_COMM_DEFAULT_LAYOUT_SLA_DAYS days)
      ?? null

if context === 'lab_print_order':
  return order.deadlines.original_expected
      ?? (thread.sent_at + thread.sla_original_days days)
      ?? (thread.sent_at + LAB_COMM_DEFAULT_ORIGINAL_SLA_DAYS days)
      ?? null
```
The `??` operator: if the left side is `null` or `undefined`, try the next. If `sent_at` is null, any SLA-derived date is also null.

---

### 9.2 `computeThreadRisk(thread, order)`

**Inputs:** a `LabCommThread` document, an `Order` document
**Output:** `'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'`
**Logic:** Evaluate deadline-based rules first, then SLA-aware rules, return the maximum.

**Deadline-based rules (evaluated in order, first match):**

| Condition | Returns |
|-----------|---------|
| `status = 'unreachable'` AND `error_count >= MAX_ERRORS` | `CRITICAL` |
| `status = 'timed_out'` AND `(now − timeout_at) > CRITICAL_OVERDUE_DAYS days` | `CRITICAL` |
| `status = 'replied'` AND `(now − reply_detected_at) > CRITICAL_REPLY_HOURS hours` | `CRITICAL` |
| `status = 'timed_out'` AND `(now − timeout_at)` is 1–2 days | `HIGH` |
| `status = 'replied'` AND `(now − reply_detected_at)` is `HIGH_REPLY_HOURS`–`CRITICAL_REPLY_HOURS` | `HIGH` |
| `status = 'replied'` AND `reply_has_attachment = true` | `HIGH` |
| `status = 'waiting'` AND effective_deadline is tomorrow | `HIGH` |
| `status = 'replied'` AND `(now − reply_detected_at) < HIGH_REPLY_HOURS hours` | `MEDIUM` |
| `status = 'waiting'` AND effective_deadline is 2–4 days away | `MEDIUM` |
| `status = 'timed_out'` AND deadline passed today | `MEDIUM` |
| `status = 'waiting'` AND effective_deadline is 5+ days away | `LOW` |
| `status = 'waiting'` AND effective_deadline is null | `LOW` |

**SLA-aware rules (apply only when `context = 'lab_interaction'` AND `sla_layout_days != null`):**

| Condition | SLA Risk |
|-----------|---------|
| `status = 'waiting'` AND `(now − sent_at) > sla_layout_days × 1.5` days | `CRITICAL` |
| `status = 'waiting'` AND `(now − sent_at) > sla_layout_days × 1.0` days | `HIGH` |
| `status = 'waiting'` AND `(now − sent_at) >= sla_layout_days × 0.8` days | `MEDIUM` |

**Final:** `return MAX(deadline_risk, sla_risk)`

Risk level ordering for MAX: `CRITICAL > HIGH > MEDIUM > LOW`

---

### 9.3 `computeOrderRisk(orderId)`

**Input:** `orderId` (ObjectId or string)
**Output:** `'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | null`

Queries `lab_comm_threads` for all records with this `order_id` where `status IN ['waiting', 'replied', 'timed_out', 'unreachable']`. Fetches the Order document. For each thread, calls `computeThreadRisk()`. Returns the maximum. Returns `null` if no active threads.

---

### 9.4 `linkThread(params)`

**Input object:**
```
{
  orderId,            // ObjectId
  version,            // Number — lab_interactions version
  threadId,           // String — Gmail thread ID
  linkMode,           // 'live' | 'historical'
  sentAt,             // Date — optional; when the operator sent the email
  context,            // 'lab_interaction' | 'lab_print_order'
}
```

**Steps:**
1. Fetch the Order document. Throw `OrderNotFoundError` if absent.
2. Validate that `lab_interactions[version-1]` exists on the Order. Throw `InvalidVersionError` if not.
3. Call `gmailClient.getThread(threadId)` to fetch current message count. This call at link time is required — it sets `initialized_message_count` and validates the thread is accessible.
4. Snapshot SLA values: read `order.laboratory.expectedLayoutDays` → `sla_layout_days`; read `order.laboratory.expectedOriginalDays` → `sla_original_days`.
5. Compute `timeout_at` via `computeEffectiveDeadline()` using the thread context.
6. Build the `LabCommThread` document with all fields.
7. Attempt `LabCommThread.create(doc)`. If MongoDB throws a unique index violation (E11000): throw `ThreadAlreadyLinkedError` with the conflicting order's ID included in the error.
8. On success: update `orders.lab_interactions[version-1].gmail_thread_id` and `gmail_linked_at` atomically using `Order.findOneAndUpdate()` with `$set`.
9. Fire `LAB_THREAD_LINKED` event on the Order via `orderService.addEvent()`.
10. If `linkMode = 'historical'`: call `taskService.createTask()` with type `manual`, priority `medium`, description "Historical thread linked — verify current state and close if already resolved."
11. Return the created `LabCommThread` document.

**Error types thrown (not generic Errors):**

| Error Class | When |
|------------|------|
| `OrderNotFoundError` | Order does not exist |
| `InvalidVersionError` | `lab_interactions[version-1]` does not exist |
| `ThreadAlreadyLinkedError` | Unique index violation |
| `ThreadNotFoundError` | Gmail API returned 404 for the thread |
| `AuthError` | Gmail API returned 401/403 |

---

### 9.5 `unlinkThread(threadRecordId)`

**Input:** `_id` of the `LabCommThread` record
**Steps:**
1. Fetch the `LabCommThread` document. Throw `NotFoundError` if absent.
2. If `status` is already `closed` or `unlinked`: throw `InvalidOperationError`.
3. Set `status = 'unlinked'`.
4. Clear `orders.lab_interactions[n].gmail_thread_id` and `gmail_linked_at` via `Order.findOneAndUpdate()`.
5. Do NOT fire `LAB_THREAD_CLOSED`. Do NOT create a task. Unlink is a data correction.
6. Return the updated `LabCommThread` document.

---

### 9.6 `closeThread(threadRecordId)`

**Input:** `_id` of the `LabCommThread` record
**Steps:**
1. Fetch the `LabCommThread` document. Throw `NotFoundError` if absent.
2. If `status` is already `closed` or `unlinked`: throw `InvalidOperationError`.
3. Set `status = 'closed'`.
4. Fire `LAB_THREAD_CLOSED` event on the associated Order.
5. Return the updated document.

---

### 9.7 `getThreadsForOrder(orderId)`

**Input:** `orderId`
**Output:** Array of `LabCommThread` documents, each augmented with a `risk` field and an `slaStatus` string.

Fetches all `lab_comm_threads` for the order. Fetches the Order once. For each thread: calls `computeThreadRisk(thread, order)` and computes `slaStatus` string:

**`slaStatus` computation** (only for `lab_interaction` context when `sla_layout_days` is set):
```
days_waiting = (now − sent_at) in days (integer)

if days_waiting > sla_layout_days:
  slaStatus = `SLA exceeded (${days_waiting}d / ${sla_layout_days}d SLA)`
else:
  days_left = sla_layout_days − days_waiting
  slaStatus = `SLA: ${days_left}d left (${days_waiting}d / ${sla_layout_days}d SLA)`
```

Returns null `slaStatus` when `sla_layout_days` is null or context is not `lab_interaction`.

---

### 9.8 `updateTimeoutAfterDeadlineChange(orderId, context)`

Called by `orderService` whenever a `ORDER_DEADLINE_SET` event fires.

**Input:** `orderId`, `context` (`'lab_interaction'` or `'lab_print_order'`)
**Steps:**
1. Fetch the Order to get the updated deadline.
2. Find all `waiting` and `timed_out` `lab_comm_threads` for this order with matching context.
3. For each: recalculate `timeout_at` via `computeEffectiveDeadline()`.
4. If the new `timeout_at` is in the future and the thread is `timed_out`: reset `status = 'waiting'` (the operator extended the deadline — monitoring resumes).
5. Update the records.

---

## 10. Routes

### 10.1 `labCommRoutes.js`

Mount at: `/api/orders/:id/lab-threads`

**`POST /api/orders/:id/lab-interactions/:version/lab-thread`**

Request body:
```json
{
  "threadId": "gmail_thread_id_string",
  "linkMode": "live",
  "sentAt": "2026-06-10T09:00:00Z",
  "context": "lab_interaction"
}
```

Validation:
- `threadId`: required, non-empty string
- `linkMode`: required, must be `'live'` or `'historical'`
- `sentAt`: optional Date
- `context`: required, must be `'lab_interaction'` or `'lab_print_order'`
- `:version`: must be a positive integer

Calls `labCommService.linkThread()`. Returns `201` with the created thread document (including computed `risk` field). On `ThreadAlreadyLinkedError`: returns `409` with message identifying the conflicting order.

---

**`DELETE /api/orders/:id/lab-threads/:threadRecordId`**

No request body. Calls `labCommService.unlinkThread(threadRecordId)`. Returns `200` with the updated thread document. On `NotFoundError`: `404`. On `InvalidOperationError`: `400`.

---

**`POST /api/orders/:id/lab-threads/:threadRecordId/close`**

Calls `labCommService.closeThread(threadRecordId)`. Returns `200`.

---

**`GET /api/orders/:id/lab-threads`**

Returns all `lab_comm_threads` for the order, augmented with `risk` and `slaStatus`. No query parameters. Returns `[]` if no threads linked.

---

### 10.2 `gmailIntegrationRoutes.js`

Mount at: `/api/integrations/gmail`

**`GET /api/integrations/gmail/search-threads`**

Query parameters:
- `q` (required): Gmail search query string
- `maxResults` (optional, default: 20, max: `LAB_COMM_SEARCH_MAX_RESULTS`)

Calls `gmailClient.searchThreads(q, maxResults)`. For each result thread: checks if `thread_id` exists in `lab_comm_threads` with active status (not `unlinked` or `closed`) and sets `isAlreadyLinked: true` and `linkedToOrderId` on that result.

Returns array of thread summaries:
```json
[
  {
    "threadId": "...",
    "subject": "Certification request — Petrov",
    "from": "operator@gmail.com",
    "to": "lab@labname.com",
    "date": "2026-06-10T09:00:00Z",
    "messageCount": 2,
    "hasAttachment": false,
    "isAlreadyLinked": false,
    "linkedToOrderId": null
  }
]
```

Returns `400` if `q` is absent. Returns `503` with a specific message if Gmail auth is unavailable.

---

### 10.3 Order Search (extend existing order routes)

**`GET /api/orders/search`**

Query parameters (all optional, at least one required):
- `name`: search `client.name` — case-insensitive regex, partial match
- `company`: search `client.companyName` — case-insensitive regex, partial match
- `phone`: search `client.phone` — prefix match
- `email`: search `client.email` — case-insensitive exact match
- `status`: filter by order status — exact enum match

If none of `name`, `company`, `phone`, `email` are provided: return `400 Bad Request`.

MongoDB query: construct a `$and` array from all provided parameters using `$regex` with `$options: 'i'` for text fields, and `$regex: '^phone_value'` for phone.

Response: array of order summaries (max 50):
```json
[
  {
    "_id": "...",
    "status": "IN_LAB",
    "client": { "name": "Petrov, Ivan", "companyName": null, "phone": "+7...", "email": null },
    "laboratory": { "laboratoryName": "Lab A", "laboratoryEmail": "lab@a.com" },
    "created_at": "2026-05-01T..."
  }
]
```

---

## 11. `constants.js` Block to Add

```javascript
// LABORATORY COMMUNICATION AGENT
// Phase L1+

const LAB_COMM_POLL_CRON               = process.env.LAB_COMM_POLL_CRON || '*/30 * * * *';
const LAB_COMM_POLL_TIMEZONE           = process.env.SCHEDULER_TIMEZONE  || 'UTC';
const LAB_COMM_MAX_CONSECUTIVE_ERRORS  = 3;
const LAB_COMM_BATCH_DELAY_MS          = 200;
const LAB_COMM_ATTACHMENT_MIMETYPES    = ['application/pdf', 'image/jpeg', 'image/png', 'image/tiff'];
const LAB_COMM_AUTO_REPLY_SUBJECTS     = ['Auto:', 'Automatic reply:', 'Out of office:'];
const LAB_COMM_DEFAULT_LAYOUT_SLA_DAYS  = parseInt(process.env.LAB_COMM_DEFAULT_LAYOUT_SLA_DAYS)  || 5;
const LAB_COMM_DEFAULT_ORIGINAL_SLA_DAYS= parseInt(process.env.LAB_COMM_DEFAULT_ORIGINAL_SLA_DAYS)|| 10;
const LAB_COMM_RISK_HIGH_REPLY_HOURS   = 12;
const LAB_COMM_RISK_CRITICAL_REPLY_HOURS = 48;
const LAB_COMM_RISK_CRITICAL_OVERDUE_DAYS = 3;
const LAB_COMM_SEARCH_MAX_RESULTS      = 50;
```

Export all new constants alongside existing exports.

---

## 12. Error Classes

Create `backend/src/errors/labCommErrors.js` with these named error classes. Each extends `Error` with a `code` property for structured error handling in routes.

| Class | `code` | HTTP Status |
|-------|--------|-------------|
| `OrderNotFoundError` | `ORDER_NOT_FOUND` | 404 |
| `InvalidVersionError` | `INVALID_LAB_VERSION` | 400 |
| `ThreadAlreadyLinkedError` | `THREAD_ALREADY_LINKED` | 409 |
| `ThreadNotFoundError` | `GMAIL_THREAD_NOT_FOUND` | 404 |
| `AuthError` | `GMAIL_AUTH_ERROR` | 503 |
| `RateLimitError` | `GMAIL_RATE_LIMITED` | 503 |
| `NotFoundError` | `RECORD_NOT_FOUND` | 404 |
| `InvalidOperationError` | `INVALID_OPERATION` | 400 |

Routes catch these specific classes and map to HTTP status codes. Generic `Error` instances return `500`.

---

## 13. Acceptance Criteria

Each criterion must be verifiable by calling the API directly (no frontend required for Phase L1 verification).

### 13.1 Model and Schema

| # | Criterion |
|---|-----------|
| AC-01 | `LabCommThread` model creates documents without error when all required fields are provided |
| AC-02 | `LabCommThread` schema rejects documents with invalid `context`, `status`, or `link_mode` enum values |
| AC-03 | `LabCommThread` partial unique index: attempting to create two records with the same `thread_id` where both have active statuses returns a MongoDB E11000 error |
| AC-04 | `LabCommThread` partial unique index: creating a second record with the same `thread_id` where the first has `status = 'unlinked'` succeeds |
| AC-05 | `Order` model accepts `laboratory.expectedLayoutDays` and `laboratory.expectedOriginalDays` as optional numbers; existing Orders without these fields validate without error |
| AC-06 | `Order` model accepts `client.email` and `client.companyName` as optional strings |
| AC-07 | `Order` model accepts `lab_interactions[n].gmail_thread_id` and `gmail_linked_at` as optional fields |

### 13.2 SLA and Risk Computation

| # | Criterion |
|---|-----------|
| AC-08 | `computeEffectiveDeadline()` returns the operator-set deadline when `deadlines.lab_response_due` is present, regardless of SLA values |
| AC-09 | `computeEffectiveDeadline()` returns `sent_at + sla_layout_days` when `deadlines.lab_response_due` is null and `sla_layout_days` is set |
| AC-10 | `computeEffectiveDeadline()` returns `sent_at + LAB_COMM_DEFAULT_LAYOUT_SLA_DAYS` when both the explicit deadline and `sla_layout_days` are null |
| AC-11 | `computeEffectiveDeadline()` returns `null` when `sent_at` is null (cannot compute SLA-derived date) |
| AC-12 | `computeThreadRisk()` returns `CRITICAL` for an `unreachable` thread with `error_count >= 3` |
| AC-13 | `computeThreadRisk()` returns `HIGH` for a `waiting` thread where `(now − sent_at) > sla_layout_days` days |
| AC-14 | `computeThreadRisk()` returns `MEDIUM` for a `waiting` thread where `(now − sent_at) >= sla_layout_days × 0.8` days |
| AC-15 | `computeThreadRisk()` SLA rules do not fire when `sla_layout_days` is null |
| AC-16 | `computeThreadRisk()` returns `MAX(deadline_risk, sla_risk)`: if deadline risk is `HIGH` and SLA risk is `CRITICAL`, result is `CRITICAL` |
| AC-17 | `computeOrderRisk()` returns the highest risk among all active threads for an order |
| AC-18 | `computeOrderRisk()` returns `null` when an order has no active threads |

### 13.3 Thread Linking

| # | Criterion |
|---|-----------|
| AC-19 | `POST /api/orders/:id/lab-interactions/1/lab-thread` with `linkMode: 'live'` creates a `lab_comm_threads` record and updates `orders.lab_interactions[0].gmail_thread_id` |
| AC-20 | `linkMode: 'live'` does NOT create a review task |
| AC-21 | `linkMode: 'historical'` creates a `manual` MEDIUM priority task with the correct description |
| AC-22 | `sla_layout_days` on the created thread record matches `orders.laboratory.expectedLayoutDays` at the moment of linking |
| AC-23 | Subsequent changes to `orders.laboratory.expectedLayoutDays` do NOT change `sla_layout_days` on an already-linked thread |
| AC-24 | `timeout_at` is set correctly using the priority cascade (explicit deadline > SLA-derived > system default > null) |
| AC-25 | Linking the same `thread_id` to a second order returns `409` with a message identifying the conflicting order |
| AC-26 | Linking a non-existent Gmail thread (404 from Gmail API) returns `404` with code `GMAIL_THREAD_NOT_FOUND` |
| AC-27 | Linking to a non-existent order returns `404` with code `ORDER_NOT_FOUND` |
| AC-28 | Linking with an invalid version number (no matching `lab_interactions` entry) returns `400` |

### 13.4 Thread Unlinking and Closing

| # | Criterion |
|---|-----------|
| AC-29 | `DELETE /api/orders/:id/lab-threads/:threadRecordId` sets `status = 'unlinked'` |
| AC-30 | Unlinking a thread clears `lab_interactions[n].gmail_thread_id` on the Order |
| AC-31 | Unlinking does NOT fire `LAB_THREAD_CLOSED` event on the Order |
| AC-32 | Unlinking an already-`unlinked` or `closed` thread returns `400` |
| AC-33 | `POST .../close` sets `status = 'closed'` and fires `LAB_THREAD_CLOSED` on the Order |

### 13.5 Thread List

| # | Criterion |
|---|-----------|
| AC-34 | `GET /api/orders/:id/lab-threads` returns all threads for the order including `risk` and `slaStatus` fields |
| AC-35 | `slaStatus` is populated correctly for `lab_interaction` threads with `sla_layout_days` set |
| AC-36 | `slaStatus` is `null` for `lab_print_order` threads and for threads with null `sla_layout_days` |

### 13.6 Search

| # | Criterion |
|---|-----------|
| AC-37 | `GET /api/orders/search?name=petrov` returns orders where `client.name` matches case-insensitively |
| AC-38 | `GET /api/orders/search?company=tech` returns orders where `client.companyName` contains "tech" case-insensitively |
| AC-39 | `GET /api/orders/search` with no search parameters returns `400` |
| AC-40 | `GET /api/integrations/gmail/search-threads?q=from:lab@a.com` returns thread summaries with correct fields |
| AC-41 | A thread already linked to an order appears with `isAlreadyLinked: true` and correct `linkedToOrderId` in search results |
| AC-42 | `GET /api/integrations/gmail/search-threads` with no `q` parameter returns `400` |

### 13.7 Backward Compatibility

| # | Criterion |
|---|-----------|
| AC-43 | All existing V1 API endpoints continue to return correct responses (no regressions from Order schema additions) |
| AC-44 | Existing Order documents without `client.email`, `client.companyName`, `laboratory.expectedLayoutDays`, or `laboratory.expectedOriginalDays` load and save without error |
| AC-45 | Existing `lab_interactions` entries without `gmail_thread_id` are unaffected |

---

## 14. Test Scenarios

These are the key end-to-end scenarios to verify after Phase L1 is implemented. Each maps to a set of acceptance criteria above.

| Scenario | Criteria Covered |
|----------|-----------------|
| **Happy path — live link:** Create order with lab SLA → link a thread → verify thread created with correct SLA snapshot, correct `timeout_at`, no review task | AC-01, AC-19, AC-20, AC-22, AC-24 |
| **Happy path — historical link:** Link a historical thread → verify review task created | AC-21 |
| **SLA fallback:** Link thread to order where `laboratory.expectedLayoutDays` is null → verify `timeout_at` uses system default | AC-10 |
| **Conflict detection:** Link same thread to two orders → verify second link returns 409 | AC-25 |
| **Unlink + re-link:** Link thread, unlink it, link same thread to different order → verify this succeeds | AC-04, AC-29, AC-30 |
| **Risk — SLA exceeded:** Set `sla_layout_days = 3`, set `sent_at = 5 days ago` → verify `computeThreadRisk` returns `HIGH` (1.0× exceeded), then `CRITICAL` (1.5× exceeded at day 5 of 3-day SLA) | AC-13, AC-16 |
| **Risk — SLA absent:** Null `sla_layout_days`, deadline 3 days away → verify SLA rules don't fire, deadline risk returns `MEDIUM` | AC-15 |
| **Deadline override:** Set explicit `lab_response_due` → verify `timeout_at` uses the explicit deadline, not SLA | AC-08 |
| **Deadline update propagation:** Link thread → change `lab_response_due` → verify `timeout_at` on thread updates | Phase L2 dependency; note for integration test |
| **Order search:** Search by name, company, phone, email across mixed data → verify partial match, case insensitivity | AC-37, AC-38 |
| **Gmail search:** Search for threads from a lab email → verify `isAlreadyLinked` flag correct | AC-40, AC-41 |
| **Backward compatibility:** Load existing Order without new fields → verify no validation errors | AC-44 |

---

## 15. Implementation Order

Implement in this sequence to minimize blockers:

1. `labCommErrors.js` — error classes needed by everything else
2. `constants.js` additions — needed by service
3. `Order.js` modifications — additive, no breaking changes
4. `LabCommThread.js` model and exports — must exist before service
5. `models/index.js` update — add new exports
6. `googleAuth.js` scope extension — needed by gmailClient
7. `gmailClient.js` — needed by linkThread for count initialization
8. `labCommService.js` — depends on model, gmailClient, constants
9. `labCommRoutes.js` — depends on service
10. `gmailIntegrationRoutes.js` — depends on gmailClient
11. Order search extension — depends on updated Order model
12. Route registration in `server.js`

---

## 16. Rollback Considerations

Phase L1 makes two types of changes:

**Additive changes (safe to leave in place):**
- New `LabCommThread` model and collection — has no effect until documents are created
- New fields on `Order` sub-schemas — ignored by existing code; absent from existing documents
- New indexes — performance-only; don't affect reads or writes
- New constants — unused until service is called
- New routes — unreachable until registered

**Scope change to `googleAuth.js`:**
This is the only change that could affect existing functionality. If adding `gmail.readonly` to the scope causes an existing Sheets auth flow to fail (e.g., token cache invalidation), the scope list can be reverted to Sheets-only. The Gmail scope is only needed when `gmailClient.js` is first called.

**If rollback is needed:** Remove the two new route registrations from `server.js`. All other Phase L1 additions are inert until those routes are active.
