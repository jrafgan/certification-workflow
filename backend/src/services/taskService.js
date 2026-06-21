'use strict';

const { Task }  = require('../models/Task');
const { Order } = require('../models/Order');

// createTask — deduplicated task creation.
// Before inserting, checks for an existing open task of same type on same order.
// Does not create tasks for terminal orders ("Отменен" or "Завершен").
async function createTask(orderId, type, description, priority, dueDate, source) {
  const order = await Order.findById(orderId).select('status').lean();
  if (!order) return null;
  if (order.status === 'Отменен' || order.status === 'Завершен') return null;

  const existing = await Task.findOne({ order_id: orderId, type, status: 'open' });
  if (existing) {
    if (dueDate && String(existing.due_date) !== String(dueDate)) {
      existing.due_date = dueDate;
      await existing.save();
    }
    return existing;
  }

  const task = await Task.create({
    order_id:    orderId,
    type,
    description,
    priority,
    status:      'open',
    source:      source || 'auto',
    due_date:    dueDate || undefined,
  });

  const eventService = require('./eventService');
  await eventService.appendEvent(orderId, {
    type:        'TASK_CREATED',
    description: `Task created: ${description}`,
    actor:       'system',
  });

  return task;
}

module.exports = { createTask };
