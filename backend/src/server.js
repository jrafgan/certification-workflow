'use strict';

require('dotenv').config();

const express  = require('express');
const mongoose = require('mongoose');
const path     = require('path');

// Register all Mongoose models before any route handler runs
require('./models');

const routes        = require('./routes');
const errorHandler  = require('./middleware/errorHandler');
const { startScheduler } = require('./scheduler');

const app  = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(express.json());

// ─── Sessions (login required — no anonymous access) ──────────────────────────
const session    = require('express-session');
const MongoStore = require('connect-mongo');
app.use(session({
  name:   'cc.sid',
  secret: process.env.SESSION_SECRET || 'dev-insecure-secret-change-me',
  resave: false,
  saveUninitialized: false,
  store:  MongoStore.create({ mongoUrl: process.env.MONGODB_URI, collectionName: 'sessions' }),
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 8 }, // 8h
}));

// ─── Static frontend (Agent Control Center + login) ───────────────────────────
// Served from the repo's /frontend dir. No build step — plain HTML/CSS/JS.
const FRONTEND_DIR = path.resolve(__dirname, '../../frontend');
app.use('/app', express.static(FRONTEND_DIR));
app.get('/', (_req, res) => res.redirect('/app/control-center.html'));

// ─── Routes ───────────────────────────────────────────────────────────────────

const { requireAuth } = require('./middleware/auth');
app.use('/api/auth', require('./routes/auth')); // public: login / logout / me
app.use('/api', requireAuth, routes);           // everything else requires a logged-in user

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    db:     mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
  });
});

// ─── Error handler (must be last middleware) ──────────────────────────────────

app.use(errorHandler);

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function bootstrap() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('ERROR: MONGODB_URI is not set. Add it to backend/.env');
    process.exit(1);
  }

  // Connect to Mongo, but do NOT block the HTTP server on it: the Agent Control Center must
  // serve (and show "DB offline") even when the database is down. The scheduler and DB-backed
  // routes only run once connected. controlCenterService guards on the connection state, so
  // it never issues buffered queries while disconnected.
  let dbConnected = false;
  try {
    await mongoose.connect(uri, { autoIndex: false, serverSelectionTimeoutMS: 4000 });
    dbConnected = true;
    console.log('MongoDB connected');
    await require('./services/authService').ensureSeedAdmin();
    startScheduler();
  } catch (err) {
    console.error(`MongoDB connection failed: ${err.message} — starting HTTP server anyway (DB-backed features disabled until it recovers).`);
    mongoose.connection.on('connected', () => { console.log('MongoDB connected (recovered)'); startScheduler(); });
  }

  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT} [${process.env.NODE_ENV || 'development'}] db=${dbConnected ? 'connected' : 'offline'}`);
  });
}

bootstrap();

module.exports = app;
