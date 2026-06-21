// js/order-detail.js — Order detail page logic
//
// Loaded by views/order-detail.html.
// Reads the order ID from URL query string: ?id=<orderId>
//
// On page load: calls api.orders.getById(id), renders all sections.
//
// Sections rendered and their actions:
//
//   CLIENT INFO     view + edit (name, phone, channel, notes)
//   QUOTE           view + set (amount, dates)
//   STATUS          current badge + transition button (next valid status shown)
//   PAYMENTS        list + record form + void action
//   LAB CONTACT     log contact (date, deadline) + log reminder
//   LAYOUTS         list of versions + record received + mark sent + record decision
//   ORIGINAL        record received + mark sent (with delivery method)
//   OPEN TASKS      list + complete / snooze / dismiss actions
//   EVENT LOG       read-only chronological list of all events
//
// Design Principle 7 enforcement:
//   All state-changing actions (transition, close, cancel, record decision,
//   complete task) call utils.showConfirm() before submitting.
//   The confirmed: true flag is only sent if the operator confirms.
//
// After any successful action, the order is re-fetched and all sections re-rendered.
