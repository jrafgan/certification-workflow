# BUSINESS PROCESS
## How the Certification Workflow Actually Works

---

## Overview

The certification workflow is a coordinated sequence of actions between three parties:

| Party | Role |
|-------|------|
| **Operator** | Manages the entire process end-to-end |
| **Client** | Requests certification, reviews layouts, receives originals |
| **Laboratory** | Produces certification layouts (drafts) and original documents |

The operator is the single point of coordination. All communication passes through them.

---

## Phase 1 — Client Contact and Order Creation

A potential client makes contact through one of several channels:
- WhatsApp (primary)
- Telegram
- Instagram or Facebook direct message
- Phone call
- Google Form submission

At the moment of first contact, an Order is created in the system with status `NEW`. This is the boundary: nothing that has been contacted is ever allowed to exist outside the system.

The operator records:
- Client name and phone number
- Contact channel
- Type of document or certification requested
- Any initial notes

If the client came through a Google Form, a Declaration record is created or linked at this point. If contact was informal (WhatsApp, phone), the Declaration is created manually.

**Risk this phase controls:** A potential client contacted but not recorded — lost before any work begins.

---

## Phase 2 — Quotation

The operator calculates the cost for the requested certification work.

The quoted amount and the date it was communicated to the client are recorded on the Order. There is no separate quote document — the quote is a field, not an entity.

The Order remains in `NEW` until the quote is communicated to the client, at which point it moves to `WAITING_PAYMENT` until payment is confirmed.

**Risk this phase controls:** A quote given but never followed up — the client goes cold and the operator has no record to act on.

---

## Phase 3 — Payment and Order Activation

When the client confirms payment, the operator:
1. Records the payment (date, amount, method) on the Order
2. Verifies that the received amount matches the quoted amount or notes any partial payment
3. Transitions the Order to `IN_LAB`

At this point, the Order is active. It will not leave the system until it is either completed or cancelled.

The Declaration record is updated to reflect the payment.

**Risk this phase controls:** Payment received but order never activated — work begins without a recorded trigger.

---

## Phase 4 — Laboratory Request

The operator sends a request to the laboratory via Gmail. The email contains the client's certification requirements and any supporting documentation.

When the request is sent, the operator records on the Order:
- The date the request was sent
- The deadline by which the laboratory should respond with a layout draft

A deadline is mandatory. Without a concrete deadline date, no automated reminder can fire.

The system scheduler monitors this deadline. If the deadline passes without a layout being recorded as received, a task is automatically created: **"Remind laboratory — layout overdue."**

The operator can send a reminder manually or wait for the next automated check. Each reminder attempt is logged.

**Risk this phase controls:** Lab contacted but no layout arrives — operator forgets to follow up and the order stalls silently.

---

## Phase 5 — Layout Receipt and Client Review

When the laboratory sends back a layout draft (by email or other means), the operator:
1. Records the layout as received on the Order (date, file reference, version number)
2. Forwards the layout to the client
3. Records the date it was sent to the client
4. Sets a client response deadline

The system scheduler monitors the client response deadline. If it passes without a client decision recorded, a task is automatically created: **"Follow up with client — layout response overdue."**

### 5a — Client Requests Corrections

The client reviews the layout and requests changes.

The operator:
1. Records the correction request with the client's notes
2. Sends the correction instructions to the laboratory
3. Creates a new laboratory interaction entry on the Order (version incremented)
4. Sets a new lab response deadline
5. Status returns to `IN_LAB`

This loop (Phase 4 → Phase 5 → corrections → Phase 4) can repeat multiple times. Each iteration is tracked as a separate lab interaction entry with its own version number, deadline, and reminder history. There is no limit on iterations, but every one is visible.

### 5b — Client Approves Layout

The client confirms the layout is acceptable.

The operator:
1. Records the approval with timestamp
2. Notifies the laboratory to proceed with printing the original document
3. Transitions the Order to `WAITING_ORIGINAL`
4. Sets the expected date for the original document to arrive

**Risk this phase controls:** Corrections sent back to lab without logging — version confusion, operator sends wrong draft to client in a future iteration.

---

## Phase 6 — Original Document Production and Delivery

The laboratory prints the original certified document and sends it to the operator.

When the original arrives:
1. The operator records receipt of the original document on the Order
2. The Order transitions to `READY_FOR_DELIVERY`
3. The operator sends the original to the client (by post, courier, or in person)
4. The date sent to the client is recorded

**Risk this phase controls:** Original received but not tracked — operator forgets to send it to the client or cannot confirm delivery.

---

## Phase 7 — Order Completion

Before an order can be completed, two conditions must both be true:
1. The original document has been sent to the client
2. The payment balance is zero (total paid equals total quoted)

If a balance remains (`balance_due > 0`), the system will not allow completion. The Order remains in `READY_FOR_DELIVERY` status with a visible debt alert on the dashboard.

When both conditions are met, the operator completes the Order. The Declaration record is updated to reflect completed status.

**Risk this phase controls:** Order closed with an unpaid balance — debt goes unnoticed.

---

## The Declaration Spreadsheet

The Declaration is the formal business record that predates this system. It is not an import artifact to be discarded after migration — it is an ongoing operational document.

**Current structure:**
- Payment date
- Payment amount
- Client name
- Document type
- Phone
- Notes
- Status

**In this system:**
- Every Order has a corresponding Declaration record
- When an Order is updated (payment received, status changed, notes added), the Declaration is updated
- The Declaration can be imported from Google Sheets or created manually in the system
- The `sheet_row_id` field allows future bidirectional sync with Google Sheets without structural changes

The Declaration is the face of the business record. The Order is the operational engine behind it.

---

## Where Orders Can Go Wrong — Summary

| Phase | What Can Be Forgotten | How the System Prevents It |
|-------|----------------------|---------------------------|
| 1 – Contact | Client contacted but not recorded | Orders created at first contact, no lead lives outside the system |
| 2 – Quote | Quote given, no follow-up | NEW orders visible on dashboard until they move or are cancelled |
| 3 – Payment | Payment received, order not activated | Payment recording is the trigger for activation |
| 4 – Lab Request | Lab not contacted after payment | IN_LAB without a lab_contacted_at triggers an open task |
| 4 – Lab Deadline | Lab misses deadline silently | lab_response_due field drives automated reminder task |
| 5 – Client Review | Client not sent the layout | Layout received without sent_to_client_at triggers an open task |
| 5 – Client Deadline | Client doesn't respond | client_response_due field drives follow-up task |
| 5 – Corrections | Corrections not properly tracked | Each correction loop is a versioned lab interaction |
| 6 – Delivery | Original not sent to client | original_received_at without sent_to_client_at triggers a task |
| 7 – Completion | Order completed with debt | balance_due > 0 blocks completion |
