# PHASE L1 — LABORATORY COMMUNICATION AGENT: FOUNDATION
## Implementation Specification

**Status:** Approved for implementation
**Supersedes:** `docs/PHASE_L1_PLAN.md` (preliminary plan)
**Reference:** `docs/LABORATORY_AGENT_ARCHITECTURE.md`
**Prerequisite:** V1 Phases 1–8 complete and passing

---

## 1. File Inventory

### 1.1 Files to Create

| File | Purpose |
|------|---------|
| `backend/src/models/LabCommThread.js` | Mongoose model for `lab_comm_threads` collection |
| `backend/src/integrations/gmailClient.js` | Authenticated Gmail API wrapper |
| `backend/src/services/labCommService.js` | Thread lifecycle, risk computation, SLA logic |
| `backend/src/validators/labCommValidator.js` | Request validation for lab communication routes |

### 1.2 Files to Modify

| File | What Changes |
|------|-------------|
| `backend/src/models/Order.js` | Add 6 new optional fields across 3 sub-schemas; add 5 new indexes |
| `backend/src/models/index.js` | Add `LabCommThread`, `LAB_COMM_STATUSES`, `LAB_COMM_CONTEXTS`, `LAB_COMM_LINK_MODES` exports |
| `backend/src/config/constants.js` | Add `LAB_COMM_*` block with 12 constants |
| `backend/src/utils/errorUtils.js` | Add 4 new error factory functions for Gmail-specific error codes |
| `backend/src/integrations/googleAuth.js` | Add `gmail.readonly` to the OAuth2 scopes array |
| `backend/src/routes/orders.js` | Add 5 new routes: 3 lab-thread routes + 1 lab-thread close route + 1 order search route |
| `backend/src/routes/integrations.js` | Add 1 new route: Gmail thread search |
| `backend/src/routes/index.js` | No prefix changes needed; lab-thread routes mount under existing `/api/orders` |
| `backend/src/services/orderService.js` | Add call to `labCommService.updateTimeoutAfterDeadlineChange()` after deadline is set |

### 1.3 Scheduler Responsibilities in Phase L1

**None.** Phase L1 contains zero scheduler jobs. No cron registration. No polling. No background processes. The `LAB_COMM_POLL_CRON` constant is defined here but first used in Phase L2.

---

## 2. Environment Variables

Add to `.env`. All are optional — constants provide defaults for development.

| Variable | Default in constants.js | Purpose |
|----------|------------------------|---------|
| `LAB_COMM_DEFAULT_LAYOUT_SLA_DAYS` | `5` | System SLA fallback for layout delivery when lab has no SLA set |
| `LAB_COMM_DEFAULT_ORIGINAL_SLA_DAYS` | `10` | System SLA fallback for original document delivery |
| `LAB_COMM_POLL_CRON` | `"*/30 * * * *"` | Defined here, used in Phase L2 |

The existing Google OAuth variables (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `GOOGLE_REFRESH_TOKEN`) are reused by `gmailClient.js` through `googleAuth.js`. No new OAuth variables are required.

---

## 3. Constants Block (`constants.js`)

Add the following block to `backend/src/config/constants.js`. The block is standalone — no changes to existing constants.

### New Constants

| Constant | Value / Source | Type | Purpose |
|----------|---------------|------|---------|
| `LAB_COMM_POLL_CRON` | `process.env.LAB_COMM_POLL_CRON \|\| '*/30 * * * *'` | String | Poll interval expression (Phase L2) |
| `LAB_COMM_MAX_CONSECUTIVE_ERRORS` | `3` | Number | Errors before thread marked `unreachable` |
| `LAB_COMM_BATCH_DELAY_MS` | `200` | Number | Milliseconds between successive Gmail API calls (Phase L2) |
| `LAB_COMM_DEFAULT_LAYOUT_SLA_DAYS` | `parseInt(process.env.LAB_COMM_DEFAULT_LAYOUT_SLA_DAYS) \|\| 5` | Number | Fallback layout SLA when lab has none configured |
| `LAB_COMM_DEFAULT_ORIGINAL_SLA_DAYS` | `parseInt(process.env.LAB_COMM_DEFAULT_ORIGINAL_SLA_DAYS) \|\| 10` | Number | Fallback original SLA when lab has none configured |
| `LAB_COMM_RISK_HIGH_REPLY_HOURS` | `12` | Number | Hours before unactioned reply escalates to HIGH |
| `LAB_COMM_RISK_CRITICAL_REPLY_HOURS` | `48` | Number | Hours before unactioned reply escalates to CRITICAL |
| `LAB_COMM_RISK_CRITICAL_OVERDUE_DAYS` | `3` | Number | Days past `timeout_at` before `timed_out` thread escalates to CRITICAL |
| `LAB_COMM_SEARCH_MAX_RESULTS` | `50` | Number | Hard cap on Gmail thread search results |
| `LAB_COMM_ATTACHMENT_MIMETYPES` | `['application/pdf','image/jpeg','image/png','image/tiff']` | Array | MIME types treated as layout or document attachments |
| `LAB_COMM_AUTO_REPLY_SUBJECTS` | `['Auto:','Automatic reply:','Out of office:']` | Array | Subject prefixes filtered as auto-replies (Phase L2) |

### New Event Codes (add to EVENT_TYPES block)

| Constant | String Value |
|----------|-------------|
| `EVENT_LAB_THREAD_LINKED` | `'LAB_THREAD_LINKED'` |
| `EVENT_LAB_THREAD_CLOSED` | `'LAB_THREAD_CLOSED'` |

The following event codes are defined here but only fired in later phases:

| Constant | String Value | Phase |
|----------|-------------|-------|
| `EVENT_LAB_THREAD_REPLY_DETECTED` | `'LAB_THREAD_REPLY_DETECTED'` | L2 |
| `EVENT_LAB_THREAD_ATTACHMENT_DETECTED` | `'LAB_THREAD_ATTACHMENT_DETECTED'` | L2 |
| `EVENT_LAB_THREAD_TIMED_OUT` | `'LAB_THREAD_TIMED_OUT'` | L3 |

---

## 4. Error Extensions (`errorUtils.js`)

The existing `errorUtils.js` provides `validationError`, `notFoundError`, `conflictError`, `forbiddenError`. The existing `errorHandler.js` middleware maps error codes to HTTP status.

### New Error Factory Functions

Add four factory functions to `errorUtils.js`:

| Function | `code` property | HTTP Status (errorHandler maps this) | When Used |
|----------|----------------|--------------------------------------|-----------|
| `gmailAuthError(message)` | `'GMAIL_AUTH_ERROR'` | `503` | Gmail API returns 401 or 403 |
| `gmailRateLimitError(message)` | `'GMAIL_RATE_LIMITED'` | `503` | Gmail API returns 429 |
| `gmailThreadNotFoundError(message)` | `'GMAIL_THREAD_NOT_FOUND'` | `404` | Gmail API returns 404 for a thread ID |
| `threadAlreadyLinkedError(message, conflictingOrderId)` | `'THREAD_ALREADY_LINKED'` | `409` | Partial unique index violation |

`threadAlreadyLinkedError` must carry the conflicting order ID. Structure the error so the response handler can extract it:
- Set `error.code = 'THREAD_ALREADY_LINKED'`
- Set `error.conflictingOrderId = conflictingOrderId` (a string)

`errorHandler.js` must be updated to include `conflictingOrderId` in the response body when present and `NODE_ENV !== 'production'`. In production, include it always (it is not sensitive information — knowing an order ID exists is not a leak).

Update `errorHandler.js` HTTP status mapping to add:
- `GMAIL_AUTH_ERROR` → `503`
- `GMAIL_RATE_LIMITED` → `503`
- `GMAIL_THREAD_NOT_FOUND` → `404`
- `THREAD_ALREADY_LINKED` → `409`

---

## 5. MongoDB Collection: `lab_comm_threads`

### 5.1 Collection Name

`lab_comm_threads`

### 5.2 Complete Field Specification

| Field | BSON Type | Required | Default | Constraints | Notes |
|-------|-----------|----------|---------|-------------|-------|
| `_id` | ObjectId | Auto | Auto | — | MongoDB default |
| `order_id` | ObjectId | Yes | — | ref: `'Order'` | Foreign key to orders |
| `thread_id` | String | Yes | — | trim | Gmail thread ID |
| `context` | String | Yes | — | enum (see below) | Communication type |
| `lab_interaction_version` | Number | No | — | min: 1, integer | Which `lab_interactions[n]` entry |
| `recipient_email` | String | Yes | — | trim, lowercase | Lab's email address. Set once, never updated. |
| `status` | String | Yes | `'waiting'` | enum (see below) | Thread monitoring lifecycle state |
| `link_mode` | String | Yes | — | enum: `['live','historical']` | Controls first-poll behavior |
| `linked_at` | Date | Yes | — | — | When operator linked this thread |
| `sent_at` | Date | No | — | — | When operator sent the originating email |
| `sla_layout_days` | Number | No | — | min: 1 | Snapshot of `laboratory.expectedLayoutDays` at link time |
| `sla_original_days` | Number | No | — | min: 1 | Snapshot of `laboratory.expectedOriginalDays` at link time |
| `initialized_message_count` | Number | Yes | `0` | min: 0 | Message count at link time. Detection baseline. |
| `last_checked_at` | Date | No | — | — | Set by poller. Null until first poll (Phase L2). |
| `last_known_message_count` | Number | Yes | `0` | min: 0 | Updated on every poll. Secondary detection fallback. |
| `auto_reply_count` | Number | Yes | `0` | min: 0 | Count of filtered auto-replies. Informational. |
| `reply_detected_at` | Date | No | — | — | When first qualifying reply was detected |
| `reply_has_attachment` | Boolean | No | — | — | True if detected reply contains an attachment |
| `reply_sender` | String | No | — | trim | From address of detected reply |
| `timeout_at` | Date | No | — | — | When thread is considered timed out |
| `error_count` | Number | Yes | `0` | min: 0 | Consecutive API errors. Reset on success. |
| `last_error_at` | Date | No | — | — | Timestamp of most recent API error |
| `last_error_message` | String | No | — | trim | Message from most recent API error |
| `created_at` | Date | Yes | `Date.now` | — | Record creation timestamp |

### 5.3 Enum Values

**`context`:**
```
['lab_interaction', 'lab_print_order']
```

**`status`:**
```
['waiting', 'replied', 'timed_out', 'unreachable', 'closed', 'unlinked']
```

**`link_mode`:**
```
['live', 'historical']
```

### 5.4 Indexes

| Index Expression | Options | Purpose |
|-----------------|---------|---------|
| `{ status: 1, last_checked_at: 1 }` | — | Poller: fetch `waiting` threads ordered by least-recently-checked |
| `{ order_id: 1 }` | — | Load all threads for one order |
| `{ thread_id: 1 }` | `unique: true`, `partialFilterExpression: { status: { $in: ['waiting','replied','timed_out','unreachable'] } }` | Prevent same Gmail thread linked to two active records simultaneously |
| `{ status: 1, timeout_at: 1 }` | `sparse: true` | Timeout scan (Phase L3) |
| `{ recipient_email: 1, status: 1 }` | — | Dashboard group-by-laboratory query (Phase L4) |

**Note on the partial unique index:** The `$in` form explicitly names active statuses rather than using `$nin`. This avoids index invalidation if a new status value is added later. When adding a new active status in a future phase, update the `$in` list in this index definition.

### 5.5 Schema Options

```
versionKey: false
timestamps: false   (created_at is managed manually via default: Date.now)
collection: 'lab_comm_threads'
```

---

## 6. MongoDB Schema Modifications: `orders` Collection

All changes are additive. No existing field is modified, renamed, or removed. Existing Order documents without these fields pass validation unchanged.

### 6.1 `laboratory` Sub-Schema — New Fields

| Field | Type | Required | Constraints | Notes |
|-------|------|----------|-------------|-------|
| `expectedLayoutDays` | Number | No | min: 1 | Days lab typically takes to return a layout draft |
| `expectedOriginalDays` | Number | No | min: 1 | Days lab typically takes to dispatch original after print order |

### 6.2 `client` Sub-Schema — New Fields

| Field | Type | Required | Constraints | Notes |
|-------|------|----------|-------------|-------|
| `email` | String | No | trim, lowercase | Client email. Used for order search only. Not used for Gmail tracking. |
| `companyName` | String | No | trim | Organization name. Used for order search. |

### 6.3 `lab_interactions` Sub-Schema — New Fields

| Field | Type | Required | Constraints | Notes |
|-------|------|----------|-------------|-------|
| `gmail_thread_id` | String | No | trim | Gmail thread ID linked to this version's communication |
| `gmail_linked_at` | Date | No | — | When this thread was linked |

### 6.4 New Indexes on `orders`

| Index Expression | Options | Purpose |
|-----------------|---------|---------|
| `{ 'client.name': 1 }` | `collation: { locale: 'en', strength: 2 }` | Case-insensitive applicant name search |
| `{ 'client.companyName': 1 }` | `sparse: true`, `collation: { locale: 'en', strength: 2 }` | Case-insensitive company search |
| `{ 'client.email': 1 }` | `sparse: true` | Exact client email lookup |
| `{ 'laboratory.laboratoryName': 1 }` | `sparse: true` | Dashboard group-by-lab (Phase L4) |
| `{ 'laboratory.laboratoryEmail': 1 }` | `sparse: true` | Thread selector pre-filter (Phase L5) |

---

## 7. Mongoose Model: `LabCommThread.js`

### 7.1 Module Structure

File: `backend/src/models/LabCommThread.js`

```
'use strict'
const mongoose = require('mongoose')
const { Schema } = mongoose

// Constants (unexported, local to this file)
const LAB_COMM_CONTEXTS   = [...]
const LAB_COMM_STATUSES   = [...]
const LAB_COMM_LINK_MODES = [...]

// labCommThreadSchema definition
// LabCommThread model registration
// Exports
```

### 7.2 Schema Definition Rules

Define a single flat schema (no sub-schemas needed). Apply the field spec from Section 5.2 exactly. Key Mongoose-specific notes:

- `_id: true` (default — do not set to false)
- `created_at: { type: Date, default: Date.now }` — use `Date.now` (the function reference), not `Date.now()` (a static value)
- `status: { type: String, enum: LAB_COMM_STATUSES, required: true, default: 'waiting' }`
- `context: { type: String, enum: LAB_COMM_CONTEXTS, required: true }` — no default; caller must supply
- `link_mode: { type: String, enum: LAB_COMM_LINK_MODES, required: true }` — no default
- `initialized_message_count: { type: Number, required: true, default: 0, min: 0 }`
- `last_known_message_count: { type: Number, required: true, default: 0, min: 0 }`
- `auto_reply_count: { type: Number, required: true, default: 0, min: 0 }`
- `error_count: { type: Number, required: true, default: 0, min: 0 }`
- `recipient_email: { type: String, required: true, trim: true, lowercase: true }`

### 7.3 Index Definitions

Define all 5 indexes using `labCommThreadSchema.index(expression, options)` calls after the schema definition. Do not use the `index: true` shorthand on individual fields — the partial unique index requires the `.index()` call form.

### 7.4 Middleware

No pre/post hooks on this schema. The model is a data store; business logic lives in `labCommService.js`.

### 7.5 Exports

```javascript
module.exports = {
  LabCommThread,           // The Mongoose model
  LAB_COMM_CONTEXTS,       // ['lab_interaction', 'lab_print_order']
  LAB_COMM_STATUSES,       // ['waiting', 'replied', 'timed_out', 'unreachable', 'closed', 'unlinked']
  LAB_COMM_LINK_MODES,     // ['live', 'historical']
};
```

---

## 8. `models/index.js` Modifications

Add one require and extend the exports:

```javascript
// Add require:
const { LabCommThread, LAB_COMM_CONTEXTS, LAB_COMM_STATUSES, LAB_COMM_LINK_MODES } = require('./LabCommThread');

// Add to module.exports:
LabCommThread,
LAB_COMM_CONTEXTS,
LAB_COMM_STATUSES,
LAB_COMM_LINK_MODES,
```

---

## 9. `googleAuth.js` Modification

Locate the scopes array in `googleAuth.js`. Currently it contains the Sheets scope. Add `'https://www.googleapis.com/auth/gmail.readonly'` as a second element.

**Result:**
```
scopes: [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/gmail.readonly',
]
```

**Operator action required:** After deployment, the operator must complete a Google OAuth re-authorization flow to grant the new scope. Until re-authorization, Gmail API calls will return 403 and `gmailClient.js` will throw `AuthError`. The existing Sheets integration continues to work during this window — scope changes only take effect after re-auth.

---

## 10. `gmailClient.js` Specification

File: `backend/src/integrations/gmailClient.js`

### 10.1 Dependencies

```
googleAuth.js   — exports the authenticated OAuth2 client
googleapis      — already in package.json; use google.gmail('v1')
```

### 10.2 Module-Level State

One module-level variable:
```
let _operatorEmail = null   // cached after first call to getOperatorEmail()
```

### 10.3 Function: `getOperatorEmail()`

**Purpose:** Returns the email address of the authenticated Google account. Used to identify the operator's own messages in reply detection.

**Steps:**
1. If `_operatorEmail` is not null, return it immediately (cached).
2. Call `gmail.users.getProfile({ userId: 'me' })`.
3. Store `response.data.emailAddress` in `_operatorEmail`.
4. Return `_operatorEmail`.

**Errors:** On 401/403, throw `gmailAuthError('Gmail authentication failed. Re-authorize Google account.')`. On any other error, re-throw with the original message.

---

### 10.4 Function: `getThread(threadId, format = 'metadata')`

**Purpose:** Fetches a Gmail thread object. Used at link time (to get `initialized_message_count`) and during polling (Phase L2).

**Input:**
- `threadId` — String, Gmail thread ID
- `format` — String, one of `'minimal'`, `'metadata'`, `'full'`. Default: `'metadata'`.

**Steps:**
1. Call `gmail.users.threads.get({ userId: 'me', id: threadId, format })`.
2. Return the thread object (`response.data`).

**Return shape (from Gmail API, `format: 'metadata'`):**
```
{
  id: String,
  historyId: String,
  messages: [
    {
      id: String,
      threadId: String,
      labelIds: [String],
      payload: {
        headers: [{ name: String, value: String }],
        parts: [{ mimeType: String, filename: String, ... }]
      },
      internalDate: String   // Unix ms timestamp as string
    }
  ]
}
```
`messages.length` is the message count.

**Errors:**
- HTTP 404: throw `gmailThreadNotFoundError('Thread not found: ' + threadId)`
- HTTP 401 or 403: throw `gmailAuthError('Gmail authentication failed.')`
- HTTP 429: throw `gmailRateLimitError('Gmail API rate limit exceeded.')`
- Other: throw the original error

---

### 10.5 Function: `searchThreads(query, maxResults = 20)`

**Purpose:** Searches Gmail threads by a query string. Returns enriched thread summaries for the UI.

**Input:**
- `query` — String, any valid Gmail search query (`from:`, `to:`, `subject:`, `after:`, `has:attachment`, etc.)
- `maxResults` — Number, capped at `LAB_COMM_SEARCH_MAX_RESULTS`

**Steps:**
1. Clamp `maxResults` to `Math.min(maxResults, LAB_COMM_SEARCH_MAX_RESULTS)`.
2. Call `gmail.users.threads.list({ userId: 'me', q: query, maxResults: clampedMax })`.
3. If no threads returned (`response.data.threads` is absent or empty): return `[]`.
4. For each thread ID in the result: call `getThread(thread.id, 'metadata')`.
5. For each fetched thread, extract:
   - `threadId`: `thread.id`
   - `subject`: value of the `Subject` header from the first message's `payload.headers`
   - `from`: value of the `From` header from the first message
   - `to`: value of the `To` header from the first message
   - `date`: `new Date(parseInt(firstMessage.internalDate))` (Gmail returns ms as string)
   - `messageCount`: `thread.messages.length`
   - `hasAttachment`: true if any message in `thread.messages` has any part where `part.filename` is non-empty and `part.mimeType` is in `LAB_COMM_ATTACHMENT_MIMETYPES`
6. Return the array of summary objects.

**Errors:** Same error handling as `getThread`. A single thread fetch failure does not abort the entire search — skip that thread and continue.

---

### 10.6 Function: `getMessage(messageId, format = 'metadata')`

**Purpose:** Fetches an individual Gmail message. Used in Phase L2 for UNREAD label detection and attachment inspection.

**Input:**
- `messageId` — String
- `format` — Default `'metadata'`

**Steps:** Call `gmail.users.messages.get({ userId: 'me', id: messageId, format })`. Return `response.data`.

**Errors:** Same as `getThread`.

---

### 10.7 Exports

```javascript
module.exports = {
  getOperatorEmail,
  getThread,
  searchThreads,
  getMessage,
};
```

---

## 11. `labCommService.js` Specification

File: `backend/src/services/labCommService.js`

### 11.1 Dependencies

```
LabCommThread      — from models/LabCommThread.js
Order              — from models/Order.js
taskService        — from services/taskService.js
eventService       — from services/eventService.js
gmailClient        — from integrations/gmailClient.js
errorUtils         — from utils/errorUtils.js
constants          — from config/constants.js
```

### 11.2 Function: `computeEffectiveDeadline(thread, order)`

**Purpose:** Returns the best available deadline for a thread, following the SLA priority cascade. Used when setting `timeout_at` at link time and when updating it after a deadline change.

**Inputs:**
- `thread` — plain object or Mongoose document with fields: `context`, `sent_at`, `sla_layout_days`, `sla_original_days`
- `order` — plain object or Mongoose document with fields: `deadlines`

**Return type:** `Date` or `null`

**Algorithm:**

For `context === 'lab_interaction'`:
```
Priority 1: order.deadlines.lab_response_due          (if truthy)
Priority 2: sent_at + sla_layout_days days             (if both truthy)
Priority 3: sent_at + DEFAULT_LAYOUT_SLA_DAYS days     (if sent_at truthy)
Priority 4: null
```

For `context === 'lab_print_order'`:
```
Priority 1: order.deadlines.original_expected          (if truthy)
Priority 2: sent_at + sla_original_days days           (if both truthy)
Priority 3: sent_at + DEFAULT_ORIGINAL_SLA_DAYS days   (if sent_at truthy)
Priority 4: null
```

**Date arithmetic:** `new Date(sent_at.getTime() + days * 86_400_000)`

The function is pure (no database calls). It does not throw.

---

### 11.3 Function: `computeThreadRisk(thread, order)`

**Purpose:** Computes the risk level for a single thread. Called by `getThreadsForOrder`, the dashboard API (Phase L4), and any endpoint that returns thread data with a `risk` field.

**Inputs:**
- `thread` — Mongoose document or plain object from `lab_comm_threads`
- `order` — Mongoose document or plain object from `orders`

**Return type:** `'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'`

**Algorithm:**

Step 1 — Compute `effectiveDeadline` via `computeEffectiveDeadline(thread, order)`.

Step 2 — Compute time distances (all in hours, floating point):
```
hoursOverdue   = timeout_at ? (now - timeout_at) / 3_600_000 : null
hoursUntil     = timeout_at ? (timeout_at - now) / 3_600_000 : null
replyAgeHours  = reply_detected_at ? (now - reply_detected_at) / 3_600_000 : null
waitingDays    = sent_at ? (now - sent_at) / 86_400_000 : null
```

Step 3 — Evaluate deadline-based rules in the following order. Return on first match:

| Condition | Return |
|-----------|--------|
| `status === 'unreachable'` AND `error_count >= LAB_COMM_MAX_CONSECUTIVE_ERRORS` | `'CRITICAL'` |
| `status === 'timed_out'` AND `hoursOverdue > LAB_COMM_RISK_CRITICAL_OVERDUE_DAYS * 24` | `'CRITICAL'` |
| `status === 'replied'` AND `replyAgeHours > LAB_COMM_RISK_CRITICAL_REPLY_HOURS` | `'CRITICAL'` |
| `status === 'replied'` AND `reply_has_attachment === true` | `'HIGH'` |
| `status === 'timed_out'` AND `hoursOverdue > 24` AND `hoursOverdue <= LAB_COMM_RISK_CRITICAL_OVERDUE_DAYS * 24` | `'HIGH'` |
| `status === 'replied'` AND `replyAgeHours > LAB_COMM_RISK_HIGH_REPLY_HOURS` | `'HIGH'` |
| `status === 'waiting'` AND `hoursUntil !== null` AND `hoursUntil > 0` AND `hoursUntil <= 24` | `'HIGH'` |
| `status === 'replied'` AND `replyAgeHours <= LAB_COMM_RISK_HIGH_REPLY_HOURS` | `'MEDIUM'` |
| `status === 'waiting'` AND `hoursUntil !== null` AND `hoursUntil > 24` AND `hoursUntil <= 96` | `'MEDIUM'` |
| `status === 'timed_out'` AND `hoursOverdue !== null` AND `hoursOverdue <= 24` | `'MEDIUM'` |
| `status === 'waiting'` AND `hoursUntil !== null` AND `hoursUntil > 96` | `'LOW'` |
| Any remaining `waiting` state (no deadline) | `'LOW'` |

Step 4 — Evaluate SLA-aware rules. Only applies when ALL of:
- `context === 'lab_interaction'`
- `thread.sla_layout_days` is a positive number
- `thread.sent_at` is a date
- `status === 'waiting'`

```
slaRisk = 'LOW'
if (waitingDays > sla_layout_days * 1.5)    slaRisk = 'CRITICAL'
else if (waitingDays > sla_layout_days)      slaRisk = 'HIGH'
else if (waitingDays >= sla_layout_days * 0.8) slaRisk = 'MEDIUM'
```

Step 5 — Return `MAX(deadlineRisk, slaRisk)`.

Risk ordering for MAX: `CRITICAL` > `HIGH` > `MEDIUM` > `LOW`.

The function is pure (no database calls). It does not throw.

---

### 11.4 Function: `computeOrderRisk(orderId)`

**Purpose:** Returns the highest risk among all active threads for an order.

**Input:** `orderId` — string or ObjectId

**Return type:** `'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | null`

**Steps:**
1. Fetch all `LabCommThread` records where `order_id = orderId` AND `status IN ['waiting','replied','timed_out','unreachable']`.
2. If no records: return `null`.
3. Fetch the Order document.
4. For each thread: call `computeThreadRisk(thread, order)`.
5. Return the maximum risk value.

---

### 11.5 Function: `computeSlaStatus(thread)`

**Purpose:** Returns a human-readable SLA status string for display in the dashboard. Separate function so the dashboard can call it without the full risk computation.

**Input:** `thread` — document with `context`, `sla_layout_days`, `sent_at`

**Return type:** String or `null`

**Algorithm:**
- If `context !== 'lab_interaction'` OR `sla_layout_days` is null OR `sent_at` is null: return `null`.
- Compute `daysWaiting = Math.floor((now - sent_at) / 86_400_000)`.
- If `daysWaiting > sla_layout_days`: return `"SLA exceeded (${daysWaiting}d / ${sla_layout_days}d SLA)"`
- Else: compute `daysLeft = sla_layout_days - daysWaiting`. Return `"SLA: ${daysLeft}d left (${daysWaiting}d / ${sla_layout_days}d SLA)"`

---

### 11.6 Function: `linkThread(params)`

**Purpose:** Creates a `lab_comm_threads` record, updates the Order's `lab_interactions[n]` entry, fires `LAB_THREAD_LINKED` event, and (if historical mode) creates a review task.

**Input object:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `orderId` | String | Yes | Must be a valid ObjectId string |
| `version` | Number | Yes | `lab_interactions` version number (1-based) |
| `threadId` | String | Yes | Gmail thread ID |
| `linkMode` | String | Yes | `'live'` or `'historical'` |
| `sentAt` | Date | No | When operator sent the email; null if unknown |
| `context` | String | Yes | `'lab_interaction'` or `'lab_print_order'` |

**Steps (execute in sequence; abort and throw on any failure):**

1. Fetch Order: `Order.findById(orderId)`. If null: throw `notFoundError('Order not found')`.

2. Validate version: if `context === 'lab_interaction'`, check `order.lab_interactions[version-1]` exists. If not: throw `validationError('lab_interactions version ' + version + ' does not exist on this order')`.

3. Fetch Gmail thread: call `gmailClient.getThread(threadId, 'metadata')`. This verifies accessibility and retrieves current message count. Let errors propagate — `ThreadNotFoundError`, `AuthError` bubble up as-is.

4. Extract `initializedCount = gmailThread.messages.length`.

5. Snapshot SLA values:
   - `slaLayoutDays = order.laboratory?.expectedLayoutDays ?? null`
   - `slaOriginalDays = order.laboratory?.expectedOriginalDays ?? null`

6. Build thread document:
   ```
   {
     order_id:                  orderId,
     thread_id:                 threadId,
     context:                   context,
     lab_interaction_version:   (context === 'lab_interaction') ? version : undefined,
     recipient_email:           order.laboratory?.laboratoryEmail ?? '',
     status:                    'waiting',
     link_mode:                 linkMode,
     linked_at:                 new Date(),
     sent_at:                   sentAt ?? null,
     sla_layout_days:           slaLayoutDays,
     sla_original_days:         slaOriginalDays,
     initialized_message_count: initializedCount,
     last_known_message_count:  initializedCount,
     timeout_at:                computeEffectiveDeadline({ context, sent_at: sentAt, sla_layout_days: slaLayoutDays, sla_original_days: slaOriginalDays }, order),
   }
   ```

7. Create the record: `await LabCommThread.create(doc)`. If MongoDB error code is `11000` (duplicate key — partial unique index violation): throw `threadAlreadyLinkedError('Thread ' + threadId + ' is already monitored for another order', existingConflictOrderId)`. To get `existingConflictOrderId`, run a lookup: `LabCommThread.findOne({ thread_id: threadId, status: { $in: ['waiting','replied','timed_out','unreachable'] } })` and use its `order_id`.

8. Update Order's `lab_interactions[n].gmail_thread_id` and `gmail_linked_at`:
   ```
   Order.findOneAndUpdate(
     { _id: orderId },
     { $set: {
         ['lab_interactions.' + (version-1) + '.gmail_thread_id']: threadId,
         ['lab_interactions.' + (version-1) + '.gmail_linked_at']: new Date(),
     }},
     { new: true }
   )
   ```
   This only applies when `context === 'lab_interaction'`. Skip for `lab_print_order`.

9. Fire event on Order via `eventService.appendEvent(orderId, { type: EVENT_LAB_THREAD_LINKED, description: 'Gmail thread ' + threadId + ' linked (' + context + ', mode: ' + linkMode + ')', actor: 'operator' })`.

10. If `linkMode === 'historical'`: call `taskService.createTask(orderId, 'manual', 'Historical thread linked — verify current state and close if already resolved', 'medium', null, 'auto')`.

11. Return the created `LabCommThread` document.

**Does not validate Order status.** Linking is permitted regardless of the order's current status. The operator is responsible for linking to the correct order.

---

### 11.7 Function: `unlinkThread(threadRecordId)`

**Purpose:** Marks a thread as `unlinked` (data correction). Clears the `gmail_thread_id` from the Order's `lab_interactions` entry.

**Input:** `threadRecordId` — string (the `_id` of the `LabCommThread` document)

**Steps:**
1. Fetch: `LabCommThread.findById(threadRecordId)`. If null: throw `notFoundError('Thread record not found')`.
2. If `status === 'closed'` or `status === 'unlinked'`: throw `validationError('Thread is already ' + thread.status + ' and cannot be unlinked')`.
3. Set `thread.status = 'unlinked'`. Save.
4. If `thread.context === 'lab_interaction'` AND `thread.lab_interaction_version` is set: clear `gmail_thread_id` and `gmail_linked_at` on the Order entry using `$unset`:
   ```
   Order.findOneAndUpdate(
     { _id: thread.order_id },
     { $unset: {
         ['lab_interactions.' + (version-1) + '.gmail_thread_id']: '',
         ['lab_interactions.' + (version-1) + '.gmail_linked_at']: '',
     }}
   )
   ```
5. Do NOT fire `LAB_THREAD_CLOSED`. Do NOT create a task. Unlink is a data correction, not a workflow event.
6. Return the updated thread document.

---

### 11.8 Function: `closeThread(threadRecordId)`

**Purpose:** Marks a thread as `closed` (normal workflow completion). Fires `LAB_THREAD_CLOSED` event.

**Input:** `threadRecordId` — string

**Steps:**
1. Fetch `LabCommThread.findById(threadRecordId)`. If null: throw `notFoundError`.
2. If `status === 'closed'` or `status === 'unlinked'`: throw `validationError('Thread is already ' + thread.status)`.
3. Set `thread.status = 'closed'`. Save.
4. Fire event: `eventService.appendEvent(thread.order_id, { type: EVENT_LAB_THREAD_CLOSED, description: 'Lab thread closed for ' + thread.context + ' (thread: ' + thread.thread_id + ')', actor: 'operator' })`.
5. Return the updated thread document.

---

### 11.9 Function: `getThreadsForOrder(orderId)`

**Purpose:** Returns all `lab_comm_threads` for an order, augmented with computed `risk` and `slaStatus` fields. Used by the Order detail view endpoint.

**Input:** `orderId` — string

**Steps:**
1. Fetch all threads: `LabCommThread.find({ order_id: orderId }).sort({ created_at: -1 })`.
2. If no threads: return `[]`.
3. Fetch the Order document once: `Order.findById(orderId)`.
4. For each thread, add two computed fields:
   - `risk`: result of `computeThreadRisk(thread, order)`
   - `slaStatus`: result of `computeSlaStatus(thread)`
5. Return the augmented array (plain objects, not Mongoose documents — call `.toObject()` on each and spread the computed fields).

---

### 11.10 Function: `updateTimeoutAfterDeadlineChange(orderId, deadlineField)`

**Purpose:** Called by `orderService.js` after a deadline field is updated. Recalculates `timeout_at` on all active threads whose `context` maps to that deadline field.

**Input:**
- `orderId` — string
- `deadlineField` — `'lab_response_due'` or `'original_expected'`

**Mapping:**
- `'lab_response_due'` → context `'lab_interaction'`
- `'original_expected'` → context `'lab_print_order'`

**Steps:**
1. Fetch the Order: `Order.findById(orderId)`.
2. Determine `context` from the mapping above.
3. Fetch all threads: `LabCommThread.find({ order_id: orderId, context, status: { $in: ['waiting', 'timed_out'] } })`.
4. For each thread:
   a. Compute new `timeout_at = computeEffectiveDeadline(thread, order)`.
   b. If `thread.status === 'timed_out'` AND new `timeout_at` is in the future (operator extended the deadline): reset `thread.status = 'waiting'`.
   c. Save.
5. Return the count of updated records.

**`orderService.js` integration point:** In the function that handles deadline updates (the one that fires `ORDER_DEADLINE_SET`), add `await labCommService.updateTimeoutAfterDeadlineChange(orderId, deadlineField)` after the event is fired. This is the only change to `orderService.js` in Phase L1.

---

### 11.11 Function: `searchOrders(params)`

**Purpose:** Searches orders by client name, company, phone, or email. Returns lightweight summaries.

**Input object:**

| Field | Type | Notes |
|-------|------|-------|
| `name` | String | Optional. Partial case-insensitive match on `client.name` |
| `company` | String | Optional. Partial case-insensitive match on `client.companyName` |
| `phone` | String | Optional. Prefix match on `client.phone` |
| `email` | String | Optional. Exact case-insensitive match on `client.email` |
| `status` | String | Optional. Exact match on order `status` |

At least one of `name`, `company`, `phone`, `email` must be provided.

**Steps:**
1. Build MongoDB query as `$and` of all provided conditions:
   - `name`: `{ 'client.name': { $regex: escapeRegex(name), $options: 'i' } }`
   - `company`: `{ 'client.companyName': { $regex: escapeRegex(company), $options: 'i' } }`
   - `phone`: `{ 'client.phone': { $regex: '^' + escapeRegex(phone) } }`
   - `email`: `{ 'client.email': { $regex: '^' + escapeRegex(email) + '$', $options: 'i' } }`
   - `status`: `{ status: status }`
2. `Order.find(query).select('status client.name client.companyName client.phone client.email laboratory.laboratoryName laboratory.laboratoryEmail laboratory.expectedLayoutDays laboratory.expectedOriginalDays created_at').limit(50).lean()`
3. Return array of result objects.

`escapeRegex` is a local helper that escapes special regex characters in the input string. Pattern: `str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`.

---

### 11.12 Function: `searchGmailThreads(query, maxResults)`

**Purpose:** Wraps `gmailClient.searchThreads` and annotates results with `isAlreadyLinked` and `linkedToOrderId`.

**Input:**
- `query` — String, Gmail query
- `maxResults` — Number

**Steps:**
1. Call `gmailClient.searchThreads(query, maxResults)`.
2. Extract all `threadId` values from results.
3. Query `LabCommThread.find({ thread_id: { $in: threadIds }, status: { $in: ['waiting','replied','timed_out','unreachable'] } })` to find which threads are already actively linked.
4. Build a lookup map: `threadId → order_id`.
5. For each result thread: set `isAlreadyLinked = !!map[thread.threadId]` and `linkedToOrderId = map[thread.threadId] ?? null`.
6. Return the annotated array.

---

### 11.13 Exports

```javascript
module.exports = {
  computeEffectiveDeadline,
  computeThreadRisk,
  computeOrderRisk,
  computeSlaStatus,
  linkThread,
  unlinkThread,
  closeThread,
  getThreadsForOrder,
  updateTimeoutAfterDeadlineChange,
  searchOrders,
  searchGmailThreads,
};
```

---

## 12. `labCommValidator.js` Specification

File: `backend/src/validators/labCommValidator.js`

Each validator function throws `validationError(message)` from `errorUtils.js` on failure. On success it returns nothing (validators are guards, not transformers).

### 12.1 `validateLinkThread(body)`

Validates the request body for `POST /api/orders/:id/lab-interactions/:version/lab-thread`.

| Field | Rule |
|-------|------|
| `body.threadId` | Required. Non-empty string. |
| `body.linkMode` | Required. Must be `'live'` or `'historical'`. |
| `body.context` | Required. Must be `'lab_interaction'` or `'lab_print_order'`. |
| `body.sentAt` | Optional. If present, must be a valid ISO 8601 date string that parses to a non-future date. |

### 12.2 `validateVersion(versionParam)`

Validates the `:version` path parameter.

- Must be a string that represents a positive integer (no decimal, no negative).
- `parseInt(versionParam, 10) >= 1`
- Throw `validationError('version must be a positive integer')` if invalid.

### 12.3 `validateOrderId(idParam)`

Validates the `:id` path parameter is a valid MongoDB ObjectId string.

- 24 hex characters, case-insensitive: `/^[0-9a-fA-F]{24}$/`
- Throw `validationError('id must be a valid ObjectId')` if invalid.

### 12.4 `validateOrderSearch(query)`

Validates `GET /api/orders/search` query parameters.

- At least one of `name`, `company`, `phone`, `email` must be present and non-empty.
- Throw `validationError('At least one search parameter (name, company, phone, email) is required')` if none are present.
- `status`, if present, must be one of `ORDER_STATUSES`.
- Each provided string parameter must be at least 2 characters to prevent overly broad searches.

### 12.5 `validateGmailSearch(query)`

Validates `GET /api/integrations/gmail/search-threads` query parameters.

- `q` must be present and non-empty string.
- `maxResults`, if present, must be a positive integer not exceeding `LAB_COMM_SEARCH_MAX_RESULTS`.

---

## 13. Route Additions: `orders.js`

### 13.1 Route Registration Order Warning

The order search route (`GET /api/orders/search`) must be registered **before** the `GET /api/orders/:id` route in `orders.js`. Express evaluates routes in registration order. If `:id` is registered first, the string `'search'` is matched as an order ID, causing a lookup failure instead of the search handler.

### 13.2 `GET /api/orders/search`

```
Method:  GET
Path:    /api/orders/search
Handler: searchOrders in orderController (or inline in route)
```

**Validation:** `validateOrderSearch(req.query)` before handler.

**Handler:** Calls `labCommService.searchOrders(req.query)`. Returns `200` with the result array.

---

### 13.3 `POST /api/orders/:id/lab-interactions/:version/lab-thread`

```
Method:  POST
Path:    /api/orders/:id/lab-interactions/:version/lab-thread
Handler: linkThread
```

**Validation:** `validateOrderId(req.params.id)`, `validateVersion(req.params.version)`, `validateLinkThread(req.body)`.

**Handler:**
```
const thread = await labCommService.linkThread({
  orderId:   req.params.id,
  version:   parseInt(req.params.version, 10),
  threadId:  req.body.threadId,
  linkMode:  req.body.linkMode,
  sentAt:    req.body.sentAt ? new Date(req.body.sentAt) : null,
  context:   req.body.context,
});
res.status(201).json(thread.toObject());
```

Returns `201` on success.

---

### 13.4 `DELETE /api/orders/:id/lab-threads/:threadRecordId`

```
Method:  DELETE
Path:    /api/orders/:id/lab-threads/:threadRecordId
Handler: unlinkThread
```

**Validation:** `validateOrderId(req.params.id)`, `validateOrderId(req.params.threadRecordId)` (both are ObjectId strings).

**Handler:** Calls `labCommService.unlinkThread(req.params.threadRecordId)`. Returns `200` with updated thread document.

---

### 13.5 `POST /api/orders/:id/lab-threads/:threadRecordId/close`

```
Method:  POST
Path:    /api/orders/:id/lab-threads/:threadRecordId/close
Handler: closeThread
```

**Validation:** `validateOrderId(req.params.id)`, `validateOrderId(req.params.threadRecordId)`.

**Handler:** Calls `labCommService.closeThread(req.params.threadRecordId)`. Returns `200` with updated thread document.

---

### 13.6 `GET /api/orders/:id/lab-threads`

```
Method:  GET
Path:    /api/orders/:id/lab-threads
Handler: getThreadsForOrder
```

**Validation:** `validateOrderId(req.params.id)`.

**Handler:** Calls `labCommService.getThreadsForOrder(req.params.id)`. Returns `200` with array (empty array `[]` if no threads).

---

## 14. Route Additions: `integrations.js`

### 14.1 `GET /api/integrations/gmail/search-threads`

```
Method:  GET
Path:    /api/integrations/gmail/search-threads
```

**Validation:** `validateGmailSearch(req.query)`.

**Handler:**
```
const maxResults = req.query.maxResults ? parseInt(req.query.maxResults, 10) : 20;
const threads = await labCommService.searchGmailThreads(req.query.q, maxResults);
res.status(200).json({ threads, count: threads.length, query: req.query.q });
```

---

## 15. Events Fired in Phase L1

| Event Code | Fired By | Trigger | Actor |
|------------|---------|---------|-------|
| `LAB_THREAD_LINKED` | `labCommService.linkThread()` | Thread successfully linked | `'operator'` |
| `LAB_THREAD_CLOSED` | `labCommService.closeThread()` | Thread manually closed | `'operator'` |
| `TASK_CREATED` | `taskService.createTask()` (called by linkThread for historical mode) | Review task created | `'system'` |

**Events NOT fired in Phase L1** (defined in constants but used in later phases):

| Event Code | Phase |
|------------|-------|
| `LAB_THREAD_REPLY_DETECTED` | L2 |
| `LAB_THREAD_ATTACHMENT_DETECTED` | L2 |
| `LAB_THREAD_TIMED_OUT` | L3 |

---

## 16. Validation Rules — Organized by Layer

### 16.1 Mongoose Model Layer (`LabCommThread.js`, `Order.js`)

Enforcement happens at `save()` / `create()` time.

| Rule | Field | Enforcement |
|------|-------|-------------|
| Required fields must be present | `order_id`, `thread_id`, `context`, `recipient_email`, `status`, `link_mode`, `linked_at`, `initialized_message_count`, `last_known_message_count`, `auto_reply_count`, `error_count`, `created_at` | Mongoose `required: true` |
| `context` must be valid | `context` | Mongoose `enum` |
| `status` must be valid | `status` | Mongoose `enum` |
| `link_mode` must be valid | `link_mode` | Mongoose `enum` |
| Numeric minimums | `sla_layout_days`, `sla_original_days`, `lab_interaction_version` must be ≥ 1 if present | Mongoose `min: 1` |
| Count fields ≥ 0 | `initialized_message_count`, `last_known_message_count`, `auto_reply_count`, `error_count` | Mongoose `min: 0` |
| `recipient_email` trimmed and lowercased | `recipient_email` | Mongoose `trim`, `lowercase` |
| Thread uniqueness (active only) | `thread_id` | Partial unique index |

### 16.2 Service Layer (`labCommService.js`)

Business logic validation — runs before database operations.

| Rule | Where Checked | Error Thrown |
|------|--------------|-------------|
| Order must exist | `linkThread` step 1 | `notFoundError` |
| `lab_interactions[version-1]` must exist | `linkThread` step 2 | `validationError` |
| Gmail thread must be accessible | `linkThread` step 3 (via gmailClient) | `gmailThreadNotFoundError` |
| Thread cannot be linked to two active orders | `linkThread` step 7 (via MongoDB E11000) | `threadAlreadyLinkedError` |
| Cannot unlink a `closed` or `unlinked` thread | `unlinkThread` step 2 | `validationError` |
| Cannot close a `closed` or `unlinked` thread | `closeThread` step 2 | `validationError` |
| At least one search field required | `searchOrders` | `validationError` (via validator) |

### 16.3 Route Layer (`labCommValidator.js`)

Structural validation — runs before the service is called.

| Rule | Where Checked | Error Thrown |
|------|--------------|-------------|
| `:id` and `:threadRecordId` are valid ObjectId format | All lab thread routes | `validationError` |
| `:version` is a positive integer | Link route | `validationError` |
| `threadId` is present and non-empty | Link route body | `validationError` |
| `linkMode` is `'live'` or `'historical'` | Link route body | `validationError` |
| `context` is valid enum value | Link route body | `validationError` |
| `sentAt` if provided is a valid past date | Link route body | `validationError` |
| At least one search param present and ≥ 2 chars | Order search | `validationError` |
| `q` is present and non-empty | Gmail search | `validationError` |

---

## 17. API Request / Response Examples

### 17.1 Link a Thread — Live Mode

**Request:**
```
POST /api/orders/6484a1c2e5f3b2a1d0c8e012/lab-interactions/1/lab-thread
Content-Type: application/json

{
  "threadId":  "18f4c2b7d9e3a1f6",
  "linkMode":  "live",
  "sentAt":    "2026-06-11T09:00:00.000Z",
  "context":   "lab_interaction"
}
```

**Response 201:**
```json
{
  "_id":                       "6484b2c3f7a4d1e8c9b0f301",
  "order_id":                  "6484a1c2e5f3b2a1d0c8e012",
  "thread_id":                 "18f4c2b7d9e3a1f6",
  "context":                   "lab_interaction",
  "lab_interaction_version":   1,
  "recipient_email":           "lab@certlab.com",
  "status":                    "waiting",
  "link_mode":                 "live",
  "linked_at":                 "2026-06-11T10:00:00.000Z",
  "sent_at":                   "2026-06-11T09:00:00.000Z",
  "sla_layout_days":           3,
  "sla_original_days":         10,
  "initialized_message_count": 1,
  "last_known_message_count":  1,
  "auto_reply_count":          0,
  "reply_detected_at":         null,
  "reply_has_attachment":      null,
  "reply_sender":              null,
  "timeout_at":                "2026-06-14T09:00:00.000Z",
  "error_count":               0,
  "last_error_at":             null,
  "last_error_message":        null,
  "created_at":                "2026-06-11T10:00:00.000Z",
  "risk":                      "LOW"
}
```

Note: `timeout_at = sent_at + sla_layout_days = June 11 + 3 days = June 14`. Operator did not set an explicit deadline — SLA-derived timeout is used.

---

### 17.2 Link a Thread — Historical Mode

**Request:**
```
POST /api/orders/6484a1c2e5f3b2a1d0c8e012/lab-interactions/1/lab-thread
Content-Type: application/json

{
  "threadId":  "17e3b1a6c8d2f0e9",
  "linkMode":  "historical",
  "sentAt":    "2026-05-20T10:00:00.000Z",
  "context":   "lab_interaction"
}
```

**Response 201:** Same shape as 17.1 but:
- `link_mode`: `"historical"`
- `initialized_message_count`: reflects actual Gmail thread message count at link time (e.g., `3` if thread had 3 messages)
- `last_known_message_count`: same as `initialized_message_count`
- `timeout_at`: derived from SLA or explicit deadline
- A `manual` task is also created on the Order (not reflected in this response; visible via `GET /api/orders/:id/tasks`)

---

### 17.3 Conflict — Thread Already Linked

**Request:** Same `threadId` already actively linked to a different order.

**Response 409:**
```json
{
  "code":               "THREAD_ALREADY_LINKED",
  "message":            "Thread 18f4c2b7d9e3a1f6 is already actively monitored for another order",
  "conflictingOrderId": "6484a1c2e5f3b2a1d0c8e099"
}
```

---

### 17.4 Unlink a Thread

**Request:**
```
DELETE /api/orders/6484a1c2e5f3b2a1d0c8e012/lab-threads/6484b2c3f7a4d1e8c9b0f301
```

**Response 200:**
```json
{
  "_id":       "6484b2c3f7a4d1e8c9b0f301",
  "thread_id": "18f4c2b7d9e3a1f6",
  "status":    "unlinked",
  "order_id":  "6484a1c2e5f3b2a1d0c8e012"
}
```

---

### 17.5 Close a Thread

**Request:**
```
POST /api/orders/6484a1c2e5f3b2a1d0c8e012/lab-threads/6484b2c3f7a4d1e8c9b0f301/close
```

**Response 200:** Full thread document with `"status": "closed"`.

---

### 17.6 List Threads for an Order

**Request:**
```
GET /api/orders/6484a1c2e5f3b2a1d0c8e012/lab-threads
```

**Response 200 (order has two threads):**
```json
[
  {
    "_id":                     "6484b2c3f7a4d1e8c9b0f301",
    "order_id":                "6484a1c2e5f3b2a1d0c8e012",
    "thread_id":               "18f4c2b7d9e3a1f6",
    "context":                 "lab_interaction",
    "lab_interaction_version": 1,
    "recipient_email":         "lab@certlab.com",
    "status":                  "waiting",
    "link_mode":               "live",
    "linked_at":               "2026-06-11T10:00:00.000Z",
    "sent_at":                 "2026-06-11T09:00:00.000Z",
    "sla_layout_days":         3,
    "sla_original_days":       10,
    "initialized_message_count": 1,
    "last_known_message_count":  1,
    "auto_reply_count":        0,
    "reply_detected_at":       null,
    "reply_has_attachment":    null,
    "timeout_at":              "2026-06-14T09:00:00.000Z",
    "error_count":             0,
    "created_at":              "2026-06-11T10:00:00.000Z",
    "risk":                    "LOW",
    "slaStatus":               "SLA: 3d left (0d / 3d SLA)"
  },
  {
    "_id":                     "6484b2c3f7a4d1e8c9b0f302",
    "order_id":                "6484a1c2e5f3b2a1d0c8e012",
    "thread_id":               "19a5d3c1e7b4f2a8",
    "context":                 "lab_print_order",
    "lab_interaction_version": null,
    "recipient_email":         "lab@certlab.com",
    "status":                  "waiting",
    "link_mode":               "live",
    "sla_layout_days":         3,
    "sla_original_days":       10,
    "timeout_at":              "2026-06-21T08:00:00.000Z",
    "error_count":             0,
    "created_at":              "2026-06-11T10:05:00.000Z",
    "risk":                    "LOW",
    "slaStatus":               null
  }
]
```

Note: `slaStatus` is `null` for `lab_print_order` threads — SLA status display is only for `lab_interaction` context.

---

### 17.7 Order Search

**Request:**
```
GET /api/orders/search?name=petrov&status=IN_LAB
```

**Response 200:**
```json
{
  "results": [
    {
      "_id":    "6484a1c2e5f3b2a1d0c8e012",
      "status": "IN_LAB",
      "client": {
        "name":        "Petrov, Ivan",
        "companyName": null,
        "phone":       "+79001234567",
        "email":       null
      },
      "laboratory": {
        "laboratoryName":        "CertLab",
        "laboratoryEmail":       "lab@certlab.com",
        "expectedLayoutDays":    3,
        "expectedOriginalDays":  10
      },
      "created_at": "2026-06-01T08:00:00.000Z"
    }
  ],
  "count": 1
}
```

---

### 17.8 Gmail Thread Search

**Request:**
```
GET /api/integrations/gmail/search-threads?q=from%3Alab%40certlab.com&maxResults=10
```

Decoded: `q=from:lab@certlab.com`

**Response 200:**
```json
{
  "threads": [
    {
      "threadId":          "18f4c2b7d9e3a1f6",
      "subject":           "Certification request — Petrov",
      "from":              "operator@gmail.com",
      "to":                "lab@certlab.com",
      "date":              "2026-06-11T09:00:00.000Z",
      "messageCount":      1,
      "hasAttachment":     false,
      "isAlreadyLinked":   true,
      "linkedToOrderId":   "6484a1c2e5f3b2a1d0c8e012"
    },
    {
      "threadId":          "17e3b1a6c8d2f0e9",
      "subject":           "Certification — Ivanov company",
      "from":              "operator@gmail.com",
      "to":                "lab@certlab.com",
      "date":              "2026-06-09T14:30:00.000Z",
      "messageCount":      3,
      "hasAttachment":     true,
      "isAlreadyLinked":   false,
      "linkedToOrderId":   null
    }
  ],
  "count": 2,
  "query": "from:lab@certlab.com"
}
```

---

### 17.9 Error Responses

All errors use the format established by `errorHandler.js`:

**Validation error (422):**
```json
{
  "code":    "VALIDATION_ERROR",
  "message": "threadId is required"
}
```

**Not found (404):**
```json
{
  "code":    "NOT_FOUND",
  "message": "Order not found"
}
```

**Gmail auth failure (503):**
```json
{
  "code":    "GMAIL_AUTH_ERROR",
  "message": "Gmail authentication failed. Re-authorize Google account."
}
```

**Gmail thread not found (404):**
```json
{
  "code":    "GMAIL_THREAD_NOT_FOUND",
  "message": "Thread 18f4c2b7d9e3a1f6 not found or inaccessible"
}
```

**Conflict — thread already linked (409):**
```json
{
  "code":               "THREAD_ALREADY_LINKED",
  "message":            "Thread 18f4c2b7d9e3a1f6 is already actively monitored for another order",
  "conflictingOrderId": "6484a1c2e5f3b2a1d0c8e099"
}
```

---

## 18. Acceptance Criteria

### 18.1 Model and Schema (AC-M)

| ID | Criterion | Verification |
|----|-----------|-------------|
| AC-M1 | `LabCommThread.create()` succeeds with all required fields provided and valid enum values | Create a valid document; no error thrown |
| AC-M2 | `LabCommThread.create()` fails when `context` is not in the allowed enum | Create with `context: 'invalid'`; expect Mongoose `ValidationError` |
| AC-M3 | `LabCommThread.create()` fails when `status` is an invalid enum value | Create with `status: 'pending'`; expect `ValidationError` |
| AC-M4 | `LabCommThread.create()` fails when `sla_layout_days` is less than 1 | Create with `sla_layout_days: 0`; expect `ValidationError` |
| AC-M5 | Partial unique index blocks: two records with the same `thread_id` both in `waiting` status | Create record A; attempt record B with same `thread_id` and `status: 'waiting'`; expect E11000 |
| AC-M6 | Partial unique index allows: one `unlinked` and one `waiting` record with the same `thread_id` | Create and unlink record A; create record B with same `thread_id`; no error |
| AC-M7 | `Order.create()` accepts `laboratory.expectedLayoutDays` and `laboratory.expectedOriginalDays` as valid numbers | Create order with these fields; confirm they persist |
| AC-M8 | Existing Order documents load without error after schema update | Load a document that has no `expectedLayoutDays`; no validation error |
| AC-M9 | `Order.lab_interactions[n].gmail_thread_id` persists correctly after `findOneAndUpdate` | Set via atomic update; reload and confirm value |

### 18.2 SLA and Risk Computation (AC-R)

| ID | Criterion | Verification |
|----|-----------|-------------|
| AC-R1 | `computeEffectiveDeadline` returns `order.deadlines.lab_response_due` when set, regardless of SLA | Thread with sla_layout_days=3, order with lab_response_due=tomorrow; result = tomorrow |
| AC-R2 | `computeEffectiveDeadline` returns `sent_at + sla_layout_days` when no explicit deadline and SLA set | `sent_at=today`, `sla_layout_days=3`, no deadline; result = today + 3 days |
| AC-R3 | `computeEffectiveDeadline` returns `sent_at + DEFAULT_LAYOUT_SLA_DAYS` when both deadline and sla_layout_days are null | No deadline, null SLA, sent_at=today; result = today + 5 days (default) |
| AC-R4 | `computeEffectiveDeadline` returns null when `sent_at` is null and no explicit deadline | All null; result = null |
| AC-R5 | `computeThreadRisk` returns CRITICAL for `unreachable` with `error_count >= 3` | Thread with status=unreachable, error_count=3; result = CRITICAL |
| AC-R6 | `computeThreadRisk` returns CRITICAL for `replied` with `reply_detected_at` 49h ago | Thread with status=replied, reply_detected_at=49h ago; result = CRITICAL |
| AC-R7 | `computeThreadRisk` returns HIGH for `replied` with `reply_has_attachment=true` regardless of reply age | Thread with status=replied, reply_has_attachment=true, reply_detected_at=1h ago; result = HIGH |
| AC-R8 | `computeThreadRisk` returns HIGH via SLA rule: waiting thread with sent_at 4 days ago and sla_layout_days=3 | sent_at=4d ago, sla_layout_days=3, status=waiting; result = HIGH (SLA exceeded at 1.33×) |
| AC-R9 | `computeThreadRisk` SLA CRITICAL: waiting 5d, sla_layout_days=3 (>1.5×) | sent_at=5d ago, sla_layout_days=3; result = CRITICAL (5 > 3×1.5=4.5) |
| AC-R10 | `computeThreadRisk` SLA rules do not fire when `sla_layout_days` is null | Thread with null sla_layout_days, waiting 10 days, no deadline; result = LOW |
| AC-R11 | `computeThreadRisk` returns MAX: deadline risk=HIGH, SLA risk=CRITICAL → result=CRITICAL | Verify MAX function works across all combinations |
| AC-R12 | `computeOrderRisk` returns CRITICAL when one of two threads is CRITICAL | Two threads: LOW and CRITICAL; result = CRITICAL |
| AC-R13 | `computeOrderRisk` returns null when no active threads | No threads in waiting/replied/timed_out/unreachable; result = null |
| AC-R14 | `computeSlaStatus` returns "SLA exceeded" string when days_waiting > sla_layout_days | sent_at=5d ago, sla_layout_days=3; result includes "exceeded" |
| AC-R15 | `computeSlaStatus` returns null for `lab_print_order` context | context=lab_print_order; result = null regardless of other values |

### 18.3 Thread Linking (AC-L)

| ID | Criterion | Verification |
|----|-----------|-------------|
| AC-L1 | Successful link creates record in `lab_comm_threads` | POST; confirm record in DB |
| AC-L2 | Successful link updates `orders.lab_interactions[0].gmail_thread_id` | POST version=1; reload order; confirm field set |
| AC-L3 | SLA values are snapshotted at link time from `orders.laboratory` | Create order with expectedLayoutDays=4; link thread; confirm sla_layout_days=4 on thread |
| AC-L4 | Changing `expectedLayoutDays` on order after linking does NOT change `sla_layout_days` on thread | Link, then update order laboratory SLA; reload thread; confirm sla_layout_days unchanged |
| AC-L5 | `timeout_at` set to `sent_at + sla_layout_days` when no explicit deadline | No deadline, sla_layout_days=3, sent_at provided; confirm timeout_at = sent_at + 3d |
| AC-L6 | `link_mode: 'historical'` creates a `manual` review task on the order | POST with historical mode; query tasks for order; confirm task exists with correct description |
| AC-L7 | `link_mode: 'live'` does NOT create a review task | POST with live mode; no new manual task created |
| AC-L8 | Duplicate active link returns 409 with `conflictingOrderId` | Link thread to order A; attempt to link same thread to order B; confirm 409 and correct order ID |
| AC-L9 | Duplicate link to same order with same thread does not throw 409 (same thread, two different orders is the blocked case) | Note: same thread cannot be linked to the SAME order twice either due to same partial index — confirm the 409 response is clear |
| AC-L10 | Non-existent Gmail thread returns 404 with GMAIL_THREAD_NOT_FOUND | POST with a threadId that doesn't exist; confirm 404 |
| AC-L11 | Non-existent order returns 404 | POST with an orderId that doesn't exist; confirm 404 |
| AC-L12 | Non-existent version returns 400 | POST to `/lab-interactions/99/lab-thread` on order with only version 1; confirm 400 |
| AC-L13 | `LAB_THREAD_LINKED` event appears in the order's events array | POST; reload order; confirm event present |

### 18.4 Unlink and Close (AC-U)

| ID | Criterion | Verification |
|----|-----------|-------------|
| AC-U1 | Unlink sets status to `unlinked` | DELETE; confirm status on reloaded record |
| AC-U2 | Unlink clears `gmail_thread_id` from `orders.lab_interactions[n]` | DELETE; reload order; confirm field absent |
| AC-U3 | Unlink does NOT fire `LAB_THREAD_CLOSED` event | DELETE; reload order events; no LAB_THREAD_CLOSED entry |
| AC-U4 | Cannot unlink an already-`closed` thread (400) | Close thread, then attempt to unlink; expect 400 |
| AC-U5 | Cannot unlink an already-`unlinked` thread (400) | Unlink, then attempt unlink again; expect 400 |
| AC-U6 | Close sets status to `closed` | POST close; confirm status |
| AC-U7 | Close fires `LAB_THREAD_CLOSED` event on order | POST close; reload order events; confirm event |
| AC-U8 | After unlink, the same `thread_id` can be linked to a different order (partial index allows this) | Unlink; link same thread to different order; success |

### 18.5 Search (AC-S)

| ID | Criterion | Verification |
|----|-----------|-------------|
| AC-S1 | Order search by `name` returns case-insensitive partial match | Create order with name "Petrov Ivan"; search `name=petrov`; confirm match |
| AC-S2 | Order search by `company` returns partial match | Create order with companyName "TechCorp"; search `company=tech`; confirm match |
| AC-S3 | Order search by `phone` returns prefix match | Create order with phone "+79001234567"; search `phone=+7900`; confirm match |
| AC-S4 | Order search by `email` returns exact case-insensitive match | Create order with email "test@example.com"; search `email=TEST@EXAMPLE.COM`; confirm match |
| AC-S5 | Order search with no params returns 400 | GET /search with no query params; confirm 400 |
| AC-S6 | Gmail thread search returns `isAlreadyLinked: true` for linked thread | Link thread; search via Gmail endpoint with query matching that thread; confirm flag |
| AC-S7 | Gmail thread search with no `q` param returns 400 | GET /gmail/search-threads with no q; confirm 400 |
| AC-S8 | Gmail search passes `maxResults` correctly and respects cap | Request maxResults=200; actual call to Gmail uses LAB_COMM_SEARCH_MAX_RESULTS |

### 18.6 Deadline Propagation (AC-D)

| ID | Criterion | Verification |
|----|-----------|-------------|
| AC-D1 | Setting `lab_response_due` on an order updates `timeout_at` on associated `waiting` lab_interaction threads | Link thread (SLA-derived timeout); then set explicit deadline via order service; reload thread; confirm timeout_at updated |
| AC-D2 | Setting `original_expected` updates `timeout_at` on associated `waiting` lab_print_order threads | Same as AC-D1 for print order context |
| AC-D3 | Extending a deadline on a `timed_out` thread resets it to `waiting` | Thread in timed_out; extend deadline to future; thread status becomes `waiting` |

### 18.7 Backward Compatibility (AC-BC)

| ID | Criterion | Verification |
|----|-----------|-------------|
| AC-BC1 | All existing V1 order API endpoints return unchanged responses | Call each order endpoint that was working before Phase L1; confirm same shape and status codes |
| AC-BC2 | Existing Order documents without new fields validate and save without error | Load existing document; save without setting new fields; no error |
| AC-BC3 | `GET /api/orders/:id` on an order with no linked threads includes no `lab_comm` field (or empty array) | Call endpoint on order with no threads; confirm no unexpected fields in response |

---

## 19. Implementation Order

Implement in this sequence. Each step depends on the previous.

| Step | File | Rationale |
|------|------|-----------|
| 1 | `utils/errorUtils.js` | Required by all subsequent steps that throw errors |
| 2 | `middleware/errorHandler.js` | Add new code→status mappings |
| 3 | `config/constants.js` | Required by model and service |
| 4 | `models/LabCommThread.js` | Required by service |
| 5 | `models/Order.js` | New fields required by service (SLA snapshot) |
| 6 | `models/index.js` | Export new model |
| 7 | `integrations/googleAuth.js` | Scope extension required by gmailClient |
| 8 | `integrations/gmailClient.js` | Required by labCommService.linkThread |
| 9 | `services/labCommService.js` | Requires model, gmailClient, eventService, taskService |
| 10 | `validators/labCommValidator.js` | Required by routes |
| 11 | `routes/orders.js` | Add search and lab-thread routes |
| 12 | `routes/integrations.js` | Add Gmail search route |
| 13 | `services/orderService.js` | Add deadline change hook |

---

## 20. Scope Boundaries

**In scope for Phase L1:**
- All items in the file inventory (Section 1)
- All new constants, error codes, model fields, indexes
- All 5 routes and their validation
- All service functions listed in Section 11
- The `orderService.js` deadline hook (Section 11.10)
- All acceptance criteria in Section 18

**Explicitly out of scope for Phase L1:**
- Polling loop (`labCommPoller.js`) — Phase L2
- UNREAD label detection — Phase L2
- Auto-reply filtering — Phase L2
- Thread timeout scanning — Phase L3
- Risk-based dashboard panel — Phase L4
- Thread selector UI — Phase L5
- Any cron job registration
- Any changes to the scheduler
- Any changes to `attentionEngine.js`
