# Module: <Name>

> Copy this file to `docs/modules/<module-slug>.md` and fill every section.
> Sections 1–6 must be complete and **approved** before implementation (step 7).

- **Status:** draft | approved | built
- **Owner:** <name>
- **Code:** `backend/src/...` (services / models / routes)
- **Last updated:** <YYYY-MM-DD>

---

## 1. Functional Specification
What the module does, who it is for, and why it exists. Scope and explicit non-goals
(what it is NOT responsible for).

## 2. Workflow Description
The step-by-step flow or state machine. A diagram/ASCII flow is encouraged. Include the
triggers (what starts it) and the outcomes.

## 3. Business Rules
The rules and constraints the business imposes — thresholds, gating, approvals, identity
rules, language/channel rules. State how the **operator-gated / output-only** principle
applies here.

## 4. Data Model
Collections/fields the module reads and writes (and which it must NOT write). Note the
source of truth and any replicas. Idempotency keys.

## 5. API Contract
Endpoints (method + path), request bodies, responses, error codes. Note auth/role
requirements. Mark read vs. mutating routes.

## 6. Approval
Recorded sign-off before implementation.
- Approved by: <name>
- Date: <YYYY-MM-DD>
- Notes / conditions:

## 7. Implementation
Pointers to the implementing files and key functions; notable design decisions and
trade-offs; dependencies and external services.

## 8. Tests
How the module is tested (suites + commands), what is covered, and known gaps.
