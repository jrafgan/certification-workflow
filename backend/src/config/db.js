'use strict';

// config/db.js — MongoDB connection
//
// Connects to MongoDB using the MONGODB_URI environment variable via Mongoose.
// Handles connection events: connected, error, disconnected.
// Implements basic reconnect behaviour.
// Exports a connect() function called once from server.js.
//
// All application code accesses MongoDB through Mongoose models only.
// Direct use of the native driver is not permitted.
//
// Phase 1 — Project Skeleton
