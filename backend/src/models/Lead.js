'use strict';

// models/Lead.js — a social-media LEAD in the Lead Conversion Agent (dokumenty.pro).
//
// A lead is an inbound inquiry from Instagram / Facebook / Telegram that the agent works
// toward an application, a payment, or a handoff to the main WhatsApp workflow. The guiding
// principle: NO LEAD MAY DISAPPEAR SILENTLY — every lead is always in exactly one state.
//
// This agent is responsible ONLY for conversion (respond, educate, push application +
// payment, transfer). It is NOT responsible for laboratory comms, document approval, status
// management, final pricing, or document edits — those live in the main workflow and stay
// operator-gated. Nothing here is ever sent autonomously: all outbound is a LeadMessageDraft
// the operator releases (see models/LeadMessageDraft.js).

const mongoose = require('mongoose');
const { Schema } = mongoose;

const PLATFORMS = ['instagram', 'facebook', 'telegram'];

// The 8 canonical lead states (the spec's state machine). Every lead is in one of these.
const LEAD_STATES = [
  'new',                  // New — just made contact
  'educating',            // Educating — answering basic questions
  'waiting_application',  // Waiting for Application — link sent, not yet submitted
  'waiting_calculation',  // Waiting for Calculation — application in, calc pending operator
  'waiting_payment',      // Waiting for Payment — calc approved, awaiting payment
  'transferred_whatsapp', // Transferred to WhatsApp — handed to the main workflow
  'dormant',              // Dormant — follow-ups exhausted / went quiet
  'recovered',            // Recovered — re-engaged after a recovery message
];

const LANGUAGES = ['ru', 'ky', 'en', 'unknown'];

// Service categories the agent identifies (Stage 2).
const SERVICE_CATEGORIES = ['certificate', 'declaration', 'refusal_letter', 'sgr', 'mpstats', 'wildbox', 'unknown'];

// Lightweight per-lead history entry (transparency; not an event bus).
const historySchema = new Schema({
  at:     { type: Date, default: Date.now },
  from:   { type: String },   // previous state
  to:     { type: String },   // new state
  note:   { type: String },
}, { _id: false });

const leadSchema = new Schema({
  // Identity — a lead is one person on one platform.
  platform:     { type: String, enum: PLATFORMS, required: true },
  handle:       { type: String, required: true, trim: true },  // platform user id / @username
  display_name: { type: String, trim: true },

  // Understanding (Stages 1–2).
  language:         { type: String, enum: LANGUAGES, default: 'unknown' },
  intent:           { type: String },                                  // last detected intent
  service_category: { type: String, enum: SERVICE_CATEGORIES, default: 'unknown' },

  // State machine.
  state: { type: String, enum: LEAD_STATES, required: true, default: 'new' },

  // Progress links into the main workflow.
  application_row: { type: Number },   // matched New Form row (Stage 6)
  whatsapp_phone:  { type: String, trim: true }, // captured for transfer (Stage 10)

  // Timers (drive follow-up + recovery; the engine reads these, never a wall clock baked in).
  first_contact_at:    { type: Date, default: Date.now },
  last_inbound_at:     { type: Date, default: Date.now },  // last message FROM the lead
  last_outbound_at:    { type: Date },                     // last released message TO the lead
  last_state_change_at:{ type: Date, default: Date.now },
  application_link_at:  { type: Date },                    // when the app link was sent
  dormant_at:          { type: Date },

  // Counters (Stage 5 follow-ups, Stage 11 recovery).
  follow_up_count: { type: Number, default: 0 },
  recovery_count:  { type: Number, default: 0 },

  history: { type: [historySchema], default: [] },

  created_at: { type: Date, default: Date.now },
}, {
  collection: 'leads',
  versionKey: false,
});

// One lead per (platform, handle).
leadSchema.index({ platform: 1, handle: 1 }, { unique: true });
leadSchema.index({ state: 1, last_state_change_at: 1 });

const Lead = mongoose.model('Lead', leadSchema);

module.exports = { Lead, PLATFORMS, LEAD_STATES, LANGUAGES, SERVICE_CATEGORIES };
