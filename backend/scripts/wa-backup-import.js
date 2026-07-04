#!/usr/bin/env node
'use strict';

// scripts/wa-backup-import.js — импорт ПОЛНОЙ истории WhatsApp из бэкапа Google Drive
// в архив whatsapp_messages (тот же, что читает панель /wa-search). Даёт агенту всю
// историю для разбора спорных моментов.
//
// ЭТО ФИНАЛЬНЫЙ ШАГ. Перед ним бэкап нужно РАСШИФРОВАТЬ (он лежит зашифрованным):
//
//   1) С телефона достать два файла:
//        • msgstore.db.crypt15  (Google Drive / внутренняя память WhatsApp → Databases)
//        • ключ шифрования: 64-hex ключ (файл /data/data/com.whatsapp/files/key на
//          рутованном телефоне) ИЛИ 64-значный ключ end-to-end бэкапа из WhatsApp →
//          Настройки → Чаты → Резервная копия → Сквозное шифрование → показать ключ.
//   2) Расшифровать проверенным инструментом wa-crypt-tools (НЕ пишем свою крипту):
//        pip install wa-crypt-tools
//        wadecrypt <key|hex> msgstore.db.crypt15 msgstore.db
//   3) Натравить ЭТОТ скрипт на расшифрованный msgstore.db:
//        npm i better-sqlite3
//        node -r dotenv/config scripts/wa-backup-import.js --db=./msgstore.db [--dry] [--since=2025-01-01]
//
// Флаги: --db=<путь> (обязательно), --dry (без записи), --since=YYYY-MM-DD, --me=<мой номер>
// (мой номер помогает корректно проставить from/to; иначе берётся из from_me).
//
// Read-only для WhatsApp: работает с локальным файлом БД, к телефону/сети не ходит.
// Дедуп по provider_message_id — можно гонять повторно.

require('dotenv').config();
const path = require('path');
const mongoose = require('mongoose');
const { WhatsAppMessage } = require('../src/models/WhatsAppMessage');

let Database;
try { Database = require('better-sqlite3'); }
catch (e) { console.error('[wa-backup] Нет зависимости. Установите:  npm i better-sqlite3'); process.exit(1); }

const args = process.argv.slice(2);
const flag = (n, d = null) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.split('=').slice(1).join('=') : (args.includes(`--${n}`) ? true : d); };
const DB_PATH = flag('db', null);
const DRY = !!flag('dry', false);
const MY = String(flag('me', '') || '').replace(/\D/g, '');
const SINCE = (() => { const s = flag('since', null); const d = s ? new Date(s) : null; return d && !isNaN(d) ? d.getTime() : null; })();

function matchKey(v) { const d = String(v || '').replace(/\D/g, ''); return d ? d.slice(-9) : ''; }
function jidPhone(raw) { const s = String(raw || ''); if (/@g\.us/.test(s)) return ''; return (s.split('@')[0] || '').replace(/\D/g, ''); }
function isGroupJid(raw) { return /@g\.us/.test(String(raw || '')); }

// WhatsApp меняет схему msgstore между версиями. Поддерживаем обе:
//   • НОВАЯ: таблицы message + chat + jid (message.chat_row_id → chat.jid_row_id → jid.raw_string)
//   • СТАРАЯ: таблица messages (key_remote_jid, key_from_me, data, timestamp)
function detectSchema(db) {
  const has = (t) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
  if (has('message') && has('jid')) return 'new';
  if (has('messages')) return 'old';
  return null;
}

function* rowsNew(db) {
  // group subject: chat.subject (новые схемы) — берём мягко через LEFT JOIN, если колонки нет.
  const hasSubject = !!db.prepare("SELECT 1 FROM pragma_table_info('chat') WHERE name='subject'").get();
  const subjectSel = hasSubject ? 'c.subject AS group_subject' : 'NULL AS group_subject';
  const sql = `
    SELECT m._id AS id, m.from_me AS from_me, m.timestamp AS ts, m.text_data AS body,
           j.raw_string AS chat_jid, ${subjectSel},
           sj.raw_string AS sender_jid
    FROM message m
    JOIN chat c ON c._id = m.chat_row_id
    JOIN jid  j ON j._id = c.jid_row_id
    LEFT JOIN jid sj ON sj._id = m.sender_jid_row_id
    WHERE m.timestamp IS NOT NULL`;
  for (const r of db.prepare(sql).iterate()) yield r;
}
function* rowsOld(db) {
  const sql = `
    SELECT _id AS id, key_from_me AS from_me, timestamp AS ts, data AS body,
           key_remote_jid AS chat_jid, NULL AS group_subject, remote_resource AS sender_jid
    FROM messages WHERE timestamp IS NOT NULL`;
  for (const r of db.prepare(sql).iterate()) yield r;
}

function toDoc(r) {
  const isGroup = isGroupJid(r.chat_jid);
  const fromMe = !!r.from_me;
  const counterpartyJid = isGroup ? (r.sender_jid || r.chat_jid) : r.chat_jid;
  const sentAt = r.ts ? new Date(Number(r.ts)) : undefined;    // msgstore timestamps — миллисекунды
  const myPhone = MY || '';
  return {
    provider_message_id: `import:${r.chat_jid}:${r.id}`,        // стабильный ключ дедупа
    provider: 'import',
    conversation_ref: r.chat_jid,
    direction: fromMe ? 'outbound' : 'inbound',
    from_phone: fromMe ? myPhone : jidPhone(counterpartyJid),
    to_phone:   fromMe ? jidPhone(r.chat_jid) : myPhone,
    phone_key:  matchKey(counterpartyJid),
    body: r.body || '',
    sent_at: sentAt,
    chat_id: r.chat_jid,
    is_group: isGroup,
    group_subject: isGroup ? (r.group_subject || undefined) : undefined,
    addressed_me: !isGroup,
    addressed_reason: isGroup ? null : 'direct',
    match_status: 'received',
    received_at: sentAt || new Date(),
  };
}

(async () => {
  if (!DB_PATH) { console.error('[wa-backup] Укажите --db=<путь к расшифрованному msgstore.db>'); process.exit(1); }
  if (!process.env.MONGODB_URI) { console.error('[wa-backup] MONGODB_URI не задан.'); process.exit(1); }

  let db;
  try { db = new Database(path.resolve(DB_PATH), { readonly: true, fileMustExist: true }); }
  catch (e) { console.error('[wa-backup] Не открыть БД:', e.message, '\n(файл ещё зашифрован? сначала wadecrypt)'); process.exit(1); }

  const schema = detectSchema(db);
  if (!schema) { console.error('[wa-backup] Неизвестная схема msgstore (нет message/messages). Пришли мне список таблиц — доработаю.'); process.exit(1); }
  console.log(`[wa-backup] Схема: ${schema}${MY ? `, мой номер ...${MY.slice(-4)}` : ''}${SINCE ? `, since=${new Date(SINCE).toISOString().slice(0,10)}` : ''}${DRY ? ' [DRY-RUN]' : ''}`);

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });

  const iter = schema === 'new' ? rowsNew(db) : rowsOld(db);
  let inserted = 0, skipped = 0, scanned = 0;
  for (const r of iter) {
    scanned++;
    if (SINCE && r.ts && Number(r.ts) < SINCE) continue;
    if (!r.body && !r.chat_jid) continue;                        // пустые системные строки
    const doc = toDoc(r);
    if (DRY) { inserted++; if (scanned <= 3) console.log('  пример:', JSON.stringify({ dir: doc.direction, key: doc.phone_key, at: doc.sent_at, body: (doc.body || '').slice(0, 40) })); continue; }
    try {
      const res = await WhatsAppMessage.updateOne({ provider_message_id: doc.provider_message_id }, { $setOnInsert: doc }, { upsert: true });
      if (res.upsertedCount) inserted++; else skipped++;
    } catch (e) { if (e && e.code === 11000) skipped++; else console.warn('  ! upsert:', e.message); }
    if (scanned % 2000 === 0) console.log(`  … просмотрено ${scanned}, импортировано ${inserted}`);
  }

  console.log(`\n[wa-backup] ГОТОВО. Просмотрено ${scanned}, импортировано новых ${inserted}, пропущено (дубли) ${skipped}.`);
  if (DRY) console.log('[wa-backup] DRY-RUN — в базу ничего не записано.');
  db.close();
  await mongoose.disconnect().catch(() => {});
  process.exit(0);
})().catch(err => { console.error('[wa-backup] fatal:', err.message); process.exit(1); });
