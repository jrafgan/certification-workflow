# Order Matching Design

Status: **Design only.** No implementation. Describes how laboratory Gmail
messages should be matched to a specific Declaration row (an Order), the
confidence model that gates the match, and the operator review flow that
executes it.

This design operates under the system's standing rule: **recommendation mode**
(Recommendation → Operator Confirmation → Execution). Matching only ever
*proposes*; it never auto-assigns an email to an order, never changes a status,
and never sends a message. See `BUSINESS_PROCESS.md` and the recommendation-mode
rule.

---

## 0. Where this fits today

Today there is **no automatic matching**. The operator searches Gmail, picks a
thread, and manually links it to one order + lab-interaction version
(`labCommService.linkThread`); detection (`workflowDetectionService`) then only
*classifies* the already-linked thread (layout vs. original). There is no
candidate set, no scoring, and no phone/entity/subject signal in the match.

This document specifies the missing layer: an **email → candidate Declaration
rows → ranked, confidence-scored recommendation** that feeds the existing
operator-confirmation path. It changes nothing about who has final authority —
the operator still confirms every link and every status change.

---

## 1. Order identity model

### 1.1 The Order is the only matchable entity

The main business entity is an **Order**, which **is a single row in the
Declaration sheet**. Not a client, not a WhatsApp contact, not an email thread,
not a legal entity.

**Source of truth.** The Google Sheet "Декларация" is the authoritative system
of record. MongoDB is a **synchronized replica / index** of it, not the origin —
if the two disagree, the **sheet wins**. So an Order *is* a sheet row; the Mongo
documents below are a projection of that row used for fast matching/search. The
sheet value of a status is authoritative even when the Mongo copy looks
"cleaner"; matching may normalize for indexing but must never treat the replica
as overriding the sheet.

In the data model an Order is represented by:

- the authoritative **Declaration sheet row** (`sheet_row_id`), and
- a synchronized `Order` document (`Order._id`) + linked `Declaration` document
  (the sheet mirror), joined by `Order.declaration_id` ⇄ `Declaration.order_id`.

**Every workflow event must ultimately resolve to one `sheet_row_id`.** Threads,
phones, entity names, and subject numbers are *signals that point at* an order —
they are never the identity of one.

### 1.2 What is explicitly NOT an identifier

| Thing | Why it is not an identity | Cardinality |
|---|---|---|
| WhatsApp / phone number | One contact places many orders across many entities | 1 phone → N orders |
| Legal entity name (IP/LLC) | The same IP/LLC recurs across many rows (repeat orders) | 1 entity → N orders |
| Email subject sequence number | Operator-appended hint for "a later order", manually typed | signal only |
| Client (person) | Owns multiple IPs/LLCs | 1 person → N entities → N orders |
| Email thread | A thread is linked to one order, but threads are created/linked manually and can be mis-linked | 1 thread → 1 order (by link) |

### 1.3 Identity resolution direction

```
Lab email  ──signals──►  candidate Declaration rows  ──operator confirm──►  ONE Order (sheet_row_id)
(subject,                (Client column match +                            = the matched entity
 sender,                  ranking signals)
 attachments)
```

The matcher's job is to produce the **candidate set and a ranking**, never to
collapse it to one row on its own when ambiguity exists.

---

## 2. Matching signals

Signals are grouped into **gating signals** (decide whether a row is even a
candidate) and **ranking signals** (order the candidates and feed the score).

### 2.1 Gating signals (candidate membership)

| Signal | Source | Rule |
|---|---|---|
| **Legal entity name** | Email subject → matched against Declaration `Client` column (`Order.client.name` / `client.companyName`, `Declaration.client_name`) | A row is a candidate only if its Client matches the subject entity (normalized; see §2.3). This mirrors the real workflow: *subject → Client column → phone → WhatsApp*. |
| **Laboratory** | Email sender vs. `Order.laboratory.laboratoryEmail` / `laboratoryName` | Sender must be a known lab (`LAB_KNOWN_SENDERS`: Dastan = standartpro98@gmail.com, Bermet = mng-1@kyrgyz-test.kg, Heavy regulations = test@test.kg). A candidate whose order is assigned to a *different* lab is heavily penalized, not excluded (orders can be reassigned). |

### 2.2 Ranking signals (score contributors)

| Signal | Source | Intent |
|---|---|---|
| **Subject sequence number** | Trailing integer in subject ("…Кенжегул **3**") | The Nth order for that entity, oldest→newest. Strong positional hint, **not** an ID. Absence = treat as order #1 / unnumbered. |
| **Workflow-stage compatibility** | Detected event (layout/original via `WORKFLOW_STATUS_MAP`) vs. candidate `Order.status` | The protection against assuming chronology. An `ORIGINAL_RECEIVED` email fits an order in `Ждем оригинал`, *not* the newest row sitting in `Запустить`. |
| **Active lab thread** | Open `LabCommThread` for the candidate (status `waiting`) awaiting exactly this kind of reply | A candidate already waiting on a layout/original is a strong match. |
| **Order recency / dates** | `Order.created_at`, `Declaration.payment_date` | "Latest row is usually the newest order" — a *soft* signal only (§ business rules: not guaranteed). |
| **Document type** | Attachment classification vs. `Declaration.document_type` (declaration vs. certificate) | A certificate attachment favors certificate orders. |
| **Attachment / keyword evidence** | `LAYOUT_*` / `ORIGINAL_*` body+filename keywords | Determines the *event type*, which then drives stage compatibility. |

### 2.3 Normalization required for signals to work

- **Entity name:** strip trailing sequence number; collapse whitespace; case-fold;
  tolerate org-form prefixes (ИП/ОсОО/LLC); consider transliteration/spelling
  variance (fuzzy match, not exact equality).
- **Phone (for the WhatsApp leg, not for email matching):** normalize to the
  local 9 digits (strip `+`, spaces, leading `996`, leading `0`). `777240858`
  and `+996777240858` must compare equal. Matching is **suffix/normalized**, not
  prefix — the current prefix-anchored regex (`labCommService.js:502`) cannot do
  this and must be replaced (schema-gated change; see §8 and the
  `client-comms-channels` rule).
- **Subject:** separate the entity name from the trailing number so the number
  becomes its own signal rather than corrupting the name match.

### 2.4 Phone source authority: Declaration > New Form

When the same client has a phone in **both** the Declaration sheet and the New Form
submission and they differ, the **Declaration phone is authoritative**. Declaration
rows are manually verified by the operator before being recorded; New Form data is
user-submitted and may carry typos, outdated numbers, assistant numbers, or temporary
numbers.

Matching rules:

1. **Primary identity** — the Declaration phone is the phone identity used for the
   WhatsApp leg and `matchKey` (§2.3).
2. **Secondary evidence only** — the New Form phone may corroborate but never decides.
3. **Never overwrite** — the Declaration phone is never auto-updated from New Form.
4. **On mismatch** — emit a review note, verbatim:
   `"Phone mismatch detected. Declaration phone retained as authoritative."`
   Do **not** auto-correct, do **not** auto-update — operator decides.

This is the phone-specific instance of the global source-of-truth priority
(Operator > Declaration > Approved KB > Email > WhatsApp history > YouTube). Stored in
the Approved Knowledge Base as `phone_source_priority`
(`operatorMasterKbV2`, category *Declarations*).

> Caveat (combat test 2026-06-22, `docs/runbooks/COMBAT_TEST_2026-06-22.md`):
> "authoritative" here means *more trustworthy than New Form*, not *always correct* —
> Declaration phones were still found wrong/truncated vs. the client's official
> registration certificate (the certification mockup). The certificate/mockup remains a
> separate, higher-fidelity recovery source and is **not** New Form data.

---

## 3. Confidence scoring model

### 3.1 Shape

For each candidate row, compute a normalized score in **[0, 1]** as a weighted
sum of signal sub-scores. Each signal yields a sub-score in [0, 1]; weights are a
**starting proposal to be calibrated against real data**, not fixed law.

| Signal | Sub-score definition | Proposed weight |
|---|---|---|
| Entity name match quality | 1.0 exact-normalized, scaled down for fuzzy distance | 0.30 |
| Workflow-stage compatibility | 1.0 if detected event applies to this status (`WORKFLOW_STATUS_MAP.from`), else ~0.1 | 0.25 |
| Subject sequence ↔ order position | 1.0 if the Nth-oldest candidate matches subject number N | 0.15 |
| Active waiting lab thread of matching kind | 1.0 if present, 0 otherwise | 0.15 |
| Laboratory match | 1.0 same lab, ~0.2 different lab | 0.10 |
| Recency / document-type tie-breakers | small positive nudges | 0.05 |

`score = Σ (weight_i × subscore_i)`, already normalized because weights sum to 1.

### 3.2 What the score gates — and what it does NOT

The score gates **how the recommendation is presented to the operator**, never
whether the system acts on its own:

| Tier | Condition | Behavior |
|---|---|---|
| **HIGH** | top score ≥ 0.80 **and** margin to 2nd ≥ 0.20 | Pre-select the top candidate in the recommendation; operator still confirms. |
| **MEDIUM** | top score ≥ 0.50 but margin small, or 0.50–0.80 | Present a **ranked candidate list** with scores + evidence; no pre-selection. |
| **LOW / AMBIGUOUS** | top < 0.50, or ≥2 candidates within the margin, or signal conflict | Full operator review; explicitly flagged "ambiguous — choose manually". |

This maps onto the existing `WorkflowDetection.recommendation` vocabulary:
`transition` (HIGH, stage-compatible), `needs_review` (MEDIUM/LOW),
`conflict` (contradictory signals). **No tier ever auto-applies** — recommendation
mode is absolute.

### 3.3 Calibration note

Weights and thresholds must be tuned on labelled history (past emails ↔ the row
the operator actually chose). Ship with conservative thresholds (bias toward
review) and tighten only as precision is measured. Confidence is advisory; a
HIGH score is a *better default for the operator*, not permission to skip them.

---

## 4. Candidate ranking algorithm (described, not coded)

1. **Parse the email.** Verify sender ∈ known labs. Extract subject; split into
   `(entity_name, sequence_number?)`. Classify attachments/body into an event
   type (layout / original / question / other) using existing keyword rules.
2. **Build the candidate set.** Query Declaration rows whose `Client` matches the
   normalized entity name (fuzzy). If zero → "no candidates" → operator review
   (possibly a brand-new/unlinked order). If exactly one → still scored, but a
   single candidate skips ranking.
3. **Order candidates oldest→newest** by order date so the subject sequence
   number can be aligned positionally (Nth order = Nth oldest).
4. **Score every candidate** with the §3 model. Compute stage compatibility from
   the detected event so out-of-order processing is handled: a candidate in the
   right stage outranks a newer candidate in the wrong stage.
5. **Rank by score; compute the top-1 vs top-2 margin.**
6. **Assign a tier** (§3.2) from score + margin + conflict checks.
7. **Emit a recommendation record** (ranked candidates, per-candidate scores, the
   evidence behind each sub-score, the proposed event type, and the tier). Persist
   as a `WorkflowDetection`-style `pending` record. **Stop.** Await operator.

The algorithm never writes a status, never links a thread, never messages a
client. It produces a ranked proposal and halts.

---

## 5. Ambiguity handling

A match is **ambiguous** (forced to operator review, never auto-assigned) when
any of the following hold:

- More than one candidate within the score margin (the §business-rule case:
  "multiple candidate rows exist").
- Top score below the HIGH threshold.
- **Sequence-number conflict** — subject says "3" but there aren't three orders
  for that entity, or the Nth-oldest is already completed.
- **Stage conflict** — the detected event (e.g. original) doesn't apply to any
  candidate's current status, suggesting out-of-order processing or a mis-typed
  subject.
- **Multiple event types** detected in one email (`conflict`).
- Sender not a known lab, or entity name unresolved/too fuzzy.

Out-of-order processing is treated as *expected*, not exceptional: ranking leans
on **stage compatibility over recency**, and any residual doubt routes to review.
The system must **never** assume Order #1 finishes before Order #3.

---

## 6. Operator review flow

```
Lab email ─► Matcher ─► pending recommendation (ranked candidates + scores + evidence)
                              │
                              ▼
                    Operator review UI
            ┌─────────────┬──────────────┬───────────────┐
            │ Confirm one │ Reject /      │ Defer / mark  │
            │ candidate   │ none apply    │ needs info    │
            └──────┬──────┴──────┬────────┴───────────────┘
                   ▼             ▼
        Execution (gated):   No state change;
        - link thread ↔ order  recommendation
        - apply status via     archived/rejected
          confirmDetection
        - queue sheet write-back (already operator-confirmed)
        - surface phone for WhatsApp follow-up (operator-initiated)
```

Properties:

- The recommendation shows, per candidate: the row (`sheet_row_id`), Client,
  current status, lab, the matched signals, and the numeric score + tier.
- **Confirm executes through the existing gated path** (`confirmDetection` →
  status transition → `sheetsSync` write-back). Nothing new bypasses the gate.
- For HIGH-tier single matches, the top candidate is pre-selected to make confirm
  one click — but confirm is still required.
- After linking, the operator gets the client's **phone for WhatsApp** (the real
  workflow's final leg); the system never messages the client automatically.
- Reject/defer leaves all state untouched; the email remains unmatched for a
  later pass.

---

## 7. Examples from real business scenarios

### 7.1 Repeat entity, subject number resolves it (HIGH)

Email subject: **"ИП Парманова Кенжегул 3"**, sender Dastan, layout attached.
Candidates (oldest→newest): row 150 (`Завершен`), row 320 (`Завершен`),
row 570 (`Ждем макет`).

- Entity name: exact → 0.30.
- Sequence "3" → 3rd-oldest = row 570 → 0.15.
- Stage: layout fits `Ждем макет` (row 570) → 0.25; rows 150/320 are
  `Завершен` → ~0.
- Active waiting layout thread on row 570 → 0.15.
→ Row 570 ≈ 0.85+, margin large → **HIGH**, pre-selected. Operator confirms.

### 7.2 Out-of-order processing (stage beats recency)

Same entity, **original** arrives while the newest row (570) is still `Ждем
макет` but an older row (320) is in `Ждем оригинал`.

- Recency would wrongly favor 570, but stage compatibility favors 320 (only
  `Ждем оригинал` accepts an original).
→ Row 320 scores higher on the dominant stage signal. If the margin is thin or
the subject number contradicts, → **MEDIUM/AMBIGUOUS**, operator chooses. The
chronology assumption is never made.

### 7.3 One phone, several entities (no collapse)

WhatsApp `0555123456` owns IP Amanov (declaration), LLC Amanat Textile
(certificate), LLC Asia Group (declaration). A layout email for "ОсОО Аманат
Текстиль" matches only the LLC Amanat Textile rows — the shared phone is
irrelevant to email matching and never merges the three entities into one order.

### 7.4 Ambiguous repeat, no number (LOW)

Subject "ИП Парманова Кенжегул" (no number), two candidate rows both in
`Ждем макет`, same lab, similar dates. Margin ≈ 0 → **AMBIGUOUS** → full
operator review, no pre-selection.

### 7.5 Unknown sender

Email from an address not in `LAB_KNOWN_SENDERS` → no candidate gating signal →
flagged for review, never matched automatically.

---

## 8. Future Workflow Auditor integration

The Workflow Auditor consumes this matcher's output and **operates at the Order
(Declaration row) level**, never the client level.

**Mandatory pipeline — matching gates auditing:**

```
Order Matching → Evidence Collection → Status Validation → Recommendation
```

Never `Evidence → direct status change`. A status mismatch can only be raised for
an order whose match is **confirmed/high-confidence**; evidence with no reliable
order attribution produces no status recommendation. Concretely:

- **Order matching must occur first.** A mismatch recommendation is only as
  reliable as the email→order match behind it.
- **Every mismatch recommendation must carry:** the matched order
  (`sheet_row_id`), the supporting evidence (the lab email / WhatsApp message),
  and the **confidence score** of the underlying match.
- **Low-confidence matches generate no automatic status recommendation** — they
  do not silently become "mismatch" alerts.
- **Ambiguous matches escalate to operator review** (resolve the match first,
  then audit).

- **Resolution:** the Auditor uses the same email→order resolution to attribute
  Gmail evidence to a specific `sheet_row_id`. WhatsApp evidence attaches via the
  normalized-phone link, but is reconciled **per order**, not per contact (one
  phone spans many orders).
- **Three-way comparison, per row:** Declaration status vs. Gmail evidence vs.
  WhatsApp evidence — e.g. status `Ждем макет` but Gmail shows the layout already
  received → mismatch.
- **Recommendations only:** the Auditor reports mismatches as recommendations;
  it performs no automatic correction, consistent with recommendation mode.
- **Shared confidence:** a low-confidence email→order match should *lower* the
  Auditor's confidence in any mismatch it derives from that email, so ambiguous
  attribution doesn't produce false "mismatch" alerts.

---

## 9. Dependencies and changes implied (for planning, not built here)

- **Phone normalization + suffix matching** for the WhatsApp leg: a stored
  normalized phone field + index, replacing the prefix-anchored regex. Schema +
  backfill = a write change, gated.
- **Subject parsing** (entity name + sequence number) and **fuzzy Client
  matching** — new read-only logic.
- **Candidate scoring + ranking** — new read-only service producing
  `WorkflowDetection`-style `pending` recommendations.
- **Operator review UI** extension to show ranked candidates with scores/evidence.
- **Labelled history** for calibrating weights/thresholds.

All execution continues to flow through the existing confirmation gate. Nothing
in this design grants any agent the ability to assign, transition, send, or
clean up without explicit operator confirmation.
