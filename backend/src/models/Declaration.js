'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

const SYNC_STATUSES = ['synced', 'pending', 'conflict', 'error', 'row_deleted'];

const DECLARATION_SOURCES = ['google_sheets', 'manual'];

// ─── Declaration schema ───────────────────────────────────────────────────────

const declarationSchema = new Schema({
  // Nullable: a sheet row may exist before it is matched to an Order
  order_id: { type: Schema.Types.ObjectId, ref: 'Order' },

  // Spreadsheet column mirrors
  payment_date:   { type: Date },
  payment_amount: { type: Number, min: 0 },
  client_name:    { type: String, trim: true },
  document_type:  { type: String, trim: true },
  phone:          { type: String, trim: true },
  notes:          { type: String },
  // Free-text from the spreadsheet status column — not constrained to Order statuses
  status:         { type: String },

  source: {
    type:     String,
    enum:     DECLARATION_SOURCES,
    required: true,
  },

  // Unique per sheet row; absent on manually created declarations
  sheet_row_id: { type: String },

  sync_status: {
    type:     String,
    enum:     SYNC_STATUSES,
    required: true,
    default:  'pending',
  },
  conflict_details: { type: String },
  last_synced_at:   { type: Date },
  created_at:       { type: Date, default: Date.now },
}, {
  collection: 'declarations',
  versionKey: false,
});

// ─── Indexes ──────────────────────────────────────────────────────────────────

// Sparse: order_id is null until the sheet row is matched to an Order
declarationSchema.index({ order_id: 1 }, { sparse: true });

// Unique sparse: sheet_row_id identifies the exact spreadsheet row; absent on manual records
declarationSchema.index({ sheet_row_id: 1 }, { unique: true, sparse: true });

// Scheduler and sync module scan for pending and conflict records
declarationSchema.index({ sync_status: 1 });

// ─── Model ────────────────────────────────────────────────────────────────────

const Declaration = mongoose.model('Declaration', declarationSchema);

module.exports = { Declaration, SYNC_STATUSES, DECLARATION_SOURCES };
