'use strict';

// middleware/auth.js — session gate. No anonymous access to the Control Center API.

// Requires a logged-in user; otherwise 401 (the UI redirects to the login page).
function requireAuth(req, res, next) {
  if (req.session && req.session.user) { req.user = req.session.user; return next(); }
  return res.status(401).json({ code: 'UNAUTHENTICATED', message: 'Требуется вход в систему' });
}

// Requires a specific role (e.g. 'administrator'). Must run after requireAuth.
function requireRole(role) {
  return (req, res, next) => {
    if (req.user && req.user.role === role) return next();
    return res.status(403).json({ code: 'FORBIDDEN', message: 'Недостаточно прав. Действие доступно только администратору.' });
  };
}

module.exports = { requireAuth, requireRole };
