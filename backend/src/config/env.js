'use strict';

// config/env.js — Environment variable validation
//
// Loads .env via dotenv and checks that every required variable is present
// and non-empty. Exits the process with a clear error message if any are
// missing so misconfiguration is caught at startup, not at runtime.
//
// Required variables are defined as a named list here, not scattered
// across individual files. Add new required vars to this list.
//
// Phase 1 — Project Skeleton
