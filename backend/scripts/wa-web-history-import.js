#!/usr/bin/env node
'use strict';

// scripts/wa-web-history-import.js — РАЗОВЫЙ импорт СТАРОЙ переписки WhatsApp через
// веб-версию (whatsapp-web.js) в архив whatsapp_messages, чтобы старое искалось в панели
// так же, как новое (/api/control-center/wa-search).
//
// ЗАЧЕМ: GOWA пишет только новые сообщения (с ~30 июня). Историю до этого веб-версия
// отдаёт (подгружает при прокрутке). Этот скрипт линкуется как ОТДЕЛЬНОЕ устройство
// (сканируешь QR — GOWA не отвалится, multi-device), проходит по чатам, тянет историю
// и складывает в Mongo с дедупом по provider_message_id.
//
// ⚠️ ЗАПУСКАТЬ ЛОКАЛЬНО (нужен Chromium/QR), НЕ в контейнере на VPS.
// ⚠️ Read-only для WhatsApp: только читает историю, ничего не отправляет и не помечает
//    прочитанным (fetchMessages не шлёт read-receipt).
//
// Установка (один раз):   npm i whatsapp-web.js qrcode-terminal
// Запуск:                 node -r dotenv/config scripts/wa-web-history-import.js [флаги]
//   --limit=500           сколько последних сообщений тянуть на чат (по умолч. 500)
//   --since=2026-01-01    импортировать только сообщения новее этой даты
//   --chat=996555         только чаты, где id/имя содержит подстроку (напр. номер)
//   --dry                 показать, что было бы импортировано, ничего не писать
//
// MONGODB_URI берётся из .env (тот же архив, что читает панель).

require('dotenv').config();
const mongoose = require('mongoose');
const { WhatsAppMessage } = require('../src/models/WhatsAppMessage');

// whatsapp-web.js — тяжёлая опциональная зависимость (тянет puppeteer/Chromium). Не в
// package.json проекта: ставится вручную только для этого разового импорта.
let Client, LocalAuth, qrcode;
try {
  ({ Client, LocalAuth } = require('whatsapp-web.js'));
  qrcode = require('qrcode-terminal');
} catch (e) {
  console.error('[wa-import] Нет зависимостей. Установите один раз:\n  npm i whatsapp-web.js qrcode-terminal');
  process.exit(1);
}

const args = process.argv.slice(2);
const flag = (name, def = null) => {
  const a = args.find(x => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : (args.includes(`--${name}`) ? true : def);
};
const LIMIT = Math.max(1, parseInt(flag('limit', '500'), 10) || 500);
const DRY   = !!flag('dry', false);
const CHAT_FILTER = flag('chat', null);
const SINCE = (() => { const s = flag('since', null); const d = s ? new Date(s) : null; return d && !isNaN(d) ? d : null; })();

// Канонический ключ телефона = последние 9 цифр (как phoneUtils.matchKey в проекте).
function matchKey(jidOrPhone) {
  const digits = String(jidOrPhone || '').replace(/\D/g, '');
  return digits ? digits.slice(-9) : '';
}
function phoneOf(jid) { const d = String(jid || '').replace(/\D/g, ''); return d || ''; }

function toDoc(msg, chat) {
  const isGroup = !!(chat && chat.isGroup);
  const fromMe  = !!msg.fromMe;
  const fromJid = fromMe ? (msg.to || (chat && chat.id && chat.id._serialized)) : msg.from;
  const toJid   = fromMe ? (msg.to || (chat && chat.id && chat.id._serialized)) : msg.to;
  const counterparty = isGroup ? (msg.author || msg.from) : (fromMe ? msg.to : msg.from);
  const sentAt = msg.timestamp ? new Date(msg.timestamp * 1000) : undefined;
  return {
    provider_message_id: msg.id && msg.id._serialized,
    provider: 'import',                              // отличает исторический импорт от cloud_api/gowa
    conversation_ref: chat && chat.id && chat.id._serialized,
    direction: fromMe ? 'outbound' : 'inbound',
    from_phone: phoneOf(fromJid),
    to_phone:   phoneOf(toJid),
    phone_key:  matchKey(counterparty),              // ключ = собеседник (не оператор)
    body: msg.body || '',
    attachments: msg.hasMedia ? [{ mime_type: msg.type, file_name: (msg._data && msg._data.filename) || undefined }] : [],
    sent_at: sentAt,
    chat_id: chat && chat.id && chat.id._serialized,
    is_group: isGroup,
    group_subject: isGroup ? (chat.name || undefined) : undefined,
    addressed_me: !isGroup,                           // прямой чат = адресовано; группы фильтруются отдельно
    addressed_reason: isGroup ? null : 'direct',
    match_status: 'received',                         // матчинг заказа — отдельным проходом
    received_at: sentAt || new Date(),
  };
}

(async () => {
  if (!process.env.MONGODB_URI) { console.error('[wa-import] MONGODB_URI не задан.'); process.exit(1); }
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  console.log(`[wa-import] Mongo OK. limit=${LIMIT}/чат${SINCE ? `, since=${SINCE.toISOString().slice(0,10)}` : ''}${CHAT_FILTER ? `, chat~"${CHAT_FILTER}"` : ''}${DRY ? ' [DRY-RUN]' : ''}`);

  const client = new Client({
    // dataPath = том wa_auth в контейнере wa-web (WHATSAPP_SESSION_PATH). Отдельный clientId,
    // чтобы не пересекаться с сессией боевого моста. Сессия переживает `compose run --rm` →
    // QR сканируется один раз, повтор/обрыв импорта не требует нового скана.
    authStrategy: new LocalAuth({ clientId: 'history-import', dataPath: process.env.WHATSAPP_SESSION_PATH || undefined }),
    puppeteer: {
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,   // distro Chromium в образе
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  });

  client.on('qr', (qr) => {
    console.log('\n[wa-import] Отсканируйте QR в WhatsApp → Связанные устройства:\n');
    qrcode.generate(qr, { small: true });
  });
  client.on('auth_failure', (m) => { console.error('[wa-import] auth_failure:', m); });

  client.on('ready', async () => {
    try {
      let chats = await client.getChats();
      if (CHAT_FILTER) chats = chats.filter(c => `${c.id && c.id._serialized} ${c.name || ''}`.includes(CHAT_FILTER));
      console.log(`[wa-import] Чатов к обработке: ${chats.length}`);

      let inserted = 0, skipped = 0, scanned = 0;
      for (const chat of chats) {
        let msgs = [];
        try { msgs = await chat.fetchMessages({ limit: LIMIT }); }
        catch (e) { console.warn(`  ! ${chat.name || chat.id._serialized}: ${e.message}`); continue; }
        for (const msg of msgs) {
          scanned++;
          const sentAt = msg.timestamp ? new Date(msg.timestamp * 1000) : null;
          if (SINCE && sentAt && sentAt < SINCE) continue;
          const doc = toDoc(msg, chat);
          if (!doc.provider_message_id) continue;
          if (DRY) { inserted++; continue; }
          try {
            const r = await WhatsAppMessage.updateOne(
              { provider_message_id: doc.provider_message_id },
              { $setOnInsert: doc },
              { upsert: true },
            );
            if (r.upsertedCount) inserted++; else skipped++;
          } catch (e) {
            if (e && (e.code === 11000)) skipped++; else console.warn('  ! upsert:', e.message);
          }
        }
        console.log(`  · ${chat.name || chat.id._serialized}: +${inserted} / ~${skipped} (просмотрено ${scanned})`);
      }
      console.log(`\n[wa-import] ГОТОВО. Импортировано новых: ${inserted}, пропущено (дубли): ${skipped}, просмотрено: ${scanned}.`);
      if (DRY) console.log('[wa-import] Это был DRY-RUN — в базу ничего не записано.');
    } catch (e) {
      console.error('[wa-import] Ошибка обхода чатов:', e.message);
    } finally {
      await client.destroy().catch(() => {});
      await mongoose.disconnect().catch(() => {});
      process.exit(0);
    }
  });

  await client.initialize();
})().catch(err => { console.error('[wa-import] fatal:', err.message); process.exit(1); });
