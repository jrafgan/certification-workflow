// js/orders.js — Orders list page logic
//
// Loaded by views/orders.html.
//
// On page load:
//   1. Call api.dashboard.getActiveOrders()
//   2. Render the orders table sorted by updated_at desc
//   3. Each row links to views/order-detail.html?id=<orderId>
//
// New order form:
//   - Inline form to create an order manually (client name, phone, channel, notes)
//   - On submit: validates fields, calls api.orders.create(), appends new row
//
// Tab or link to closed/cancelled orders (calls getClosedOrders / getCancelledOrders).
