# Module: Mockup Agent (MVP)

Generates DRAFT Declaration (ДС) and Certificate (СС) documents from Google-Form data.
Output-only and fully operator-gated — it never sends anything to the client or the lab.

Status: **MVP — template-independent core implemented + tested.** DOCX rendering is wired
but blocked on operator-supplied templates (see §7).

## 1. Functional Specification

Input: an `application` object (source of truth = Google Form, KB `draft_source_of_truth`):
```
{ doc_type, applicant:{name,inn,address,phone,email},
  manufacturer:{name,country,address}, brand,
  items:[{ name, composition, tnved }] }
```
Output: an output-only proposal `{ doc_type, fields, warnings, attachment, status:'draft',
auto_send:false, requires:{operator_approval,client_approval}, rendered, document_path? }`.

Canonical fields / placeholders (§1/§5): `APPLICANT_L_E_NAME, INN, L_E_ADRESS, PHONE_NUMBER,
EMAIL, MANUFACTURER_L_E_NAME, MANUFACTURER_COUNTRY, MANUFACTURER_ADRESS, BRAND_NAME, ITEMS,
ITEM_COMPOSITION, TNVED`.
*Discrepancy noted:* §5's placeholder list omits `MANUFACTURER_COUNTRY` and `ITEM_COMPOSITION`
(present in §1). The engine resolves all §1 fields; templates fill whichever placeholders exist.

## 2. Workflow Description (KB §4)

application → payment → receipt → **create order → GENERATE DRAFT → operator review →
send to client (operator) → client approval → lab package (operator) → lab**.
No automatic sending at any step.

## 3. Business Rules

- **§6 four-per-composition** (`declaration_four_per_composition`): for ONE composition,
  >4 product names OR >4 TN VED codes ⇒ warning `"Possible additional PI required. Operator
  review needed."` Never auto-decides. Implemented in `compositionWarnings()`.
- **§7 multi-TN VED** (`multi_tnved_attachment`): >1 distinct TN VED ⇒ build application-table
  attachment (product/composition/tnved); main doc TN VED cell becomes "см. приложение".
  Implemented in `buildAttachment()` / `tnvedField()`.
- **§9 lab package** (`lab_submission_package`): draft doc + client IP/OsOO/LLC certificate +
  standard lab email text + supporting files; auto-generate, never auto-send.
- Samples (§3): work starts after payment; do NOT wait for samples to create mockups.

## 4. Data Model

MVP is stateless/pure — proposals are returned, not yet persisted. Persistence should reuse the
existing output-only `DraftPackage` pattern (proposed-action records) when wired into the
pipeline. No new collection introduced yet.

## 5. API Contract (`src/services/mockupAgentService.js`)

- `resolveFields(application)` → `{ PLACEHOLDER: string }`
- `compositionWarnings(application)` → `[{ code, composition, product_count, tnved_count, message, auto_decide:false }]`
- `buildAttachment(application)` → `{ columns, rows, main_doc_references_attachment } | null`
- `fillTemplate(templatePath, values, outPath?)` → `{ buffer, out_path, missing_placeholders }`
  (system `zip`/`unzip`; no npm dep)
- `proposeMockup(application, { templateDir?, outPath? })` → output-only proposal
- `buildLabPackage(proposal, { clientCertPath?, standardEmailText? })` → §9 package

## 6. Approval

Every output is `status:'draft'`, `auto_send:false`, `requires.operator_approval` AND
`requires.client_approval`. Mockup → operator review → (operator sends) → client approval →
(operator approves) lab package. Consistent with recommendation-mode; nothing auto-released.

## 7. Implementation — status

**DS path works end-to-end** against the real template `templates/mockup/declaration.docx`
(operator-provided "Заявление о принятии декларации о соответствии"). Demo:
`npm run mockup:demo` → fills the DS draft + attachment + lab package preview, sends nothing.

- **Placeholders:** real templates use `<FIELD>` (not `{{FIELD}}`); the engine supports **both**,
  and **rejoins placeholders split across Word runs** (Word splits `<APPLICANT_L_E_NAME>` across
  several `<w:t>` runs — handled by a balanced pre-pass). Unmapped tokens (`<LEGAL_ENTITY>`,
  `<PROTOCOL_NUMBER>`) are left intact and reported (engine is not restricted to a fixed set).
- **Attachment:** `renderAttachmentDocx` builds a valid table .docx from scratch (no template
  needed); filename `приложение_<APPLICANT>.docx`.
- **File naming (§7):** `макет_<APPLICANT_L_E_NAME>.docx` / `приложение_<APPLICANT_L_E_NAME>.docx`.

**Real form mapper DONE** (`src/services/formFieldMapper.js`): maps the live
"Ответы на форму (1)" headers → the canonical fields (greedy synonym match; the combined
"товары — состав — ТН ВЭД" column P is claimed by ITEMS before the dedicated composition (Q) /
TN VED (R) columns). `mapRow(header,row,{docType})` → an `application` for `proposeMockup`, with
`_meta.field_warnings` for missing-required / doc_type-not-in-form / multi-TN VED structuring.
End-to-end proven on a live row: `npm run mockup:from-form` (Google Form → mapper → DS DOCX →
attachment → lab package preview; real values verified in the output). doc_type is NOT in the
form — operator selects ДС/СС.

Remaining blockers:
1. **SS (certificate) template missing.** No `certificate.docx` present — `proposeMockup` for
   СС returns `render_blocked:'template_not_found'`. Operator must supply it (DS works).
2. **Control Center display.** Package preview is produced (data + files); surfacing it in the
   Control Center UI is the next increment (no sending).
3. **Free-text product parsing.** Column P mixes products/composition/TN VED as prose; the mapper
   keeps it verbatim for placeholders and flags `product_structuring_needed` when multiple TN VED
   codes share one blob — operator confirms product↔TN VED pairing for the attachment.

## 8. Tests

`backend/tests/mockup-agent.test.js` (12 cases, no DB/network): field mapping, §6 boundary
(4 ok / 5 warns / spread-across-compositions ok), §7 attachment + main-cell reference, a real
`fillTemplate` round-trip on a synthetic .docx (replacement + missing-placeholder report), and
`proposeMockup`/`buildLabPackage` gating (draft, never sends, both approvals required).
Wired into CI (`ci.yml`) and `npm run test:mockup-agent`.
