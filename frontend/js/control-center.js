/* Центр управления — рабочее место оператора. Talks to /api/control-center/*.
   Вход обязателен: при 401 — переход на страницу входа. Роли: administrator / operator. */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const api = (p) => '/api/control-center' + p;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  let me = null;             // { username, display_name, role }
  let lastItems = [];        // inbox/draft items (for chat selector)

  // RU labels
  const ACTION_RU = { approve: 'Одобрить', reject: 'Отклонить', edit: 'Изменить', acknowledge: 'Принять к сведению', request_changes: 'На доработку' };
  const CONF_RU = { HIGH: 'высокая уверенность', MEDIUM: 'средняя уверенность', LOW: 'низкая уверенность', 'авто-ответ': 'авто-ответ', 'нужно одобрение': 'нужно одобрение' };
  const SRC_STATUS_RU = { ok: 'подключено', empty: 'нет данных', unavailable: 'недоступно' };

  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2400); }
  function setDb(connected) {
    const el = $('#dbstatus');
    el.className = 'db ' + (connected === true ? 'ok' : connected === false ? 'off' : 'unknown');
    el.textContent = connected === true ? 'База подключена' : connected === false ? 'База недоступна' : 'База ?';
  }
  async function getJSON(url) { const r = await fetch(url); if (r.status === 401) { location.href = '/app/login.html'; throw new Error('unauth'); } return r.json(); }
  async function postJSON(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 401) { location.href = '/app/login.html'; throw new Error('unauth'); }
    return r.json();
  }
  const offline = (msg) => `<div class="offline">${esc(msg || 'Нет подключения к базе данных. Запустите MongoDB — интерфейс работает, данные появятся после подключения.')}</div>`;

  // ── навигация ───────────────────────────────────────────────────────────
  const SCREENS = { dashboard: loadAttention, inbox: loadInbox, drafts: loadDrafts, pipeline: loadPipeline, chat: loadChat, kb: loadKb, audit: loadAudit, users: loadUsers };
  let current = 'dashboard';
  function show(name) {
    current = name;
    $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.screen === name));
    $$('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + name));
    (SCREENS[name] || (() => {}))();
  }
  $('#tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) show(b.dataset.screen); });
  $('#refresh').addEventListener('click', () => show(current));
  $('#logout').addEventListener('click', async () => { await fetch('/api/auth/logout', { method: 'POST' }); location.href = '/app/login.html'; });

  // ── 1. Главная: очередь внимания (критические проблемы + приоритетная очередь) ──
  const BUCKETS = [
    ['waiting_client', 'Ждём клиента', 'pipeline'],
    ['waiting_lab', 'Ждём лабораторию', 'pipeline'],
    ['waiting_operator', 'Ждём оператора', 'inbox'],
    ['completed', 'Завершено', 'pipeline'],
  ];
  async function loadAttention() {
    const d = await getJSON(api('/attention')); setDb(d.db_connected);
    const ci = $('#critical-issues'), bk = $('#attention-buckets'), q = $('#attention-queue');
    if (!d.db_connected) { ci.innerHTML = offline(); bk.innerHTML = ''; q.innerHTML = ''; loadSources(); return; }

    // Критические проблемы — самое опасное для бизнеса, наверху.
    const issues = d.critical_issues || [];
    ci.innerHTML = issues.length
      ? `<div class="crit-head">⚠ Критические проблемы (${issues.length})</div>` + issues.map(x =>
          `<div class="crit ${esc(x.severity)}"><div class="crit-row"><b>${esc(x.label)}</b><span class="crit-d">${esc(x.detail)}</span>${x.order_id ? `<button class="btn-tl" data-tl="${esc(x.order_id)}">Таймлайн</button> <button class="btn-ws" data-ws="${esc(x.order_id)}">Открыть заказ</button>` : ''}</div><div class="tl-inline"></div></div>`).join('')
      : `<div class="crit-ok">Критических проблем нет ✓</div>`;

    // Сводка ожиданий (Pipeline сохраняется как отдельный экран).
    const b = d.buckets || {};
    bk.innerHTML = BUCKETS.map(([k, l, go]) =>
      `<div class="card ${b[k] ? '' : 'zero'}" data-go="${go}"><div class="n">${b[k] || 0}</div><div class="lbl">${esc(l)}</div></div>`).join('');

    // Приоритетная очередь предложений агента.
    lastItems = b.needs_attention || [];
    q.innerHTML = lastItems.length ? lastItems.map(itemCard).join('') : '<div class="empty">Нет предложений, требующих решения.</div>';
    refreshChatSelector();
    loadAttentionCenter();
    loadSources();
  }

  // ── Центр внимания (Phase 6): 7 категорий того, что требует оператора сегодня ──
  function acItem(it) {
    if (it.lead_id) return `<li>${esc(it.label || '—')}${it.platform ? ` <span class="muted">${esc(it.platform)}</span>` : ''}</li>`;
    if (it.current !== undefined) return `<li>«${esc(it.current || '')}» → «${esc(it.proposed || 'без изменений')}» <span class="muted">${esc(String(it.confidence || ''))}</span>${it.order_id ? ` <button class="btn-ws" data-ws="${esc(it.order_id)}">Открыть заказ</button>` : ''}</li>`;
    if (it.detail !== undefined && it.type) return `<li>${esc(it.label || it.type)}: ${esc(it.detail || '')}${it.order_id ? ` <button class="btn-ws" data-ws="${esc(it.order_id)}">Открыть заказ</button>` : ''}</li>`;
    return `<li>${esc(it.client || '—')} <span class="muted">${esc(it.status || '')}</span>${it.order_id ? ` <button class="btn-ws" data-ws="${esc(it.order_id)}">Открыть заказ</button>` : ''}</li>`;
  }
  async function loadAttentionCenter() {
    const el = $('#attention-center'); if (!el) return;
    const d = await getJSON(api('/attention-center'));
    if (d.db_connected === false) { el.innerHTML = ''; return; }
    el.innerHTML = (d.categories || []).map(c =>
      `<details class="attn-cat" ${c.count ? '' : 'data-empty="1"'}><summary>${esc(c.label)} <span class="attn-n">${c.count}</span></summary>` +
      (c.count ? `<ul class="attn-list">${c.items.map(acItem).join('')}</ul>` : '<div class="empty">нет</div>') +
      `</details>`).join('');
  }
  async function loadSources() {
    const d = await getJSON(api('/sources'));
    $('#dash-sources').innerHTML = (d.sources || []).map(s =>
      `<div class="src ${s.status}"><div class="src-h"><b>${esc(s.label)}</b><span class="src-badge ${s.status}">${SRC_STATUS_RU[s.status] || s.status}</span></div><div class="src-d">${esc(s.detail)}</div></div>`).join('');
  }
  document.addEventListener('click', e => { const c = e.target.closest('[data-go]'); if (c) show(c.dataset.go); });

  // ── общая карточка (входящие + черновики) ───────────────────────────────
  function confBadge(c) { return c ? `<span class="badge ${esc(c)}">${esc(CONF_RU[c] || c)}</span>` : ''; }
  function itemCard(it) {
    const conf = confBadge(it.confidence);
    const n = (it.evidence || []).length;
    // Evidence inline, expandable (no screen switch needed — Task 3).
    const ev = n ? `<details class="ev-d"><summary>Доказательства (${n})</summary><ul class="evidence">${it.evidence.map(e => `<li>${esc(e)}</li>`).join('')}</ul></details>` : '';
    const acts = (it.actions || []).map(a => `<button class="btn-${a}" data-act="${a}" data-type="${esc(it.type)}" data-id="${esc(it.id)}">${ACTION_RU[a] || a}</button>`).join('');
    const tlBtn = it.order_id ? `<button class="btn-tl" data-tl="${esc(it.order_id)}">Таймлайн</button> <button class="btn-ws" data-ws="${esc(it.order_id)}">Открыть заказ</button>` : '';
    const isAudit = it.audit_kind === 'status_audit';
    // Status-audit card (Task 5): Current | Suggested | Confidence, before approval.
    const auditFlow = isAudit ? `<div class="audit-flow">
        <div><span class="af-l">Текущий статус:</span> «${esc(it.current_status || '')}»</div>
        <div><span class="af-l">Предлагаемый:</span> «${esc(it.proposed_status || 'без изменений')}» ${conf}</div>
      </div>` : '';
    return `<div class="item" data-type="${esc(it.type)}" data-id="${esc(it.id)}">
      <div class="head"><span class="title">${esc(it.title)}</span>${isAudit ? '' : conf}<span class="sub">${esc(it.subtitle || '')}</span></div>
      ${auditFlow}
      ${it.body && !isAudit ? `<div class="body">${esc(it.body)}</div>` : ''}
      ${it.reason ? `<div class="reason">${esc(it.reason)}</div>` : ''}${ev}
      <div class="actions">${acts}${tlBtn}<button class="btn-ask" data-act="ask" data-type="${esc(it.type)}" data-id="${esc(it.id)}">? Спросить</button></div>
      <div class="tl-inline"></div>
    </div>`;
  }

  // ── Order timeline (Task 4): Заявка → Оплата → Лаборатория → Согласование → Оригинал → Завершено
  function renderTimeline(steps) {
    return `<div class="timeline">` + (steps || []).map((s, i) =>
      `<div class="tl-step ${s.state}"><span class="tl-dot"></span><span class="tl-lbl">${esc(s.label)}</span></div>${i < steps.length - 1 ? '<span class="tl-arrow">→</span>' : ''}`).join('') + `</div>`;
  }
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-tl]'); if (!b) return;
    const card = b.closest('.item, .crit'); const slot = card && card.querySelector('.tl-inline'); if (!slot) return;
    if (slot.dataset.open === '1') { slot.innerHTML = ''; slot.dataset.open = '0'; return; }
    slot.innerHTML = '<div class="muted">загрузка…</div>';
    const d = await getJSON(api(`/order/${b.dataset.tl}/timeline`));
    slot.innerHTML = d.db_connected && d.steps ? renderTimeline(d.steps) : '<div class="empty">нет данных по заказу</div>';
    slot.dataset.open = '1';
  });

  // ── Unified Operator Workspace (Phase 5): one read-only order screen ──────
  const fmtDate = (d) => d ? new Date(d).toLocaleString('ru-RU') : '—';
  function wsSection(title, inner) { return `<div class="ws-sec"><h3>${esc(title)}</h3>${inner || '<div class="empty">нет данных</div>'}</div>`; }
  function renderWorkspace(w) {
    const sv = w.status_verification;
    const svHtml = sv ? `<div>Текущий: «${esc(sv.current_status || '')}» → Предлагаемый: «${esc(sv.proposed_status || 'без изменений')}» <span class="muted">(${esc(String(sv.confidence_band || sv.confidence || ''))})</span></div>`
      + ((sv.findings || []).map(f => `<div class="ws-find ${esc(f.severity || '')}">⚠ ${esc(f.detail || f.type)}</div>`).join('') || '')
      + (sv.reasoning ? `<div class="muted">${esc(sv.reasoning)}</div>` : '') : '';
    const decl = w.declaration && w.declaration.present
      ? `<div>Статус: «${esc(w.declaration.status || '—')}» · Телефон: ${esc(w.declaration.phone || '—')} · Оплата: ${esc(String(w.declaration.payment_amount ?? '—'))} · Строка: ${esc(w.declaration.sheet_row_id || '—')}</div>`
      : '<div class="empty">Строка Декларации не связана</div>';
    const pays = (w.payments || []).map(p => `<div>${fmtDate(p.date)} — ${esc(String(p.amount ?? ''))} ${esc(p.method || '')}${p.voided ? ' <span class="muted">(аннулирован)</span>' : ''}</div>`).join('');
    const wa = (w.whatsapp || []).map(m => `<div class="ws-msg"><span class="muted">${fmtDate(m.at)} ${esc(m.direction || '')}</span> ${esc(m.body || (m.has_media ? '[вложение]' : ''))}</div>`).join('');
    const em = (w.emails || []).map(t => `<div>${esc(t.recipient || '—')} · ${esc(t.status || '')} · ${fmtDate(t.last_at)}${t.has_attachment ? ' · 📎' : ''}</div>`).join('');
    const mk = (w.mockups || []).map(l => `<div>v${esc(String(l.version || ''))} ${esc(l.file_name || '—')} · получен ${fmtDate(l.received_at)} · клиенту ${fmtDate(l.sent_to_client_at)}${l.client_decision ? ' · ' + esc(l.client_decision) : ''}</div>`).join('');
    const att = (w.attachments || []).map(a => `<div>[${esc(a.source)}] ${esc(a.name || a.ref || '')} <span class="muted">${esc(a.kind || '')}</span></div>`).join('');
    const recs = (w.recommendations || []).map(r => `<div>${esc(r.label || r.type)} <span class="muted">${esc(String(r.confidence || ''))} ${esc(r.state || '')}</span></div>`).join('');
    const dng = (w.dangers || []).map(x => `<div class="ws-find ${esc(x.severity || '')}">⚠ ${esc(x.label || '')}: ${esc(x.detail || '')}</div>`).join('');
    return `<div class="ws">
      <div class="ws-head"><b>${esc(w.client.company || w.client.name || 'Заказ')}</b> · статус «${esc(w.status || '—')}» · долг ${esc(String(w.balance_due || 0))}
        <div class="muted">${esc(w.client.name || '')} · ${esc(w.client.phone || '')} · ${esc(w.client.email || '')}</div></div>
      ${wsSection('Проверка статуса (реальность)', svHtml)}
      ${wsSection('Опасности', dng)}
      ${wsSection('Декларация', decl)}
      ${wsSection('Оплаты', pays)}
      ${wsSection('Макеты', mk)}
      ${wsSection('WhatsApp', wa)}
      ${wsSection('Почта / лаборатория', em)}
      ${wsSection('Вложения', att)}
      ${wsSection('Рекомендации агента', recs)}
    </div>`;
  }
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-ws]'); if (!b) return;
    const body = $('#workspace-body'); body.innerHTML = '<div class="muted">загрузка…</div>';
    show('workspace');
    const d = await getJSON(api(`/order/${b.dataset.ws}/workspace`));
    body.innerHTML = d.db_connected === false ? offline() : renderWorkspace(d);
  });
  $('#ws-back').addEventListener('click', () => show('dashboard'));

  // ── 2. Входящие задачи ──────────────────────────────────────────────────
  async function loadInbox() {
    const d = await getJSON(api('/inbox')); setDb(d.db_connected);
    const el = $('#inbox-list');
    if (!d.db_connected) { el.innerHTML = offline(); return; }
    lastItems = d.items || [];
    el.innerHTML = lastItems.length ? lastItems.map(itemCard).join('') : '<div class="empty">Входящих задач нет — новых предложений от агента нет.</div>';
    refreshChatSelector();
  }

  // ── 3. Черновики ────────────────────────────────────────────────────────
  const GROUP_RU = { replies: 'Ответы клиентам', calculations: 'Расчёты', emails: 'Письма лабораториям', status_changes: 'Изменения статусов' };
  async function loadDrafts() {
    const d = await getJSON(api('/drafts')); setDb(d.db_connected);
    const el = $('#drafts-groups');
    if (!d.db_connected) { el.innerHTML = offline(); return; }
    const all = []; let html = '';
    for (const key of ['replies', 'calculations', 'emails', 'status_changes']) {
      const items = d.groups[key] || []; items.forEach(i => all.push(i));
      html += `<div class="group-title">${GROUP_RU[key]} (${items.length})</div>` + (items.length ? items.map(itemCard).join('') : '<div class="empty">пусто</div>');
    }
    el.innerHTML = html; lastItems = all; refreshChatSelector();
  }

  // действия: одобрить / отклонить / изменить / спросить
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const { act, type, id } = b.dataset;
    if (act === 'ask') { openChatFor(type, id); return; }
    if (act === 'edit') {
      const card = b.closest('.item'); const cur = card ? ($('.body', card)?.textContent || '') : '';
      const text = prompt('Изменить текст:', cur); if (text == null) return;
      const r = await postJSON(api('/decide'), { type, id, action: 'edit', text });
      toast(r.ok ? 'Изменено (ожидает одобрения)' : (r.message || 'Не удалось изменить')); show(current); return;
    }
    const r = await postJSON(api('/decide'), { type, id, action: act });
    toast(r.ok ? `${ACTION_RU[act] || act} — готово` : (r.message || 'Действие не выполнено'));
    show(current);
  });

  // ── 4. Воронка клиентов ─────────────────────────────────────────────────
  async function loadPipeline() {
    const d = await getJSON(api('/pipeline')); setDb(d.db_connected);
    const el = $('#pipeline-board');
    if (!d.db_connected) { el.innerHTML = offline(); return; }
    const cols = d.columns || [];
    el.innerHTML = cols.map((c, i) => `<div class="col"><div class="cn">${c.count}</div><div class="cl">${esc(c.label)}</div></div>` + (i < cols.length - 1 ? '<div class="arrow">→</div>' : '')).join('');
  }

  // ── 5. Чат с агентом ────────────────────────────────────────────────────
  let chatItem = null;
  function refreshChatSelector() {
    const sel = $('#chat-item');
    sel.innerHTML = '<option value="">— выберите задачу —</option>' + lastItems.map(i => `<option value="${esc(i.type)}::${esc(i.id)}">${esc(i.title)}</option>`).join('');
    if (chatItem) sel.value = chatItem.type + '::' + chatItem.id;
  }
  function openChatFor(type, id) {
    chatItem = { type, id };
    const found = lastItems.find(i => i.type === type && i.id === id);
    show('chat');
    $('#chat-ctx').textContent = found ? `Задача: ${found.title}` : `Задача: ${type} ${id}`;
    refreshChatSelector();
  }
  $('#chat-item').addEventListener('change', e => {
    const [type, id] = (e.target.value || '').split('::');
    chatItem = type && id ? { type, id } : null;
    const found = chatItem && lastItems.find(i => i.type === type && i.id === id);
    $('#chat-ctx').textContent = chatItem ? `Задача: ${(found && found.title) || id}` : 'Задача не выбрана.';
  });
  async function ask(question) {
    if (!chatItem) { toast('Сначала выберите задачу'); return; }
    appendMsg('you', question);
    const r = await postJSON(api('/chat'), { type: chatItem.type, id: chatItem.id, question });
    const ev = (r.evidence || []).length ? `<ul class="ev">${r.evidence.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
    appendMsg('agent', esc(r.answer || '(нет ответа)') + ev, true);
  }
  function appendMsg(who, html, isHtml) {
    const div = document.createElement('div'); div.className = 'msg ' + who;
    div[isHtml ? 'innerHTML' : 'textContent'] = html; $('#chat-log').appendChild(div); div.scrollIntoView({ behavior: 'smooth' });
  }
  $('.chat-quick').addEventListener('click', e => { const b = e.target.closest('button'); if (b) ask(b.dataset.q); });
  $('#chat-send').addEventListener('click', () => { const v = $('#chat-input').value.trim(); if (v) { ask(v); $('#chat-input').value = ''; } });
  $('#chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('#chat-send').click(); });
  function loadChat() { if (!lastItems.length) getJSON(api('/inbox')).then(d => { setDb(d.db_connected); lastItems = d.items || []; refreshChatSelector(); }); else refreshChatSelector(); }

  // ── 6. База знаний (+ управление для администратора) ────────────────────
  async function loadKb() {
    const d = await getJSON(api('/kb')); setDb(d.db_connected);
    const el = $('#kb-list');
    if (!d.db_connected) { el.innerHTML = offline(); $('#kb-admin').innerHTML = ''; return; }
    el.innerHTML = (d.entries || []).length ? d.entries.map(e =>
      `<div class="e"><div class="cat">${esc(e.category)} · ${esc(e.type)}${e.possibly_outdated ? ' <span class="out">⚠ возможно устарело</span>' : ''}</div>${esc(e.text)}</div>`).join('') : '<div class="empty">Нет одобренных записей.</div>';
    if (me && me.role === 'administrator') loadKbPending();
  }
  async function loadKbPending() {
    const d = await getJSON(api('/kb-pending'));
    const el = $('#kb-admin');
    if (!d.db_connected) { el.innerHTML = ''; return; }
    el.innerHTML = `<div class="group-title">На рассмотрении (${(d.entries || []).length})</div>` +
      ((d.entries || []).map(e => `<div class="e pending"><div class="cat">${esc(e.category)} · ${esc(e.type)}</div>${esc(e.text)}
        <div class="actions"><button class="btn-approve" data-kb="${esc(e.id)}" data-dec="approve">Одобрить</button><button class="btn-reject" data-kb="${esc(e.id)}" data-dec="reject">Отклонить</button></div></div>`).join('') || '<div class="empty">Нет записей на рассмотрении.</div>');
  }
  document.addEventListener('click', async e => {
    const b = e.target.closest('button[data-kb]'); if (!b) return;
    const r = await postJSON(api(`/kb/${b.dataset.kb}/decision`), { decision: b.dataset.dec });
    toast(r.ok ? 'Готово' : (r.message || 'Ошибка')); loadKb();
  });

  // ── 7. Журнал действий ──────────────────────────────────────────────────
  async function loadAudit() {
    const d = await getJSON(api('/audit')); setDb(d.db_connected);
    const el = $('#audit-list');
    if (!d.db_connected) { el.innerHTML = offline(); return; }
    el.innerHTML = (d.entries || []).length ? `<table class="audit"><thead><tr><th>Время</th><th>Сотрудник</th><th>Действие</th><th>Было → стало</th></tr></thead><tbody>` +
      d.entries.map(a => {
        const b = a.before || {}, af = a.after || {};
        const chg = (b.state || b.status || '') !== (af.state || af.status || '') || (b.proposed_status || b.current_status) ? `${esc(b.status || b.state || '')} → ${esc(af.status || af.state || '')}` : '';
        return `<tr><td>${new Date(a.at).toLocaleString('ru-RU')}</td><td>${esc(a.user)} <span class="role">${esc(a.role || '')}</span></td><td>${esc(a.summary || a.action)}</td><td class="chg">${chg}</td></tr>`;
      }).join('') + '</tbody></table>' : '<div class="empty">Журнал пуст.</div>';
  }

  // ── 8. Пользователи (только администратор) ──────────────────────────────
  async function loadUsers() {
    if (!me || me.role !== 'administrator') { $('#users-list').innerHTML = '<div class="offline">Доступно только администратору.</div>'; return; }
    const d = await getJSON(api('/users'));
    $('#users-list').innerHTML = `<table class="audit"><thead><tr><th>Логин</th><th>Имя</th><th>Роль</th><th>Статус</th><th></th></tr></thead><tbody>` +
      (d.users || []).map(u => `<tr><td>${esc(u.username)}</td><td>${esc(u.display_name)}</td><td>${u.role === 'administrator' ? 'Администратор' : 'Оператор'}</td><td>${u.active ? 'активен' : 'отключён'}</td>
        <td><button class="btn-edit" data-uid="${esc(u.id)}" data-active="${u.active ? '0' : '1'}">${u.active ? 'Отключить' : 'Включить'}</button></td></tr>`).join('') + '</tbody></table>';
  }
  $('#user-form').addEventListener('submit', async e => {
    e.preventDefault();
    const body = { username: $('#u-login').value.trim(), display_name: $('#u-name').value.trim(), password: $('#u-pass').value, role: $('#u-role').value };
    const r = await postJSON(api('/users'), body);
    if (r.user) { toast('Пользователь создан'); e.target.reset(); loadUsers(); } else toast(r.message || 'Не удалось создать');
  });
  document.addEventListener('click', async e => {
    const b = e.target.closest('button[data-uid]'); if (!b) return;
    const r = await postJSON(api(`/users/${b.dataset.uid}/active`), { active: b.dataset.active === '1' });
    toast(r.user ? 'Готово' : (r.message || 'Ошибка')); loadUsers();
  });

  // ── инициализация: проверка входа ───────────────────────────────────────
  (async function init() {
    let res;
    try { res = await fetch('/api/auth/me'); } catch (_) { location.href = '/app/login.html'; return; }
    if (!res.ok) { location.href = '/app/login.html'; return; }
    me = (await res.json()).user;
    $('#whoami').textContent = `${me.display_name} · ${me.role === 'administrator' ? 'Администратор' : 'Оператор'}`;
    // скрыть админ-элементы для оператора
    if (me.role !== 'administrator') $$('[data-admin="1"]').forEach(el => el.style.display = 'none');
    show('dashboard');
  })();
})();
