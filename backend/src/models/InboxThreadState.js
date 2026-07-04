'use strict';

// models/InboxThreadState.js — per-thread operator UI state for the Task Inbox.
//
// PURELY UI/operator state — carries NO business truth (it never affects order status,
// the Declaration, or what the agent proposes). One document per client thread, keyed by
// the canonical phone match key. Powers: unread counts (last_seen_at), clearing the list
// (done), and hiding until later (snoozed_until). See docs/modules/operator-task-inbox.md.

const mongoose = require('mongoose');
const { Schema } = mongoose;

const inboxThreadStateSchema = new Schema({
  phone_key:     { type: String, trim: true, required: true, unique: true }, // canonical thread key
  last_seen_at:  { type: Date },   // operator has read up to here → newer msgs are "unread"
  snoozed_until: { type: Date },   // hide from the list until this time
  done:          { type: Boolean, default: false }, // operator marked the thread handled
  updated_by:    { type: String, trim: true },
}, {
  collection: 'inbox_thread_state',
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  versionKey: false,
});

const InboxThreadState = mongoose.model('InboxThreadState', inboxThreadStateSchema);

module.exports = { InboxThreadState };
