# PROCESS STATES
## Order Lifecycle — States, Transitions, Deadlines, and Attention Logic

---

## Status Overview

| Status | Meaning | Waiting For | Terminal |
|--------|---------|-------------|----------|
| `NEW` | Application received, cost not yet calculated | Quote calculation and communication to client | No |
| `WAITING_PAYMENT` | Quote communicated to client, awaiting payment | Payment confirmation | No |
| `IN_LAB` | Payment confirmed, lab cycle active | Layout from laboratory | No |
| `WAITING_CLIENT_APPROVAL` | Layout sent to client | Client decision | No |
| `WAITING_ORIGINAL` | Client approved, lab printing original | Original document from lab | No |
| `READY_FOR_DELIVERY` | Original received, pending delivery and debt check | Confirmation of delivery + zero balance | No |
| `COMPLETED` | Order complete | — | Yes |
| `CANCELLED` | Order voided | — | Yes |

---

## Detailed State Definitions

---

### NEW

**What it means:**
Application received. Cost has not yet been calculated or communicated to the client.

**What the operator is doing:**
Reviewing the application and calculating the certification cost.

**Deadline fields active:**
None mandatory. The system tracks order age to detect stale new orders.

**Attention trigger:**
Order has been in `NEW` for more than 3 days without a status change → task generated: *"Follow up — new order stale."*

**Transition to WAITING_PAYMENT:**
When the quote has been calculated and communicated to the client, the operator transitions the order manually.

---

### WAITING_PAYMENT

**What it means:**
The quote has been communicated to the client. The operator is waiting for payment confirmation before beginning lab work.

**What the operator is doing:**
Waiting for payment. Following up with the client if payment is delayed.

**Deadline fields active:**
None mandatory. The system tracks order age to detect stale payment-pending orders.

**Attention trigger:**
Order has been in `WAITING_PAYMENT` for more than 3 days without a status change → task generated: *"Follow up — payment pending."*

**Transition to IN_LAB:**
When the payment is confirmed and recorded, the operator transitions the order and contacts the laboratory.

---

### IN_LAB

**What it means:**
Payment has been confirmed. The laboratory has been contacted (or must be contacted immediately). The system is waiting for a layout draft from the lab.

**What the operator is doing:**
Managing the lab relationship — sending the request, tracking the deadline, sending reminders if the lab is late.

**Deadline fields active:**
- `lab_response_due` — the date by which the lab should deliver a layout

**Attention triggers:**
- Order is `IN_LAB` but no `lab_contacted_at` is recorded → task generated: *"Lab not yet contacted — send request."*
- `lab_response_due` is today → task generated: *"Lab deadline today — expect layout or send reminder."*
- `lab_response_due` is in the past → task generated: *"Lab overdue — reminder required."* Each day past deadline increments a visible counter.

**Reminder behavior:**
Each reminder sent is logged in the lab interaction entry (reminder count, last reminder date). The system generates the reminder task; the operator sends it manually and confirms it was sent.

**Corrections loop:**
When a client requests corrections (from `WAITING_CLIENT_APPROVAL`), the order returns to `IN_LAB`. A new lab interaction entry is created with an incremented version number and a new deadline. The previous layout and client correction notes are preserved.

---

### WAITING_CLIENT_APPROVAL

**What it means:**
A layout has been received from the laboratory and forwarded to the client. The system is waiting for the client's decision.

**What the operator is doing:**
Waiting for client response. Following up if the client is slow.

**Deadline fields active:**
- `client_response_due` — the date by which the client should respond

**Attention triggers:**
- Layout received but `sent_to_client_at` not recorded → task generated: *"Layout not yet sent to client."*
- `client_response_due` is today → task generated: *"Client response due today."*
- `client_response_due` is in the past → task generated: *"Client response overdue — follow up."*

**Possible client decisions (both require human confirmation):**
- **Approved** → Order moves to `WAITING_ORIGINAL`
- **Corrections requested** → Correction notes recorded; order returns to `IN_LAB`

---

### WAITING_ORIGINAL

**What it means:**
The client has approved the layout. The laboratory has been notified to print the original certified document.

**What the operator is doing:**
Waiting for the original document to arrive from the lab.

**Deadline fields active:**
- `original_expected` — the expected date the original document will arrive

**Attention triggers:**
- `original_expected` is today → task generated: *"Original expected today — check with lab."*
- `original_expected` is in the past → task generated: *"Original overdue — contact lab."*

---

### READY_FOR_DELIVERY

**What it means:**
The original document has arrived from the laboratory. It must be sent to the client and the payment balance must be verified before the order can be completed.

**What the operator is doing:**
Sending the original to the client; confirming full payment has been received.

**Deadline fields active:**
None formal. The system flags this state if it persists more than 1 day without action.

**Attention triggers:**
- `original_received_at` is set but `sent_to_client_at` is not recorded after 1 day → task generated: *"Original not yet sent to client."*
- `balance_due` is greater than zero → task generated: *"Payment debt outstanding — resolve before completing."*

**Closure gate:**
The order cannot move to `COMPLETED` unless both conditions are met:
1. `sent_to_client_at` is recorded
2. `balance_due` equals zero

Both conditions are checked by the system, but the act of completing the order requires explicit operator confirmation.

---

### COMPLETED

**What it means:**
The order is complete. The original document was delivered, payment was received in full, and the operator confirmed completion.

**No attention triggers.** Completed orders are read-only history.

---

### CANCELLED

**What it means:**
The order was voided at any stage. A cancellation reason is recorded.

An order can be cancelled from any non-terminal status. Cancelled orders are never deleted — they remain visible in order history with their full event log.

**No attention triggers.** Cancelled orders are read-only history.

---

## State Transition Map

```
                    ┌─────┐
         Form/      │ NEW │
         Contact ──▶│     │─────────────────────────────────────┐
                    └──┬──┘                                     │
                       │ quote communicated to client            │
                       ▼                                         │
              ┌─────────────────┐                                │
              │ WAITING_PAYMENT │──────────────────────────────▶ │
              └────────┬────────┘                               │
                       │ payment confirmed                       │
                       ▼                                         │
              ┌────────────────┐                                 │
  corrections │    IN_LAB      │◀──────────┐                     │
      loop ──▶│                │           │                     │
              └───────┬────────┘           │                     │
                      │ layout received     │                     │
                      │ + sent to client    │                     │
                      ▼                    │                     │
          ┌────────────────────────┐        │                     │
          │ WAITING_CLIENT_APPROVAL│        │                     │
          └──────────┬─────────────┘        │                     │
                     │                      │                    │
         ┌───────────┴──────────┐           │                    │
         │ approved             │ corrections                     │ CANCELLED
         ▼                      └───────────┘                    │
  ┌─────────────────┐                                            │
  │ WAITING_ORIGINAL│                                            │
  └────────┬────────┘                                            │
           │ original received                                   │
           ▼                                                     │
  ┌────────────────────┐                                         │
  │ READY_FOR_DELIVERY │                                         │
  └────────┬───────────┘                                         │
           │ original sent to client                             │
           │ + balance_due = 0                                   │
           ▼                                                     │
       ┌───────────┐                                             │
       │ COMPLETED │◀────────────────────────────────────────────┘
       └───────────┘    (CANCELLED is a separate terminal
                         reachable from any active state)
```

---

## The Corrections Loop

Each pass through the corrections loop is a separate, versioned lab interaction. Nothing from a previous iteration is overwritten.

| Iteration | Lab Interaction Entry | Layout Entry | Client Review Entry |
|-----------|-----------------------|--------------|---------------------|
| First | version 1, own deadline | version 1 | decision + notes |
| Second | version 2, own deadline | version 2 | decision + notes |
| Third | version 3, own deadline | version 3 | decision + notes |

The operator can always see the complete history of every layout version and every client response in chronological order.

---

## Closure Gates Summary

| Gate | Field Checked | Who Enforces |
|------|--------------|-------------|
| Cannot complete with unpaid debt | `balance_due === 0` | System (blocks transition) |
| Cannot complete without delivery confirmed | `sent_to_client_at` is set | System (blocks transition) |
| Cannot complete without human confirmation | Explicit operator action required | Design Principle 7 |

---

## Attention Dashboard Logic

The dashboard evaluates every active order against these rules on each load and on a scheduled background check. Priority order (highest to lowest):

| Priority | Condition | Label |
|----------|-----------|-------|
| 1 — Critical | Deadline passed and no action recorded | OVERDUE |
| 2 — Urgent | Deadline is today | DUE TODAY |
| 3 — Blocked | Required action not taken (lab not contacted, layout not sent) | ACTION NEEDED |
| 4 — Debt | `balance_due > 0` in `READY_FOR_DELIVERY` status | DEBT |
| 5 — Stale | `NEW` or `WAITING_PAYMENT` order with no movement for 3+ days | STALE |
| 6 — Pending | Open tasks assigned to this order | TASKS |

An order with no flags does not appear in the attention panel. Only flagged orders surface.
