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

// POST /api/auth/change-password { current_password, new_password } — self-service, any role.
router.post('/change-password', async (req, res, next) => {
  try {
    const sess = req.session && req.session.user;
    if (!sess) return res.status(401).json({ code: 'UNAUTHENTICATED', message: 'Не выполнен вход' });
    const { current_password, new_password } = req.body || {};
    const r = await authService.changePassword({ username: sess.username, currentPassword: current_password, newPassword: new_password });
    if (!r.ok) return res.status(400).json({ code: 'BAD_CURRENT', message: 'Текущий пароль неверный' });
    audit.record({ user: sess.username, role: sess.role, action: 'change_password', summary: `${sess.display_name} сменил пароль` });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
