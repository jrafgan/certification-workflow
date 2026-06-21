'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

const TASK_TYPES = [
  'remind_lab',
  'follow_up_client',
  'send_layout',
  'send_original',
  'check_payment',
  'stale_intake',
  'manual',
];

const TASK_STATUSES = ['open', 'done', 'snoozed', 'dismissed'];

const TASK_PRIORITIES = ['high', 'medium', 'low'];

const TASK_SOURCES = ['auto', 'manual'];

// ─── Task schema ──────────────────────────────────────────────────────────────

const taskSchema = new Schema({
  order_id: {
    type:     Schema.Types.ObjectId,
    ref:      'Order',
    required: true,
  },
  type: {
    type:     String,
    enum:     TASK_TYPES,
    required: true,
  },
  description: {
    type:     String,
    required: true,
    trim:     true,
  },
  priority: {
    type:     String,
    enum:     TASK_PRIORITIES,
    required: true,
  },
  status: {
    type:     String,
    enum:     TASK_STATUSES,
    required: true,
    default:  'open',
  },
  source: {
    type:     String,
    enum:     TASK_SOURCES,
    required: true,
  },
  due_date:      { type: Date },
  snoozed_until: { type: Date },
  created_at:    { type: Date, default: Date.now },
  // completed_at is set by the service when status transitions to done or dismissed
  completed_at:  { type: Date },
}, {
  collection: 'tasks',
  versionKey: false,
});

// ─── Indexes ──────────────────────────────────────────────────────────────────

// Dashboard: loads all open/snoozed tasks sorted by due_date
taskSchema.index({ status: 1, due_date: 1 });

// Order detail view: all tasks for a given order, filtered by status
taskSchema.index({ order_id: 1, status: 1 });

// Deduplication check before every auto-generated task insert
taskSchema.index({ order_id: 1, type: 1, status: 1 });

// ─── Model ────────────────────────────────────────────────────────────────────

const Task = mongoose.model('Task', taskSchema);

module.exports = { Task, TASK_TYPES, TASK_STATUSES, TASK_PRIORITIES, TASK_SOURCES };
