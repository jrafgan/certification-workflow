'use strict';

// scripts/check-env.js — Environment variable pre-flight check
//
// Validates that all required environment variables are set and non-empty.
// Exits with code 1 and a descriptive error if any are missing.
// Exits with code 0 if all required variables are present.
//
// Run before deployment or in CI to catch missing configuration early.
//
// Usage:
//   node scripts/check-env.js
//
// Required variables checked:
//   PORT, MONGODB_URI, NODE_ENV
//   (SESSION_SECRET and OPERATOR_PASSWORD are checked only if NODE_ENV=production)
//   (Google API vars are checked only if GOOGLE_CLIENT_ID is set — Phase 6+)
