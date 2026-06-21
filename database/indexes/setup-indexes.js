'use strict';

// database/indexes/setup-indexes.js — MongoDB index creation script
//
// Creates all indexes defined in docs/DATABASE_DESIGN.md.
// Safe to re-run: createIndex() is idempotent.
// Run once on first deployment and after any index changes.
//
// Usage:
//   node database/indexes/setup-indexes.js
//
// Requires MONGODB_URI in environment (reads from backend/.env).
//
// Indexes created:
//
//   orders:
//     { status: 1 }
//     { 'deadlines.lab_response_due': 1 }
//     { 'deadlines.client_response_due': 1 }
//     { 'deadlines.original_expected': 1 }
//     { declaration_id: 1 }
//     { 'client.phone': 1 }
//     { created_at: -1 }
//
//   declarations:
//     { order_id: 1 }
//     { sheet_row_id: 1 }  (unique, sparse)
//     { sync_status: 1 }
//
//   tasks:
//     { order_id: 1, type: 1, status: 1 }  (compound — deduplication queries)
//     { status: 1, due_date: 1 }            (dashboard open task queries)
