'use strict';

// services/emailFollowupService.js — НЕОТВЕЧЕННЫЕ ПИСЬМА для админки.
//
// Находит цепочки Gmail, где ПОСЛЕДНЕЕ сообщение пришло НЕ от нас (мы так и не ответили),
// и отдаёт их в панель. Живой read-only расчёт: пока не ответили — письмо в списке; ответил
// оператор (последнее сообщение стало нашим) — оно само исчезает из списка. Ничего не шлёт.
//
// По каждому письму отдаём: Тему, текст и вложение (файл) ПОСЛЕДНЕГО сообщения — как просил
// оператор.

const MAX_BODY = 2000;

// Автоматические/рекламные отправители — это НЕ письма, на которые отвечают. Отсекаем их,
// чтобы в списке были только реальные переписки (лаборатории, клиенты, партнёры).
const NOISE_SENDER = /noreply|no-reply|donotreply|do-not-reply|notification|notifications|mailer-daemon|postmaster|unread-messages|security@|@mail\.instagram|@facebookmail|@bounce|newsletter|@e\.|@email\.|@mailer\./i;

// Сообщения треда по возрастанию времени → последнее = самое свежее.
function sortedMessages(thread) {
  const msgs = Array.isArray(thread && thread.messages) ? thread.messages.slice() : [];
  return msgs.sort((a, b) => Number(a.internalDate || 0) - Number(b.internalDate || 0));
}
function sameMailbox(from, operatorEmail) {
  const f = String(from || '').toLowerCase();
  const op = String(operatorEmail || '').toLowerCase();
  return !!op && f.includes(op);
}

// unanswered({ limit, days }, deps) → { ok, count, threads:[...] } | { ok:false, reason }
async function unanswered(opts = {}, deps = {}) {
  const gmail = deps.gmailClient || require('../integrations/gmailClient');
  const limit = Number.isFinite(opts.limit) ? opts.limit : 30;
  const days = Number.isFinite(opts.days) ? opts.days : 180;

  let operatorEmail;
  try { operatorEmail = await gmail.getOperatorEmail(); }
  catch (e) { return { ok: false, reason: 'gmail_unavailable', detail: e.message }; }

  let candidates;
  // Только реальная переписка: исключаем промо/соц/уведомления Gmail-категориями.
  const q = `in:inbox -category:promotions -category:social -category:updates -category:forums newer_than:${days}d`;
  try { candidates = await gmail.searchThreads(q, Math.min(limit * 3, 50)); }
  catch (e) { return { ok: false, reason: 'gmail_search_failed', detail: e.message }; }
  if (!Array.isArray(candidates) || !candidates.length) return { ok: true, count: 0, threads: [] };

  const threads = [];
  for (const c of candidates) {
    if (threads.length >= limit) break;
    let full;
    try { full = await gmail.getThread(c.threadId, 'full'); }
    catch (_) { continue; } // пропускаем сбойные треды, не роняем весь список
    const msgs = sortedMessages(full);
    if (!msgs.length) continue;
    const last = msgs[msgs.length - 1];
    const headers = (last.payload && last.payload.headers) || [];
    const from = gmail.extractHeader(headers, 'From') || '';

    // Ответили = последнее сообщение отправили МЫ. Тогда письмо НЕ показываем.
    if (sameMailbox(from, operatorEmail)) continue;
    // Автоматические/рекламные отправители — не письма для ответа.
    if (NOISE_SENDER.test(from)) continue;

    const subject = gmail.extractHeader(headers, 'Subject') || c.subject || '(без темы)';
    const body = String(gmail.getMessageBody(last) || '').trim().slice(0, MAX_BODY);
    const attachments = gmail.getAttachmentFilenames(last) || [];
    threads.push({
      thread_id: full.id,
      subject,
      from,
      date: last.internalDate ? new Date(Number(last.internalDate)) : null,
      text: body,
      attachments,
      message_count: msgs.length,
    });
  }

  threads.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  return { ok: true, count: threads.length, threads };
}

module.exports = { unanswered };
