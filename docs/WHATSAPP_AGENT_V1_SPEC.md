# WhatsApp Agent — V1 Specification

Status: **Specification only. No code.** Defines the scope, state machine, and
hard boundaries for the first version of the WhatsApp Agent. Implementation
begins only after this spec is reviewed and approved.

The WhatsApp Agent operates under the system's standing rules:
**recommendation mode** (Recommendation → Operator Confirmation → Execution),
**Declaration is the source of truth** (Mongo is a synchronized replica;
statuses are authoritative but *auditable*), and the **single confirmation
gate**. WhatsApp is the **client** communication channel; email is the **lab**
channel (the two never mix). See `ORDER_MATCHING_DESIGN.md`,
`APPLICATION_TO_ORDER_WORKFLOW.md`, and the project memory rules.

---

## 1. Purpose & exact scope of V1

The V1 agent **assists the operator with client (WhatsApp) communication**. It
**reads** WhatsApp, **matches** messages to orders, **classifies** client
intent, **drafts** outbound replies, and **recommends** actions — and it **stops
at the operator**. It never sends, never changes a status, never forwards a file
on its own.

### In scope (V1)

1. **Inbound ingestion (read-only):** receive WhatsApp messages (text +
   attachment metadata) into the Mongo replica as evidence.
2. **Order matching:** match an inbound message's **phone number** to candidate
   orders using **normalized suffix matching** (one phone → many orders, so this
   produces a *candidate set* with confidence, never an assumed single order).
3. **Intent / evidence classification:** classify client messages — e.g.
   *approval* ("согласен/ок"), *corrections requested*, *question*,
   *missing-info response*, *document received*, *other*.
4. **Evidence feed to the Workflow Auditor:** surface WhatsApp evidence (e.g.
   "client approved the layout") for status validation — **as a recommendation
   only**, gated on a confirmed order match.
5. **Outbound draft generation:** draft client replies (missing-info requests,
   "layout ready" notifications, status updates, answers) addressed to the
   matched order's phone — **as drafts pending approval**.
6. **Recommendations:** produce operator-facing recommendations with supporting
   evidence and a confidence score.

### Out of scope (V1 — explicitly deferred)

- Autonomous sending of any WhatsApp message.
- Automatic status changes / Declaration writes.
- Automatic file forwarding (Email↔WhatsApp) — deferred to a later version,
  always gated.
- Two-way conversational autonomy / chatbot behavior with the client.
- Client email (does not exist in this system — clients are WhatsApp-only).
- Group chats, broadcast, marketing.
- Any lab communication (that is the Gmail agent's domain).

---

## 2. State machine

V1 tracks two linked units of work. Both are persisted in the Mongo replica and
visible to the operator.

### 2.1 Inbound message / evidence

```
RECEIVED ──► MATCHED ──────────► CLASSIFIED ──► EVIDENCE_RECORDED ──► (feeds Auditor as recommendation)
   │            │
   │            └─(low conf / many candidates)─► NEEDS_REVIEW ──(operator picks order)──► CLASSIFIED
   └─(no candidate / unknown phone)────────────► UNMATCHED ─────(operator links or ignores)
```

- `RECEIVED` — stored read-only.
- `MATCHED` — phone resolved to **one** order at HIGH confidence.
- `NEEDS_REVIEW` — multiple candidate orders or low confidence → operator chooses.
- `UNMATCHED` — phone matches no order, or unknown contact.
- `CLASSIFIED` — client intent assigned.
- `EVIDENCE_RECORDED` — stored as auditable evidence; may raise a status
  recommendation **only** if the match is confirmed (see §10/§11).

### 2.2 Outbound draft

```
TRIGGERED ──► DRAFTED ──► PENDING_APPROVAL ──► APPROVED ──► SENT(by operator)
                              │                    │
                              ├─► EDITED ──────────┘
                              └─► REJECTED          └─► EXPIRED (stale, never sent)
```

- `TRIGGERED` — a condition created a need to message the client (missing info,
  layout ready, status update, answer).
- `DRAFTED` — agent produced message text + target phone + rationale.
- `PENDING_APPROVAL` — awaiting operator.
- `EDITED` — operator modified the draft (loops back to pending).
- `APPROVED` — operator approved the exact text.
- `SENT` — **transmission is operator-controlled** (see §4.1). The agent records
  the send; it does not perform an autonomous API send in V1.
- `REJECTED` / `EXPIRED` — no message leaves the system.

**Invariant:** no transition crosses from `DRAFTED`/`PENDING_APPROVAL` to a real
send without an explicit `APPROVED` by the operator.

---

## 3. Approval workflow

Every outbound action and every status-affecting recommendation passes through
the single gate:

```
Agent Recommendation/Draft → Operator Review (evidence + confidence shown) → Operator Confirmation → Execution
```

- The operator always sees: the matched order (`sheet_row_id`), the client, the
  supporting evidence (the WhatsApp message / the missing-info list), the
  **confidence score**, and the exact proposed text or status change.
- Confirmation is per-item and explicit. Bulk auto-approval is not part of V1.
- Approval of a *draft* authorizes **that exact message**; editing invalidates
  the prior approval and requires re-approval.
- Approval of a *status recommendation* authorizes a Declaration write through
  the existing gated path — and only the sheet write makes it truth (Mongo
  follows).

## 4. Draft workflow

### 4.1 How a draft is sent in V1

V1 is conservative about transmission. The agent **prepares and gets approval**;
the **operator performs the send**. Two acceptable V1 transmission modes (a
review-time decision, not a code decision yet):

- **Manual mode (default, safest):** the approved text is presented for the
  operator to send in their own WhatsApp client. The agent records it as sent.
- **Gated send mode (optional):** if a WhatsApp send capability is wired later,
  it fires **only** on a per-message `APPROVED` confirmation through the gate —
  never autonomously, never batched.

The agent **never** initiates a send by itself in either mode.

### 4.2 Draft triggers

| Trigger | Source | Draft content |
|---|---|---|
| Missing application info | completeness check (`APPLICATION_TO_ORDER_WORKFLOW.md` §3–5) | request the specific missing items |
| Layout ready for client | lab layout received + order at the right stage | notify client; ask for approval |
| Status update | order status change the client should know | informational update |
| Answer to a client question | inbound `question` intent | drafted answer for operator review |

All drafts are templated, addressed to the **matched order's** phone, reference
the specific order/entity (never "the contact" — one phone has many orders), and
carry the matched order + confidence.

## 5. Declaration integration

- **Declaration is the source of truth.** The agent **reads** it (via the Mongo
  replica) to resolve orders by phone and to know current status.
- **The phone for matching is the Declaration "Номер тел:" column** = the
  client's WhatsApp number; matching is **normalized suffix** (see §9.1).
- The agent **never writes the Declaration directly.** A WhatsApp-evidence status
  recommendation (e.g. client approved → suggest `На согласовании` →
  `Ждем оригинал`) is gated; on approval the write goes to the **sheet**, and the
  Mongo replica follows. Approved statuses are used **verbatim** (the seven
  Russian values).
- Status comparison for the auditor uses **stage-ordinal** logic, not equality
  (a lesson from the end-to-end test): WhatsApp approval implies the order is
  *at least* past approval; flag only orders that are *behind* the evidence.

## 6. Gmail integration

- The WhatsApp agent **does not touch Gmail directly.** Email is the lab channel.
- The link between the two channels is the **order**: lab layout/original
  arrives by Gmail (matched per `ORDER_MATCHING_DESIGN.md`), which can *trigger* a
  WhatsApp draft to the client (e.g. "layout received → notify client"). That
  trigger still produces a draft requiring approval.
- The **Workflow Auditor** combines both: Declaration status vs. **Gmail
  evidence** vs. **WhatsApp evidence**, per order — all recommend-only, all
  match-gated.

## 7. New Applications integration

- During the application stage (`APPLICATION_TO_ORDER_WORKFLOW.md`), the agent's
  WhatsApp role is **missing-information follow-up**: when the completeness check
  finds gaps, the agent drafts the "missing info" WhatsApp message; the operator
  sends it; replies come back as inbound evidence and update the application.
- **An application is not an Order.** WhatsApp follow-up during intake never
  creates an order — only the operator sending the **lab email** does
  (the activation trigger). The agent must not conflate a WhatsApp reply with
  order creation.

## 8. MongoDB synchronization

- Mongo is a **synchronized replica / index / analytics layer**, never the
  source of truth. On conflict with the Declaration sheet, the sheet wins.
- **New V1 collections (replica/working data):**
  - `whatsapp_messages` — inbound (and recorded outbound) messages as evidence.
  - `whatsapp_drafts` — outbound drafts with their state-machine state.
  - (reuses) `declarations` — the synced sheet rows used for phone→order matching.
- Sync direction for Declaration data is **Sheet → Mongo**. WhatsApp message data
  originates at WhatsApp and is replicated into Mongo for analysis; it is not a
  competing source of truth for order status.
- Staleness matters: matching/auditing read the replica, but the sheet is the
  tiebreaker.

## 9. Matching specifics

### 9.1 Phone normalization & matching (required)

- Normalize to the **local 9 digits** (strip `+`, spaces, leading `996`, leading
  `0`). `777240858` and `+996777240858` must compare equal.
- Match on **normalized suffix/equality**, not the current prefix-anchored regex
  (which cannot match shortened vs. `+996` forms — a known gap).
- Minimum match length to avoid over-broad hits (≥ 7–9 digits).

### 9.2 One phone → many orders (disambiguation)

- A phone resolves to a **candidate set** of orders. The agent ranks candidates
  using the same signals as `ORDER_MATCHING_DESIGN.md` (open lab thread, current
  stage, recency, message content) and assigns confidence.
- **HIGH + unique** → propose that order (operator still confirms). **Otherwise**
  → `NEEDS_REVIEW`, operator picks. Never assume phone = one order.

---

## 10. Allowed actions (no confirmation required)

- Read WhatsApp messages (inbound).
- Read the Declaration replica and Gmail-derived evidence.
- Normalize phones; match messages to candidate orders; score confidence.
- Classify client intent / extract evidence.
- Write to the Mongo **replica** working collections (`whatsapp_messages`,
  `whatsapp_drafts`, evidence) — replica only, never the sheet.
- Generate outbound **drafts** (not sent).
- Detect missing information.
- Generate recommendations and reports (including status-mismatch
  recommendations that are match-gated).

## 11. Approval-required actions (gated)

- **Sending any WhatsApp message** to a client (manual or gated-send mode).
- **Applying a status change** derived from WhatsApp evidence (writes to the
  sheet via the existing gated path).
- **Linking an `UNMATCHED`/`NEEDS_REVIEW`** message to a specific order.
- **Forwarding any file** to the client (deferred capability; gated when it
  exists).
- Acting on a low-confidence match (must be operator-confirmed first).

## 12. Forbidden autonomous actions (never, in any mode)

- Sending a WhatsApp message without explicit per-message operator approval.
- Changing a Declaration status / editing a Declaration row autonomously.
- Creating, closing, or cancelling an order autonomously.
- Auto-forwarding files (Email→WhatsApp or WhatsApp→Email).
- Auto-assigning an ambiguous message to an order (multiple candidates → review).
- Raising a status recommendation from evidence **without** a confirmed order
  match (`Evidence → direct status change` is prohibited — match first).
- Treating one phone number as one order, or merging distinct orders by phone.
- Communicating with clients over email, or with labs over WhatsApp.
- Writing to the Declaration sheet directly (the sheet is the source of truth;
  Mongo is the replica).

---

## 13. Dependencies / open decisions (resolve during review, before coding)

- **WhatsApp ingestion transport** — how inbound messages reach the system
  (WhatsApp Business Cloud API webhook, a bridge, or manual import for V1). V1
  needs *read* access; a *send* path is optional and gated.
- **Phone normalization field + index** on the replica (the suffix-match
  enabler) — a schema addition to support §9.1.
- **Intent classification approach** — rules vs. LLM; if LLM, it emits
  structured intent only (data, not actions), validated server-side, consistent
  with the recommendation-mode boundary.
- **Confidence thresholds** for phone-based matching (calibrate like the
  email matcher; start conservative, bias to review).
- **Auditor comparison** must use stage-ordinal logic (per the e2e test finding),
  not status equality.

Nothing in this spec authorizes any agent to send, change status, or forward
without explicit operator confirmation. Implementation starts only after review.
