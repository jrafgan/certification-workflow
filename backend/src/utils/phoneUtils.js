'use strict';

// utils/phoneUtils.js — phone normalization + matching for the WhatsApp Agent.
//
// The Declaration "Номер тел:" column is the client's WhatsApp number, but it is
// stored inconsistently: shortened local form ("777240858") vs. full
// international form ("+996777240858", "996 777 240 858", "0777240858").
//
// Matching must therefore be on a NORMALIZED LOCAL form, not exact string
// equality and not a prefix (the previous order-search used a "^"-anchored regex,
// which cannot match shortened vs. +996 forms — the gap this module closes).
//
// Canonical key = the last `LOCAL_LEN` digits after stripping non-digits, a
// leading country code (996), and a leading trunk 0. For Kyrgyzstan that is the
// 9-digit local subscriber number.

const COUNTRY_CODE = '996';
const LOCAL_LEN    = 9;
const MIN_DIGITS   = 7; // guard against over-broad suffix matches

// digitsOnly — strip everything that isn't a digit.
function digitsOnly(raw) {
  return String(raw == null ? '' : raw).replace(/\D/g, '');
}

// normalizeLocal — reduce any stored form to the local subscriber number.
//   "+996777240858" → "777240858"
//   "996777240858"  → "777240858"
//   "0777240858"    → "777240858"
//   "777240858"     → "777240858"
// Returns '' when there are too few digits to be a real number.
function normalizeLocal(raw) {
  let d = digitsOnly(raw);
  if (d.length >= COUNTRY_CODE.length + LOCAL_LEN && d.startsWith(COUNTRY_CODE)) {
    d = d.slice(COUNTRY_CODE.length);
  }
  if (d.length === LOCAL_LEN + 1 && d.startsWith('0')) {
    d = d.slice(1);
  }
  return d;
}

// matchKey — the canonical comparison key: the last LOCAL_LEN digits of the
// normalized local number. Returns '' if the number is too short to match on.
function matchKey(raw) {
  const local = normalizeLocal(raw);
  if (local.length < MIN_DIGITS) return '';
  return local.slice(-LOCAL_LEN);
}

// phonesMatch — true when two numbers resolve to the same canonical key.
// Both must clear MIN_DIGITS; empty/short inputs never match.
function phonesMatch(a, b) {
  const ka = matchKey(a);
  const kb = matchKey(b);
  return !!ka && ka === kb;
}

module.exports = {
  COUNTRY_CODE,
  LOCAL_LEN,
  MIN_DIGITS,
  digitsOnly,
  normalizeLocal,
  matchKey,
  phonesMatch,
};
