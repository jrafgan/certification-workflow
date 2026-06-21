# Module: Document Understanding (OCR)

- **Status:** built
- **Owner:** —
- **Code:** `backend/src/services/documentUnderstandingService.js`, `extractionReviewService.js`, `fileClassifierService.js`; `models/ExtractionReview.js`; `routes/extractionReviews.js`
- **Last updated:** 2026-06-21

---

## 1. Functional Specification
Reads the actual contents of a received document (payment receipt, IP/OsOO registration,
declaration, certificate, scanned doc, WhatsApp photo) and extracts structured fields for
operator review. **Not responsible for** deciding anything, writing the Declaration, or
sending messages — it only reads and proposes. Every extraction yields a **Review Package**.

## 2. Workflow Description
```
file (image/pdf) → extractText → extractFields → infer doc_type → relevant-field subset
                 → ExtractionReview (pending) → operator approves/rejects (+ optional corrections)
```
- PDFs → poppler `pdftotext`; images & scanned PDFs → `tesseract -l rus+eng`.
- `inferDocType` classifies receipt / registration / declaration / certificate from content.
- The Review Package surfaces only the fields relevant to the inferred type and scores confidence.

## 3. Business Rules
- OCR quality prioritised: system tesseract with **rus+eng** language packs (not a JS lib).
- Extracted values are **candidates**; nothing is written to the Declaration/sheet/Gmail/WhatsApp.
- `approve` records operator-confirmed values (with optional corrections) and still propagates nothing.
- Relevant fields by type: receipt = amount/date/time/payer/recipient; registration =
  legal entity/INN/registration id; declaration & certificate = doc number/issue date/expiry date/applicant.
- Confidence = share of expected fields detected (HIGH ≥ 80, MEDIUM ≥ 50, else LOW).

## 4. Data Model
`extraction_reviews` (model `ExtractionReview`): doc_type, method, reason, evidence[{field,value,raw,confidence}],
extracted_fields, confidence(+band), expected_fields, missing[], text_excerpt, source{file_name,media_ref,mime_type,origin,message_id},
dedupe_key (unique, one review per source), status (pending|approved|rejected|superseded), confirmed_fields, corrections.
Writes only this collection.

## 5. API Contract
- `GET  /api/extraction-reviews` — pending reviews (auth required).
- `POST /api/extraction-reviews` — `{ file:{file_name,media_ref,mime_type}, origin?, messageId? }` → creates a pending review.
- `POST /api/extraction-reviews/:id/decision` — `{ decision: approve|reject, corrections?, decidedBy? }`.

## 6. Approval
- Approved by: operator (Option B — system tesseract for quality). Date: 2026-06-21.

## 7. Implementation
`documentUnderstandingService`: `extractText` (engine routing + injectable `pdfText`/`ocr` seams),
`extractFields` (pure RU regex extraction; note: `\b` is ASCII-only — Cyrillic uses explicit
boundaries), `inferDocType`, `FIELDS_BY_DOC_TYPE`. `extractionReviewService`: pure `buildReviewPackage`
+ DB `createFromFile`/`listPending`/`decide`. OCR engine: tesseract-ocr + rus + eng + poppler-utils (in the backend image).

## 8. Tests
`npm run test:document-understanding` (11 — extraction + routing + real pdftotext round-trip) and
`npm run test:extraction-review` (7 — review package build/score). Verified end-to-end on a real
rendered receipt image. Gap: no automated test against many real-world scan qualities.
