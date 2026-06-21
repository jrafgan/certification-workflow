# WORKFLOW EVENTS
## Complete Event Catalog — Certification Workflow Management System

---

## What Events Are

Every meaningful thing that happens in the system is recorded as an event. Events serve three purposes:

1. **Audit trail** — an immutable record of what happened, when, and who caused it.
2. **Task triggers** — system events cause the scheduler to create operator tasks.
3. **Transition preconditions** — certain events must exist before a status change is permitted.

Events are never modified or deleted. They accumulate on each order as an append-only log.

### Event Record Structure

Every event stored on an order contains:

| Field | Content |
|-------|---------|
| `type` | Event code (e.g., `LAB_LAYOUT_RECEIVED`) |
| `description` | Human-readable description of what occurred |
| `actor` | `operator` — triggered by a person in the UI; `system` — triggered by scheduler or sync |
| `timestamp` | Exact date and time the event was recorded |

### Where Events Are Stored

| Event Category | Stored In |
|----------------|-----------|
| Order events | `orders.events[]` (embedded in the order document) |
| Payment events | `orders.events[]` |
| Laboratory events | `orders.events[]` |
| Client approval events | `orders.events[]` |
| Task events | `orders.events[]` (for the linked order) |
| System / order-level | `orders.events[]` (for the affected order) |
| System / global | Server operational log only (not in order documents) |

> **Note:** This document supersedes the event type list in `DATABASE_DESIGN.md`. The codes defined here are the canonical reference. Use UPPER_SNAKE_CASE for all event type values.

---

## Category 1 — Order Events

Events related to the order's core identity and lifecycle.

| Event Code | Description | Trigger | Created By |
|------------|-------------|---------|------------|
| `ORDER_CREATED` | A new order was created in the system | Operator creates order manually, or Sheets sync detects a new Google Form submission | system (form) / operator (manual) |
| `ORDER_QUOTE_SET` | The quoted price and calculation date were recorded on the order | Operator saves the calculated quote | operator |
| `ORDER_QUOTE_COMMUNICATED` | The operator confirmed the quote was communicated to the client | Operator marks quote as sent | operator |
| `ORDER_DEADLINE_SET` | A deadline field (`lab_response_due`, `client_response_due`, or `original_expected`) was set or changed | Operator sets or updates a deadline | operator |
| `ORDER_NOTE_ADDED` | A free-text note was added to the order | Operator saves a note | operator |
| `ORDER_CLIENT_UPDATED` | Client information (name, phone, channel, notes) was modified | Operator edits client fields | operator |
| `ORDER_STATUS_CHANGED` | The order moved from one status to another | Operator confirms a status transition after all preconditions are met | operator |
| `ORDER_CANCELLED` | The order was cancelled. Cancellation reason is recorded in the event description. | Operator explicitly cancels the order | operator |
| `ORDER_COMPLETED` | The order was completed after all closure gates passed | Operator confirms completion (balance zero + original delivered) | operator |

---

## Category 2 — Payment Events

Events related to financial tracking on the order.

| Event Code | Description | Trigger | Created By |
|------------|-------------|---------|------------|
| `PAYMENT_RECORDED` | A payment entry (date, amount, method) was added to the order's payments array | Operator records a received payment | operator |
| `PAYMENT_VOIDED` | A previously recorded payment was marked as voided. Reason is recorded. | Operator marks a payment as entered in error | operator |
| `BALANCE_UPDATED` | The `balance_due` field was recalculated. New balance is recorded in the event description. | Fires automatically after every `PAYMENT_RECORDED` or `PAYMENT_VOIDED` | system |
| `BALANCE_CLEARED` | `balance_due` reached exactly zero. | Fires automatically when `BALANCE_UPDATED` results in zero balance | system |
| `DEBT_FLAGGED` | Order is in `READY_FOR_DELIVERY` status but `balance_due` is greater than zero. Operator is alerted. | Scheduler detects balance > 0 while order is in READY_FOR_DELIVERY | system |

---

## Category 3 — Laboratory Events

Events covering the entire operator-to-laboratory relationship: requests, reminders, layouts, corrections, and the original document.

| Event Code | Description | Trigger | Created By |
|------------|-------------|---------|------------|
| `LAB_REQUEST_SENT` | The operator sent a certification request to the laboratory via Gmail (or other channel). A new `lab_interactions` entry is created (version 1 on first contact; incremented on corrections loop). | Operator confirms request was sent and records the sent date | operator |
| `LAB_DEADLINE_SET` | The lab response deadline was set for the current lab interaction. | Operator sets `lab_response_due` after sending the request | operator |
| `LAB_REMINDER_SENT` | The operator sent a reminder to the laboratory. `reminder_count` on the current lab interaction entry is incremented. | Operator confirms reminder was sent | operator |
| `LAB_LAYOUT_RECEIVED` | A layout draft was received from the laboratory and recorded in the system. A new entry is added to `orders.layouts[]` with the version number and file reference. | Operator records receipt of the layout | operator |
| `LAB_CORRECTIONS_SENT` | Correction instructions from the client were sent back to the laboratory. A new `lab_interactions` entry is created with an incremented version and the correction notes. | Operator confirms corrections were sent | operator |
| `LAB_PRINT_ORDER_SENT` | The laboratory was notified to print the original document following client approval. | Operator confirms print instruction was sent | operator |
| `LAB_ORIGINAL_RECEIVED` | The original printed document arrived from the laboratory and was recorded in the system. `orders.original.received_at` is set. | Operator records receipt of the original | operator |

---

## Category 4 — Client Approval Events

Events covering the operator-to-client relationship during the layout review and delivery phases.

| Event Code | Description | Trigger | Created By |
|------------|-------------|---------|------------|
| `CLIENT_LAYOUT_SENT` | The layout draft was forwarded to the client. `layouts[n].sent_to_client_at` is set on the active version. | Operator records that the layout was sent | operator |
| `CLIENT_RESPONSE_DEADLINE_SET` | The deadline for the client to respond to the layout was set. `deadlines.client_response_due` is recorded. | Operator sets the deadline when sending the layout | operator |
| `CLIENT_LAYOUT_APPROVED` | The client approved the layout. `layouts[n].client_decision` is set to `approved` and `decided_at` is recorded. | Operator records client's approval decision | operator |
| `CLIENT_CORRECTIONS_REQUESTED` | The client requested corrections to the layout. `layouts[n].client_decision` is set to `corrections_requested`. Correction notes are recorded. | Operator records client's correction request and notes | operator |
| `CLIENT_ORIGINAL_SENT` | The original document was sent to the client. `orders.original.sent_to_client_at` is set along with delivery method and optional tracking reference. | Operator records delivery of the original | operator |

---

## Category 5 — Task Events

Events related to the task system. All task events are also logged in the linked order's events array so the full order history includes task activity.

| Event Code | Description | Trigger | Created By |
|------------|-------------|---------|------------|
| `TASK_CREATED` | A new task was created and linked to this order. Task type and description are recorded in the event. | Scheduler (auto task) or operator (manual task) | system / operator |
| `TASK_COMPLETED` | A task was marked as done by the operator. | Operator confirms the task action was performed | operator |
| `TASK_SNOOZED` | A task was snoozed until a future date. The wake date is recorded. | Operator postpones a task | operator |
| `TASK_DISMISSED` | A task was dismissed without action. Reason is optionally recorded. | Operator explicitly dismisses an irrelevant task | operator |
| `TASK_UNSNOOZED` | A previously snoozed task became active again because its snooze date was reached. | Scheduler detects `snoozed_until` has passed | system |

---

## Category 6 — System Events

Events generated by automated processes. Order-level system events are stored in `orders.events[]`. Global operational events (scheduler runs, sync status) are stored in the server operational log only and do not appear in order documents.

### Order-Level System Events
*(Stored in `orders.events[]` for the affected order)*

| Event Code | Description | Trigger | Created By |
|------------|-------------|---------|------------|
| `SYS_NEW_ORDER_STALE` | The order has been in `NEW` or `WAITING_PAYMENT` status for more than 3 days without any status change. | Scheduler daily check | system |
| `SYS_LAB_DEADLINE_TODAY` | The lab response deadline (`lab_response_due`) is today and no layout has been received. | Scheduler daily check | system |
| `SYS_LAB_DEADLINE_MISSED` | The lab response deadline has passed and no layout has been received. | Scheduler daily check | system |
| `SYS_LAYOUT_NOT_SENT` | A layout was received but `sent_to_client_at` has not been set after 1 day. | Scheduler daily check | system |
| `SYS_CLIENT_RESPONSE_DUE_TODAY` | The client response deadline is today and no decision has been recorded. | Scheduler daily check | system |
| `SYS_CLIENT_RESPONSE_OVERDUE` | The client response deadline has passed and no decision has been recorded. | Scheduler daily check | system |
| `SYS_ORIGINAL_OVERDUE` | The `original_expected` date has passed and `original.received_at` has not been set. | Scheduler daily check | system |
| `SYS_ORIGINAL_NOT_SENT` | The original was received but `original.sent_to_client_at` has not been set after 1 day. | Scheduler daily check | system |
| `SYS_DEBT_FLAGGED` | The order is in `READY_FOR_DELIVERY` status and `balance_due` is greater than zero. | Scheduler daily check | system |

### Global Operational Events
*(Stored in server log only — not in order documents)*

| Event Code | Description | Trigger | Created By |
|------------|-------------|---------|------------|
| `SYS_FORM_SUBMISSION_DETECTED` | A new Google Form submission was detected in the Declaration spreadsheet. An `ORDER_CREATED` event follows on the newly created order. | Sheets sync detects a new row | system |
| `SYS_SHEETS_SYNC_COMPLETED` | A Sheets sync run completed successfully. Row count and created/updated counts are logged. | Scheduled sync interval | system |
| `SYS_SHEETS_SYNC_CONFLICT` | A Sheets sync run detected a conflict — a spreadsheet row was manually edited since the last sync. The affected declaration is flagged. | Sheets sync conflict detection | system |
| `SYS_SHEETS_SYNC_ERROR` | A Sheets sync run failed. Error details are logged. | Sync process exception | system |
| `SYS_DECLARATION_SYNCED` | A declaration record was successfully written back to the Google Sheets row. | After any order update that affects Declaration fields | system |
| `SYS_SCHEDULER_RUN` | The deadline and attention checker completed a full pass over all active orders. Count of tasks generated is logged. | Cron job interval | system |

---

## How Events Create Tasks

The scheduler evaluates every active order once per run. For each order, it checks a set of conditions and creates a task if the condition is true **and** no open task of the same type already exists for that order.

The scheduler never sends messages or transitions statuses. It only creates tasks.

### Task Creation Rules

| Condition Detected | System Event Fired | Task Created | Task Type | Priority |
|-------------------|-------------------|--------------|-----------|----------|
| Order in `NEW` or `WAITING_PAYMENT` with no activity for 3+ days | `SYS_NEW_ORDER_STALE` | "Follow up — order stale for N days" | `stale_intake` | medium |
| `lab_response_due` is today, no layout received | `SYS_LAB_DEADLINE_TODAY` | "Lab deadline today — expect layout or send reminder" | `remind_lab` | medium |
| `lab_response_due` is in the past, no layout received | `SYS_LAB_DEADLINE_MISSED` | "Lab overdue by N days — reminder required" | `remind_lab` | high |
| `LAB_LAYOUT_RECEIVED` fired but `sent_to_client_at` not set after 1 day | `SYS_LAYOUT_NOT_SENT` | "Layout received but not yet sent to client" | `send_layout` | high |
| `client_response_due` is today, no client decision | `SYS_CLIENT_RESPONSE_DUE_TODAY` | "Client response due today" | `follow_up_client` | medium |
| `client_response_due` is in the past, no client decision | `SYS_CLIENT_RESPONSE_OVERDUE` | "Client response overdue by N days" | `follow_up_client` | high |
| `original_expected` is in the past, `original.received_at` not set | `SYS_ORIGINAL_OVERDUE` | "Original document overdue from lab" | `remind_lab` | high |
| `original.received_at` set but `original.sent_to_client_at` not set after 1 day | `SYS_ORIGINAL_NOT_SENT` | "Original received but not yet sent to client" | `send_original` | high |
| Order in `READY_FOR_DELIVERY` with `balance_due` > 0 | `SYS_DEBT_FLAGGED` | "Outstanding payment balance — resolve before completing" | `check_payment` | high |

### Deduplication

Before creating any auto-generated task, the system checks:

```
Is there already an OPEN task of the same type for this order?
  YES → skip creation, optionally update due_date if deadline changed
  NO  → create the task and fire TASK_CREATED event on the order
```

This prevents the same alert from being created on every scheduler run.

### Manual Tasks

The operator can create a `manual` task on any order at any time. Manual tasks fire a `TASK_CREATED` event on the order but do not require a system event condition to be met first.

---

## How Events Affect Status Transitions

Status transitions are always initiated by the operator. The system never transitions an order automatically. Events serve as **preconditions** that must be satisfied before a transition is permitted — the system blocks the transition if they are not met.

### Transition Precondition Table

Statuses are the seven Declaration-sheet values stored directly in `Order.status`.

| From | To | Required Events / Conditions | Blocked If |
|------|----|------------------------------|------------|
| `Запустить` | `Ждем макет` | Laboratory request sent (`LAB_REQUEST_SENT`) for the order | — |
| `Ждем макет` | `На согласовании` | `LAB_LAYOUT_RECEIVED` and `CLIENT_LAYOUT_SENT` events both exist for the current lab interaction version | — |
| `На согласовании` | `Ждем оригинал` | `CLIENT_LAYOUT_APPROVED` exists for the current layout version, **or** `CLIENT_CORRECTIONS_REQUESTED` exists and the corrections have been sent to the lab (no revised layout pending) | — |
| `Ждем оригинал` | `На согласовании` | `LAB_LAYOUT_RECEIVED` exists for a revised layout version — the lab answered corrections with a new layout for another approval round | — |
| `Ждем оригинал` | `Оригинал получен` | `LAB_ORIGINAL_RECEIVED` event exists | — |
| `Оригинал получен` | `Завершен` | `CLIENT_ORIGINAL_SENT` event exists | `balance_due` is greater than zero |
| Any non-terminal status | `Отменен` | None — cancellation is always permitted; reason recorded in `cancelled_reason` | — |

### Important: Events Do Not Trigger Transitions

Receiving a layout (`LAB_LAYOUT_RECEIVED`) does not automatically move the order to `На согласовании`. A client approving a layout (`CLIENT_LAYOUT_APPROVED`) does not automatically move the order to `Ждем оригинал`.

Each transition requires the operator to review the state, confirm the data is correct, and explicitly initiate the transition. This is Design Principle 7: the system assists judgment, it does not replace it.

### The Corrections Loop and Versioning

Corrections do not have a single fixed destination. After the client requests
corrections and the operator sends them to the lab, the business supports two
outcomes, distinguished by what the lab actually sends back:

- **Case A — lab issues the final document directly.** No revised layout is
  produced. The operator moves the order `На согласовании → Ждем оригинал` and
  waits for `LAB_ORIGINAL_RECEIVED`.
- **Case B — lab returns a revised layout for another approval round.**
  `LAB_LAYOUT_RECEIVED` fires for the new layout version, which recommends moving
  the order back `Ждем оригинал → На согласовании`.

The system never guesses which case applies — the recommendation follows the
detected event (`WORKFLOW_STATUS_MAP` in `backend/src/config/constants.js`). When
corrections produce a new layout version:

1. `CLIENT_CORRECTIONS_REQUESTED` is already recorded on the prior layout version
2. A new `lab_interactions` entry is created (version N+1)
3. `LAB_LAYOUT_RECEIVED` is recorded for the revised layout
4. `ORDER_STATUS_CHANGED` fires: `Ждем оригинал → На согласовании`
5. The previous layout and client correction notes remain intact and visible in the order history

Every iteration of the loop is independently traceable through the events log.

---

## Event Reference Summary

| Code | Category | Actor |
|------|----------|-------|
| `ORDER_CREATED` | Order | system / operator |
| `ORDER_QUOTE_SET` | Order | operator |
| `ORDER_QUOTE_COMMUNICATED` | Order | operator |
| `ORDER_DEADLINE_SET` | Order | operator |
| `ORDER_NOTE_ADDED` | Order | operator |
| `ORDER_CLIENT_UPDATED` | Order | operator |
| `ORDER_STATUS_CHANGED` | Order | operator |
| `ORDER_CANCELLED` | Order | operator |
| `ORDER_COMPLETED` | Order | operator |
| `PAYMENT_RECORDED` | Payment | operator |
| `PAYMENT_VOIDED` | Payment | operator |
| `BALANCE_UPDATED` | Payment | system |
| `BALANCE_CLEARED` | Payment | system |
| `DEBT_FLAGGED` | Payment | system |
| `LAB_REQUEST_SENT` | Laboratory | operator |
| `LAB_DEADLINE_SET` | Laboratory | operator |
| `LAB_REMINDER_SENT` | Laboratory | operator |
| `LAB_LAYOUT_RECEIVED` | Laboratory | operator |
| `LAB_CORRECTIONS_SENT` | Laboratory | operator |
| `LAB_PRINT_ORDER_SENT` | Laboratory | operator |
| `LAB_ORIGINAL_RECEIVED` | Laboratory | operator |
| `CLIENT_LAYOUT_SENT` | Client Approval | operator |
| `CLIENT_RESPONSE_DEADLINE_SET` | Client Approval | operator |
| `CLIENT_LAYOUT_APPROVED` | Client Approval | operator |
| `CLIENT_CORRECTIONS_REQUESTED` | Client Approval | operator |
| `CLIENT_ORIGINAL_SENT` | Client Approval | operator |
| `TASK_CREATED` | Task | system / operator |
| `TASK_COMPLETED` | Task | operator |
| `TASK_SNOOZED` | Task | operator |
| `TASK_DISMISSED` | Task | operator |
| `TASK_UNSNOOZED` | Task | system |
| `SYS_NEW_ORDER_STALE` | System (order-level) | system |
| `SYS_LAB_DEADLINE_TODAY` | System (order-level) | system |
| `SYS_LAB_DEADLINE_MISSED` | System (order-level) | system |
| `SYS_LAYOUT_NOT_SENT` | System (order-level) | system |
| `SYS_CLIENT_RESPONSE_DUE_TODAY` | System (order-level) | system |
| `SYS_CLIENT_RESPONSE_OVERDUE` | System (order-level) | system |
| `SYS_ORIGINAL_OVERDUE` | System (order-level) | system |
| `SYS_ORIGINAL_NOT_SENT` | System (order-level) | system |
| `SYS_DEBT_FLAGGED` | System (order-level) | system |
| `SYS_FORM_SUBMISSION_DETECTED` | System (global) | system |
| `SYS_SHEETS_SYNC_COMPLETED` | System (global) | system |
| `SYS_SHEETS_SYNC_CONFLICT` | System (global) | system |
| `SYS_SHEETS_SYNC_ERROR` | System (global) | system |
| `SYS_DECLARATION_SYNCED` | System (global) | system |
| `SYS_SCHEDULER_RUN` | System (global) | system |
