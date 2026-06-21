# Project Acceptance Criteria — WhatsApp Agent V1

Status: **Acceptance definition. No code.** Defines exactly when WhatsApp Agent
V1 is considered complete. Scoped strictly to `WHATSAPP_AGENT_V1_SPEC.md` and the
standing rules (recommendation mode, the single confirmation gate, Declaration as
source of truth with auditable statuses, WhatsApp = client channel).

**Governing rule (scope lock):**
> If all acceptance criteria below pass, **V1 is complete** — even if further
> improvements are possible. **No feature may be added to V1** unless it is
> required to satisfy one of these criteria. "Nice to have" is out by definition.

---

## 1. In Scope

V1 delivers an operator-assistive WhatsApp agent that:

- Ingests inbound WhatsApp messages (read-only) into the Mongo replica.
- Matches a message's **phone** to candidate orders via **normalized suffix
  matching**, producing a confidence-scored candidate set (one phone → many
  orders).
- Classifies client intent / extracts evidence (approval, corrections, question,
  missing-info response, document received, other).
- Generates outbound **drafts** (missing-info request, layout notification,
  status update, answer) addressed to the matched order's client.
- Routes every draft and every status-affecting recommendation through the
  **operator approval gate**.
- Feeds WhatsApp evidence to the Workflow Auditor as **match-gated, recommend-only**
  status observations.
- Persists working data to replica collections (`whatsapp_messages`,
  `whatsapp_drafts`) without ever writing the Declaration sheet directly.

## 2. Out of Scope

Explicitly **not** part of V1 (presence of any of these is *not* required and
must not block acceptance):

- Autonomous sending of WhatsApp messages.
- Automatic status changes / direct Declaration writes by the agent.
- Automatic file forwarding (Email↔WhatsApp).
- Conversational chatbot autonomy with clients.
- Client email; lab communication over WhatsApp.
- Group chats, broadcasts, marketing.
- Order creation/closing/cancellation by the agent.
- Auto-resolution of ambiguous (multi-candidate) matches.

---

## 3. Business Acceptance Criteria

| ID | Criterion (operator-observable) |
|---|---|
| **BAC-1** | For an inbound WhatsApp message from a known client phone, the operator sees the message correctly matched to the right order (or a ranked candidate list when ambiguous), with the matched order shown as a Declaration row + client. |
| **BAC-2** | A shortened number (`777240858`) and its full form (`+996777240858`) match the **same** order(s) — partial matching works. |
| **BAC-3** | When one phone maps to several orders, the agent presents a **candidate set for operator choice**, never a silent single guess. |
| **BAC-4** | The agent produces a usable client **draft** for each trigger (missing-info, layout-ready, status update, answer), referencing the specific order/entity. |
| **BAC-5** | No WhatsApp message is ever sent without the operator explicitly approving that exact text. Editing a draft requires re-approval. |
| **BAC-6** | Client intent is classified accurately enough to be useful (approval / corrections / question / missing-info / other) on a representative sample. |
| **BAC-7** | WhatsApp evidence that contradicts the Declaration status produces a **recommendation** (with matched order + evidence + confidence), never an automatic change; comparison is stage-ordinal (only flags orders *behind* the evidence). |
| **BAC-8** | During intake, a missing-info WhatsApp follow-up can be drafted; a client reply updates the application but **does not create an order**. |
| **BAC-9** | The operator can reject/ignore any recommendation or draft with zero side effects on Declaration or Gmail. |

## 4. Technical Acceptance Criteria

| ID | Criterion (verifiable behavior) |
|---|---|
| **TAC-1** | Inbound messages are stored read-only in `whatsapp_messages`; the source WhatsApp account and Gmail are never modified. |
| **TAC-2** | Phone normalization reduces to the local 9 digits (strips `+`, spaces, leading `996`/`0`); matching is suffix/normalized, indexed, with a minimum match length (≥ 7–9 digits). |
| **TAC-3** | Matching returns a candidate set with per-candidate confidence; HIGH+unique → proposed; otherwise → `NEEDS_REVIEW`. No path auto-assigns an ambiguous match. |
| **TAC-4** | The outbound draft state machine enforces `DRAFTED → PENDING_APPROVAL → APPROVED → SENT`; there is **no code path** from draft to send that bypasses `APPROVED`. |
| **TAC-5** | The agent has **no capability** (no wired function) to: send WhatsApp autonomously, write the Declaration sheet, change a status without confirmation, or forward files. Forbidden actions are structurally absent, not merely unused. |
| **TAC-6** | Status recommendations are **match-gated**: evidence with low-confidence or no confirmed order match produces **no** status recommendation (`Evidence → direct status change` is impossible). |
| **TAC-7** | Declaration data is read from the Mongo replica (Sheet → Mongo direction); any approved status write goes to the **sheet** via the existing gated path, and the replica follows. The sheet wins on conflict. |
| **TAC-8** | All agent LLM use (if any) emits **structured data only** (intent/draft text), validated server-side; the model is given no action-taking tools. |
| **TAC-9** | The system runs the full inbound→match→classify→evidence and trigger→draft→approval flows end-to-end on **real data** without manual DB surgery. |

---

## 5. End-to-End Client Journey (the happy path V1 must support)

```
1. Client sends a WhatsApp message (e.g. "согласен с макетом").
2. Agent ingests it (read-only) → whatsapp_messages.
3. Agent normalizes the phone → matches to candidate order(s) by suffix.
4. HIGH+unique → MATCHED to one order; else NEEDS_REVIEW → operator picks.
5. Agent classifies intent = "approval".
6. Agent records evidence and, since the matched order's status is BEHIND
   "approved", raises a status recommendation
   (e.g. На согласовании → Ждем оригинал) with evidence + confidence.
7. Operator reviews: sees order (sheet_row_id), the message, confidence.
8a. Operator approves → status write goes to the SHEET (gated); replica follows.
8b. Operator also approves a drafted client reply → OPERATOR sends it.
9.  No autonomous send, no autonomous status change occurred at any step.
```

A second journey (outbound-initiated): lab layout arrives by Gmail → triggers a
"layout ready" **draft** to the client → operator approves → operator sends.

A third (intake): completeness check finds a missing document → agent drafts a
missing-info WhatsApp message → operator sends → client replies → application
updated (no order created).

## 6. Definition of Done

V1 is **done** when all of the following hold:

- [ ] All **BAC-1 … BAC-9** pass on real data.
- [ ] All **TAC-1 … TAC-9** pass.
- [ ] The three journeys in §5 complete end-to-end with a real operator.
- [ ] Every forbidden action in `WHATSAPP_AGENT_V1_SPEC.md` §12 is demonstrably
      impossible (verified, not assumed).
- [ ] Drafts, matches, and recommendations are visible to the operator with
      matched order + evidence + confidence.
- [ ] Declaration sheet and Gmail are provably unmodified by the agent across all
      tests.
- [ ] No out-of-scope (§2) feature is present as a requirement for completion.

## 7. Acceptance Test Procedure

Run on real data; record pass/fail per criterion.

1. **Ingestion (TAC-1):** receive/import a set of real inbound WhatsApp messages;
   confirm they appear in `whatsapp_messages` and that WhatsApp/Gmail are untouched.
2. **Phone matching (BAC-1/2/3, TAC-2/3):** include messages from numbers stored
   shortened vs. `+996`; confirm same-order matches; include a phone known to map
   to multiple orders and confirm a candidate set + `NEEDS_REVIEW`.
3. **Intent (BAC-6):** classify a representative sample; confirm useful accuracy
   across the intent set.
4. **Evidence/auditor (BAC-7, TAC-6):** feed an "approval" for an order that is
   behind, and one that has already advanced; confirm the behind case yields a
   recommendation and the advanced case does **not** (stage-ordinal); confirm a
   low-confidence/unmatched message yields **no** status recommendation.
5. **Drafts + approval (BAC-4/5, TAC-4):** generate each draft type; confirm send
   requires explicit approval; edit a draft and confirm re-approval is required;
   reject one and confirm zero side effects (BAC-9).
6. **Intake (BAC-8):** draft a missing-info follow-up; simulate a client reply;
   confirm the application updates and **no order is created**.
7. **Forbidden actions (TAC-5):** attempt (in test) to trigger an autonomous send,
   a direct sheet write, and an ambiguous auto-assign; confirm each is impossible.
8. **Source-of-truth (TAC-7):** approve one status change; confirm it lands in the
   **sheet** and the replica reflects it; confirm sheet wins on a deliberate
   replica/sheet divergence.

## 8. Exit Criteria

V1 **ships / is accepted** when:

1. **100% of BAC and TAC pass** (no waivers on safety criteria TAC-4, TAC-5,
   TAC-6, BAC-5, BAC-7).
2. The §5 journeys pass end-to-end on real data.
3. **Zero** forbidden-action regressions (autonomous send, autonomous status
   change, direct sheet write, ambiguous auto-assign, file auto-forward).
4. Declaration and Gmail are verified unmodified by the agent.

If 1–4 hold, **V1 is complete** and further enhancements move to a V2 backlog —
they do not block acceptance. Conversely, **any failure in the safety criteria is
a hard stop** regardless of other progress.
