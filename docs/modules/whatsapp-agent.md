# Module: WhatsApp Agent

> **⚠️ SUPERSEDED (2026-06-29).** The `whatsapp-web.js` transport described below was
> **removed**. The live channel is the **Meta WhatsApp Cloud API** on the working number
> **507391773** — see [whatsapp-cloud-inbox.md](./whatsapp-cloud-inbox.md). The old
> `TEST_MODE` / `WHATSAPP_TEST_CONTACT` sandbox (test contact «Мой Билайн») no longer
> exists. The ingest/matching/LID services below are still in use; the transport is not.

- **Status:** superseded (transport removed; ingest/matching live via Cloud API)
- **Owner:** —
- **Code:** `services/whatsappCloudService.js`, `routes/whatsappCloud.js`, `services/whatsappIngestService.js`, `whatsappMatchService.js`, `whatsappLidService.js`
- **Last updated:** 2026-06-29

---

## 1. Functional Specification
Connects to the Dokumenty.pro WhatsApp Business number via `whatsapp-web.js` (headless
Chromium) and **ingests inbound messages + attachments** into MongoDB, running phone→order
matching on each. **Receive-only**: it NEVER sends, NEVER modifies the Declaration, NEVER
touches Gmail, and NEVER marks chats read or alters unread counters.

## 2. Workflow Description
```
startClient (LocalAuth session persisted) → on first run prints QR → scan once
  → on inbound message: ingest → store whatsapp_messages → phone→order match
  → feed payment/file signals to recognition + review modules (all output-only)
```

## 3. Business Rules
- **TEST_MODE**: when on, only `WHATSAPP_TEST_CONTACT` (default «Мой Билайн») is actively
  processed; every other contact is **observe-only** (logged, no actions).
- CRITICAL: never mark chats read / change unread counters; `markOnlineOnConnect:false`.
- Client channel for the business = WhatsApp (phone = WhatsApp; partial match). Email never reaches clients.
- LID↔phone resolution handles WhatsApp's privacy IDs (see `whatsappLidService`).

## 4. Data Model
`whatsapp_messages` (model `WhatsAppMessage`): direction, body, attachments, contact/phone, match
status, timestamps. `lid_mappings` (LID↔phone). Session persisted on disk (`WHATSAPP_SESSION_PATH`,
LocalAuth) — a volume in production. Media written to `WHATSAPP_MEDIA_DIR`.

## 5. API Contract
Runs as a **separate process/container** (`scripts/whatsapp-listen.js`), not an HTTP route.
Env: `MONGODB_URI`, `WHATSAPP_SESSION_PATH`, `WHATSAPP_MEDIA_DIR`, `PUPPETEER_EXECUTABLE_PATH`
(distro Chromium in containers), `TEST_MODE`, `WHATSAPP_TEST_CONTACT`.

## 6. Approval
- Approved by: operator (live-testing rules). Date: 2026-06-21. Condition: stay receive-only;
  keep TEST_MODE until verified on the live number.

## 7. Implementation
`whatsappWebClient.startClient` (puppeteer headless, `--no-sandbox --disable-setuid-sandbox
--disable-dev-shm-usage`, honours `PUPPETEER_EXECUTABLE_PATH`). Deployed via
`deploy/Dockerfile.whatsapp` with distro Chromium; session in the `wa_auth` volume. Single
instance (one business number).

## 8. Tests
`npm run test:whatsapp`, `test:whatsapp-ingest`, `test:whatsapp-lookup`, `test:whatsapp-application`,
`test:whatsapp-test-mode`, `test:whatsapp-lid`, `test:whatsapp-lid-resolution`. Gap: no real stored
corpus in the dev DB — conversation-level understanding is limited (see Lead Conversion Agent intent model).
