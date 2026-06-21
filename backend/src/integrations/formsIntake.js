'use strict';

// integrations/formsIntake.js — Google Forms submission detection and Order creation
//
// Polls the Declaration Google Sheet for rows not yet present in the
// declarations collection (identified by sheet_row_id).
//
// For each unprocessed row:
//   1. Validates required fields using the column mapping constant
//   2. Calls orderService.createOrder() to create a NEW Order
//   3. Calls declarationService to create a linked Declaration record
//   4. Marks the row as processed (stores sheet_row_id)
//   5. Logs SYS_FORM_SUBMISSION_DETECTED to server log
//
// If order creation fails, the row is NOT marked as processed (retry on next poll).
//
// Concurrent-run lock prevents overlapping polls.
//
// Exports:
//   runIntakePoll()  — executes one full poll cycle, returns { created, skipped, errors }
//
// Column mapping constant is defined at the top of this file.
// If a required column is missing, that row is skipped with a named log error.
//
// Phase 6 — Google Forms Integration
