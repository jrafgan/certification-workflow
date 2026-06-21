'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

const LAB_COMM_CONTEXTS   = ['lab_interaction', 'lab_print_order'];
const LAB_COMM_STATUSES   = ['waiting', 'replied', 'timed_out', 'unreachable', 'closed', 'unlinked'];
const LAB_COMM_LINK_MODES = ['live', 'historical'];

// ─── Schema ───────────────────────────────────────────────────────────────────

const labCommThreadSchema = new Schema({
  order_id: {
    type:     Schema.Types.ObjectId,
    ref:      'Order',
    required: true,
  },
  thread_id: {
    type:     String,
    required: true,
    trim:     true,
  },
  context: {
    type:     String,
    enum:     LAB_COMM_CONTEXTS,
    required: true,
  },
  // 1-based version number. Only set for lab_interaction context.
  lab_interaction_version: {
    type: Number,
    min:  1,
  },
  // Snapshot of laboratory email at link time — never updated after creation
  recipient_email: {
    type:      String,
    required:  true,
    trim:      true,
    lowercase: true,
  },
  status: {
    type:     String,
    enum:     LAB_COMM_STATUSES,
    required: true,
    default:  'waiting',
  },
  link_mode: {
    type:     String,
    enum:     LAB_COMM_LINK_MODES,
    required: true,
  },
  linked_at: {
    type:     Date,
    required: true,
  },
  // When the operator sent the originating email; null if unknown at link time
  sent_at: { type: Date },

  // Snapshots of lab SLA at link time — not updated when Order.laboratory changes
  sla_layout_days:   { type: Number, min: 1 },
  sla_original_days: { type: Number, min: 1 },

  // Message count at link time — baseline for reply detection
  initialized_message_count: { type: Number, required: true, default: 0, min: 0 },
  last_checked_at:           { type: Date },
  last_known_message_count:  { type: Number, required: true, default: 0, min: 0 },
  auto_reply_count:          { type: Number, required: true, default: 0, min: 0 },

  reply_detected_at:    { type: Date },
  reply_has_attachment: { type: Boolean },
  reply_sender:         { type: String, trim: true },

  timeout_at: { type: Date },

  error_count:        { type: Number, required: true, default: 0, min: 0 },
  last_error_at:      { type: Date },
  last_error_message: { type: String, trim: true },

  created_at: { type: Date, default: Date.now },
}, {
  collection: 'lab_comm_threads',
  versionKey: false,
  timestamps: false,
});

// ─── Indexes ──────────────────────────────────────────────────────────────────

// Poller: fetch waiting threads ordered by least-recently-checked (Phase L2)
labCommThreadSchema.index({ status: 1, last_checked_at: 1 });

// Load all threads for one order (order detail view)
labCommThreadSchema.index({ order_id: 1 });

// Prevent same Gmail thread linked to two active records simultaneously.
// $in over active statuses (not $nin) so adding a new status does not silently
// expand the uniqueness constraint.
labCommThreadSchema.index(
  { thread_id: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: ['waiting', 'replied', 'timed_out', 'unreachable'] },
    },
  }
);

// Timeout scan — Phase L3
labCommThreadSchema.index({ status: 1, timeout_at: 1 }, { sparse: true });

// Dashboard group-by-laboratory — Phase L4
labCommThreadSchema.index({ recipient_email: 1, status: 1 });

// Prevent two active monitoring records for the same order+context+version.
// A single compound index covers both contexts:
//   lab_interaction: (orderId, 'lab_interaction', N)   — unique per version
//   lab_print_order: (orderId, 'lab_print_order', null) — unique per order
// MongoDB treats null === null in unique indexes, so two active lab_print_order
// threads for the same order are blocked by the null key collision.
labCommThreadSchema.index(
  { order_id: 1, context: 1, lab_interaction_version: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: ['waiting', 'replied', 'timed_out', 'unreachable'] },
    },
    name: 'idx_active_version_unique',
  }
);

// ─── Model ────────────────────────────────────────────────────────────────────

const LabCommThread = mongoose.model('LabCommThread', labCommThreadSchema);

module.exports = {
  LabCommThread,
  LAB_COMM_CONTEXTS,
  LAB_COMM_STATUSES,
  LAB_COMM_LINK_MODES,
};
