'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

// A WorkflowDetection is a PROPOSAL produced by inspecting a lab email. It never
// changes order state or the Google Sheet on its own — an operator must confirm
// the recommendation first. See services/workflowDetectionService.js.

const DETECTION_EVENTS  = ['LAYOUT_RECEIVED', 'ORIGINAL_RECEIVED'];
const DETECTION_STATUSES = ['pending', 'confirmed', 'rejected', 'superseded'];

// transition  → order is in the expected status; recommended_to is set and confirmable
// needs_review → order not in expected status; recommended_to is null
// conflict     → the email matched both layout and original cues
const RECOMMENDATION_KINDS = ['transition', 'needs_review', 'conflict'];

const matchedRuleSchema = new Schema({
  source: { type: String, enum: ['body', 'attachment'], required: true },
  term:   { type: String, required: true },
}, { _id: false });

const workflowDetectionSchema = new Schema({
  order_id: {
    type:     Schema.Types.ObjectId,
    ref:      'Order',
    required: true,
  },
  thread_id:  { type: String, required: true, trim: true },
  message_id: { type: String, required: true, trim: true },

  detected_event: {
    type:     String,
    enum:     DETECTION_EVENTS,
    required: true,
  },
  matched_rules: { type: [matchedRuleSchema], default: [] },

  // Email snapshot at detection time
  email_from:           { type: String, trim: true },
  email_subject:        { type: String, trim: true },
  email_excerpt:        { type: String },                 // first ~500 chars of parsed body
  attachment_filenames: { type: [String], default: [] },  // requirement: store filenames

  // Recommendation
  recommended_from: { type: String },           // order status at detection time
  recommended_to:   { type: String },           // null when needs_review / conflict
  recommendation:   { type: String, enum: RECOMMENDATION_KINDS, required: true },

  status: {
    type:     String,
    enum:     DETECTION_STATUSES,
    required: true,
    default:  'pending',
  },
  decided_at: { type: Date },
  decided_by: { type: String, trim: true },

  detected_at: { type: Date, default: Date.now },
}, {
  collection: 'workflow_detections',
  versionKey: false,
});

// ─── Indexes ──────────────────────────────────────────────────────────────────

// Dashboard: list pending recommendations newest-first
workflowDetectionSchema.index({ status: 1, detected_at: -1 });

// Order detail view: all detections for an order
workflowDetectionSchema.index({ order_id: 1 });

// Idempotency: the same email cannot raise the same event twice
workflowDetectionSchema.index(
  { thread_id: 1, message_id: 1, detected_event: 1 },
  { unique: true }
);

const WorkflowDetection = mongoose.model('WorkflowDetection', workflowDetectionSchema);

module.exports = {
  WorkflowDetection,
  DETECTION_EVENTS,
  DETECTION_STATUSES,
  RECOMMENDATION_KINDS,
};
