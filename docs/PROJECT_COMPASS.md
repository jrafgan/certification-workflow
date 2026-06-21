# PROJECT COMPASS
## Certification Workflow Management System

---

## Purpose

This system exists to give one person complete operational control over a small certification business — so that no application, payment, laboratory request, layout, approval, or original document is ever forgotten or lost.

It is not a CRM. It is not a sales pipeline. It is an operational memory and attention system.

---

## Business Context

A single operator manages the full lifecycle of certification orders:
- Clients contact the business through multiple channels (WhatsApp, phone, social media)
- New applications arrive automatically via Google Forms into Google Sheets
- Orders involve coordinating with an external laboratory
- Documents pass through multiple review cycles before completion
- Payment tracking is critical — debts must not go unnoticed at closure

The business currently tracks work in a Google Spreadsheet ("the Declaration"). That spreadsheet is a live business artifact and is not being replaced — it is being connected to a system that adds workflow control around it.

Google Forms and Google Sheets are the primary intake channel. They are active, in use today, and V1 must integrate with them.

---

## The Core Problem Being Solved

The operator cannot hold every active order's status in memory simultaneously.

The system must answer one question at any moment:

> **"What requires my attention today?"**

Every design decision flows from this question.

---

## V1 Goal

Automatic monitoring of new applications, order statuses, laboratory deadlines, client approvals, and payment balances.

---

## Design Principles

**1. Order is the center of gravity.**
Every piece of information — client contact, quote, payment, lab request, layout, approval, original document — belongs to an Order. There is no information that exists outside of an Order context in V1.

**2. Nothing disappears silently.**
Every order that enters the system stays visible until it is explicitly closed or cancelled. Stale orders surface as attention items, not as missing data.

**3. Deadlines are first-class citizens.**
Lab response deadlines, client response deadlines, and original document expected dates are stored as concrete fields — not inferred from events. This is what makes automated attention alerts possible.

**4. The Declaration spreadsheet is a business artifact, not a legacy detail.**
It existed before this system and must be respected. Declarations are synchronized with Orders but maintained as their own record.

**5. Simple by default, extensible by design.**
V1 is built for one user with Google Forms and Google Sheets as the primary intake channel. Every additional integration point (WhatsApp, Gmail, Telegram, Instagram, Facebook) is architecturally anticipated but not built in V1. Adding them does not require changing how Orders or states work.

**6. No data is ever hard-deleted.**
Orders are cancelled, not deleted. Events are appended, never modified. Payments are voided, not removed. The system is an audit trail as much as it is a workflow tool.

**7. Human approval over automation.**
The system may recommend actions, generate reminders, detect delays, and prepare communications. However, the following actions always require explicit human approval:

- Sending laboratory emails
- Sending client messages
- Approving layouts
- Approving corrections
- Closing orders
- Marking debts as resolved

The system assists decision-making but does not replace business judgment.

---

## What Success Looks Like

- New Google Form submissions appear in the system automatically — no manual entry required for new applications
- The Declaration spreadsheet stays synchronized without manual copying
- The operator opens the dashboard each morning and immediately sees every item that needs action
- No order can be closed with an unpaid balance
- No order can remain in a lab-waiting state past its deadline without generating a visible alert
- Every client approval or correction request is logged with a timestamp
- Every action that affects the business is traceable to a human decision

---

## In Scope — Version 1

- Google Forms intake (automatic order creation from form submissions)
- Google Sheets synchronization (Declaration spreadsheet read and write)
- Order lifecycle management (NEW → COMPLETED)
- Deadline tracking and automated attention alerts
- Laboratory request and reminder tracking
- Layout versioning and client approval logging
- Payment and debt tracking
- Tasks system for operator action items
- Single-user dashboard centered on "What requires attention today?"

---

## Out of Scope — Version 1

- Automated WhatsApp or Gmail sending
- Client-facing portal
- Multi-user access or role management
- Reporting and analytics
- Telegram, Instagram, Facebook integrations
- Mobile application
- Document generation or PDF export

These are valid future features. They are not V1 requirements.

---

## Version History

| Version | Date | Notes |
|---------|------|-------|
| 1.0 | 2026-06-11 | Initial architecture and documentation |
| 1.1 | 2026-06-11 | Google Forms and Sheets moved to V1 scope; V1 Goal added |
| 1.2 | 2026-06-11 | Design Principle 7 (Human approval over automation) added |
