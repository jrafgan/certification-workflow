# Phase L2.5 — Unlinked Reply Detection

## Backlog Item

**ID:** L2.5
**Depends on:** Phase L2 (polling engine must be active)
**Status:** Backlog
**Audit source:** Architecture Audit finding H4

---

## Problem

The Laboratory Communication Agent monitors threads by `thread_id`. This covers the case where the lab replies within the original monitored thread. However, laboratories sometimes:

1. Send a reply as a **new email** instead of replying to the original thread.
2. Contact the operator about an order **without referencing** the original email.

In both cases, the new thread is invisible to the monitoring system. The operator receives no task or alert. The order continues to show `waiting` status while the lab's message sits unread in Gmail.

This is a silent failure: no error, no timeout until `sla_layout_days` expires, no operator notification.

---

## Goal

Detect laboratory replies that arrive as new Gmail threads — not as replies in a monitored thread — and surface them to the operator for review.

**No automatic linking.** The operator decides whether a detected thread is relevant. This upholds Design Principle 7: Human approval over automation.

---

## Requirements

### R1 — Periodic Gmail Search

Run a background Gmail search at a configurable interval. Triggered by the same scheduler that runs the Phase L2 poller.

- Frequency: configurable via new constant `LAB_COMM_UNLINKED_SEARCH_CRON` (default: same as `LAB_COMM_POLL_CRON`)
- Scope: only orders with status `IN_LAB` or `WAITING_ORIGINAL` that have at least one active `lab_comm_threads` record
- Search window: last N hours, configurable via `LAB_COMM_UNLINKED_SEARCH_WINDOW_HOURS` (default: 72)

### R2 — Search Query Construction

For each qualifying order, construct a Gmail search query using all available identifying information:

| Signal | Query fragment |
|--------|---------------|
| Lab email address | `from:<laboratory.laboratoryEmail>` |
| Order ID suffix | `"<last 6 chars of order._id>"` |
| Client name | `"<client.name>"` |
| Lab name | `"<laboratory.laboratoryName>"` |

Combine fragments with OR within a date-restricted query:

```
from:lab@example.com after:YYYY/MM/DD ("order-A4B5C6" OR "Иванов Иван" OR "ООО Ромашка")
```

### R3 — Candidate Filtering

Before creating a task, exclude false positives:

- Thread `thread_id` is **already linked** to any order in `lab_comm_threads` with active status — skip
- Thread is already the monitored thread for this order — skip
- Message subject matches `LAB_COMM_AUTO_REPLY_SUBJECTS` — skip (auto-reply)
- An open `manual` task with the same description prefix already exists for this order — skip (deduplication via existing `taskService` dedup check)

### R4 — Operator Task Creation

For each candidate thread that passes the filter:

```
type:        'manual'
priority:    'high'
description: 'Possible unlinked reply from <laboratoryName> — verify in Gmail and link if relevant.
              Thread: <thread_id> | From: <sender> | Subject: <subject> | Date: <date>'
source:      'auto'
due_date:    now
```

The task surfaces in the operator dashboard. The operator opens Gmail, reviews the thread, and if relevant manually calls `POST /api/orders/:id/lab-interactions/:version/lab-thread` to link it.

### R5 — No Automatic Linking

The system creates a task. It never calls `linkThread`. Design Principle 7 is enforced at the architecture level, not just policy.

---

## New Constants (add to `config/constants.js`)

| Constant | Default | Purpose |
|----------|---------|---------|
| `LAB_COMM_UNLINKED_SEARCH_CRON` | same as `LAB_COMM_POLL_CRON` | How often to run the unlinked reply search |
| `LAB_COMM_UNLINKED_SEARCH_WINDOW_HOURS` | `72` | How far back to search (prevents re-flagging resolved threads) |
| `LAB_COMM_UNLINKED_MAX_RESULTS_PER_LAB` | `10` | Gmail search result cap per lab per run |

---

## Data Requirements

No new MongoDB collections. Uses existing:
- `lab_comm_threads` — to check if a found thread is already linked
- `tasks` — to create the "Possible Reply Detected" task
- `orders` — to find qualifying orders and build search queries

---

## Out of Scope for L2.5

- Automatic linking (violates Design Principle 7)
- Detecting replies from addresses not in `laboratory.laboratoryEmail`
- Flagging one thread for multiple orders simultaneously
- Modifying the generated task — create-only; operator closes it manually
- Declaration number search (declaration data available in Phase 7)

---

## Acceptance Criteria

| # | Criterion |
|---|-----------|
| AC-1 | A new Gmail thread from a known lab email, within the search window, creates a `manual/high` task for the matching order |
| AC-2 | A thread already actively linked to any order is not flagged |
| AC-3 | Messages matching `LAB_COMM_AUTO_REPLY_SUBJECTS` are not flagged |
| AC-4 | Running the search twice for the same thread creates only one task (deduplication) |
| AC-5 | Orders not in `IN_LAB` or `WAITING_ORIGINAL` are excluded from search |
| AC-6 | `LAB_COMM_UNLINKED_SEARCH_WINDOW_HOURS` prevents re-flagging threads older than the window |
| AC-7 | No thread is ever linked automatically — only tasks are created |
