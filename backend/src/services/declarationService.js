'use strict';

// services/declarationService.js — Declaration CRUD and sync state management
//
// Responsibilities:
//   - findById, findAll (with sync_status filter support)
//   - createFromOrder(order) — creates a Declaration linked to a new Order
//   - updateFromOrder(order, changedFields) — called after order changes that
//     affect Declaration fields; sets sync_status to 'pending' and queues write-back
//   - resolveConflict(declarationId, resolution) — operator chooses 'system' or
//     'sheet' version; resets sync_status to 'synced'
//   - markSynced(declarationId) — called by sheetsSync after a successful write
//   - markConflict(declarationId, details) — called by sheetsSync on conflict detection
//   - markError(declarationId, error) — called by sheetsSync on write failure
//
// Does not communicate directly with Google Sheets API.
// All Sheets I/O is delegated to src/integrations/sheetsSync.js.
//
// See: docs/DATABASE_DESIGN.md — Collection: declarations
//
// Phase 7 — Google Sheets Synchronization

const { Declaration } = require('../models/Declaration');

// updateStatusFromOrder — mirror an order's (already-changed) status onto the
// linked Declaration and queue the write-back. Order.status IS the sheet status
// value, so the mirror is a direct copy. The actual Google Sheets API write is
// performed later by integrations/sheetsSync.js (separate phase); here we only
// record the new value and flag it pending. Returns the Declaration, or null if
// the order has no linked sheet row.
async function updateStatusFromOrder(orderId, status) {
  const declaration = await Declaration.findOne({ order_id: orderId });
  if (!declaration) return null;
  declaration.status      = status;
  declaration.sync_status = 'pending';
  await declaration.save();
  return declaration;
}

// markSynced — called by sheetsSync after a successful write-back.
async function markSynced(declarationId) {
  await Declaration.findByIdAndUpdate(declarationId, {
    sync_status:      'synced',
    last_synced_at:   new Date(),
    conflict_details: undefined,
  });
}

// markError — called by sheetsSync when a write-back fails; the record stays
// eligible for retry via sheetsSync.retryPendingDeclarations once reset to pending.
async function markError(declarationId, details) {
  await Declaration.findByIdAndUpdate(declarationId, {
    sync_status:      'error',
    conflict_details: details,
  });
}

module.exports = { updateStatusFromOrder, markSynced, markError };
