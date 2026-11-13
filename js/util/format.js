/**
 * Formatting and small pure helpers: numbers, file names, text, ids.
 */
OVS.define('util/format', () => {
  'use strict';

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const round = (v, digits) => { const k = Math.pow(10, digits || 0); return Math.round(v * k) / k; };

  const fmtInt = (n) => Number(n || 0).toLocaleString('en-US');
  const percent = (part, whole, digits) => (whole ? part / whole * 100 : 0).toFixed(digits || 0) + '%';
  /** plural(3, 'page') → "3 pages"; plural(1, 'child', 'children') → "1 child" */
  const plural = (n, one, many) => fmtInt(n) + ' ' + (n === 1 ? one : (many || one + 's'));
  const clock = (d) => { d = d || new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };

  function median(values) {
    if (!values.length) return 0;
    const s = values.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /* ---------- file names ---------- */

  const baseName = (name) => String(name || '').split(/[\\/]/).pop();
  const stem = (name) => baseName(name).replace(/\.[^.]+$/, '');
  const ext = (name) => { const m = /\.([^.\\/]+)$/.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; };
  /** Key for matching file names loosely: "Letter_01.PNG" and "letter-01.json" both give "letter01". */
  const normKey = (name) => stem(name).toLowerCase().replace(/[\s_-]+/g, '');
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const naturalCompare = (a, b) => collator.compare(a, b);
  const formatBytes = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');

  /* ---------- text ---------- */

  const XML_ENTITIES = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' };
  const xmlEscape = (s) => String(s).replace(/[<>&"']/g, (c) => XML_ENTITIES[c]);
  const csvEscape = (v) => { if (v == null) return ''; const s = String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  /** Hebrew, Arabic, Syriac, Thaana, N'Ko and their presentation forms. */
  const RTL_RE = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
  const isRtlChar = (ch) => RTL_RE.test(ch || '');
  /** Loose boolean for values read from files: true, 1, "true", "yes", "y", "1". */
  const truthy = (v) => v === true || v === 1 || (typeof v === 'string' && /^(true|yes|y|1)$/i.test(v.trim()));
  /** Keep only the last character the user typed (handles surrogate pairs). */
  const lastChar = (s) => { const chars = Array.from(s || ''); return chars.length ? chars[chars.length - 1] : ''; };

  /* ---------- ids ---------- */

  let counter = 0;
  const makeId = (prefix) => (prefix || 'id') + '-' + Date.now().toString(36) + '-' + (counter++).toString(36);

  return {
    clamp, round, fmtInt, percent, plural, clock, median,
    baseName, stem, ext, normKey, naturalCompare, formatBytes,
    xmlEscape, csvEscape, isRtlChar, truthy, lastChar, makeId
  };
});
