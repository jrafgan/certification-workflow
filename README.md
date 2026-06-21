# Certification Workflow Management System

Operational control system for a small certification business.  
Answers the question: **"What requires my attention today?"**

## Purpose

Single-user dashboard to track certification orders from intake to delivery.  
Ensures no application, payment, laboratory request, layout, approval, or original document is ever lost.

## Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js, Express, MongoDB, Mongoose |
| Frontend | HTML, CSS, Vanilla JavaScript |
| Integrations | Google Forms, Google Sheets |

## Documentation

All architecture documentation is in `/docs`:

| File | Contents |
|------|---------|
| `PROJECT_COMPASS.md` | Purpose, design principles, V1 scope |
| `BUSINESS_PROCESS.md` | Step-by-step workflow narrative |
| `PROCESS_STATES.md` | Order lifecycle, states, closure gates |
| `ARCHITECTURE.md` | System design and component map |
| `DATABASE_DESIGN.md` | MongoDB collections and field definitions |
| `WORKFLOW_EVENTS.md` | Complete event catalog |
| `V1_IMPLEMENTATION_PLAN.md` | Phase-by-phase build plan with acceptance criteria |

## Getting Started

```bash
cd backend
npm install
cp .env.example .env
# Edit .env with your values
npm run dev
```

The frontend is served as static files by Express.  
Open `http://localhost:3000` after starting the backend.

## Project Structure

```
certification-workflow/
├── docs/          ← Architecture documentation
├── backend/       ← Node.js / Express / Mongoose API
├── frontend/      ← HTML / CSS / Vanilla JS (served by Express)
├── database/      ← Index setup and seed scripts
└── scripts/       ← Setup and development shell scripts
```

See `docs/V1_IMPLEMENTATION_PLAN.md` for the complete file-by-file phase plan.
