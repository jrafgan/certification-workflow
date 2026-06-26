# Module — WhatsApp Cloud inbound storage + inbox

**Status:** implemented 2026-06-24. Builds on the Cloud API transport
(`services/whatsappCloudService.js`) and the existing ingest/matching pipeline.

## 1. Problem
Inbound WhatsApp Cloud API messages reached the webhook (`POST /webhooks/whatsapp`)
but `handleIncoming` only `console.log`-ged them — nothing was persisted, so operators
could not see client messages and matching never ran. Storage + an operator-visible inbox
were the missing link.

## 2. Design (reuse, don't duplicate)
The storage model (`WhatsAppMessage`), the ingest+match pipeline
(`whatsappIngestService.ingestIncoming` → `whatsappMatchService`), LID resolution, and the
Control Center inbox screen **already existed** (built for the whatsapp-web.js path). This
change only:

1. **Bridges Cloud API → ingest.** A pure mapper `whatsappCloudService.toIngestRaw(parsed)`
   converts a parsed Cloud message `{id,from,type,text,timestamp,media_id,is_voice}` into the
   provider-agnostic raw shape `ingestIncoming` expects
   `{id,from,body,timestamp,provider:'cloud_api',attachments:[{media_ref,mime_type}]}`.
   `handleIncoming` (routes/whatsappCloud.js) calls `ingestIncoming` per message — idempotent
   on `provider_message_id`, resilient per-message (never blocks the 200 ack to Meta).
2. **Provider tag passthrough.** `whatsappIngestService.mapIncomingMessage` now uses
   `raw.provider || 'whatsapp_web'` so Cloud messages are stored as `provider:'cloud_api'`.
3. **Inbox surfacing.** `controlCenterService.inbox()` additionally loads recent inbound
   `WhatsAppMessage`s and renders them as `type:'whatsapp_message'` cards merged into the
   unified feed (newest first). Message cards carry **no decide actions** (a message is not a
   gated decision); if matched to an order they expose `order_id` → "Открыть заказ"/"Таймлайн".

## 3. Invariants kept
- **Read-only toward the world.** Ingest only writes the `whatsapp_messages` replica; it never
  sends, never writes the Declaration sheet, never auto-acts. Recommendation mode intact.
- **Idempotent.** Meta retries on non-200 and can duplicate; the unique `provider_message_id`
  index + ingest's pre-check dedupe.
- **Signature still enforced** upstream in the POST handler (`verifySignature` via APP_SECRET);
  bad signatures 401 before reaching ingest.

## 4. Out of scope (future)
- Sender display name is not stored (schema has no name field) — cards show phone/LID.
- Media binaries are not downloaded (attachment metadata/`media_ref` only).
- A dedicated "Messages" screen (currently merged into the existing inbox).
- Operator reply from the message card (send path exists at `POST /api/whatsapp/send`).

## 5. Tests
`tests/whatsapp-cloud-inbox.test.js` — pure units: `toIngestRaw` mapping (text + media +
timestamp) and `mapIncomingMessage` provider passthrough. DB-touching ingest is covered by the
existing ingest/match tests.
