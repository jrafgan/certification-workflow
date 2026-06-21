# ARCHITECTURE
## Certification Workflow Management System — V1

---

## Guiding Philosophy

This is a single-user operational tool, not a platform. Every architectural choice must serve simplicity, reliability, and the dashboard question: **"What requires my attention today?"**

No microservices. No message queues. No event sourcing. One server, one database, one user, one dashboard.

Integrations are real in V1 (Google Forms, Google Sheets) but isolated behind an adapter interface so future channels (WhatsApp, Telegram, Gmail, Instagram, Facebook) can be added without touching the Order logic.

---

## System Map

```
┌─────────────────────────────────────────────────────────────────┐
│                     APPLICATION SOURCES                          │
│                                                                  │
│   Google Form ──────────▶ Google Sheets (Declaration Sheet)     │
│                                    │                            │
│                         ┌──────────▼──────────┐                 │
│                         │   SHEETS SYNC        │                 │
│                         │  (polling / webhook) │                 │
│                         └──────────┬──────────┘                 │
└────────────────────────────────────│────────────────────────────┘
                                     │ new row detected
                                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                         API SERVER                               │
│                                                                  │
│   Order CRUD           State Machine Engine                      │
│   Declaration Sync     Event Logger                              │
│   Task Manager         Closure Gate Validator                    │
│   File Handler         Deadline Field Manager                    │
└────────────┬──────────────────────────────────┬────────────────┘
             │                                  │
┌────────────▼───────────┐          ┌───────────▼───────────────┐
│       DATABASE          │          │        SCHEDULER           │
│                         │          │                            │
│   orders                │          │  Runs on configurable      │
│   declarations          │          │  interval (e.g. daily)     │
│   tasks                 │          │                            │
│                         │          │  • Checks all deadlines    │
│   MongoDB               │          │  • Generates overdue tasks │
└─────────────────────────┘          │  • Flags stale new orders  │
                                     │  • Checks debt at delivery │
                                     └────────────────────────────┘
             │
┌────────────▼───────────────────────────────────────────────────┐
│                        DASHBOARD                                 │
│                                                                  │
│   "What requires my attention today?"                           │
│                                                                  │
│   [ OVERDUE ]  [ DUE TODAY ]  [ ACTION NEEDED ]                 │
│   [ DEBT ]     [ STALE ]      [ OPEN TASKS ]                    │
│                                                                  │
│   ────────────────────────────────────────────────              │
│   Active Orders  │  Order Detail View  │  Declaration View      │
└─────────────────────────────────────────────────────────────────┘
```

---

## Components

### API Server

The single backend process. Responsible for:

- All Order CRUD operations (create, read, update, status transitions)
- Enforcing state machine rules — invalid transitions are rejected
- Enforcing closure gates (balance must be zero, delivery must be confirmed)
- Writing to the event log on every state change
- Creating and resolving Tasks
- Exposing Declaration sync endpoints
- Serving the dashboard frontend

All state-changing actions that fall under Design Principle 7 require an explicit operator confirmation parameter in the request. The server rejects any automated attempt to perform these actions without it.

---

### State Machine Engine

A module within the API server that owns all order status transitions.

Responsibilities:
- Validates that a requested transition is permitted from the current status
- Checks closure gates before allowing the COMPLETED transition
- Appends a transition event to the order's event log
- Updates `updated_at` on every change
- Updates the linked Declaration record on status changes relevant to it

No transition is possible outside of this module. Direct database writes that bypass it are never made from application code.

---

### Sheets Sync

A module that connects the system to the existing Google Sheets Declaration spreadsheet.

**Inbound (Sheets → System):**
- Polls the Declaration sheet on a configurable interval (or responds to a Google Apps Script webhook)
- Detects new rows added by Google Form submissions
- Creates a new Order in `NEW` status for each new row
- Creates a linked Declaration record
- Marks rows as synced to prevent duplicate creation

**Outbound (System → Sheets):**
- When an Order's payment, status, or notes change, the linked Declaration row is updated
- Writes are non-destructive: only the columns the system owns are touched

**Conflict resolution:**
If a sheet row has been manually edited since the last sync, the system logs a conflict flag rather than silently overwriting. The operator resolves conflicts manually.

---

### Scheduler

A background job that runs on a configurable interval (default: once per day at a set time, plus on-demand trigger from dashboard).

Responsibilities:
- Scans all orders in active states (NEW, WAITING_PAYMENT, IN_LAB, WAITING_CLIENT_APPROVAL, WAITING_ORIGINAL, READY_FOR_DELIVERY)
- Evaluates each order against deadline fields and attention rules defined in PROCESS_STATES.md
- Creates Tasks for any triggered condition that does not already have an open task of the same type
- Does not duplicate tasks — if an open "Lab overdue" task already exists for an order, no second one is created
- Logs each scheduler run with a count of tasks generated

The scheduler never sends messages, emails, or notifications on its own. It only creates tasks. Sending is always a human action.

---

### Task Engine

Manages the `tasks` collection. Tasks are the bridge between the scheduler's automated detection and the operator's manual action.

Task lifecycle:
```
[auto-generated by scheduler] ──▶ OPEN ──▶ DONE (operator confirms action taken)
                                       ├──▶ SNOOZED (check again later)
                                       └──▶ DISMISSED (acknowledged, no action needed)
```

Task types:
- `remind_lab` — lab deadline approaching or passed
- `follow_up_client` — client response overdue
- `send_layout` — layout received but not yet sent to client
- `send_original` — original received but not yet sent to client
- `check_payment` — delivery state with outstanding balance
- `stale_intake` — order in NEW or WAITING_PAYMENT too long without movement
- `manual` — operator-created task for any reason

---

### Dashboard

A single-page interface. The default view is the attention panel — not a generic list of all orders.

**Attention Panel — "What requires attention today?"**

Sections displayed in priority order:

```
┌─────────────────────────────────────────────────────────┐
│  OVERDUE                                        [3]      │
│  Orders past a deadline with no recorded action          │
│  ─────────────────────────────────────────────────────  │
│  Ivanov, Ivan  │  IN_LAB       │  Lab +4 days overdue   │
│  Petrova, Anna │  WAIT.APPROV  │  Client +2 days overdue │
│  ...                                                     │
├─────────────────────────────────────────────────────────┤
│  DUE TODAY                                      [1]      │
│  Deadlines hitting today                                 │
│  ─────────────────────────────────────────────────────  │
│  Sidorov, K.   │  WAIT.ORIG    │  Original expected today│
├─────────────────────────────────────────────────────────┤
│  ACTION NEEDED                                  [2]      │
│  Required steps not yet taken                           │
│  ─────────────────────────────────────────────────────  │
│  Kozlov, D.    │  IN_LAB       │  Lab not yet contacted  │
│  ...                                                     │
├─────────────────────────────────────────────────────────┤
│  DEBT                                           [1]      │
│  Outstanding payment balance at delivery stage           │
├─────────────────────────────────────────────────────────┤
│  STALE                                          [2]      │
│  Orders in NEW or WAITING_PAYMENT, no movement >3 days  │
├─────────────────────────────────────────────────────────┤
│  OPEN TASKS                                     [4]      │
│  Manually created or snoozed tasks                      │
└─────────────────────────────────────────────────────────┘
```

**Secondary views:**

- **All Active Orders** — full list of non-terminal orders, sorted by last activity
- **Order Detail** — full order view: client info, payment history, lab interactions, layout versions, event log
- **Declaration View** — Declaration records with sync status, sheet row linkage
- **Closed Orders** — searchable archive

**What the dashboard never does automatically:**
Sends messages, emails, or marks actions as completed. Every interaction is the operator confirming something they did.

---

## Integration Points — V1 and Future

| Channel | V1 Status | Interface |
|---------|-----------|-----------|
| Google Forms | **In scope** — reads submissions via Sheets | Sheets Sync module |
| Google Sheets | **In scope** — read/write Declaration sheet | Sheets Sync module |
| Gmail | Out of scope — operator sends manually | Future: Gmail adapter |
| WhatsApp | Out of scope | Future: WhatsApp Business adapter |
| Telegram | Out of scope | Future: Telegram Bot adapter |
| Instagram | Out of scope | Future: Meta API adapter |
| Facebook | Out of scope | Future: Meta API adapter |

All future adapters connect to the same Order creation and event interfaces. The Order schema and state machine do not change when integrations are added.

---

## Technology Stack

| Layer | Choice | Reason |
|-------|--------|--------|
| Backend | Node.js + Express | Proven Google API ecosystem; fast development |
| Database | MongoDB | Flexible embedded documents fit order sub-structures naturally |
| Frontend | Vanilla HTML/CSS/JavaScript | No build step; single-page attention view served directly by Express |
| Scheduler | node-cron or Agenda.js | Simple interval jobs; no external infrastructure required |
| Google Integration | googleapis (Node.js SDK) | Official, well-maintained, covers Sheets and Forms |
| File storage | Local filesystem (V1) / Google Drive (future) | Layouts and originals need versioned storage |
| Authentication | Single-user session (V1) | No multi-user in V1; simple session secret |
