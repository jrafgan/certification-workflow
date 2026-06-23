'use strict';

// services/newFormClassificationService.js — New Form Classification Engine (Phase 3).
//
// PURE + deterministic (no I/O). From New-Form application fields it determines, per the
// operator-approved KB rules:
//   • Adult / Child         — from the AGE field (primary signal)
//   • Sewing / Knitwear / Mixed — per-product (TNVED heading 61/62 + item-name keywords)
//   • Composition groups    — distinct составы
//   • TNVED groups          — raw vs grouped count + 4-digit headings
//   • Protocol groups       — UNIQUE (category × composition) → drives the ПИ estimate
//   • DS / SS               — AGE is the PRIMARY driver (Adult→ДС, Child→СС); knit/sew and
//                             TNVED classify category/protocol structure ONLY and never change
//                             the DS/SS decision. NEVER decide DS/SS from TNVED alone.
//   • Samples               — per composition (ДС 1, СС 2 — from piCalculationService.PRICING)
//
// Recommend-only: this NEVER writes anything and NEVER finalizes. Below the confidence
// threshold the result is needs_operator=true (stop and ask, do not guess).

const { PRICING } = require('./piCalculationService');

// Confidence at/above which a DS/SS proposal is offered (else stop & ask). Mirrors the
// auditor's AUDIT_RECOMMEND_THRESHOLD default (70).
const CONFIDENCE_THRESHOLD = parseInt(process.env.CLASSIFY_CONFIDENCE_THRESHOLD, 10) || 70;

// ─── Product parsing ──────────────────────────────────────────────────────────

// parseProducts — split a merged "Name - composition, TNVED  Name2 - …" blob (New Form col P)
// into products using the 10-digit TNVED codes as delimiters.
function parseProducts(blob) {
  const text = String(blob || '');
  const codeRe = /\d{10}/g;
  const out = [];
  let last = 0, m;
  while ((m = codeRe.exec(text))) {
    const seg = text.slice(last, m.index).replace(/[,\s]+$/, '').trim();
    last = codeRe.lastIndex;
    if (!seg) { out.push({ name: '', composition: '', tnved: m[0] }); continue; }
    const pctIdx = seg.search(/\d+\s*%/);
    let name, composition;
    if (pctIdx >= 0) { name = seg.slice(0, pctIdx).replace(/[-,\s]+$/, '').trim(); composition = seg.slice(pctIdx).trim(); }
    else { name = seg.replace(/[-,\s]+$/, '').trim(); composition = ''; }
    // strip a leading separator artifact ("," / "-") left by the previous segment boundary
    name = name.replace(/^[,\-\s]+/, '').trim();
    out.push({ name, composition, tnved: m[0] });
  }
  return out;
}

// compositionKey — canonical sorted "material:qty" key so equal составы group together.
function compositionKey(comp) {
  const pairs = [...String(comp || '').matchAll(/(\d+)\s*%\s*([а-яёa-z]+)/gi)].map(x => `${x[2].toLowerCase()}:${x[1]}`);
  return pairs.sort().join('|');
}

// ─── Category (sewing / knitwear) ─────────────────────────────────────────────

const KNIT_KW = /футболк|лонгслив|худи|свитшот|трикотаж|майк|пуловер|джемпер|водолазк/i;
const SEW_KW  = /рубашк|блузк|плать|юбк|брюк|костюм|куртк|пиджак|сорочк|джинс/i;

// productCategory — TNVED heading is primary (61 knit, 62 sew); item-name keyword fallback.
function productCategory(p) {
  const h = String(p.tnved || '').slice(0, 2);
  if (h === '61') return 'knitwear';
  if (h === '62') return 'sewing';
  if (KNIT_KW.test(p.name)) return 'knitwear';
  if (SEW_KW.test(p.name)) return 'sewing';
  return 'unknown';
}

// fabricSummary — overall sewing/knitwear/mixed + whether TNVED and item-name signals agree.
function fabricSummary(products) {
  const cats = new Set(products.map(productCategory).filter(c => c !== 'unknown'));
  const result = cats.size > 1 ? 'mixed' : (cats.size === 1 ? [...cats][0] : 'unknown');
  const headings = [...new Set(products.map(p => String(p.tnved || '').slice(0, 2)).filter(Boolean))];
  const names = products.map(p => p.name).join(' ');
  const byName = KNIT_KW.test(names) && SEW_KW.test(names) ? 'mixed' : KNIT_KW.test(names) ? 'knitwear' : SEW_KW.test(names) ? 'sewing' : 'unknown';
  const byTnved = headings.includes('61') && headings.includes('62') ? 'mixed' : headings.includes('61') ? 'knitwear' : headings.includes('62') ? 'sewing' : 'unknown';
  return { result, by_tnved: byTnved, by_item_names: byName, signals_agree: byTnved === byName, headings };
}

// ─── Grouping ─────────────────────────────────────────────────────────────────

function compositionGroups(products) {
  const map = new Map();
  for (const p of products) {
    const k = compositionKey(p.composition) || '(пусто)';
    if (!map.has(k)) map.set(k, { key: k, products: [] });
    map.get(k).products.push(p.name);
  }
  return [...map.values()];
}

function tnvedGroups(products) {
  const raw = products.map(p => String(p.tnved || '')).filter(Boolean);
  const grouped = [...new Set(raw)];
  const headings = [...new Set(grouped.map(c => c.slice(0, 4)))];
  return { raw_count: raw.length, grouped_count: grouped.length, grouped, headings };
}

// protocolGroups — UNIQUE (category × composition). Drives the protocol (ПИ) estimate.
function protocolGroups(products) {
  const map = new Map();
  for (const p of products) {
    const cat = productCategory(p);
    const ck = compositionKey(p.composition) || '(пусто)';
    const key = `${cat} | ${ck}`;
    if (!map.has(key)) map.set(key, { category: cat, composition: ck, products: [] });
    map.get(key).products.push(p.name);
  }
  return [...map.values()];
}

// ─── Age (adult / child) ──────────────────────────────────────────────────────

function detectAge(ageText) {
  const t = String(ageText || '').toLowerCase();
  if (/детск|для детей|ребен|child/.test(t)) return { value: 'child', confidence: 0.95, raw: ageText || '' };
  if (/взросл|муж|жен|adult/.test(t)) return { value: 'adult', confidence: 0.95, raw: ageText || '' };
  return { value: 'unknown', confidence: 0, raw: ageText || '' };
}

// ─── DS / SS determination ────────────────────────────────────────────────────

// determineDocument — AGE is the PRIMARY (sole) driver. Adult→ДС, Child→СС. Knit/sew & TNVED
// classify category/protocol structure ONLY and do NOT change DS/SS confidence. Below threshold
// (AGE unknown) → needs_operator (stop, ask, do not guess).
function determineDocument(age, fabric) {
  const reasoning = [];
  let proposed = null, confidence = 0;
  if (age.value === 'adult') { proposed = 'ДС'; confidence = 92; reasoning.push('AGE = взрослое → ДС (декларация). AGE — первичный и единственный определитель ДС/СС.'); }
  else if (age.value === 'child') { proposed = 'СС'; confidence = 92; reasoning.push('AGE = детское → СС (сертификат). AGE — первичный определитель.'); }
  else { reasoning.push('AGE неизвестен — определить ДС/СС нельзя без подтверждения оператора (STOP/ask).'); }

  if (proposed) {
    reasoning.push(`Категория продукции: ${fabric.result} (ТН ВЭД группы ${fabric.headings.join(',') || '—'}) — влияет на структуру/протоколы, НЕ на ДС/СС.`);
    if (!fabric.signals_agree && fabric.result !== 'unknown') {
      reasoning.push(`Примечание (не влияет на ДС/СС): сигналы категории расходятся — по названиям «${fabric.by_item_names}», по ТН ВЭД «${fabric.by_tnved}».`);
    }
    reasoning.push('Решение НЕ основано на ТН ВЭД в одиночку (первично AGE; ITEMS/COMPOSITION/ТН ВЭД — вторично).');
  }

  const band = confidence >= 80 ? 'HIGH' : confidence >= 50 ? 'MEDIUM' : 'LOW';
  const needs_operator = !proposed || confidence < CONFIDENCE_THRESHOLD;
  return { proposed, confidence, confidence_band: band, needs_operator, reasoning };
}

// ─── Top-level classify ───────────────────────────────────────────────────────

// classify({ age, items_text, composition_text, tnved_text }) → full classification.
// `age` is the raw AGE field text (New Form col O). Product data is parsed from items_text
// (the merged blob); composition_text/tnved_text are accepted but items_text is authoritative
// for the per-product split. RECOMMEND-ONLY — never writes, never finalizes.
function classify({ age, items_text, composition_text, tnved_text } = {}) {
  const products = parseProducts(items_text || composition_text || '');
  const ageInfo = detectAge(age);
  const fabric = products.length ? fabricSummary(products) : { result: 'unknown', by_tnved: 'unknown', by_item_names: 'unknown', signals_agree: true, headings: [] };
  const compGroups = compositionGroups(products);
  const tnved = tnvedGroups(products);
  const protoGroups = protocolGroups(products);
  const determination = determineDocument(ageInfo, fabric);

  const doc_type = determination.needs_operator ? null : determination.proposed;
  const perComp = doc_type && PRICING[doc_type] ? PRICING[doc_type].samples_per_composition : null;
  const samples_required = perComp != null ? compGroups.length * perComp : null;  // KB §8: per composition
  const laboratory = doc_type && PRICING[doc_type] ? PRICING[doc_type].laboratory : null;

  const warnings = [];
  if (!products.length) warnings.push({ code: 'no_products_parsed', message: 'Не удалось распознать товары из заявки.' });
  if (ageInfo.value === 'unknown') warnings.push({ code: 'age_missing', message: 'Поле «детский/взрослый» (AGE) пусто или нераспознано — нужно подтверждение оператора.' });
  if (!fabric.signals_agree && fabric.result !== 'unknown') warnings.push({ code: 'category_signal_disagreement', message: 'Сигналы категории (названия vs ТН ВЭД) расходятся — категория для протоколов, не для ДС/СС.' });
  if (tnved.grouped_count > 1) warnings.push({ code: 'multi_tnved_attachment', message: 'Несколько кодов ТН ВЭД — потребуется приложение (таблица товар↔состав↔ТН ВЭД).' });
  // KB declaration "4 per composition": >4 product names OR >4 TNVED codes within one composition.
  for (const g of compGroups) {
    const codes = new Set(products.filter(p => (compositionKey(p.composition) || '(пусто)') === g.key).map(p => p.tnved));
    if (g.products.length > 4 || codes.size > 4) {
      warnings.push({ code: 'possible_additional_pi', composition: g.key, message: 'Possible additional PI required. Operator review needed.', auto_decide: false });
    }
  }

  return {
    age: ageInfo,
    category: fabric.result,                 // sewing | knitwear | mixed | unknown
    fabric,
    products,
    composition_groups: compGroups,
    composition_group_count: compGroups.length,
    tnved_groups: tnved,
    protocol_groups: protoGroups,
    estimated_protocol_count: protoGroups.length,
    doc_type,
    determination,
    samples_required,
    laboratory,
    warnings,
    needs_operator: determination.needs_operator,
    recommend_only: true,
  };
}

module.exports = {
  CONFIDENCE_THRESHOLD,
  parseProducts,
  compositionKey,
  productCategory,
  fabricSummary,
  compositionGroups,
  tnvedGroups,
  protocolGroups,
  detectAge,
  determineDocument,
  classify,
};
