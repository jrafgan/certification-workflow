# Module: Payment Recognition

- **Status:** built
- **Owner:** —
- **Code:** `backend/src/services/paymentRecognitionService.js` (+ `fileClassifierService.js`)
- **Last updated:** 2026-06-21

---

## 1. Functional Specification
Recognises **payment evidence** from inbound WhatsApp content (text + attachments) and from
OCR'd receipts: amount, intent phrases, and receipt attachments. Surfaces a payment signal
for operator review and feeds the New Order Proposal's payment signal. **Not responsible for**
recording a payment, writing the Declaration, or deciding sufficiency on its own.

## 2. Workflow Description
```
message {body, attachments} → recognizeFromMessage
   → receipt-file? (fileClassifier) + intent phrase? + amount?
   → { has_payment_signal, amount, has_receipt_file, has_intent, confidence }
assessSufficiency(amount, total?) → recommendation (operator confirms)
```

## 3. Business Rules (per operator Master KB v2)
- Minimum payment is always **≥ 10 000 сом**.
- Large orders require **≥ 60%** of the order total.
- Sufficiency is **assessed with reasons**, never auto-decided — `needs_operator_confirmation: true` always.
- Confidence: receipt file OR (intent + amount) → MEDIUM; intent or amount alone → LOW; none → NONE.
- Never records a payment or changes status (output-only).

## 4. Data Model
Pure/stateless at its core (operates on a message object). When wrapped over a stored message
it reads `whatsapp_messages` (read-only). Writes nothing. The payment Review Package itself is
persisted by Document Understanding (`extraction_reviews`, doc_type=receipt).

## 5. API Contract
No dedicated route — consumed by the Lead Conversion Agent (Stage 9), the Draft Package
Generator (payment signal), and surfaced in the Control Center inbox as a payment review.
Core functions: `recognizeFromMessage`, `assessSufficiency`, `toDraftSignal`, `recognizeFromMessageId`.

## 6. Approval
- Approved by: operator (KB v2 payment rules). Date: 2026-06-21.

## 7. Implementation
Pure functions: `parseAmount` (RU currency regex — сом/руб/тенге/usd/eur), `recognizeFromMessage`,
`assessSufficiency` (MIN_PAYMENT=10000, LARGE_ORDER_PERCENT=0.6), `toDraftSignal`. Known caveat
documented in evals: the intent regex can over-fire (e.g. «внести правки» matched `внес`) — handle in review.

## 8. Tests
`npm run test:payment-recognition` (9). Covers amount parsing, intent detection, sufficiency
rules, draft-signal shape. Gap: the «внести» false-positive is known and left to operator review.
