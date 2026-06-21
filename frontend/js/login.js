/* Login page — posts to /api/auth/login, then opens the Control Center. */
(function () {
  'use strict';
  const form = document.getElementById('login-form');
  const errEl = document.getElementById('login-error');
  const btn = document.getElementById('login-btn');

  // If already logged in, skip straight to the workspace.
  fetch('/api/auth/me').then(r => { if (r.ok) location.href = '/app/control-center.html'; }).catch(() => {});

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.textContent = '';
    btn.disabled = true; btn.textContent = 'Вход…';
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: document.getElementById('username').value.trim(), password: document.getElementById('password').value }),
      });
      const d = await r.json();
      if (r.ok) { location.href = '/app/control-center.html'; return; }
      errEl.textContent = d.message || 'Не удалось войти';
    } catch (_) {
      errEl.textContent = 'Сервер недоступен. Попробуйте позже.';
    } finally {
      btn.disabled = false; btn.textContent = 'Войти';
    }
  });
})();
