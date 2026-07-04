# Runbook — временный WhatsApp-канал на 507391773 через whatsapp-web.js

**Зачем:** запустить WhatsApp-агента на **507391773** прямо сейчас, **без официального Cloud
API**, пока 508391773 проходит верификацию в Meta/FB. Это **временный мост** на неофициальной
библиотеке `whatsapp-web.js` (вход по QR, как «Связанные устройства» в WhatsApp).

⚠️ **РИСК БАНА.** whatsapp-web.js нарушает правила WhatsApp; Meta может **забанить 507391773**.
Это основной номер — решение осознанное. Как только заработает Cloud API на 508391773, этот
канал отключаем.

---

## Что уже готово в коде (этой сессии)
- `backend/src/integrations/whatsappWebClient.js` — клиент: QR-логин, приём сообщений/вложений,
  `sendText` (для ответов из панели). **Никогда не помечает прочитанным** (инвариант unread
  сохранён, проверено `whatsapp-readstate-guard`).
- `backend/src/wa-web-server.js` — отдельный процесс: входящие → `whatsappIngestService.
  ingestIncoming` (инбокс панели + сопоставление с заказом) + внутренний `POST /send` для панели.
- `routes/whatsappSend.js` — если задан `WHATSAPP_WEB_SEND_URL`, ответы оператора идут через этот
  мост; иначе — Cloud API. Атрибуция оператора (счётчик) работает в обоих случаях.
- `deploy/Dockerfile.whatsapp` (Chromium) + сервис `wa-web` в `docker-compose.yml`
  (профиль `waweb`, тома `wa_auth`/`wa_media`), зависимости `whatsapp-web.js`+`qrcode-terminal`.

## ПРЕДУСЛОВИЕ (делает оператор) — без него QR не отсканировать
507391773 сейчас на Cloud API → в приложении его нет. Поэтому:
1. В Meta (WhatsApp Manager → Dokumenty.pro) **отвязать/удалить номер 507391773** из Cloud API.
2. Поставить 507391773 в обычный **WhatsApp** (или WhatsApp Business) на телефоне (придёт SMS-код).
3. Убедиться, что с номера можно зайти в **Настройки → Связанные устройства** (для скана QR).

## Запуск (делает разработчик/агент по SSH)
1. В `/opt/certification-workflow/.env` добавить:
   ```
   WHATSAPP_WEB_SEND_URL=http://wa-web:3100/send
   ```
2. Собрать и поднять мост (профиль `waweb`):
   ```
   cd /opt/certification-workflow
   docker compose --profile waweb build wa-web
   docker compose --profile waweb up -d wa-web
   docker compose up -d backend      # перечитать WHATSAPP_WEB_SEND_URL
   ```
3. Показать QR из логов и **отсканировать его с телефона 507391773**:
   ```
   docker compose logs -f wa-web        # ищем "event":"qr" + сам QR-код
   ```
   После скана — событие `authenticated` → `ready`. Сессия сохраняется в томе `wa_auth`
   (повторный скан при рестартах не нужен).

## Проверка end-to-end
1. С другого телефона написать на **507391773** → сообщение появляется в **инбоксе панели**
   (Центр управления), агент готовит черновик.
2. Оператор отвечает из панели → ответ уходит клиенту через мост (через `wa-web`).
3. `docker compose exec -T backend node -e 'fetch("http://wa-web:3100/status").then(r=>r.json()).then(console.log)'`
   → `{ready:true, channel:"whatsapp_web"}`.

## Откат / переход на Cloud API (когда 508391773 заработает)
1. Убрать `WHATSAPP_WEB_SEND_URL` из `.env` (или оставить пустым) → панель снова шлёт через Cloud API.
2. `docker compose --profile waweb down` (остановить мост). Тома `wa_auth`/`wa_media` можно удалить.
3. Прописать Cloud API под 508391773 (см. `CONNECT_WHATSAPP_NUMBER_508391773.md`).

## Если что-то не так
- QR не появляется: `docker compose logs wa-web` — ищи ошибки Chromium; проверь, что контейнер
  собрался (Chromium ставится в образ).
- `auth_failure` / просит скан снова: удали том `wa_auth` и повтори (`docker volume rm`…).
- Ответы из панели не уходят: проверь `WHATSAPP_WEB_SEND_URL` в env backend и `/status` моста.
- Хост **не должен быть в РФ** (Meta/WhatsApp блокируют RU-хосты) — у нас Hetzner Helsinki, ок.
