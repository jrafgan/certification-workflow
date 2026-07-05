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
  // cache:'no-store' — всегда свежие данные с бэкенда, никакого кэша браузера при обновлении страницы.
  async function getJSON(url) { const r = await fetch(url, { cache: 'no-store' }); if (r.status === 401) { location.href = '/app/login.html'; throw new Error('unauth'); } return r.json(); }
  async function postJSON(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 401) { location.href = '/app/login.html'; throw new Error('unauth'); }
    return r.json();
  }
  const offline = (msg) => `<div class="offline">${esc(msg || 'Нет подключения к базе данных. Запустите MongoDB — интерфейс работает, данные появятся после подключения.')}</div>`;

  // ── навигация ───────────────────────────────────────────────────────────
  const SCREENS = { tasks: loadTasks, dashboard: loadAttention, inbox: loadInbox, emails: loadEmails, drafts: loadDrafts, autoreplies: loadAutoReplies, pipeline: loadPipeline, chat: loadChat, kb: loadKb, audit: loadAudit, users: loadUsers, 'first-contact': loadFirstContact, stats: loadStats };
  let current = 'tasks';
  function show(name) {
    current = name;
    $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.screen === name));
    $$('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + name));
    const more = document.querySelector('.more-menu'); if (more) more.open = false; // close «Ещё»
    (SCREENS[name] || (() => {}))();
  }
  $('#tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) show(b.dataset.screen); });
  $('#refresh').addEventListener('click', () => show(current));
  $('#logout').addEventListener('click', async () => { await fetch('/api/auth/logout', { method: 'POST' }); location.href = '/app/login.html'; });
  // Self-service password change — available to every logged-in user (operator + admin).
  $('#change-pass').addEventListener('click', async () => {
    const current_password = prompt('Текущий пароль:');
    if (current_password == null) return;
    const new_password = prompt('Новый пароль (минимум 6 символов):');
    if (new_password == null) return;
    if (String(new_password).length < 6) { toast('Новый пароль — минимум 6 символов'); return; }
    if (new_password !== prompt('Повторите новый пароль:')) { toast('Пароли не совпадают'); return; }
    const r = await postJSON('/api/auth/change-password', { current_password, new_password });
    toast(r && r.ok ? 'Пароль изменён ✓' : (r && r.message) || 'Не удалось сменить пароль');
  });

  // ── Сущность по номеру WhatsApp (1-й ID телефон, 2-й ID юрлицо) ──
  const ACTOR_RU = { operator: 'оператор', lab: 'лаборатория', client: 'клиент' };
  async function findEntity() {
    const phone = ($('#entity-phone').value || '').trim();
    const out = $('#entity-result'); if (!phone) { out.innerHTML = ''; return; }
    out.innerHTML = '<div class="muted">поиск…</div>';
    let e; try { e = await getJSON('/api/client-entity?phone=' + encodeURIComponent(phone)); } catch (_) { out.innerHTML = '<div class="empty">Ошибка.</div>'; return; }
    if (!e || !e.found) { out.innerHTML = `<div class="empty">Сущность не найдена (${esc((e && e.reason) || '')}).</div>`; return; }
    const orders = (e.orders || []).map(o =>
      `<li>«${esc(o.status || '—')}» <span class="muted">${esc(o.stage)}${o.next_actor_ru ? ' · действует: ' + esc(o.next_actor_ru) : ' · готово'}</span></li>`).join('') || '<li class="muted">нет строк в «Декларации»</li>';
    out.innerHTML = `<div class="entity-card">
      <div><b>Телефон:</b> ${esc(e.phone)} <span class="muted">(1-й ID)</span></div>
      <div><b>Юрлицо:</b> ${esc(e.legal_entity || '—')} ${e.entity_confirmed ? '<span class="muted">(подтверждено)</span>' : '<span class="muted">(предварительно)</span>'} <span class="muted">(2-й ID)</span></div>
      <div><b>Состояние:</b> ${e.is_new_application ? 'новая заявка' : (e.in_declaration ? 'в работе' : '—')} · активных заказов: ${esc(String(e.active_count))} · ${e.alive ? 'живёт' : 'завершено'}</div>
      <div><b>Заказы:</b><ul class="entity-orders">${orders}</ul></div>
      <div class="muted">Из WhatsApp (канал не подключён): свидетельство ИП/ОсОО, чек оплаты, долг.</div>
    </div>`;
  }
  $('#entity-find').addEventListener('click', findEntity);
  $('#entity-phone').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') findEntity(); });

  // ── Очередь работ (агент сам определяет состояние; «Создать макет» — пер-заявка) ──
  function wqItem(key, it) {
    if (key === 'new_applications') {
      return `<li>${esc(it.applicant || '—')}${it.legal_entity ? ` <span class="muted">${esc(it.legal_entity)}</span>` : ''}
        <button class="btn-mk" data-row="${esc(String(it.sheet_row))}" data-name="${esc(it.applicant || '')}">Создать макет</button></li>`;
    }
    if (it.current !== undefined) return `<li>«${esc(it.current || '')}» → «${esc(it.proposed || 'без изменений')}»${it.order_id ? ` <button class="btn-ws" data-ws="${esc(it.order_id)}">Открыть заказ</button>` : ''}</li>`;
    if (it.detail !== undefined && it.type) return `<li>${esc(it.label || it.type)}: ${esc(it.detail || '')}${it.order_id ? ` <button class="btn-ws" data-ws="${esc(it.order_id)}">Открыть заказ</button>` : ''}</li>`;
    return `<li>${esc(it.client || '—')} <span class="muted">${esc(it.status || '')}</span>${it.order_id ? ` <button class="btn-ws" data-ws="${esc(it.order_id)}">Открыть заказ</button>` : ''}</li>`;
  }
  async function loadWorkQueue() {
    const el = $('#work-queue'); if (!el) return;
    let d; try { d = await getJSON('/api/work-queue'); } catch (_) { el.innerHTML = ''; return; }
    el.innerHTML = (d.sections || []).map(s =>
      `<details class="wq-sec" ${s.count ? '' : 'data-empty="1"'}><summary>${esc(s.label)} <span class="wq-n">${s.count}</span></summary>` +
      (s.count ? `<ul class="wq-list">${s.items.map(it => wqItem(s.key, it)).join('')}</ul>` : '<div class="empty">нет</div>') +
      `</details>`).join('');
  }
  // «Создать макет» for a specific application row → classify → DOCX → download link.
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-row]'); if (!b) return;
    const out = $('#mockup-result'); out.innerHTML = `<div class="muted">генерация для «${esc(b.dataset.name)}»…</div>`;
    let d;
    try { d = await postJSON('/api/mockups/generate', { sheet_row: parseInt(b.dataset.row, 10) }); }
    catch (_) { out.innerHTML = '<div class="empty">Ошибка генерации.</div>'; return; }
    if (!d || !d.generated) {
      const why = d && d.blocked === 'classification_needs_operator'
        ? 'требуется решение оператора по ДС/СС (поле «детский/взрослый» не распознано)'
        : (d && d.blocked) || 'неизвестная причина';
      out.innerHTML = `<div class="empty">Не сгенерировано: ${esc(why)}</div>`; return;
    }
    const c = d.classification || {};
    out.innerHTML = `<div class="mockup-card">
      <div><b>Классификация:</b> ${esc(c.age || '')} · ${esc(c.category || '')} · <b>${esc(c.doc_type || '')}</b> · составов: ${esc(String(c.composition_groups))} · протоколов: ${esc(String(c.protocol_groups))} · образцов: ${esc(String(c.samples_required))} · лаб.: ${esc(c.laboratory || '')} · ${esc(String(c.confidence))}%</div>
      <div><b>Шаблон:</b> ${esc((d.template_used || '').split('/').pop())}</div>
      <div><b>Файл:</b> ${esc(d.mockup_file_name || '')}</div>
      <div class="mockup-dl"><a class="btn-dl" href="${esc(d.download_url)}" download>⬇ Скачать макет</a>${d.attachment_download_url ? ` <a class="btn-dl" href="${esc(d.attachment_download_url)}" download>⬇ Скачать приложение</a>` : ''}
        <button class="btn-mail" data-mrow="${esc(String(d.sheet_row || ''))}">✉ Письмо в лабораторию</button></div>
      <div class="lab-email"></div>
      <div class="muted">строка формы: ${esc(String(d.sheet_row || ''))}</div>
    </div>`;
  });

  // «Письмо в лабораторию»: подготовить ЧЕРНОВИК (получатель/тема/тело/вложения). НЕ отправляет.
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-mrow]'); if (!b) return;
    const card = b.closest('.mockup-card'); const slot = card && card.querySelector('.lab-email'); if (!slot) return;
    slot.innerHTML = '<div class="muted">подготовка письма…</div>';
    let d;
    try { d = await postJSON('/api/lab-emails/prepare-from-form', { sheet_row: parseInt(b.dataset.mrow, 10) }); }
    catch (_) { slot.innerHTML = '<div class="empty">Ошибка подготовки письма.</div>'; return; }
    if (!d || !d.prepared) { slot.innerHTML = `<div class="empty">Письмо не подготовлено: ${esc((d && d.blocked) || 'неизвестно')}</div>`; return; }
    const m = d.lab_email;
    slot.innerHTML = `<div class="mail-card">
      <div><b>Кому:</b> ${esc(m.to)} <span class="muted">(${esc(m.lab)})</span></div>
      <div><b>Тема:</b> ${esc(m.subject)}</div>
      <div><b>Вложения:</b> ${esc(m.attachments.map(a => a.name).join(', '))}</div>
      <div class="mail-body">${esc(m.body).replace(/\n/g, '<br>')}</div>
      ${m.duplicate_warning ? `<div class="mail-warn">⚠ ${esc(m.duplicate_warning)}</div>` : ''}
      <div class="muted">Черновик — проверьте и отправьте вручную. Система не отправляет автоматически.</div>
    </div>`;
  });

  // ── 0. ЗАДАЧИ: главный экран — список тредов (как WhatsApp) + деталь ──────────
  const CHAN_ICON = { whatsapp: '📱', email: '✉️', application: '🆕' };
  const KIND_RU = { whatsapp_reply: 'клиент', lab_email: 'письмо', new_application: 'заявка' };
  function ageRu(ms) {
    if (ms == null) return '';
    const m = Math.floor(ms / 60000); if (m < 1) return 'сейчас'; if (m < 60) return m + 'м';
    const h = Math.floor(m / 60); if (h < 24) return h + 'ч';
    return Math.floor(h / 24) + 'д';
  }
  // Срочность по возрасту: чем дольше без ответа — тем «горячее».
  function ageClass(ms) { if (ms == null) return ''; const h = ms / 3600000; return h >= 24 ? 'hot' : h >= 4 ? 'warn' : ''; }

  let taskCache = [];
  let taskFilter = 'all';
  let taskSearch = '';
  const TASK_FILTERS = [
    ['all',      'Все',           () => true],
    ['unread',   'Непрочитанные', t => t.unread > 0],
    ['whatsapp', 'Ответить',      t => t.kind === 'whatsapp_reply'],
    ['paid',     'Оплатившие',    t => t.is_paid],
    ['email',    'Письма',        t => t.kind === 'lab_email'],
    ['new',      'Заявки',        t => t.kind === 'new_application'],
  ];
  const filterPred = (id) => (TASK_FILTERS.find(f => f[0] === id) || TASK_FILTERS[0])[2];
  const taskMatchesSearch = (t, q) => !q || [t.title, t.phone, t.subtitle, t.last_message, t.legal_entity].filter(Boolean).join(' ').toLowerCase().includes(q);
  function taskRow(t) {
    const icon = CHAN_ICON[t.channel] || '•';
    const unread = t.unread ? `<span class="tk-dot">${t.unread > 1 ? esc(String(t.unread)) : ''}●</span>` : '';
    const tag = KIND_RU[t.kind] ? `<span class="tk-tag ${esc(t.kind)}">${KIND_RU[t.kind]}</span> ` : '';
    return `<div class="tk ${t.unread ? 'unread' : ''} ${ageClass(t.age_ms)}" data-kind="${esc(t.kind)}" data-phone="${esc(t.phone || '')}" data-row="${esc(String(t.sheet_row == null ? '' : t.sheet_row))}">
      <div class="tk-ic">${icon}</div>
      <div class="tk-main">
        <div class="tk-top"><span class="tk-title">${esc(t.title)}</span><span class="tk-age">${ageRu(t.age_ms)}</span></div>
        <div class="tk-sub">${tag}${esc(t.subtitle || '')}</div>
        <div class="tk-msg">${esc(t.last_message || '')}</div>
      </div>${unread}
    </div>`;
  }
  function renderTaskFilters() {
    const el = $('#tasks-filters'); if (!el) return;
    el.innerHTML = TASK_FILTERS.map(([id, label, pred]) =>
      `<button class="tk-f ${taskFilter === id ? 'active' : ''}" data-filter="${id}">${label} <span class="tk-fn">${taskCache.filter(pred).length}</span></button>`).join('');
  }
  function renderTaskList() {
    const shown = taskCache.filter(filterPred(taskFilter)).filter(t => taskMatchesSearch(t, taskSearch));
    $('#tasks-count').textContent = taskCache.length ? `${shown.length} из ${taskCache.length}` : '';
    $('#tasks-list').innerHTML = shown.length ? shown.map(taskRow).join('')
      : (taskCache.length ? '<div class="empty">Ничего не найдено по фильтру/поиску.</div>' : '<div class="empty">Задач нет — всё разобрано ✓</div>');
  }
  async function loadTasks() {
    const d = await getJSON(api('/tasks')); setDb(d.db_connected);
    if (!d.db_connected) { $('#tasks-list').innerHTML = offline(); $('#tasks-count').textContent = ''; $('#tasks-filters').innerHTML = ''; return; }
    taskCache = d.tasks || [];
    renderTaskFilters();
    renderTaskList();
  }
  const bubbleAt = (d) => d ? new Date(d).toLocaleString('ru-RU') : '';
  const fmtSom = (n) => String(n || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  function renderThread(d) {
    const e = d.entity;
    const pay = d.payment || { paid: 0, debt: 0 };
    const name = (e && e.legal_entity) || d.phone || '';

    // Оплата (кол. G): «оплачено … · долг …».
    const payHtml = pay.paid > 0
      ? `<span class="td-pay paid">💰 оплачено ${esc(fmtSom(pay.paid))} сом${pay.debt > 0 ? ` · долг ${esc(fmtSom(pay.debt))} сом` : ''}</span>`
      : '<span class="td-pay none">не оплачено</span>';

    // Откуда + куда идём.
    const nextStep = d.next_step
      ? `«${esc(d.next_step.status || '')}»${d.next_step.actor_ru ? ` · действует: ${esc(d.next_step.actor_ru)}` : ''}`
      : (e ? 'завершено / нет активного заказа' : '—');
    const meta = `<div class="td-info">
        <div><b>Откуда:</b> ${esc(d.origin || '—')}</div>
        <div><b>Куда идём:</b> ${nextStep}</div>
        ${d.days_since_last != null ? `<div><b>Последнее сообщение:</b> ${d.days_since_last === 0 ? 'сегодня' : esc(String(d.days_since_last)) + ' дн. назад'}</div>` : ''}
        ${e ? `<div><b>Заказов активных:</b> ${esc(String(e.active_count == null ? '' : e.active_count))}</div>` : ''}
      </div>`;

    // Резюме переписки (агент).
    const summary = d.conversation_summary
      ? `<div class="td-info" style="background:#eff6ff;border-color:#bfdbfe"><b>🧾 Резюме:</b> ${esc(d.conversation_summary)}</div>` : '';

    // Карточка заявки из «Новой формы» (центр CRM).
    const fld = (label, val) => `<div><b>${label}:</b> ${val ? esc(val) : '<span class="muted">—</span>'}</div>`;
    const app = d.application && d.application.found ? d.application.card : null;
    const multi = d.application && d.application.match_count > 1
      ? `<div class="muted" style="margin-top:4px">⚠ По этому номеру найдено ${esc(String(d.application.match_count))} заявок — показана последняя (строка ${esc(String(app.sheet_row))}).</div>` : '';
    const appCard = app
      ? `<div class="td-sec-h">Заявка (Новая форма)</div><div class="td-info">
          ${fld('Дата заявки', app.submitted_at ? new Date(app.submitted_at).toLocaleString('ru-RU') : '')}
          ${fld('Компания / ФИО', app.company_name)}
          ${fld('ИП / ОсОО', app.entity_type)}
          ${fld('ТН ВЭД', app.tnved)}
          ${fld('Товары / состав', app.goods)}
          ${fld('Производитель', app.producer)}
          ${fld('Страна производства', app.production_country)}
          ${fld('Страна регистрации', app.reg_country)}
          ${fld('Бренд', app.brand)}
          ${fld('Группа товара', app.age_group)}
          ${multi}
        </div>`
      : `<div class="td-sec-h">Заявка (Новая форма)</div><div class="muted">Заявка по этому номеру в «Новой форме» не найдена.</div>`;

    // История WhatsApp.
    const msgs = (d.messages || []).map(m =>
      `<div class="bub ${m.direction === 'outbound' ? 'out' : 'in'}">${m.is_group ? '<span class="bub-g">группа</span> ' : ''}${esc(m.body)}<span class="bub-at">${bubbleAt(m.at)}</span></div>`).join('') || '<div class="empty">нет сообщений</div>';

    // История почты / лаборатории (ищется ТОЛЬКО если клиент в Декларации и статус ≠ «Запустить»).
    const eh = (d.email_history || []).length
      ? (d.email_history || []).map(t =>
          `<div class="td-eh">${t.needs_reply ? '<span class="tk-tag" style="background:#fee2e2;color:#991b1b">нужен ответ</span> ' : ''}<span class="muted">${bubbleAt(t.at)}</span> ${t.kind === 'lab' ? '🧪 лаборатория' : '✉️ черновик'} · ${esc(t.recipient || '—')} · ${esc(t.status || '')}${t.has_attachment ? ' · 📎' : ''}${t.subject ? ` · ${esc(t.subject)}` : ''}</div>`).join('')
      : `<div class="muted">${esc(d.email_search_reason || 'Переписки с лабораторией по этому клиенту не найдено.')}</div>`;

    // Предложение агента (всегда есть) — редактируемое, с отправкой в один клик.
    const pr = d.proposed_reply || {};
    const canSend = !!d.phone;
    const reply = `<div class="td-draft">
        <div class="td-draft-h">🤖 Предложение агента ответить клиенту${pr.reason ? ` <span class="muted">(${esc(pr.reason)})</span>` : ''}</div>
        <textarea class="td-reply" id="td-reply">${esc(pr.text || '')}</textarea>
        <div class="actions">
          ${d.phone ? `<button class="btn-ai" data-ai-phone="${esc(d.phone)}">🤖 Черновик ИИ</button>` : ''}
          ${canSend ? `<button class="btn-send" data-send-phone="${esc(d.phone)}">✉ Отправить клиенту</button>` : ''}
          <button class="btn-copy" data-copy-el="td-reply">Скопировать</button>
          ${pr.draft_id ? `<button class="btn-reject" data-act="reject" data-type="lead_message" data-id="${esc(pr.draft_id)}">Отклонить черновик</button>` : ''}
        </div>
        <div class="muted">Проверьте текст и отправьте. Отправка идёт через безопасный канал (анти-бан).</div>
      </div>`;

    return `<div class="td">
      <div class="td-head"><b>${esc(name)}</b> <span class="muted">${esc(d.phone || '')}</span> ${payHtml}
        <span class="td-tools"><button class="btn-done" data-done-phone="${esc(d.phone || '')}">✓ Готово</button>
        <button class="btn-snooze" data-snooze-phone="${esc(d.phone || '')}">🕒 Отложить</button></span></div>
      ${meta}
      ${summary}
      ${appCard}
      ${reply}
      <div class="td-sec-h">История переписки WhatsApp</div>
      <div class="td-thread">${msgs}</div>
      <div class="td-sec-h">Почта / лаборатория</div>
      <div class="td-eh-list">${eh}</div>
    </div>`;
  }
  async function openThread(phone) {
    const pane = $('#task-detail'); pane.innerHTML = '<div class="muted">загрузка…</div>';
    const d = await getJSON(api('/thread?phone=' + encodeURIComponent(phone)));
    if (d.db_connected === false) { pane.innerHTML = offline(); return; }
    pane.innerHTML = renderThread(d);
    if (d.proposed_reply && d.proposed_reply.draft_id) lastItems = [{ type: 'lead_message', id: d.proposed_reply.draft_id, title: 'Ответ клиенту ' + (phone || '') }];
    postJSON(api('/thread/seen'), { phone, action: 'seen' }).catch(() => {}); // mark read
  }
  // «🤖 Черновик ИИ» — LLM-ответ клиенту с учётом «Декларации» + истории WhatsApp; кладём в поле.
  document.addEventListener('click', async e => {
    const b = e.target.closest('button[data-ai-phone]'); if (!b) return;
    const ta = $('#td-reply'); b.disabled = true; const old = b.textContent; b.textContent = 'Готовлю…';
    try {
      const r = await postJSON(api('/whatsapp-draft'), { phone: b.dataset.aiPhone });
      if (r && r.ok) { if (ta) ta.value = r.draft || ''; toast(`Черновик готов${r.context && r.context.status ? ' · ' + r.context.status : ''}`); }
      else toast('Не удалось' + (r && r.reason ? ' (' + r.reason + ')' : ''));
    } catch (_) { toast('Ошибка запроса'); }
    finally { b.disabled = false; b.textContent = old; }
  });
  // «Скопировать» the (editable) agent reply from a textarea/element.
  document.addEventListener('click', e => {
    const b = e.target.closest('button[data-copy-el]'); if (!b) return;
    const el = document.getElementById(b.dataset.copyEl); const txt = el ? (el.value || el.textContent || '') : '';
    if (navigator.clipboard) navigator.clipboard.writeText(txt).then(() => toast('Скопировано')).catch(() => toast('Не удалось скопировать'));
    else toast('Копирование недоступно');
  });
  // «Отправить клиенту» — operator-confirmed, safety-gated send via /api/whatsapp/send.
  document.addEventListener('click', async e => {
    const b = e.target.closest('button[data-send-phone]'); if (!b) return;
    const ta = $('#td-reply'); const body = ta ? ta.value.trim() : '';
    if (!body) { toast('Пустой ответ'); return; }
    const phone = b.dataset.sendPhone;
    if (!confirm(`Отправить это сообщение клиенту ${phone}?`)) return;
    b.disabled = true;
    let r; try { r = await postJSON('/api/whatsapp/send', { to: phone, body }); } catch (_) { toast('Ошибка отправки'); b.disabled = false; return; }
    if (r && r.ok) { toast('Отправлено клиенту ✓'); postJSON(api('/thread/seen'), { phone, action: 'seen' }).catch(() => {}); loadTasks(); }
    else {
      const why = r && r.reason === 'safety_blocked'
        ? `анти-бан${r.wait_ms ? `, подождите ${Math.ceil(r.wait_ms / 1000)}с` : ''}`
        : (r && (r.reason || r.message)) || 'не отправлено';
      toast('Не отправлено: ' + why); b.disabled = false;
    }
  });
  // Поиск + фильтры (клиентская фильтрация кэша задач).
  $('#tasks-search').addEventListener('input', e => { taskSearch = (e.target.value || '').trim().toLowerCase(); renderTaskList(); });
  $('#tasks-filters').addEventListener('click', e => { const b = e.target.closest('button[data-filter]'); if (!b) return; taskFilter = b.dataset.filter; renderTaskFilters(); renderTaskList(); });
  // Авто-обновление списка каждые 30с (только на экране «Задачи», деталь не трогаем).
  setInterval(() => { if (current === 'tasks' && document.visibilityState !== 'hidden') loadTasks().catch(() => {}); }, 30000);
  function openTask(ds) {
    if (ds.kind === 'whatsapp_reply' && ds.phone) { openThread(ds.phone); return; }
    const pane = $('#task-detail');
    if (ds.kind === 'lab_email') {
      pane.innerHTML = `<div class="td"><div class="td-head"><b>Письмо лаборатории</b></div>
        <p class="muted">Проверьте черновик письма и отправьте вручную — система не отправляет сама.</p>
        <button class="btn-approve" data-goto="drafts">Открыть в «Черновиках»</button></div>`;
    } else if (ds.kind === 'new_application') {
      const t = taskCache.find(x => x.kind === 'new_application' && String(x.sheet_row) === String(ds.row)) || {};
      const dateRu = t.submitted_at ? new Date(t.submitted_at).toLocaleString('ru-RU') : 'дата неизвестна';
      const staleWarn = t.stale
        ? `<div class="td-info" style="background:#fef2f2;border-color:#fecaca;color:#991b1b">⚠ Заявке ${esc(String(t.age_days))} дн. — возможно, клиент уже отказался. Стоит уточнить актуальность перед просчётом.</div>`
        : '';
      const reasons = [
        ['already_replied', 'Уже ответили'], ['not_relevant', 'Не актуальна'],
        ['duplicate', 'Дубликат'], ['already_client', 'Уже клиент / есть заказ'],
        ['handled_offline', 'Обработана вне системы'], ['spam_wrong', 'Спам / не тот номер'],
        ['other', 'Другое'],
      ];
      const markBox = `<div class="td-info" style="margin-top:10px">
        <b>Не новая?</b> Отметьте — агент запомнит и уберёт из списка.
        <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">
          <select id="app-reason" style="flex:1;min-width:160px">${reasons.map(r => `<option value="${r[0]}">${r[1]}</option>`).join('')}</select>
          <input id="app-note" placeholder="заметка (необязательно)" style="flex:2;min-width:160px"/>
        </div>
        <button class="btn-approve" style="margin-top:8px"
          data-app-mark="1" data-phone="${esc(t.phone || '')}" data-row="${esc(String(t.sheet_row == null ? '' : t.sheet_row))}" data-name="${esc(t.client_name || '')}">
          Отметить: не новая</button>
      </div>`;
      pane.innerHTML = `<div class="td"><div class="td-head"><b>Новая заявка без просчёта</b></div>
        <div class="td-info"><b>Заявка создана:</b> ${esc(dateRu)}${t.age_days != null ? ` · ${esc(String(t.age_days))} дн. назад` : ''}</div>
        ${staleWarn}
        <p class="muted">Строка формы: ${esc(ds.row || '—')}. Подготовьте макет и расчёт в очереди заявок.</p>
        <button class="btn-approve" data-goto="dashboard">Открыть очередь заявок</button>
        ${markBox}</div>`;
    }
  }
  $('#tasks-list').addEventListener('click', e => { const row = e.target.closest('.tk'); if (row) openTask(row.dataset); });
  document.addEventListener('click', async e => {
    const g = e.target.closest('[data-goto]'); if (g) { show(g.dataset.goto); return; }
    const done = e.target.closest('[data-done-phone]');
    if (done) { await postJSON(api('/thread/seen'), { phone: done.dataset.donePhone, action: 'done' }); toast('Отмечено «Готово»'); $('#task-detail').innerHTML = '<div class="td-empty">Выберите задачу слева.</div>'; loadTasks(); return; }
    const sn = e.target.closest('[data-snooze-phone]');
    if (sn) { await postJSON(api('/thread/seen'), { phone: sn.dataset.snoozePhone, action: 'snooze' }); toast('Отложено на 24 ч'); loadTasks(); return; }
    const am = e.target.closest('[data-app-mark]');
    if (am) {
      const reason = ($('#app-reason') || {}).value || 'other';
      const note = (($('#app-note') || {}).value || '').trim();
      const r = await postJSON(api('/applications/mark'), { phone: am.dataset.phone, sheet_row: am.dataset.row, client_name: am.dataset.name, reason, note });
      if (r && r.ok) { toast('Заявка отмечена как не новая ✓'); $('#task-detail').innerHTML = '<div class="td-empty">Выберите задачу слева.</div>'; loadTasks(); }
      else { toast('Не удалось отметить (нужен телефон или строка формы)'); }
      return;
    }
  });

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
    loadWorkQueue();
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

  // ── Письма без ответа (живой список неотвеченных цепочек Gmail) ───────────
  function emailCard(t) {
    const date = t.date ? new Date(t.date).toLocaleString('ru-RU') : '';
    const files = (t.attachments || []).length
      ? `<div class="reason">📎 Файл: ${t.attachments.map(esc).join(', ')}</div>` : '';
    return `<div class="item" data-thread="${esc(t.thread_id)}">
      <div class="head"><span class="title">✉️ ${esc(t.subject || '(без темы)')}</span><span class="sub">${esc(t.from || '')}${date ? ' · ' + esc(date) : ''}${t.message_count ? ' · сообщений: ' + t.message_count : ''}</span></div>
      <div class="body">${esc(t.text || '(без текста)')}</div>
      ${files}
      <div class="actions"><button class="btn-approve" data-draft-thread="${esc(t.thread_id)}">✍ Подготовить ответ</button></div>
      <div class="email-draft"></div></div>`;
  }
  // «Подготовить ответ» → LLM-черновик по цепочке + БЗ; показываем в редактируемом поле.
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-draft-thread]'); if (!b) return;
    const card = b.closest('.item'); const box = card && $('.email-draft', card);
    b.disabled = true; const old = b.textContent; b.textContent = 'Готовлю…';
    try {
      const r = await postJSON(api(`/emails/${encodeURIComponent(b.dataset.draftThread)}/draft`), {});
      if (r && r.ok) {
        box.innerHTML = `<div class="reason">Черновик ответа (${esc(r.provider || '')}) — проверьте и отправьте из почты:</div>
          <textarea class="draft-edit" rows="8" style="width:100%">${esc(r.draft || '')}</textarea>`;
      } else {
        box.innerHTML = `<div class="empty">Не удалось подготовить${r && r.reason ? ' (' + esc(r.reason) + ')' : ''}.</div>`;
      }
    } catch (_) { box.innerHTML = '<div class="empty">Ошибка запроса.</div>'; }
    finally { b.disabled = false; b.textContent = old; }
  });
  async function loadEmails() {
    const el = $('#emails-list');
    el.innerHTML = '<div class="empty">Загрузка писем…</div>';
    const d = await getJSON(api('/emails-unanswered'));
    if (!d || !d.ok) { el.innerHTML = `<div class="empty">Gmail недоступен${d && d.reason ? ' (' + esc(d.reason) + ')' : ''}.</div>`; return; }
    const th = d.threads || [];
    el.innerHTML = th.length ? th.map(emailCard).join('') : '<div class="empty">Неотвеченных писем нет — на всё ответили. ✅</div>';
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

  // ── Авто-ответы: что агент ответил бы / ответил / отложил (проверка перед включением auto) ──
  let arFilter = 'shadow';
  const AR_KIND_RU = { service_info: 'инфо', pricing_from_kb: 'цены', timelines_from_kb: 'сроки', application_link: 'заявка', application_instructions: 'инструкция', other: 'прочее' };
  const AR_DEC_CLASS = { shadow: 'warn', auto_sent: 'ok', gated: '', skipped: 'muted' };
  async function loadAutoReplies() {
    const d = await getJSON(api('/autoreplies?limit=120')).catch(() => null);
    setDb(d && d.db_connected);
    const modeEl = $('#ar-mode'), filtEl = $('#ar-filters'), listEl = $('#ar-list');
    if (!d || !d.db_connected) { if (listEl) listEl.innerHTML = offline(); return; }
    const modeRu = { off: 'выключен', shadow: 'тень (ничего не отправляет)', auto: 'АВТО-ОТПРАВКА ВКЛЮЧЕНА' }[d.mode] || d.mode;
    modeEl.innerHTML = `Режим авто-ответчика: <b>${esc(modeRu)}</b>. ${d.mode === 'shadow' ? 'Агент только показывает, что <b>ответил бы</b> — ничего не отправляется. Проверьте качество ниже, затем можно включить реальную отправку.' : ''}`;
    const c = d.counts || {};
    const FILT = [['shadow', 'Ответил бы', c.shadow || 0], ['auto_sent', 'Отправлено', c.auto_sent || 0], ['gated', 'Оператору', c.gated || 0], ['', 'Все', (c.shadow || 0) + (c.auto_sent || 0) + (c.gated || 0) + (c.skipped || 0)]];
    filtEl.innerHTML = FILT.map(([id, label, n]) => `<button class="tk-f ${arFilter === id ? 'active' : ''}" data-ar-filter="${id}">${label} <span class="tk-fn">${n}</span></button>`).join('');
    const items = (d.items || []).filter(i => !arFilter || i.decision === arFilter);
    listEl.innerHTML = items.length ? items.map(i => `
      <div class="ar-card td-info" style="margin:8px 0">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
          <span><b>${esc(i.phone || '—')}</b> <span class="tk-tag">${esc(AR_KIND_RU[i.kind] || i.kind)}</span></span>
          <span class="${AR_DEC_CLASS[i.decision] || ''}">${esc(i.decision_ru)}${i.skip_reason ? ' · ' + esc(i.skip_reason) : ''} · ${i.at ? new Date(i.at).toLocaleString('ru-RU') : ''}</span>
        </div>
        <div style="margin-top:6px"><span class="muted">Клиент:</span> ${esc(i.inbound || '')}</div>
        ${i.answer ? `<div style="margin-top:4px"><span class="muted">Агент ответил бы:</span> ${esc(i.answer)}</div>` : '<div style="margin-top:4px" class="muted">(ответа нет — передано оператору)</div>'}
      </div>`).join('')
      : '<div class="empty">Пока нет решений в этой категории.</div>';
  }
  document.addEventListener('click', e => {
    const b = e.target.closest('button[data-ar-filter]'); if (!b) return;
    arFilter = b.dataset.arFilter; loadAutoReplies();
  });

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
    appendMsg('you', question);
    // Задача необязательна: без неё — общий вопрос по работе к ИИ-помощнику.
    const payload = chatItem ? { type: chatItem.type, id: chatItem.id, question } : { question };
    const r = await postJSON(api('/chat'), payload);
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
    loadUserActivity();
  }
  // Счётчик действий по пользователям (кто что сделал и сколько) — для разбора ошибок.
  async function loadUserActivity() {
    const host = $('#users-activity'); if (!host) return;
    const d = await getJSON(api('/user-activity?days=30')).catch(() => null);
    if (!d || !d.users) { host.innerHTML = ''; return; }
    host.innerHTML = `<h3 style="margin:16px 0 6px">Активность за 30 дней — кто что сделал</h3>` +
      (d.users.length ? `<table class="audit"><thead><tr><th>Пользователь</th><th>Всего</th><th>Действия</th><th>Последняя активность</th></tr></thead><tbody>` +
        d.users.map(u => `<tr>
          <td>${esc(u.user)} <span class="role">${u.role === 'administrator' ? 'админ' : (u.role || 'оператор')}</span></td>
          <td><b>${u.total}</b></td>
          <td>${u.breakdown.map(b => `${esc(b.label)}: <b>${b.n}</b>`).join(' · ')}</td>
          <td>${u.last_at ? new Date(u.last_at).toLocaleString('ru-RU') : '—'}</td>
        </tr>`).join('') + '</tbody></table>'
      : '<div class="muted">Пока нет записанных действий.</div>');
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

  // ── Новые номера из заявок (холодный контакт — гейт + шаблон) ───────────
  async function loadFirstContact() {
    const el = $('#fc-list');
    let d; try { d = await getJSON('/api/first-contact'); } catch (_) { el.innerHTML = offline(); return; }
    const ps = d.proposals || [];
    el.innerHTML = ps.length ? ps.map(p => {
      const ev = (p.evidence || []).length ? `<ul class="evidence">${p.evidence.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
      const sent = p.state === 'sent';
      const failed = p.state === 'approved' && p.send_result && p.send_result.ok === false;
      const acts = sent ? '<span class="muted">отправлено ✓</span>'
        : `<button class="btn-approve" data-fc="${esc(p.id)}" data-dec="approve">Подтвердить и отправить</button>
           <button class="btn-reject" data-fc="${esc(p.id)}" data-dec="reject">Отклонить</button>`;
      const isChat = p.source === 'chat_interest';
      const tag = isChat ? `<span class="badge">лид из чата${p.context ? ' · ' + esc(p.context) : ''}</span>` : '';
      const body = isChat
        ? `<div class="body">${esc(p.proposed_text || '')}</div>`
        : `<div class="muted">Шаблон: ${esc(p.template_name || '')}</div>`;
      return `<div class="item">
        <div class="head"><span class="title">${esc(p.client_name || 'Без названия')}</span>${tag}<span class="sub">${esc(p.to_phone || '')}</span></div>
        <div class="reason">${esc(p.reason)}</div>${ev}
        ${body}${failed ? '<div class="muted">⚠ отправка не удалась — проверьте номер/канал</div>' : ''}
        <div class="actions">${acts}</div>
      </div>`;
    }).join('') : '<div class="empty">Новых лидов нет. Сюда попадают номера из заявок и люди, спросившие про сертификаты/декларации в чатах.</div>';
  }
  $('#fc-scan').addEventListener('click', async () => {
    toast('Сканирую заявки…');
    let r; try { r = await postJSON('/api/first-contact/scan', {}); } catch (_) { toast('Ошибка сканирования'); return; }
    toast(`Найдено новых: ${r.generated || 0} (пропущено ${r.skipped || 0})`);
    loadFirstContact();
  });
  document.addEventListener('click', async e => {
    const b = e.target.closest('button[data-fc]'); if (!b) return;
    const r = await postJSON(`/api/first-contact/${b.dataset.fc}/decision`, { decision: b.dataset.dec });
    if (b.dataset.dec === 'approve') toast(r.state === 'sent' ? 'Отправлено клиенту' : 'Не удалось отправить — проверьте шаблон');
    else toast('Отклонено');
    loadFirstContact();
  });

  // ── Статистика операторов (счётчик отправленных ответов) ────────────────
  const INTENT_RU = { payment_made: 'оплата', price_question: 'цена', timeline_question: 'сроки', docs_question: 'документы', service_question: 'услуга', application_help: 'помощь с заявкой', greeting: 'приветствие', unknown: 'прочее' };
  const CAT_RU = { mpstats: 'MPStats', wildbox: 'WildBox', sgr: 'СГР', refusal_letter: 'отказное письмо', certificate: 'сертификат', declaration: 'декларация', unknown: 'прочее' };
  function breakdown(map, dict) {
    const keys = Object.keys(map || {}).sort((a, b) => map[b] - map[a]);
    return keys.length ? keys.map(k => `${esc(dict[k] || k)}: ${map[k]}`).join(', ') : '—';
  }
  async function loadStats() {
    const el = $('#stats-body');
    const from = $('#stats-from').value, to = $('#stats-to').value;
    const qs = []; if (from) qs.push('from=' + from); if (to) qs.push('to=' + to + 'T23:59:59');
    let d; try { d = await getJSON('/api/stats/operators' + (qs.length ? '?' + qs.join('&') : '')); } catch (_) { el.innerHTML = offline(); return; }
    const ops = d.operators || [];
    if (!ops.length) { el.innerHTML = '<div class="empty">Пока нет отправленных ответов за выбранный период.</div>'; return; }
    el.innerHTML = `<table class="audit"><thead><tr><th>Сотрудник</th><th>Ответов</th><th>Типы вопросов</th><th>Темы</th></tr></thead><tbody>` +
      ops.map(o => `<tr><td>${esc(o.display_name)}</td><td><b>${o.total}</b></td><td>${breakdown(o.by_intent, INTENT_RU)}</td><td>${breakdown(o.by_category, CAT_RU)}</td></tr>`).join('') +
      `</tbody></table><div class="muted">Всего ответов: ${(d.totals && d.totals.total) || 0}</div>`;
  }
  $('#stats-apply').addEventListener('click', loadStats);

  // ── инициализация: проверка входа ───────────────────────────────────────
  (async function init() {
    let res;
    try { res = await fetch('/api/auth/me', { cache: 'no-store' }); } catch (_) { location.href = '/app/login.html'; return; }
    if (!res.ok) { location.href = '/app/login.html'; return; }
    me = (await res.json()).user;
    $('#whoami').textContent = `${me.display_name} · ${me.role === 'administrator' ? 'Администратор' : 'Оператор'}`;
    // скрыть админ-элементы для оператора
    if (me.role !== 'administrator') $$('[data-admin="1"]').forEach(el => el.style.display = 'none');
    show('tasks');
  })();
})();
