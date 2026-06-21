'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

// Single source of truth: the seven Google Sheet "Declaration" statuses.
const { ORDER_STATUSES } = require('../config/constants');

const CONTACT_CHANNELS = [
  'whatsapp', 'telegram', 'instagram', 'facebook', 'google_form', 'phone', 'other',
];

// ─── Embedded sub-schemas ─────────────────────────────────────────────────────

const clientSchema = new Schema({
  name:            { type: String, trim: true },
  phone:           { type: String, trim: true },
  contact_channel: { type: String, enum: CONTACT_CHANNELS },
  notes:           { type: String },
  // Phase L1: order search and future client communication
  email:           { type: String, trim: true, lowercase: true },
  companyName:     { type: String, trim: true },
}, { _id: false });

const laboratorySchema = new Schema({
  laboratoryName:    { type: String, trim: true },
  laboratoryEmail:   { type: String, trim: true, lowercase: true },
  laboratoryContact: { type: String, trim: true },
  // Phase L1: SLA expectations per lab, snapshotted onto LabCommThread at link time
  expectedLayoutDays:   { type: Number, min: 1 },
  expectedOriginalDays: { type: Number, min: 1 },
}, { _id: false });

const pricingSchema = new Schema({
  amount:          { type: Number, min: 0 },
  calculated_at:   { type: Date },
  communicated_at: { type: Date },
}, { _id: false });

const deadlinesSchema = new Schema({
  lab_response_due:    { type: Date },
  client_response_due: { type: Date },
  original_expected:   { type: Date },
}, { _id: false });

// _id retained (Mongoose default) — void endpoint targets individual payments by _id
const paymentSchema = new Schema({
  date:          { type: Date },
  amount:        { type: Number, min: 0 },
  method:        { type: String, enum: ['cash', 'transfer', 'card', 'other'] },
  note:          { type: String },
  voided:        { type: Boolean, default: false },
  voided_at:     { type: Date },
  voided_reason: { type: String },
});

const labInteractionSchema = new Schema({
  version:            { type: Number, required: true },
  sent_at:            { type: Date },
  deadline:           { type: Date },
  reminder_count:     { type: Number, default: 0, min: 0 },
  last_reminder_at:   { type: Date },
  layout_received_at: { type: Date },
  correction_notes:   { type: String },
  // Phase L1: linked Gmail thread for this interaction version
  gmail_thread_id:  { type: String, trim: true },
  gmail_linked_at:  { type: Date },
}, { _id: false });

const layoutSchema = new Schema({
  version:           { type: Number, required: true },
  file_ref:          { type: String },
  file_name:         { type: String },
  received_at:       { type: Date },
  sent_to_client_at: { type: Date },
  // undefined until client responds; enum validates only when a value is set
  client_decision:   { type: String, enum: ['approved', 'corrections_requested'] },
  correction_notes:  { type: String },
  decided_at:        { type: Date },
}, { _id: false });

const originalSchema = new Schema({
  received_at:       { type: Date },
  sent_to_client_at: { type: Date },
  delivery_method:   { type: String, enum: ['post', 'courier', 'in_person', 'other'] },
  tracking_ref:      { type: String },
}, { _id: false });

// type is plain String — no enum; event codes are defined in WORKFLOW_EVENTS.md
// and must remain extensible without schema changes
const eventSchema = new Schema({
  timestamp:   { type: Date, default: Date.now },
  type:        { type: String, required: true },
  description: { type: String },
  actor:       { type: String, enum: ['operator', 'system'], required: true },
}, { _id: false });

// ─── Order schema ─────────────────────────────────────────────────────────────

const orderSchema = new Schema({
  status: {
    type:     String,
    enum:     ORDER_STATUSES,
    required: true,
    default:  'Запустить',
  },
  balance_due:      { type: Number, default: 0 },
  declaration_id:   { type: Schema.Types.ObjectId, ref: 'Declaration' },
  cancelled_reason: { type: String },

  client:           { type: clientSchema,          default: () => ({}) },
  laboratory:       { type: laboratorySchema,       default: () => ({}) },
  pricing:          { type: pricingSchema,          default: () => ({}) },
  deadlines:        { type: deadlinesSchema,        default: () => ({}) },
  payments:         { type: [paymentSchema],        default: [] },
  lab_interactions: { type: [labInteractionSchema], default: [] },
  layouts:          { type: [layoutSchema],         default: [] },
  original:         { type: originalSchema,         default: () => ({}) },
  events:           { type: [eventSchema],          default: [] },
}, {
  collection: 'orders',
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  versionKey: false,
});

// ─── Indexes ──────────────────────────────────────────────────────────────────

// Dashboard and scheduler filter by status on every query
orderSchema.index({ status: 1 });

// Three separate sparse indexes — scheduler runs independent queries per deadline type
orderSchema.index({ 'deadlines.lab_response_due': 1 },    { sparse: true });
orderSchema.index({ 'deadlines.client_response_due': 1 }, { sparse: true });
orderSchema.index({ 'deadlines.original_expected': 1 },   { sparse: true });

// Sparse: declaration_id is absent on manually created orders until linked
orderSchema.index({ declaration_id: 1 }, { sparse: true });

// Sparse: phone is present on all form-intake orders but may be absent on partial manual entries
orderSchema.index({ 'client.phone': 1 }, { sparse: true });

// Default sort for order list views
orderSchema.index({ created_at: 1 });

// ─── Phase L1: search and dashboard indexes ───────────────────────────────────

// Case-insensitive applicant name search
orderSchema.index(
  { 'client.name': 1 },
  { collation: { locale: 'en', strength: 2 } }
);

// Case-insensitive company name search; sparse because field is optional
orderSchema.index(
  { 'client.companyName': 1 },
  { sparse: true, collation: { locale: 'en', strength: 2 } }
);

// Exact client email lookup; sparse because field is optional
orderSchema.index({ 'client.email': 1 }, { sparse: true });

// Dashboard group-by-lab (Phase L4); sparse because lab may not be assigned yet
orderSchema.index({ 'laboratory.laboratoryName': 1 }, { sparse: true });

// Thread selector pre-filter by lab email (Phase L5); sparse for same reason
orderSchema.index({ 'laboratory.laboratoryEmail': 1 }, { sparse: true });

// ─── Model ────────────────────────────────────────────────────────────────────

const Order = mongoose.model('Order', orderSchema);

module.exports = { Order, ORDER_STATUSES };
