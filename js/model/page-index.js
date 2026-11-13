/**
 * Cached views over a page. Character arrays are immutable, so each view is
 * computed once per array and reused until the page changes.
 */
OVS.define('model/page-index', () => {
  'use strict';

  const lineCache = new WeakMap();
  const orderCache = new WeakMap();
  const idCache = new WeakMap();

  /** Map lineId → characters of that line in display order (spaces included). */
  function linesOf(page) {
    let map = lineCache.get(page.chars);
    if (!map) {
      map = new Map(page.lines.map((l) => [l.id, []]));
      for (const c of page.chars) {
        if (!map.has(c.lineId)) map.set(c.lineId, []);
        map.get(c.lineId).push(c);
      }
      for (const list of map.values()) list.sort((a, b) => a.order - b.order);
      lineCache.set(page.chars, map);
    }
    return map;
  }

  /** Non-space characters in reading order: lines top to bottom, characters in line order. */
  function readingOrder(page) {
    let list = orderCache.get(page.chars);
    if (!list) {
      const lines = linesOf(page);
      list = [];
      for (const line of page.lines) for (const c of lines.get(line.id) || []) if (!c.space) list.push(c);
      orderCache.set(page.chars, list);
    }
    return list;
  }

  /** Map id → character. */
  function byId(page) {
    let map = idCache.get(page.chars);
    if (!map) { map = new Map(page.chars.map((c) => [c.id, c])); idCache.set(page.chars, map); }
    return map;
  }

  /** 1-based line number of a line id. */
  const lineNumber = (page, lineId) => page.lines.findIndex((l) => l.id === lineId) + 1;

  /**
   * Text of each line, for exports and previews.
   * @returns {Array<{ text, dir, blank? }>}  blank entries mark paragraph breaks
   */
  function textLines(page, opts) {
    const o = Object.assign({ indent: true, paragraphs: true }, opts);
    const lines = linesOf(page);
    const out = [];
    for (const line of page.lines) {
      if (o.paragraphs && line.paraBefore && out.length) out.push({ text: '', dir: 'ltr', blank: true });
      const text = (lines.get(line.id) || []).map((c) => c.value).join('').replace(/\s+$/, '');
      out.push({ text: (o.indent && line.dir === 'ltr' ? ' '.repeat(line.indent) : '') + text, dir: line.dir });
    }
    return out;
  }

  /** Split a line's characters (in reading order) into words at space tokens. */
  function words(lineChars) {
    const out = [];
    let cur = [];
    for (const c of lineChars) {
      if (c.space) { if (cur.length) out.push(cur); cur = []; }
      else cur.push(c);
    }
    if (cur.length) out.push(cur);
    return out;
  }

  /** Smallest box [x0, y0, x1, y1] around the given boxes (missing ones are skipped); null if none. */
  function unionBox(boxes) {
    let r = null;
    for (const b of boxes) {
      if (!b) continue;
      if (!r) r = b.slice();
      else { r[0] = Math.min(r[0], b[0]); r[1] = Math.min(r[1], b[1]); r[2] = Math.max(r[2], b[2]); r[3] = Math.max(r[3], b[3]); }
    }
    return r;
  }

  return { linesOf, readingOrder, byId, lineNumber, textLines, words, unionBox };
});
