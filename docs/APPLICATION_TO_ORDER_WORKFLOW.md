# Application → Order Workflow

Status: **Design only.** No implementation. Describes how a Google Form
submission becomes an active laboratory order, the lifecycle stages in between,
and where the system may *recommend* (never act).

Operates under **recommendation mode** (Recommendation → Operator Confirmation →
Execution). Nothing here sends a WhatsApp message, sends a lab email, or promotes
an application without explicit operator action. See `ORDER_MATCHING_DESIGN.md`,
`PROCESS_STATES.md`, and the recommendation-mode rule.

---

## 0. The central fact

**A Google Form submission is NOT yet an Order.** It is a raw *application*
living in the "New Applications" intake artifact. It becomes an Order — a row in
the Declaration sheet — only when the operator has prepared it, and it becomes an
**active laboratory order only when the lab email is actually sent** (business
step 11).

This has a direct consequence for design: the system must **not** auto-create a
Declaration Order the moment a form row appears. (An early `formsIntake` sketch
in the codebase would call `orderService.createOrder()` straight from a form row;
that is premature under this workflow and is **not wired** — see §6.4.) The
application must mature through review, completeness checks, and operator commit
before it ever touches the Declaration.

---

## 1. Application lifecycle

The application moves through intake stages that are **distinct from**
`ORDER_STATUSES`. Only at promotion does it acquire an Order status.

```
[Google Form submitted]
        │
        ▼
  NEW                  Row appears in "New Applications". No Order yet.
        │
        ▼
  UNDER_REVIEW         Operator reads it; completeness check runs (§3).
        │
        ├─ missing info ─► INFO_PENDING ──(WhatsApp follow-up, §5)──┐
        │                                                          │
        ▼                                                          │
  READY_TO_PREPARE  ◄───────────────(info received)───────────────┘
        │
        ▼
  PREPARED             Word draft written, IP/LLC registration cert attached,
        │              lab email drafted (subject = entity name; body = DS/SS/PI…).
        │
        │  ◄── PROMOTION POINT: operator commits → Declaration row created
        │      as an Order at status "Запустить" (prepared; lab request not yet sent)
        ▼
  SUBMITTED_TO_LAB     Operator sends the lab email.
                       Order transitions "Запустить" → "Ждем макет".
                       === NOW it is an active laboratory order. ===
```

Terminal intake outcomes before promotion: **REJECTED** (not a real order — bad
data, duplicate, client withdrew) and **STALE** (no response to WhatsApp
follow-up after a threshold). Neither writes to the Declaration.

### 1.1 Stage → status mapping

| Application stage | In Declaration? | Order status |
|---|---|---|
| NEW / UNDER_REVIEW / INFO_PENDING / READY_TO_PREPARE | No | — (no status) |
| PREPARED (operator commits) | **Row created** | `Запустить` |
| SUBMITTED_TO_LAB (lab email sent) | Yes | `Запустить` → `Ждем макет` |

"Active laboratory order" ≡ `Ждем макет` (lab request sent, awaiting layout).
The whole point of step 11 is this transition.

---

## 2. Order creation trigger

There are **two distinct trigger moments**, and conflating them is the main
design risk:

| Trigger | What it produces | Who fires it |
|---|---|---|
| **Promotion trigger** | A Declaration row (Order) at `Запустить` | Operator commits a PREPARED application |
| **Activation trigger** | `Запустить` → `Ждем макет` ("active lab order") | Operator **sends the lab email** |

Design rules:

- The **promotion trigger is operator-driven**. The system may *recommend* "this
  application looks complete and ready to promote", but creating the Declaration
  row is an operator confirmation, not an automatic side effect of form arrival.
- The **activation trigger is the act of sending the lab email**. The system must
  **never auto-send** that email (recommendation mode + the "no sending without
  confirmation" rule). It may *prepare* the draft; the operator sends; the send
  is what flips the status.
- Because activation = "lab request sent", this is exactly the `Запустить →
  Ждем макет` edge in the status model — keep them the same event, not two.

---

## 3. Required information checks

Before an application can be promoted, the system checks completeness against the
fields a real lab order needs. Each maps to an Order/Declaration field or an
attachment.

| Required item | Maps to | Why required |
|---|---|---|
| Legal entity name (IP/LLC) | `client.name` / `client.companyName` | The subject line + Declaration `Client` column; the matching anchor (`ORDER_MATCHING_DESIGN.md`). |
| Client phone (WhatsApp) | `client.phone` (normalized) | The only client channel; needed for follow-up and delivery. |
| Document type (DS vs SS) | `Declaration.document_type` | Declaration of conformity vs. certificate of conformity — drives the lab instructions. |
| IP/LLC registration certificate | attachment (classified "IP registration" / "company registration") | Required attachment on the lab email. |
| Product / position info incl. **PI count** | application fields → lab email body | Lab instruction parameter (number of product items/positions to certify). |
| Laboratory assignment | `laboratory.laboratoryName` / `laboratoryEmail` | Determines recipient (Dastan / Bermet / Heavy regulations). |
| Payment status | `payments` / `balance_due` | `Запустить` presumes payment received; flag if unpaid. |
| Authorization letter (if applicable) | attachment | Some orders require it. |

The check is a **read-only completeness evaluation**; it produces a *report*, not
a state change.

---

## 4. Missing information detection

- **What it does:** compares the submitted form fields + attachments against the
  §3 required set and produces a structured list of what's missing or
  low-quality (e.g. phone present but un-normalizable, entity name blank,
  registration cert not attached, DS/SS ambiguous, PI count absent).
- **Granularity:** per-field, with a reason and a suggested resolution channel
  (most missing client data → WhatsApp; most document issues → operator).
- **Output:** a recommendation attached to the application ("3 items missing
  before this can be promoted"), plus a draft follow-up (§5). It **does not**
  block anything on its own and **does not** message anyone.
- **Quality, not just presence:** detect malformed values too — a phone that
  can't be normalized to 9 local digits, an entity name that won't match the
  Declaration `Client` column, conflicting document type.

---

## 5. WhatsApp follow-up recommendations

When client-side information is missing, the system **recommends** a WhatsApp
message; the operator reviews and sends it. WhatsApp is the client channel (the
Declaration phone is the WhatsApp number; partial/suffix matching applies).

Design:

- The system **drafts** a message listing exactly the missing items, addressed to
  the normalized client phone, and surfaces it for operator review.
- The operator edits/approves and **sends it themselves** — the system never
  sends WhatsApp automatically (recommendation-mode hard rule; future
  Email↔WhatsApp transfer is also gated).
- While awaiting a reply the application sits in **INFO_PENDING**; a follow-up
  task tracks it. After a staleness threshold with no reply → **STALE**
  (recommend, don't auto-reject).
- One phone may belong to many orders/entities — the follow-up must reference the
  **specific application/entity**, never assume the contact = this one order
  (see the order-identity model).

---

## 6. Transition from New Applications to Declaration

### 6.1 The promotion gate

An application may be promoted to a Declaration Order only when:

1. Completeness check passes (§3), and
2. The operator commits.

On promotion the operator-confirmed write creates the **Declaration sheet row**
— the authoritative record (the sheet "Декларация" is the source of truth;
MongoDB is a synchronized replica that mirrors the new row, not the origin).
The `Order` / `Declaration` documents are the synchronized projection, keyed to
the row by `sheet_row_id`. From here the order is governed by `ORDER_STATUSES`
and the matching/auditor designs. If the Mongo copy ever diverges from the sheet,
the sheet wins.

### 6.2 Activation

Sending the lab email (operator action) transitions `Запустить → Ждем макет`.
The sent email's **subject = legal entity name** (optionally with the operator's
sequence number for repeats — a matching signal, per `ORDER_MATCHING_DESIGN.md`),
and the **body carries the lab instructions** (DS/SS, additional PI count, etc.).
That subject + sender is what the matcher later uses to attribute the lab's
replies back to this exact row.

### 6.3 Idempotency / duplicates

Each application promotes to **at most one** Declaration row. Re-processing the
same form row must not create a second order. (One legal entity legitimately
recurs across many rows for *separate* orders — duplicate-suppression keys on the
application identity, not on the entity name.)

### 6.4 Note on the existing intake sketch

The unwired `formsIntake` design creates an Order directly from a form row. Under
this workflow that is the **wrong trigger** — it would put an unreviewed,
possibly-incomplete application into the Declaration at `Запустить` before review,
completeness checks, or operator commit. If intake is ever automated, it should
write to a **New Applications staging area**, not the Declaration, and stop at
the promotion gate.

---

## 7. Future automation opportunities

All recommend-only; the operator confirms/sends every outward or state-changing
step.

| Opportunity | Recommend (allowed) | Never (gated) |
|---|---|---|
| Completeness scoring | Flag missing/low-quality fields, rank readiness | Auto-promote |
| WhatsApp follow-up | Draft the exact "missing info" message | Auto-send it |
| Word draft generation | Generate the draft from application data | — |
| Registration cert handling | Detect/classify the attached cert, flag if absent | Auto-attach without review |
| Lab email drafting | Draft subject (entity name [+ seq number]) and body (DS/SS, PI count, instructions) from a template | **Auto-send the lab email** (this is the activation trigger — must stay manual) |
| Lab routing | Suggest the laboratory (Dastan/Bermet/Heavy) from order type/history | Auto-assign silently |
| Promotion suggestion | "Application complete — ready to create the order" | Create the row on its own |
| Duplicate detection | Warn if this application looks already-promoted | Auto-merge/auto-reject |

**Hard line:** the two trigger actions that define a real order — *creating the
Declaration row* and *sending the lab email* — remain operator actions. The
system's role across this whole pipeline is to **prepare and recommend**, so the
operator can act in one click, never to act for them.

---

## 8. Dependencies (for planning, not built here)

- A **New Applications staging model** distinct from the Declaration (Google Form
  responses sheet or an `applications` collection), with intake stages from §1.
- **Completeness rules** (§3) as data, so they can evolve without code churn.
- **Phone normalization** (shared with `ORDER_MATCHING_DESIGN.md` §9) for both
  follow-up addressing and later WhatsApp evidence.
- **Draft templating** for the Word draft and the lab email body (DS/SS/PI).
- Promotion writes a Declaration row — a **gated write**; activation writes a
  status — also gated. Both flow through the existing confirmation path.
