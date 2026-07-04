# Runbook — подключение Telegram-бота (социальный агент)

**Цель:** включить Telegram как живой канал для Lead Conversion Agent. Telegram **не зависит
от Meta** — не нужна верификация бизнеса, App Review или платёжка. Достаточно токена от
@BotFather. Поэтому его можно запустить, пока Meta-верификация (WhatsApp/IG/FB) ещё идёт.

**Что уже готово в коде:** транспорт `integrations/telegramClient.js`, адаптер доставки
`RealAdapter` (`integrations/platformAdapter.js`), вебхук `POST /webhooks/telegram`. Агент
**сам не отправляет** — он предлагает черновики, оператор одобряет и нажимает «отправить»
(release), и только тогда сообщение уходит через бота.

---

## Шаг 1 — создать бота (выполняет оператор, ~2 минуты)

1. В Telegram открыть **@BotFather** → команда **/newbot**.
2. Задать имя бота и username (должен заканчиваться на `bot`, напр. `dokumenty_pro_bot`).
3. BotFather пришлёт **токен** вида `123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxx` — это секрет,
   никому не пересылать (в т.ч. не вставлять в чат).
4. (Опц.) Настроить профиль: `/setdescription`, `/setuserpic`, `/setabouttext`.

> Важно: один бот = один токен. Если бот уже есть — возьмите его токен через
> @BotFather → **/mybots → выбрать бота → API Token**.

## Шаг 2 — прописать env на сервере (выполняет разработчик)

VPS Hetzner `157.180.38.103`, домен `dokumenty.win`. В env backend:

```
TELEGRAM_BOT_TOKEN=<токен от BotFather>
TELEGRAM_WEBHOOK_SECRET=<любая случайная строка, напр. 32 hex-символа>
```

Передеплой: `docker compose build backend && docker compose up -d backend`.

## Шаг 3 — зарегистрировать вебхук у Telegram (один раз)

Telegram должен знать, куда слать входящие. Выполнить ОДИН раз (с сервера или откуда угодно,
подставив токен и секрет):

```
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://dokumenty.win/webhooks/telegram","secret_token":"<TELEGRAM_WEBHOOK_SECRET>","allowed_updates":["message","edited_message"]}'
```

Ответ `{"ok":true,...}` = вебхук установлен. Проверить можно
`https://api.telegram.org/bot<TOKEN>/getWebhookInfo` (должен показать наш URL и
`pending_update_count`).

> В коде есть и хелпер `telegramClient.setWebhook(url)` — он подставит секрет из env, если
> предпочитаете звать из Node.

## Шаг 4 — проверка end-to-end

1. Написать боту в Telegram любое сообщение (напр. «сколько стоит сертификат?»).
2. В панели (Центр управления) у социального агента появится **лид** + **черновики**
   (приветствие/обучение) — агент классифицирует язык/намерение и предлагает текст.
3. Оператор открывает черновик → **Одобрить** → **Отправить (release)** → бот отправляет
   ответ клиенту в Telegram. До этого момента ничего не уходит.

---

## Безопасность и поведение

- Вебхук защищён секрет-токеном (заголовок `X-Telegram-Bot-Api-Secret-Token`); чужой POST
  без верного секрета отклоняется (401).
- Агент **никогда не отправляет автономно** — каждый исходящий проходит одобрение оператора
  (правило системы, recommendation mode).
- Instagram и Facebook Messenger используют тот же `RealAdapter`, но включатся только после
  прохождения верификации Meta + App Review (см. отдельный runbook по WhatsApp/Meta). Сейчас
  для IG/FB адаптер безопасно падает в заглушку (ничего не шлёт).

## Если что-то не работает

- `getWebhookInfo` показывает `last_error_message` — URL недоступен/не HTTPS, или секрет не
  совпадает. Сверьте `TELEGRAM_WEBHOOK_SECRET` в env и в `setWebhook`.
- Лиды не появляются: проверьте, что backend передеплоен с `TELEGRAM_BOT_TOKEN`, и что
  `setWebhook` вернул `ok:true`.
- Бот не отправляет ответ: токен не задан/неверен, либо пользователь не начинал диалог с ботом
  (в Telegram бот не может написать первым тому, кто ему ни разу не писал — это политика
  Telegram, аналог 24-часового окна).
