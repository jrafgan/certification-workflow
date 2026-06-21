# Documentation

**Documentation is a first-class artifact. The order is: documentation → code → optimization.**
No major new module is built before its documentation exists and is approved.

> Goal: a new developer can understand the entire system **from these docs alone**, without
> reading source code.

## The doc-first workflow (every major module)
Each major module follows these eight steps, in order. Steps 1–6 are documentation and
must be completed (and approved) **before** step 7.

1. **Functional Specification** — what the module does and why it exists.
2. **Workflow Description** — the step-by-step flow / state machine.
3. **Business Rules** — the rules and constraints the business imposes.
4. **Data Model** — collections/fields the module reads and writes.
5. **API Contract** — endpoints, inputs, outputs, errors.
6. **Approval** — operator/owner sign-off recorded in the doc.
7. **Implementation** — the code.
8. **Tests** — automated coverage.

Use [`modules/_TEMPLATE.md`](modules/_TEMPLATE.md) for every module document.

## Folder structure
| Folder | Contents |
|--------|----------|
| [`business/`](business/) | Business process, charter, rules, acceptance criteria — the "why". |
| [`workflows/`](workflows/) | End-to-end workflows & state machines (order lifecycle, intake→order, events). |
| [`architecture/`](architecture/) | System architecture, data model, cross-cutting design (matching, agents). |
| [`modules/`](modules/) | One 8-section document per major module (the heart of the doc-first rule). |
| [`deployment/`](deployment/) | Deploy guide, backup/restore, production checklist (AdminVPS/Docker). |
| [`runbooks/`](runbooks/) | Operational how-tos: incidents, recovery, routine tasks. |

## Module index
Documentation for each major module lives in [`modules/`](modules/):

| Module | Doc | Status |
|--------|-----|--------|
| Document Understanding (OCR) | [modules/document-understanding.md](modules/document-understanding.md) | built |
| Payment Recognition | [modules/payment-recognition.md](modules/payment-recognition.md) | built |
| Lead Recovery | [modules/lead-recovery.md](modules/lead-recovery.md) | built |
| Status Intelligence (Workflow Auditor) | [modules/status-intelligence.md](modules/status-intelligence.md) | built |
| WhatsApp Agent | [modules/whatsapp-agent.md](modules/whatsapp-agent.md) | built |
| Social / Lead Conversion Agent | [modules/lead-conversion-agent.md](modules/lead-conversion-agent.md) | built |
| Agent Control Center | [modules/control-center.md](modules/control-center.md) | built (V2) |

## Existing reference docs (to be migrated during repo cleanup)
These predate the new structure and remain at `docs/` root for now; they will be sorted into
`business/`, `workflows/`, and `architecture/` during the **GitHub repository cleanup** milestone:
- **business/**: BUSINESS_PROCESS.md, PROJECT_COMPASS.md, PROJECT_ACCEPTANCE_CRITERIA_V1.md
- **workflows/**: APPLICATION_TO_ORDER_WORKFLOW.md, PROCESS_STATES.md, WORKFLOW_EVENTS.md, PHASE_L2.5_UNLINKED_REPLY.md
- **architecture/**: ARCHITECTURE.md, DATABASE_DESIGN.md, ORDER_MATCHING_DESIGN.md, GMAIL_AGENT_ARCHITECTURE.md, LABORATORY_AGENT_ARCHITECTURE.md
- **planning/history**: PHASE_L1_PLAN.md, PHASE_L1_SPEC.md, V1_IMPLEMENTATION_PLAN.md, WHATSAPP_AGENT_V1_SPEC.md

## Cross-cutting principle
Everything the agents produce is **output-only and operator-gated** — proposals, drafts,
reviews, and audits never auto-apply, auto-send, or change status. Each module doc restates
how this principle applies to it.
