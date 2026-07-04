# Combat Test — Business Intelligence Validation (2026-06-22)

**Goal:** validate the *reasoning process* (not the answers) of the order-status
intelligence against real production data. Every intermediate step exposed, gated,
and approved before the next. No status changed, no message sent, nothing written.

**Method:** 5 gated steps × 3 randomly-selected **active** orders drawn from the live
`Декларация` sheet (tab `Лист1`, 1,020 populated rows; active pool = 54).

**Sources reachable this run:** Declaration (live Google Sheet) ✓ · Gmail (live API,
`bizmaksat@gmail.com`) ✓ · WhatsApp ✗ (messages live only in Mongo, which was offline;
live-session pull is forbidden — would mark chats read).

---

## Orders tested

| # | Row | Client | Declaration status | Match confidence |
|---|-----|--------|--------------------|------------------|
| 1 | 1015 | ИП Жолубаева Жаннат | на согласовании | HIGH |
| 2 | 989  | Надырбаев Исхак Мелисбекович | ждем оригинал | HIGH |
| 3 | 1025 | ИП Эрмеков Кутманшер | на согласовании | MEDIUM |

All three route lab correspondence to the same lab: **Дастан Акматов
`<standartpro98@gmail.com>`**.

---

## Status reasoning (Step 3)

For all three the current Declaration status was judged **plausibly correct, no
confident basis to change**. The pivotal transition for two of them
(`на согласовании → ждем оригинал`) hinges on **client approval**, which lives on
WhatsApp — dark this run. The system correctly should *hold*, not auto-advance.

- **Order 1** — ~75% current is correct. Lab returned mockup `06-17`; no proof of client
  approval; 5 days stale.
- **Order 2** — ~65%. Active (op→lab `06-21`), trajectory fits `ждем оригинал`, but rests
  on email *metadata* only — bodies not read.
- **Order 3** — ~55%. Plausible but propped up by weak data; client side permanently dark
  unless the phone is fixed.

---

## 🔴 Primary finding — the Declaration phone column is unreliable

The mockup `.docx` (built from the client's official GNS registration certificate)
carries the **true** contact; the Declaration `Номер тел:` column does not.

| Order | Declaration phone | Mockup phone (authoritative) | Verdict |
|-------|-------------------|------------------------------|---------|
| 1 | `79336716501` (+7 format) | `+996706439615` | Different numbers — Declaration wrong |
| 2 | `507575533` | `0507565452` | Mismatch (…575533 vs …565452) |
| 3 | `130280` (6 digits, invalid) | `+996990130280` | Declaration = last 6 digits, truncated |

**Consequence:** WhatsApp phone-key matching (last-9-digit canonical key) would fail or
mis-match on **3/3** orders. Order 3's match-key is empty (below the 7-digit floor), so it
can never match — a structurally dead order until the phone is corrected.

**Recovered numbers** (from mockups): Order 1 `+996706439615`, Order 3 `+996990130280`.

---

## Secondary findings

- **Doc-type gaps.** Order 2 Declaration says «сертификат» but the mockup is a
  *declaration of conformity*; Order 3 doc-type is empty (it's a women's-garment
  declaration). Both warrant correction.
- **No `Исполнитель` (lab assignee)** on any of the three rows → SLA/overdue detection
  can't anchor.
- **Config defect.** `DECLARATION_SHEET_STATUS_COLUMN` is set to `G`, but in the live
  sheet column G holds the payment amount; the real workflow status sits in column **N**
  (header "аак"). Status reads/writes via sheetsSync target the wrong column.
- **Possible TN VED / composition mismatch (Order 2):** code `6204530000` = women's skirts
  *of synthetic fibres*, stated composition `100% хлопок` (cotton → `620452`).
- **Real lab correction cycles observed** on all three (product reclassification,
  placeholder resolution), consistent with the live statuses.

---

## Attachment audit (Step 5) — 21 files

- docx mockups extracted cleanly (applicant, ИНН, phone, product, composition, TN VED).
- GNS registration JPEGs: Order 1 OCR clean, Order 2 degraded, Order 3 OCR failed
  (image quality/orientation).
- TN VED reconstructed from concatenated XML runs — Order 1 ≈ `6303929000/6303999000`
  (curtains, matches «тюль, занавески»); Order 3 ≈ `6206300000/6204520000/6204623900`
  (women's garments, matches «для женщин»).

---

## Verdict

The reasoning process **held up**: it matched orders correctly, refused to advance status
without the deciding (WhatsApp) signal, and surfaced concrete, actionable defects rather
than fabricating conclusions. The single most important systemic issue is **data quality
in the Declaration phone column** — the certification mockups are a more authoritative
source of client contact and should be used to backfill/repair it.

## Recommended next actions (all gated, none executed)

1. Backfill Declaration phones from mockups where the sheet value is invalid/divergent
   (start with the 3 recovered above).
2. Fix `DECLARATION_SHEET_STATUS_COLUMN` G → N (or confirm the intended column).
3. Add a phone-validity check at intake (flag <7-digit / non-996 numbers).
4. Reconcile doc-type (сертификат vs декларация) for Orders 2 and 3.
5. Resume client-approval reasoning once WhatsApp (Mongo) is reachable.
