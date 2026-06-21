'use strict';

// routes/auth.js — login / logout / current user. Mounted UNAUTHENTICATED at /api/auth.

const express = require('express');
const router  = express.Router();
const authService = require('../services/authService');
const audit = require('../services/auditService');

// POST /api/auth/login { username, password }
router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    const user = await authService.authenticate(username, password);
    if (!user) return res.status(401).json({ code: 'INVALID_CREDENTIALS', message: 'Неверный логин или пароль' });
    req.session.user = user;
    audit.record({ user: user.username, role: user.role, action: 'login', summary: `${user.display_name} вошёл в систему` });
    res.json({ user });
  } catch (err) { next(err); }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  const user = req.session && req.session.user;
  if (user) audit.record({ user: user.username, role: user.role, action: 'logout', summary: `${user.display_name} вышел из системы` });
  req.session.destroy(() => res.json({ ok: true }));
});

// GET /api/auth/me — who am I (used by the UI to gate access on load)
router.get('/me', (req, res) => {
  if (req.session && req.session.user) return res.json({ user: req.session.user });
  res.status(401).json({ code: 'UNAUTHENTICATED', message: 'Не выполнен вход' });
});

module.exports = router;
