# V1 IMPLEMENTATION PLAN
## Certification Workflow Management System

---

## How to Use This Document

This plan is the authoritative implementation roadmap for V1. It translates the approved architecture into a concrete sequence of work.

**Before starting any phase:**
- Read the objective and verify all dependencies are met.
- Read the acceptance criteria — these define "done," not task completion.
- Read the risks — they describe where the phase is most likely to drift or fail.

**During any phase:**
- If a task feels like it is outside the phase's objective, stop and check the scope guardrails below.
- Do not build for the next phase inside the current one.
- Do not add error handling, abstractions, or features that are not required by the acceptance criteria.

**Reference documents:**
- `PROJECT_COMPASS.md` — purpose, principles, what is in and out of scope
- `ARCHITECTURE.md` — system map, component responsibilities
- `DATABASE_DESIGN.md` — collection field definitions, indexes
- `PROCESS_STATES.md` — order lifecycle, transitions, closure gates
- `WORKFLOW_EVENTS.md` — event codes, task creation rules, transition preconditions

---

## Scope Guardrails

These items are permanently out of scope for all phases of V1. If a task or discussion leads toward any of these, stop and refer back to `PROJECT_COMPASS.md — Out of Scope`.

| Never Build in V1 | Reason |
|-------------------|--------|
| Automated sending of emails or WhatsApp/Telegram messages | Violates Design Principle 7 |
| Client-facing portal or public URLs | Out of scope |
| Multi-user accounts or role-based access | Out of scope |
| Reporting, charts, or analytics | Out of scope |
| Telegram, Instagram, or Facebook integrations | Out of scope |
| Mobile application | Out of scope |
| PDF generation or document export | Out of scope |
| Hard deletion of any Order, Declaration, or Event | Violates Design Principle 6 |
| Any transition that executes without operator confirmation | Violates Design Principle 7 |

---

## Project File Structure

The complete file tree that will exist after all 8 phases are complete.

```
certification-workflow/
├── docs/                            ← architecture documentation (complete)
├── src/
│   ├── config/
│   │   ├── db.js                    ← MongoDB connection (Phase 1)
│   │   ├── env.js                   ← environment variable validation (Phase 1)
│   │   └── constants.js             ← business thresholds (Phase 5)
│   ├── models/
│   │   ├── Order.js                 ← (Phase 2)
│   │   ├── Declaration.js           ← (Phase 2)
│   │   ├── Task.js                  ← (Phase 2)
│   │   └── index.js                 ← (Phase 2)
│   ├── services/
│   │   ├── orderService.js          ← state machine + CRUD (Phase 3)
│   │   ├── eventService.js          ← event append logic (Phase 3)
│   │   ├── taskService.js           ← task lifecycle + deduplication (Phase 4)
│   │   ├── declarationService.js    ← Declaration CRUD + sync (Phase 7)
│   │   └── dashboardService.js      ← attention query aggregation (Phase 5)
│   ├── controllers/
│   │   ├── orderController.js       ← (Phase 3)
│   │   ├── taskController.js        ← (Phase 4)
│   │   ├── declarationController.js ← (Phase 7)
│   │   └── dashboardController.js   ← (Phase 5)
│   ├── routes/
│   │   ├── orders.js                ← (Phase 3)
│   │   ├── tasks.js                 ← (Phase 4)
│   │   ├── declarations.js          ← (Phase 7)
│   │   └── dashboard.js             ← (Phase 5)
│   ├── integrations/
│   │   ├── googleAuth.js            ← Google OAuth2 client (Phase 6)
│   │   ├── formsIntake.js           ← Form submission detection (Phase 6)
│   │   └── sheetsSync.js            ← Declaration bidirectional sync (Phase 7)
│   ├── scheduler/
│   │   ├── attentionEngine.js       ← deadline checks + task generation (Phase 8)
│   │   └── index.js                 ← cron job setup (Phase 8)
│   ├── middleware/
│   │   ├── auth.js                  ← single-user session auth (Phase 1)
│   │   └── errorHandler.js          ← global error handler (Phase 1)
│   └── server.js                    ← Express app entry point (Phase 1)
├── .env.example                     ← (Phase 1)
├── .gitignore                       ← (Phase 1)
└── package.json                     ← (Phase 1)
```

---

## Cross-Phase Conventions

These conventions apply across all phases. Establish them in Phase 1 and never deviate.

**Authentication:** Single-user session. All API routes are protected. No public endpoints.

**Error handling:** All service-layer errors are thrown as structured objects with a `code` and `message`. The global error handler in `middleware/errorHandler.js` catches everything and returns a consistent response shape. Controllers never contain try/catch logic.

**No direct database writes outside models and services.** Controllers call services. Services call models. Nothing else touches MongoDB.

**All business thresholds** (stale intake days, reminder intervals, response deadlines) are defined as named constants in `src/config/constants.js`, not hardcoded in logic.

**Design Principle 7 enforcement:** Any API endpoint that performs an action listed under "always require explicit human approval" must require a `confirmed: true` parameter in the request body. The service layer validates this and rejects the request if it is absent.

---

## Phase 1 — Project Skeleton

### Objective

Create a working Node.js/Express application that connects to MongoDB, enforces authentication on all routes, handles errors consistently, and serves a health check endpoint. Establish the folder structure that all subsequent phases build into.

No business logic. No models. No routes beyond health check.

### Dependencies

None. This is the foundation.

### Files to Create

| File | Purpose |
|------|---------|
| `package.json` | Project metadata and all V1 dependencies declared upfront |
| `.env.example` | Documents every required environment variable with descriptions |
| `.gitignore` | Excludes `.env`, `node_modules/`, `uploads/`, OS files |
| `src/server.js` | Express app: middleware stack, route mounting, server start |
| `src/config/db.js` | MongoDB connection with retry logic and connection event logging |
| `src/config/env.js` | Validates all required environment variables on startup; crashes with a clear message if any are missing |
| `src/middleware/auth.js` | Session-based authentication; rejects unauthenticated requests with 401 |
| `src/middleware/errorHandler.js` | Global error handler; returns `{ code, message }` shape for all errors |

### Environment Variables to Document in `.env.example`

```
PORT                    ← Express server port
MONGODB_URI             ← MongoDB connection string
SESSION_SECRET          ← Session signing secret (min 32 chars)
OPERATOR_PASSWORD       ← Single-user login password
GOOGLE_CLIENT_ID        ← (used in Phase 6)
GOOGLE_CLIENT_SECRET    ← (used in Phase 6)
GOOGLE_REDIRECT_URI     ← (used in Phase 6)
GOOGLE_REFRESH_TOKEN    ← (used in Phase 6)
DECLARATION_SHEET_ID    ← (used in Phase 6–7)
DECLARATION_SHEET_NAME  ← (used in Phase 6–7)
SCHEDULER_CRON          ← cron expression (used in Phase 8)
SCHEDULER_TIMEZONE      ← IANA timezone string (used in Phase 8)
```

### Acceptance Criteria

- Server starts without errors using only `.env` values
- `GET /health` returns `{ status: "ok", db: "connected" }` with HTTP 200
- `GET /health` returns `{ status: "ok", db: "disconnected" }` with HTTP 503 if MongoDB is unreachable
- All routes except `/health` and `/auth/login` return 401 if no valid session exists
- Any missing required environment variable causes the process to exit on startup with a clear error naming the missing variable
- `.gitignore` verified: committing `.env` is blocked

### Risks

| Risk | Mitigation |
|------|-----------|
| Google credentials committed to version control | `.gitignore` must include `.env`; verify before first commit |
| `SESSION_SECRET` left as a placeholder value in production | `env.js` validates minimum length (32 characters) |
| MongoDB URI not abstracted — connection logic scattered later | All DB access goes through `config/db.js` only; direct `mongoose.connect` calls elsewhere are not permitted |

---

## Phase 2 — MongoDB Models

### Objective

Define the three MongoDB collections from `DATABASE_DESIGN.md` as Mongoose schemas. Establish all field types, embedded sub-documents, and indexes. No business logic belongs here — only structure and validation.

### Dependencies

- Phase 1 complete (`src/config/db.js` available)

### Files to Create

| File | Purpose |
|------|---------|
| `src/models/Order.js` | Order schema with all embedded arrays and objects |
| `src/models/Declaration.js` | Declaration schema matching the Google Sheets structure |
| `src/models/Task.js` | Task schema with status enum and order reference |
| `src/models/index.js` | Exports all three models from a single entry point |

### Field Coverage Requirements

Each model must implement every field defined in `DATABASE_DESIGN.md`. The following embedded structures in the Order model require particular attention:

- `client` object (4 fields)
- `laboratory` object (3 fields)
- `pricing` object (3 fields)
- `deadlines` object (3 date fields — these drive all scheduler logic)
- `payments` array (7 fields including `voided` and `voided_reason`)
- `lab_interactions` array (7 fields including `reminder_count`)
- `layouts` array (8 fields including `client_decision` enum)
- `original` object (4 fields)
- `events` array (4 fields — `type` must accept any string to support all event codes in `WORKFLOW_EVENTS.md`)
- `balance_due` maintained at the top level of the order

### Indexes to Define

As specified in `DATABASE_DESIGN.md`:

**Orders:** `status`, `deadlines.lab_response_due`, `deadlines.client_response_due`, `deadlines.original_expected`, `declaration_id`, `client.phone`, `created_at`

**Declarations:** `order_id`, `sheet_row_id` (unique sparse), `sync_status`

**Tasks:** compound index on `(order_id, type, status)` for deduplication queries; `(status, due_date)` for dashboard queries

### Acceptance Criteria

- All three models can be imported from `src/models/index.js`
- A document can be created, read, and updated for each model without errors
- All indexes are confirmed present via MongoDB index inspection
- `status` field on Order rejects values not in the 8-value enum
- `client_decision` on layout entries rejects values outside `approved` / `corrections_requested`
- `task.status` rejects values outside `open` / `done` / `snoozed` / `dismissed`
- `orders.events` array accepts any event code string (not restricted by enum — event codes evolve)
- `balance_due` defaults to 0 on new orders
- No business logic (no pre-save hooks that calculate, transform, or send anything)

### Risks

| Risk | Mitigation |
|------|-----------|
| Missing index on `status` causes full collection scans on dashboard queries | Define all indexes in the schema; verify with `.explain()` |
| `events.type` defined as an enum — blocks new event codes added in the future | Define as `String` only, no enum restriction |
| `balance_due` not stored as a real field — recalculated on every read | Store as a real maintained field; update it in the service layer, not the model |
| Over-engineering: adding virtual fields, complex validators, or middleware hooks | Models are structure only; all logic lives in services |

---

## Phase 3 — Order Service

### Objective

Implement the complete Order lifecycle: creation, field updates, status transitions, closure gate validation, payment recording, and event logging. This phase builds the business logic core that every other phase depends on.

### Dependencies

- Phase 2 complete (all models available)

### Files to Create

| File | Purpose |
|------|---------|
| `src/services/eventService.js` | Single function: append an event to an order's events array. Used by every other service. |
| `src/services/orderService.js` | Order CRUD, state machine transitions, closure gate validation, payment operations, lab interaction management, layout management |
| `src/controllers/orderController.js` | HTTP request handlers — parameter extraction, service calls, response formatting |
| `src/routes/orders.js` | Route definitions with auth middleware applied to all |

### API Endpoints to Implement

| Method | Path | Action |
|--------|------|--------|
| POST | `/api/orders` | Create new order (status: NEW) |
| GET | `/api/orders` | List all active orders |
| GET | `/api/orders/:id` | Full order detail |
| PATCH | `/api/orders/:id` | Update client info, notes, pricing, deadlines |
| POST | `/api/orders/:id/transition` | Transition status (body: `{ to, confirmed: true }`) |
| POST | `/api/orders/:id/payments` | Record a payment |
| PATCH | `/api/orders/:id/payments/:paymentId/void` | Void a payment |
| POST | `/api/orders/:id/lab-interactions` | Record lab contacted (new interaction entry) |
| POST | `/api/orders/:id/lab-interactions/:version/reminder` | Record reminder sent |
| POST | `/api/orders/:id/layouts` | Record layout received |
| PATCH | `/api/orders/:id/layouts/:version/sent` | Record layout sent to client |
| POST | `/api/orders/:id/layouts/:version/decision` | Record client decision (body: `{ decision, correction_notes, confirmed: true }`) |
| POST | `/api/orders/:id/original/received` | Record original document received |
| POST | `/api/orders/:id/original/sent` | Record original sent to client |

### State Machine Rules to Enforce

Per `PROCESS_STATES.md` and `WORKFLOW_EVENTS.md`:

| Transition | Precondition | Hard Block |
|-----------|-------------|------------|
| NEW → WAITING_PAYMENT | Quote communicated to client | — |
| WAITING_PAYMENT → IN_LAB | At least one payment recorded | — |
| IN_LAB → WAITING_CLIENT_APPROVAL | Layout received AND layout sent to client (current version) | — |
| WAITING_CLIENT_APPROVAL → IN_LAB | Client decision is `corrections_requested` (current version) | — |
| WAITING_CLIENT_APPROVAL → WAITING_ORIGINAL | Client decision is `approved` (current version) | — |
| WAITING_ORIGINAL → READY_FOR_DELIVERY | Original document received | — |
| READY_FOR_DELIVERY → COMPLETED | Original sent to client | `balance_due > 0` |
| Any active → CANCELLED | None | — |

Every transition must:
1. Validate the precondition
2. Check for hard blocks
3. Require `confirmed: true` in the request (Design Principle 7)
4. Append `ORDER_STATUS_CHANGED` to the order's events array
5. Update `updated_at`

### Acceptance Criteria

- Order creation returns the new order with `ORDER_CREATED` in events
- Every field defined in `DATABASE_DESIGN.md` is settable through the appropriate endpoint
- All invalid transitions return HTTP 422 with a descriptive error message naming the failed precondition
- `READY_FOR_DELIVERY → COMPLETED` returns HTTP 422 when `balance_due > 0`; error message states the outstanding amount
- `READY_FOR_DELIVERY → COMPLETED` returns HTTP 422 when original has not been sent to client
- Any transition without `confirmed: true` returns HTTP 422
- Payment recording recalculates `balance_due` and appends `PAYMENT_RECORDED` + `BALANCE_UPDATED`; if balance reaches zero, `BALANCE_CLEARED` is also appended
- Payment voiding recalculates `balance_due` and appends `PAYMENT_VOIDED` + `BALANCE_UPDATED`
- No order returns HTTP 200 for a DELETE request — cancellation is the only removal path
- Lab interaction versioning: each new lab interaction increments the version; the version on the interaction entry matches the version on the corresponding layout entry

### Risks

| Risk | Mitigation |
|------|-----------|
| State machine logic duplicated between controller and service | All transition logic lives exclusively in `orderService.js`; controllers only extract parameters and call the service |
| Event logging and state change are separate operations — one can succeed while the other fails | Wrap both in a single operation; if event logging fails, the transition must roll back |
| `confirmed: true` check bypassed in integration tests | Add an explicit test case that verifies the endpoint rejects requests without the confirmation parameter |
| `balance_due` going out of sync with actual payments | `balance_due` is always recalculated from the payments array on every payment operation, never incremented/decremented manually |

---

## Phase 4 — Tasks Engine

### Objective

Implement the Tasks system that bridges automated detection and human action. Tasks are created by services and the scheduler; they are completed, snoozed, or dismissed only by the operator. This phase establishes the deduplication logic that prevents task floods.

### Dependencies

- Phase 2 complete (Task model)
- Phase 3 complete (`eventService.js` available for logging `TASK_CREATED` on the linked order)

### Files to Create

| File | Purpose |
|------|---------|
| `src/services/taskService.js` | Task creation with deduplication, status transitions, snooze logic |
| `src/controllers/taskController.js` | HTTP handlers |
| `src/routes/tasks.js` | Route definitions |

### API Endpoints to Implement

| Method | Path | Action |
|--------|------|--------|
| GET | `/api/tasks` | List tasks (filterable by status, order_id, type) |
| GET | `/api/orders/:id/tasks` | All tasks for a specific order |
| POST | `/api/orders/:id/tasks` | Create manual task for an order |
| PATCH | `/api/tasks/:id/complete` | Mark task done (`confirmed: true` required) |
| PATCH | `/api/tasks/:id/snooze` | Snooze task (body: `{ until: ISODate }`) |
| PATCH | `/api/tasks/:id/dismiss` | Dismiss task |

### Deduplication Logic

The `taskService.createTask` function must implement this check before every insert:

```
Query: find one task where:
  order_id = given order_id
  type = given type
  status = "open"

If found:
  → Do not create a new task
  → If the given due_date differs from existing, update it
  → Return the existing task

If not found:
  → Create new task
  → Append TASK_CREATED event to the linked order
  → Return new task
```

This logic applies to both auto-generated tasks (from the scheduler) and manual tasks of the same type. A manual `remind_lab` task blocks the scheduler from creating a duplicate auto `remind_lab` task for the same order.

### Acceptance Criteria

- Manual task creation via API returns HTTP 201 and the new task
- `TASK_CREATED` event appears in the linked order's events array after creation
- Creating a task of the same type for the same order when an open task exists returns the existing task without creating a duplicate (HTTP 200, not 201)
- Task can be completed only with `confirmed: true` (Design Principle 7); rejects without it
- Completing a task appends `TASK_COMPLETED` to the order's events
- Snoozed task with a past `snoozed_until` date is returned as `open` when listed
- Dismissed task does not appear in active task lists
- `GET /api/orders/:id/tasks` returns tasks sorted by priority (high → medium → low) then by `due_date` ascending
- A task cannot be completed if it is already `done` or `dismissed`

### Risks

| Risk | Mitigation |
|------|-----------|
| Deduplication check has a race condition if two scheduler processes run concurrently | Use an atomic upsert operation instead of check-then-insert; Phase 8 also prevents concurrent runs |
| `TASK_UNSNOOZED` event never fired — snoozed tasks just silently reappear | Phase 8's scheduler must explicitly call `taskService.unsnoozeStaleTasks()` and log `TASK_UNSNOOZED` on each affected task |
| Tasks created for cancelled or closed orders by a late-running scheduler | `taskService.createTask` must check that the linked order is not in a terminal status before creating |

---

## Phase 5 — Dashboard API

### Objective

Implement the attention query API. This phase translates the priority logic from `PROCESS_STATES.md` into a set of API endpoints that power the "What requires attention today?" dashboard view.

This phase delivers the API only. Frontend implementation is a separate concern.

### Dependencies

- Phase 3 complete (orders queryable with deadline fields)
- Phase 4 complete (tasks queryable)

### Files to Create

| File | Purpose |
|------|---------|
| `src/config/constants.js` | Named business thresholds: `STALE_NEW_ORDER_DAYS = 3`, `LAYOUT_NOT_SENT_HOURS = 24`, `ORIGINAL_NOT_SENT_HOURS = 24` |
| `src/services/dashboardService.js` | Attention query aggregation logic |
| `src/controllers/dashboardController.js` | HTTP handlers |
| `src/routes/dashboard.js` | Route definitions |

### API Endpoints to Implement

| Method | Path | Action |
|--------|------|--------|
| GET | `/api/dashboard/attention` | Returns all flagged orders grouped by attention category |
| GET | `/api/dashboard/orders` | All active (non-terminal) orders, sorted by `updated_at` descending |
| GET | `/api/dashboard/orders/closed` | Closed orders, paginated, sorted by `updated_at` descending |
| GET | `/api/dashboard/orders/cancelled` | Cancelled orders, paginated |

### Attention Response Structure

The `GET /api/dashboard/attention` endpoint returns:

```
{
  "overdue":        [ ...orders ],   ← deadlines passed, no action recorded
  "due_today":      [ ...orders ],   ← deadlines hitting today
  "action_needed":  [ ...orders ],   ← required step not yet taken
  "debt":           [ ...orders ],   ← READY_FOR_DELIVERY status, balance_due > 0
  "stale":          [ ...orders ],   ← NEW or WAITING_PAYMENT, no movement > 3 days
  "open_tasks":     [ ...tasks  ],   ← open/unsnoozed tasks across all orders
  "generated_at":   ISODate
}
```

Each order in the response includes: `_id`, `status`, `client.name`, `client.phone`, `balance_due`, `deadlines`, and the specific flag that caused it to appear. It does not include the full event log or embedded arrays — those are in the detail endpoint.

### Attention Detection Logic

All thresholds come from `constants.js`, not hardcoded values.

| Category | Detection Rule |
|----------|---------------|
| OVERDUE | `lab_response_due < today` AND no layout received; OR `client_response_due < today` AND no client decision; OR `original_expected < today` AND no original received |
| DUE_TODAY | Same fields equal today's date |
| ACTION_NEEDED | IN_LAB with no `lab_contacted_at`; OR layout received with no `sent_to_client_at` after 24h; OR original received with no `sent_to_client_at` after 24h |
| DEBT | Status is READY_FOR_DELIVERY AND `balance_due > 0` |
| STALE | Status is NEW or WAITING_PAYMENT AND `updated_at < (today - 3 days)` |
| OPEN_TASKS | All tasks where `status = "open"` OR (`status = "snoozed"` AND `snoozed_until <= today`) |

An order may appear in multiple categories simultaneously (e.g., OVERDUE and DEBT).

### Acceptance Criteria

- `GET /api/dashboard/attention` response time is under 500ms with 100 active orders in the database
- An order in READY_FOR_DELIVERY with `balance_due = 50` appears in `debt` section
- An order with `lab_response_due` set to yesterday with no layout appears in `overdue`
- An order with `lab_response_due` set to today appears in `due_today`
- A closed or cancelled order never appears in any attention section
- An order with no flags does not appear in the attention response
- All thresholds (`STALE_NEW_ORDER_DAYS`, etc.) can be changed in `constants.js` without touching service code
- `GET /api/dashboard/orders/closed` supports `?page=` and `?limit=` query parameters

### Risks

| Risk | Mitigation |
|------|-----------|
| Date comparison logic inconsistent across time zones | All date comparisons use UTC midnight; document this in constants.js |
| Aggregation query slow without correct indexes | Run `.explain()` on the attention query; confirm index usage on deadline fields |
| Dashboard logic leaking into controller | All detection logic stays in `dashboardService.js`; controller only calls the service and formats the response |
| Large event arrays slowing down order list queries | Use MongoDB projection to exclude `events` array from list endpoints; include it only in the detail endpoint |

---

## Phase 6 — Google Forms Integration

### Objective

Connect the system to the existing Google Forms intake flow. New form submissions that appear in the Declaration spreadsheet are automatically detected, and a new Order is created in `NEW` status for each one. This is the primary automated intake path described in `PROJECT_COMPASS.md`.

No write-back to Sheets in this phase. Read-only Google Sheets access only.

### Dependencies

- Phase 3 complete (order creation endpoint available)
- Phase 2 complete (Declaration model available)
- Google Cloud project with Sheets API enabled and OAuth2 credentials generated

### Files to Create

| File | Purpose |
|------|---------|
| `src/integrations/googleAuth.js` | Builds and exports an authenticated Google API client using credentials from environment variables |
| `src/integrations/formsIntake.js` | Polls the Declaration sheet for new rows; maps form fields to Order and Declaration structures; calls order creation service |

### Form Field Mapping

The intake mapper must document the explicit mapping from Google Form field names (sheet column headers) to Order and Declaration fields. This mapping is defined in `formsIntake.js` as a named constant — not inline logic — so it can be updated when the form changes without touching the detection logic.

Expected columns from the existing Declaration sheet:
`payment_date`, `payment_amount`, `client` (name), `document_type`, `phone`, `notes`, `status`

The mapper must validate that all expected columns are present on each sync run. If a column is missing, log a clear error naming the missing column and skip that row — do not crash.

### Intake Flow

```
1. Fetch all rows from the Declaration sheet
2. Filter to rows where sheet_row_id is not in the declarations collection
   (unprocessed rows only)
3. For each unprocessed row:
   a. Validate required fields are present
   b. Call orderService.createOrder() → Order created in NEW
   c. Create Declaration record linked to the new Order
   d. Mark the row as processed (store sheet_row_id in Declaration)
   e. Log SYS_FORM_SUBMISSION_DETECTED to server log
   f. ORDER_CREATED event is logged on the Order by the order service
4. Log SYS_SHEETS_SYNC_COMPLETED with count of new orders created
```

If step (b) or (c) fails, the row must NOT be marked as processed. It will be retried on the next poll.

### Polling Configuration

- Interval configured via `SCHEDULER_CRON` or a dedicated `FORMS_POLL_INTERVAL_MS` env variable
- Polling runs as a background interval, not as an HTTP endpoint
- Concurrent polls prevented: if a poll is already running, the new trigger is skipped and logged
- A manual trigger endpoint `POST /api/integrations/forms/sync` is provided for testing

### Acceptance Criteria

- A new row added to the Declaration sheet appears as an Order in NEW status within one poll interval
- The Order's `client` object is populated from the sheet row fields
- A linked Declaration record exists with `sheet_row_id` matching the sheet row and `source: "google_sheets"`
- Running the poll twice does not create duplicate Orders for the same sheet row
- A sheet row with missing required fields is skipped with a server log error; other rows in the same batch are still processed
- Google API authentication failure is caught and logged; it does not crash the server
- `POST /api/integrations/forms/sync` triggers an immediate poll and returns a count of orders created

### Risks

| Risk | Mitigation |
|------|-----------|
| Google API rate limits (100 requests / 100 seconds) | Fetch all rows in a single batch read; never fetch per-row |
| Form column names change — mapper breaks silently | Mapper validates column presence on every run; logs error with column name if missing |
| Two poll processes run simultaneously — duplicate orders | Mutex flag checked before starting a poll; flag released in a `finally` block to prevent deadlock |
| OAuth2 refresh token expires | `googleAuth.js` handles token refresh automatically; logs clearly if refresh fails |
| `sheet_row_id` not a stable identifier in Google Sheets | Use row number + sheet ID as composite key, or rely on a dedicated "processed" marker column — document the chosen approach |

---

## Phase 7 — Google Sheets Synchronization

### Objective

Implement bidirectional sync of Declaration records. When an Order changes in ways that affect the Declaration (payment recorded, status changed, notes updated), the linked row in Google Sheets is updated to match. When a sheet row has been manually edited outside the system, the conflict is flagged for the operator rather than silently overwritten.

This phase also builds the Declaration API so declarations can be queried and reviewed from the dashboard.

### Dependencies

- Phase 6 complete (`googleAuth.js` and sheet structure already established)
- Phase 3 complete (order events available to trigger outbound sync)

### Files to Create

| File | Purpose |
|------|---------|
| `src/integrations/sheetsSync.js` | Writes updated Declaration fields back to the corresponding Google Sheets row; reads rows to detect conflicts |
| `src/services/declarationService.js` | Declaration CRUD; sync status management; conflict detection |
| `src/controllers/declarationController.js` | HTTP handlers |
| `src/routes/declarations.js` | Route definitions |

### API Endpoints to Implement

| Method | Path | Action |
|--------|------|--------|
| GET | `/api/declarations` | List all declarations (filterable by sync_status) |
| GET | `/api/declarations/:id` | Single declaration with linked order summary |
| PATCH | `/api/declarations/:id/resolve-conflict` | Operator resolves a sync conflict by choosing system or sheet version |
| POST | `/api/integrations/sheets/sync` | Manual trigger for full sync run |

### Outbound Sync (System → Sheets)

When any of the following Order events are recorded, the linked Declaration row in Sheets is updated:
- `PAYMENT_RECORDED` — updates `payment_date`, `payment_amount`
- `ORDER_STATUS_CHANGED` — updates `status`
- `ORDER_NOTE_ADDED` — updates `notes`
- `ORDER_CLIENT_UPDATED` — updates `client`, `phone`

**Only system-owned columns are written.** Columns not in the Declaration field list are never touched.

Writes are performed asynchronously — they do not block the Order API response. Write failures are logged and the Declaration `sync_status` is set to `pending` for retry on the next sync run.

### Conflict Detection

Before writing to a sheet row, the sync module reads the current value of that row and compares it to the last known value stored in the Declaration record. If they differ:
- The Declaration `sync_status` is set to `conflict`
- `conflict_details` records which fields differ and both values
- `SYS_SHEETS_SYNC_CONFLICT` is logged
- No write is performed
- The operator sees the conflict in the dashboard and resolves it manually via `PATCH /api/declarations/:id/resolve-conflict`

### Acceptance Criteria

- Recording a payment on an Order updates the `payment_date` and `payment_amount` columns in the linked sheet row within one sync cycle
- Changing an Order's status updates the `status` column in the linked sheet row
- A sheet row manually edited since the last sync is marked `conflict` and NOT overwritten
- `GET /api/declarations?sync_status=conflict` returns all conflicted records
- Manual conflict resolution sets `sync_status` back to `synced` and logs `SYS_DECLARATION_SYNCED`
- A Sheets API write failure sets `sync_status` to `pending` and logs `SYS_SHEETS_SYNC_ERROR`; it does not crash the server
- `POST /api/integrations/sheets/sync` retries all `pending` declarations
- System-write-triggered reads do not create false conflicts (writes are tagged to be ignored on re-read)

### Risks

| Risk | Mitigation |
|------|-----------|
| Write-back loop: system writes sheet → inbound poll reads its own write as a new change | Tag outbound writes with a system marker column (e.g., `last_synced_by: "system"`); inbound poll skips rows where this marker matches the last known system write timestamp |
| Sheets API quota exhausted by writing on every Order save | Batch writes using the Sheets `batchUpdate` API; accumulate pending writes for up to 30 seconds before flushing |
| Declaration row deleted from Google Sheets | Detect missing row on sync; set `sync_status: "row_deleted"` and alert operator; do not crash |
| `declarationService` becomes a God object mixing sync and CRUD | Sync transport logic stays in `sheetsSync.js`; `declarationService.js` only handles business rules and calls the sync module |

---

## Phase 8 — Attention Engine

### Objective

Implement the scheduled background job that evaluates all active orders daily, fires all `SYS_*` system events defined in `WORKFLOW_EVENTS.md`, and creates the tasks that appear on the operator's dashboard. This phase closes the loop between the operational data and the attention view.

### Dependencies

- All previous phases complete
- `constants.js` exists with threshold values (Phase 5)
- `taskService.createTask` with deduplication (Phase 4)
- `eventService.appendEvent` (Phase 3)

### Files to Create

| File | Purpose |
|------|---------|
| `src/scheduler/attentionEngine.js` | Core logic: queries active orders, evaluates all 9 conditions, creates tasks, fires SYS events |
| `src/scheduler/index.js` | Registers the cron job using the configured expression; manages the concurrent-run lock |

### Conditions to Evaluate

The engine evaluates every order in a non-terminal status (`NEW`, `WAITING_PAYMENT`, `IN_LAB`, `WAITING_CLIENT_APPROVAL`, `WAITING_ORIGINAL`, `READY_FOR_DELIVERY`). For each order, it checks all 9 conditions from `WORKFLOW_EVENTS.md`:

| Condition | SYS Event Fired | Task Type Created | Priority |
|-----------|----------------|-------------------|---------|
| NEW or WAITING_PAYMENT with no activity for ≥ `STALE_NEW_ORDER_DAYS` | `SYS_NEW_ORDER_STALE` | `stale_intake` | medium |
| `lab_response_due` = today, no layout received | `SYS_LAB_DEADLINE_TODAY` | `remind_lab` | medium |
| `lab_response_due` < today, no layout received | `SYS_LAB_DEADLINE_MISSED` | `remind_lab` | high |
| Layout received, no `sent_to_client_at` after 24h | `SYS_LAYOUT_NOT_SENT` | `send_layout` | high |
| `client_response_due` = today, no decision | `SYS_CLIENT_RESPONSE_DUE_TODAY` | `follow_up_client` | medium |
| `client_response_due` < today, no decision | `SYS_CLIENT_RESPONSE_OVERDUE` | `follow_up_client` | high |
| `original_expected` < today, no original received | `SYS_ORIGINAL_OVERDUE` | `remind_lab` | high |
| Original received, no `sent_to_client_at` after 24h | `SYS_ORIGINAL_NOT_SENT` | `send_original` | high |
| READY_FOR_DELIVERY status, `balance_due` > 0 | `SYS_DEBT_FLAGGED` | `check_payment` | high |

SYS events are appended to the affected order's events array only when the condition is **newly detected** in this run. A condition that was already logged in the previous run does not generate a duplicate event — only a new task attempt (which deduplication handles). The check: if the most recent event of this `SYS_*` type on the order has a timestamp within the last scheduler run interval, skip firing the event.

Additionally, the engine calls `taskService.unsnoozeStaleTasks()` at the start of each run to activate any snoozed tasks whose `snoozed_until` has passed, and fires `TASK_UNSNOOZED` for each.

### Cron Configuration

- Expression read from `SCHEDULER_CRON` environment variable (default: `"0 8 * * *"` — 08:00 daily)
- Time zone read from `SCHEDULER_TIMEZONE` environment variable (must be a valid IANA string)
- A manual trigger endpoint `POST /api/scheduler/run` executes one immediate run and returns the run summary

### Run Log Format

Each run writes `SYS_SCHEDULER_RUN` to the server log with:
```
{
  started_at: ISODate,
  completed_at: ISODate,
  orders_evaluated: Number,
  tasks_created: Number,
  tasks_deduplicated: Number,
  sys_events_fired: Number,
  tasks_unsnoozed: Number
}
```

### Acceptance Criteria

- Scheduler starts with the server and fires at the configured cron time
- Running the scheduler against a database with 20 active orders with various overdue conditions creates the correct tasks for each
- No duplicate open tasks exist after running the scheduler three times in a row on the same data
- A snoozed task with a past `snoozed_until` is activated and `TASK_UNSNOOZED` is logged on the first scheduler run after the snooze expires
- Concurrent run prevention: if the cron fires while a run is already in progress, the second trigger is skipped and logged
- Scheduler failure (e.g., database unreachable mid-run) is caught; partial results are committed; `SYS_SCHEDULER_RUN` is logged with error details; the server process continues running
- `POST /api/scheduler/run` returns the run summary JSON
- Changing `STALE_NEW_ORDER_DAYS` in `constants.js` changes scheduler behavior without touching engine code

### Risks

| Risk | Mitigation |
|------|-----------|
| First run on existing data creates hundreds of tasks — overwhelming dashboard | Add a `SCHEDULER_FIRST_RUN` env flag that limits first run to `high` priority tasks only; remove the flag after the first run |
| SYS events written on every scheduler run → event arrays fill with noise | Check last SYS event timestamp before appending; only fire if condition is newly detected |
| Concurrent run lock never released if run crashes | Lock is stored with a `lock_expires_at` timestamp; any run that finds an expired lock (e.g., > 1 hour old) overwrites it |
| Time zone misconfiguration — scheduler fires at wrong local time | Log the calculated next fire time in local time on server start; operator can verify it is correct |

---

## V1 Completion Criteria

V1 is complete when all of the following can be demonstrated end-to-end:

| # | Criteria |
|---|---------|
| 1 | A new Google Form submission appears as an Order in NEW status within one poll interval — no manual entry required |
| 2 | The Declaration spreadsheet row for that Order is updated automatically when the Order's payment or status changes |
| 3 | The operator can progress the Order through all 8 statuses using the API |
| 4 | Attempting to close an Order with `balance_due > 0` returns an error naming the outstanding amount |
| 5 | Attempting to close an Order before the original is marked as sent returns an error |
| 6 | The attention endpoint returns correctly grouped and prioritized items with no false positives |
| 7 | The scheduler runs daily and creates the correct tasks for overdue conditions without duplicates |
| 8 | Every status change, payment, lab interaction, layout decision, and task action is visible in the Order's event log |
| 9 | No Order, Declaration, Event, or Payment can be hard-deleted through any API endpoint |
| 10 | All actions under Design Principle 7 reject requests without `confirmed: true` |

---

## Appendix: Phase Dependencies

```
Phase 1 (Skeleton)
    └── Phase 2 (Models)
            └── Phase 3 (Order Service)
                    ├── Phase 4 (Tasks Engine)
                    │       └── Phase 5 (Dashboard API)
                    │               └── Phase 8 (Attention Engine) ←─┐
                    └── Phase 5 (Dashboard API)                        │
                                                                        │
Phase 6 (Forms Integration) ── requires Phase 3                        │
    └── Phase 7 (Sheets Sync) ── requires Phase 6                      │
                                                                        │
Phase 8 requires: Phase 3 + Phase 4 + Phase 5 + Phase 7 ───────────────┘
```

Phase 8 is last. It depends on everything being in place.
Phases 6 and 7 can begin after Phase 3, in parallel with Phases 4 and 5.
