'use strict';

const { Order } = require('../models/Order');

// Appends one event to orders.events[]. Callers provide type, description, actor.
// Timestamp is set here. The events array is append-only — never modified or deleted.
async function appendEvent(orderId, { type, description, actor }) {
  await Order.findByIdAndUpdate(orderId, {
    $push: {
      events: { type, description, actor, timestamp: new Date() },
    },
  });
}

module.exports = { appendEvent };
