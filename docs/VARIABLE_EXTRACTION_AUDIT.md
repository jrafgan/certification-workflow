# Variable Extraction Audit (2026-06-22)

**Goal:** minimize hardcoded business data so logic stays stable when prices, deadlines,
or procedures change. Every value that can change over time is identified, classified, and
given a recommended home.

**Classification key:**
- **A — CONSTANT:** business/regulatory rule that rarely changes; acceptable in source.
- **B — CONFIGURABLE:** value likely to change; should be config/env/DB/KB, not a literal.
- **C — EXTERNAL DATA:** identity/endpoint/structure that must come from config or DB.

---

## 0. Headline findings

1. **Prices are duplicated and can drift.** `piCalculationService.js` hardcodes its own
   `PRICING` object (ДС 15 000 / СС 35 000 / +ПИ 7 000 / 9 000) **and** the same numbers
   live as entries in the Approved KB (`operatorMasterKbV2.js`). Two sources of truth for
   the same price → guaranteed eventual divergence. The calc engine should **read the KB**,
   not keep a private copy.
2. **Attention-engine thresholds are inline magic numbers** in
   `controlCenterService.orderDangers()` (`2`, `3`, `14`, fallback `5`/`10`) — not even in
   `constants.js`, not env-overridable. Changing "paid-but-not-launched = 2 days" requires a
   code edit.
3. **Lab identity is hardcoded** (`Дастан`, `Бермет`, `standartpro98@gmail.com`), and the
   known-senders list still contains **test addresses** (`test@test.kg`, `mng-1@kyrgyz-test.kg`)
   in production constants.
4. **Sheet column mapping is wrong/stale** (see Combat Test 2026-06-22): status column
   configured `G`, real sheet uses `N`; `DECLARATION_SHEET_COLUMNS` A→G layout does not match
   the live sheet at all.

---

## A. CONSTANTS (business rules — acceptable in source)

| Variable | Current value | Location | Why stable |
|---|---|---|---|
| Order statuses | 7: Запустить … Завершен, Отменен | `constants.js:23` | Canonical workflow; changes only with a process redesign |
| Workflow status map | LAYOUT→На согласовании, ORIGINAL→Оригинал получен | `constants.js:174` | Tied to the regulatory workflow |
| Event type codes | `EVENT_TYPES{}` | `constants.js:56` | Internal contract |
| Task types / priorities | 7 types / high·med·low | `constants.js:35,45` | Internal taxonomy |
| Samples per composition | ДС 1, СС 2 | `piCalc:20`, KB | Regulatory (lab requirement) |
| TN VED group rules | трикотаж=61, швейка=62; incompatibilities | KB `TN VED` | Customs classification, stable |
| "First ПИ included in price" | rule | KB `PI Calculations` | Pricing policy structure |
| Currency | `сом` | `piCalc:23` | Stable, but should be a single shared symbol |

> Note: `Отменен` (constants) vs `отказ` (live sheet value) is a **mismatch worth
> reconciling** — the canonical list and the sheet's actual cancellation label differ.

---

## B. CONFIGURABLE VARIABLES (should not be literals)

### B1. Prices

| Value | Current | Location(s) | Why it changes | Recommended storage |
|---|---|---|---|---|
| ДС base | 15 000 сом | `piCalc:20` **+** KB | inflation, lab repricing | **KB (single source); calc reads KB** |
| СС base | 35 000 сом | `piCalc:20` + KB | same | KB |
| ДС additional ПИ | 7 000 сом | `piCalc:20` + KB | same | KB |
| СС additional ПИ | 9 000 сом | `piCalc:20` + KB | same | KB |
| Отказное письмо | 5 000 сом | KB | same | KB |
| MPStats add-on | 2 400 сом | KB | vendor pricing | KB |
| Wildbox add-on | 1 700 сом | KB | vendor pricing | KB |
| Minimum payment | 10 000 сом | KB | policy | KB / config |
| Large-order deposit | 60% | KB | policy | KB / config |

### B2. Turnaround times

| Value | Current | Location | Why it changes | Recommended |
|---|---|---|---|---|
| ДС turnaround | ~2 weeks | KB | lab load | KB (already `possibly_outdated`) |
| СС turnaround | 1–1.5 months | KB | lab load | KB |
| ДС validity | 3 года | `piCalc:20` + KB | regulation | KB |
| СС validity | 1 год | `piCalc:21` + KB | regulation | KB |
| Default layout SLA | 5 days | `constants.js:111` (env ✓) | per-lab | env ✓ / per-lab DB |
| Default original SLA | 10 days | `constants.js:113` (env ✓) | per-lab | env ✓ / per-lab DB |

### B3. Overdue / escalation / attention-queue thresholds

| Value | Current | Location | Why it changes | Recommended |
|---|---|---|---|---|
| Stale new order | 3 days | `constants.js:49` | ops tuning | env / config |
| Layout-not-sent | 24 h | `constants.js:50` | ops tuning | env / config |
| Original-not-sent | 48 h | `constants.js:51` | ops tuning | env / config |
| Lab risk HIGH reply | 12 h | `constants.js:116` | ops tuning | env / config |
| Lab risk CRITICAL reply | 48 h | `constants.js:117` | ops tuning | env / config |
| Lab risk CRITICAL overdue | 3 days | `constants.js:118` | ops tuning | env / config |
| **Paid-but-not-launched idle** | **2 days** | `controlCenterService.js:384` ⚠️ inline | ops tuning | **→ constants/env** |
| **Approval-overdue** | **3 days** | `controlCenterService.js:398` ⚠️ inline | ops tuning | **→ constants/env** |
| **Client-waiting-long idle** | **14 days** | `controlCenterService.js:405` ⚠️ inline | ops tuning | **→ constants/env** |
| Layout SLA fallback | 5 | `controlCenterService.js:376` ⚠️ inline (dupes `constants:111`) | — | reuse the constant |
| Original SLA fallback | 10 | `controlCenterService.js:377` ⚠️ inline (dupes `constants:113`) | — | reuse the constant |

---

## C. EXTERNAL DATA (identity / endpoints / structure)

| Value | Current | Location | Why it changes | Recommended |
|---|---|---|---|---|
| Lab names | `Дастан`, `Бермет` | `piCalc:20,21` + KB | new labs, reassignment | **Laboratory DB collection** (or config), referenced by id |
| Lab known-senders | `standartpro98@gmail.com`, `mng-1@kyrgyz-test.kg`, `test@test.kg` | `constants.js:144` | lab onboarding; **test addrs in prod** | Laboratory DB / env; drop test addrs in prod |
| Heavy-regulation lab | (per `lab-identities` memory) | — | onboarding | Laboratory DB |
| Application URL | `https://dokumenty.pro/zayavka` | `leadReplyTemplates.js:18` (env ✓) | rebrand/route | env ✓ (`LEAD_APPLICATION_URL`) |
| Social / channel | `@dokumenty_pro` | `youtubeChannelClient`, `KbVideo`, `knowledgeBaseService` | handle change | config/env |
| Contact info | (various templates) | `leadReplyTemplates.js` | rebrand | config/env |
| Declaration sheet id / tab | env ✓ | `.env` | — | env ✓ |
| **Status column** | **`G` (WRONG — real `N`)** | `constants.js:183` (env) | sheet layout | **fix value**; keep env-overridable |
| **Sheet column map A→G** | **stale, ≠ live sheet** | `constants.js:189` | sheet layout | **re-derive from live sheet**; move to config |
| Poll cron | `*/30 * * * *` | `constants.js:106` (env ✓) | scheduling | env ✓ |

---

## Recommendations (priority order)

1. **Single pricing source.** Make `piCalculationService` read approved KB `price` entries
   (category Payments/PI Calculations) instead of its private `PRICING` object. Removes the
   #1 drift risk.
2. **Lift inline thresholds** (`controlCenterService.js` 2/3/14 + 5/10 fallbacks) into
   `constants.js` with env overrides; reuse the existing SLA constants instead of re-literals.
3. **Laboratory registry.** Move lab names + emails + SLAs into a `Laboratory` collection
   (or a config module); reference by id. Remove test sender addresses from production.
4. **Fix the sheet mapping** (status column `G`→`N`; re-derive column layout) — already
   tracked in the combat-test report.
5. **Externalize contact/social** to config/env, matching the existing `LEAD_APPLICATION_URL`
   pattern.

**Outcome:** prices, deadlines, labs, and contact details become operator-editable data
(KB / config / DB) — business logic (`computePi`, `orderDangers`, matching) stays unchanged
when those values move.
