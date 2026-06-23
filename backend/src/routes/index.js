'use strict';

// routes/index.js — Central route mount point.
// All route modules registered here with their URL prefix.
// server.js mounts this router at /api.
//
// Active prefixes:
//   /api/orders        → routes/orders.js       (Phase L1 routes active)
//   /api/integrations  → routes/integrations.js (Phase L1 routes active)
//   /api/dashboard     → routes/dashboard.js    (Phase L2 lab comm attention view)
//   /api/draft-packages → routes/draftPackages.js (Draft Package Generator — output only)
//   /api/extraction-reviews → routes/extractionReviews.js (OCR extraction reviews — output only)
//   /api/email-drafts   → routes/emailDrafts.js (Draft Email Engine — lab-only, output only)
//   /api/lead-recoveries → routes/leadRecoveries.js (Lead Recovery Engine — WhatsApp, output only)
//   /api/audit-packages → routes/auditPackages.js (Workflow Auditor — status audit, output only)
//   /api/leads          → routes/leads.js (Lead Conversion Agent — social leads, output only)
//   /api/control-center → routes/controlCenter.js (Agent Control Center — operator UI aggregation)
//
// Planned prefixes (routes not yet implemented):
//   /api/tasks         Phase 4
//   /api/declarations  Phase 7

const express = require('express');
const router  = express.Router();

router.use('/orders',         require('./orders'));
router.use('/integrations',   require('./integrations'));
router.use('/dashboard',      require('./dashboard'));
router.use('/draft-packages', require('./draftPackages'));
router.use('/extraction-reviews', require('./extractionReviews'));
router.use('/email-drafts', require('./emailDrafts'));
router.use('/lead-recoveries', require('./leadRecoveries'));
router.use('/audit-packages', require('./auditPackages'));
router.use('/leads', require('./leads'));
router.use('/phone-entities', require('./phoneEntities'));
router.use('/mockups', require('./mockups'));
router.use('/control-center', require('./controlCenter'));

module.exports = router;
