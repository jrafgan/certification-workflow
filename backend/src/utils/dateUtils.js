'use strict';

// utils/dateUtils.js — Date manipulation and comparison helpers
//
// Pure functions used by services and the scheduler.
// All comparisons use UTC midnight to avoid timezone drift.
//
// Functions to implement:
//   isToday(date)           — returns true if date is today (UTC)
//   isPast(date)            — returns true if date is before today (UTC)
//   daysSince(date)         — number of full days between date and today
//   daysUntil(date)         — number of full days between today and date
//   hoursSince(date)        — number of hours between date and now
//   toUTCMidnight(date)     — strips time component, returns UTC midnight Date
//
// Phase 3 — Order Service (used by state machine deadline checks)
// Phase 8 — Attention Engine (used by all condition evaluations)
