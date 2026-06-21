# Module: Agent Control Center

- **Status:** built (V2)
- **Owner:** —
- **Code:** `backend/src/services/controlCenterService.js`, `authService.js`, `auditService.js`; `models/User.js`, `AuditLog.js`; `routes/controlCenter.js`, `routes/auth.js`; `middleware/auth.js`; `frontend/` (control-center.html, login.html, js, css)
- **Last updated:** 2026-06-21

---

## 1. Functional Specification
A single web workspace for operators and employees over all the agent engines. Six screens:
Главная (dashboard), Входящие задачи (inbox), Черновики (drafts), Воронка клиентов (pipeline),
Чат с агентом (chat), База знаний (KB), plus Журнал действий (audit) and Пользователи (admin).
Read-mostly; the only writes are operator decisions routed to each engine's own gated path.

## 2. Workflow Description
```
login (session) → dashboard (business tiles + data-source status)
  → inbox/drafts: approve/reject/edit → engine.decide() → audit recorded
  → chat: ask why/show evidence/recalculate → answered from STORED evidence (no LLM)
```
Vanilla HTML/CSS/JS served by Express at `/app`; API at `/api/control-center`.

## 3. Business Rules
- **No anonymous access**: every `/api` route except `/api/auth` + `/health` requires a session.
- Two roles only — **administrator** (full: settings, KB management, user management) and
  **operator** (review/approve/reject drafts, calcs, status, emails, orders). Viewer removed.
- Passwords hashed with scrypt (built-in crypto). First-boot admin auto-seeded; must be changed.
- **Every mutation is audited** (user, time, action, before, after) with a Russian summary.
- Full Russian localization; data-source panel shows a clear message, never a blank screen.
- Nothing is auto-applied or auto-sent — decisions route to each engine's gated decide().

## 4. Data Model
`users` (model `User`): username(unique), display_name, role, password_hash, password_salt, active.
`audit_logs` (model `AuditLog`): at, user, role, action, summary, target_type, target_id, before, after.
`sessions` (connect-mongo). Reads all engine collections for aggregation; writes only via engine decides.

## 5. API Contract
Auth (public): `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`.
Read (auth): `/dashboard`, `/summary`, `/pipeline`, `/inbox`, `/drafts`, `/kb`, `/sources`, `/audit`.
Actions (auth): `POST /decide` `{type,id,action,text?,note?}`, `POST /chat` `{type,id,question}`.
Admin only (`requireRole('administrator')`): `/users` (GET/POST), `/users/:id/active`, `/kb-pending`, `/kb/:id/decision`.

## 6. Approval
- Approved by: operator (V2 scope: localization, auth, roles, audit, dashboard, data visibility). Date: 2026-06-21.

## 7. Implementation
`controlCenterService`: DB-resilient aggregation (guards on `mongoose.connection.readyState`),
audited `decide` (before/after snapshots), `chat` answering from stored evidence, business
dashboard, source probes (Declaration/WhatsApp/KB via Mongo; New Form/Gmail via live network).
`server.js` adds express-session + connect-mongo, gates `/api`, and serves the frontend even when
the DB is offline. Env: SESSION_SECRET, ADMIN_USERNAME/PASSWORD.

## 8. Tests
Verified live against MongoDB: gate 401s, login, dashboard, sources (real counts: Declarations 1018,
New Form 567, Gmail connected), lead ingest→inbox→audited approve, audit log, role 403s. No automated
UI test suite yet (gap). Backend regression: 113 unit tests green.
