/**
 * Builds a page's structure from flat character records: ordered lines (with
 * reading direction, indentation and paragraph breaks) and ordered characters,
 * including spaces inferred from gaps between boxes.
 *
 * Input records come from io/annotation-schema.js:
 *   { index, value, conf, bbox, poly, line, order, ocrValue, ocrBbox, added, verified, joined }
 *
 * Rotated text (records with a poly) is handled the same way: characters are
 * ordered along their line's direction and spacing is measured along the text,
 * so a stamp at an angle reads as normal words. Each stamp or seal is then shown
 * straightened where it sits on the page: as one block, placed among the other
 * lines by its height on the page, each line centred on its original position.
 */
OVS.define('model/layout', (require) => {
  'use strict';

  const { median, isRtlChar, makeId } = require('util/format');
  const geometry = require('model/geometry');

  const cx = (b) => (b[0] + b[2]) / 2;
  const cy = (b) => (b[1] + b[3]) / 2;
  const isBlank = (r) => r.value.trim() === '';
  /** Centre and width along the text of a record's box. */
  const frame = (r) => (r.poly ? geometry.frameOf(r.poly) : { cx: cx(r.bbox), cy: cy(r.bbox), w: r.bbox[2] - r.bbox[0] });
  /** Centre distance along the text: horizontal for upright characters (as before), straight-line once one is rotated. */
  const distance = (a, b) => {
    const fa = frame(a), fb = frame(b);
    return a.poly || b.poly ? Math.hypot(fb.cx - fa.cx, fb.cy - fa.cy) : Math.abs(fb.cx - fa.cx);
  };

  /**
   * @param {Array} records
   * @param {{ idPrefix: string }} opts
   * @returns {{ lines, chars, metrics: { charW, charH, pitch, linePitch } }}
   */
  function buildPage(records, opts) {
    const prefix = (opts && opts.idPrefix) || 'c';
    const recs = records.filter((r) => r.value != null && r.value !== '');
    const hasExplicitSpaces = recs.some(isBlank);
    // Page-wide measurements come from upright text, so a stamp or seal does not change the
    // body layout; a page that is rotated as a whole is measured along its characters instead.
    const boxed = recs.filter((r) => r.bbox && !isBlank(r));
    const upright = boxed.filter((r) => !r.poly);
    const sized = (upright.length ? upright : boxed).map((r) => (r.poly ? geometry.frameOf(r.poly) : { w: r.bbox[2] - r.bbox[0], h: r.bbox[3] - r.bbox[1] }));
    const charW = median(sized.map((f) => f.w)) || 10;
    const charH = median(sized.map((f) => f.h)) || 16;

    const groups = groupIntoLines(recs, charH);
    groups.forEach(orderLine);
    for (const g of groups) g.rotated = g.items.filter((r) => r.poly).length > g.items.length / 2;
    const body = groups.some((g) => !g.rotated) ? groups.filter((g) => !g.rotated) : groups;
    const ordered = body === groups ? groups : placeRotatedBlocks(groups);
    const pitch = globalPitch(body, charW);
    groups.forEach((g) => { g.pitch = linePitchOf(g, charW, pitch, charH); });

    const tops = body.filter((g) => g.bbox).map((g) => g.bbox[1]);
    const gaps = [];
    for (let i = 1; i < tops.length; i++) { const d = tops[i] - tops[i - 1]; if (d > charH * 0.5 && d < charH * 4) gaps.push(d); }
    const linePitch = median(gaps) || charH * 1.5;

    const boxes = body.filter((g) => g.bbox).map((g) => g.bbox);
    const left = boxes.length ? Math.min(...boxes.map((b) => b[0])) : 0;
    const right = boxes.length ? Math.max(...boxes.map((b) => b[2])) : 0;

    const lines = [];
    const chars = [];
    let n = 0;
    let prevBox = null, prevGroup = null;
    const nextId = () => prefix + '-' + (n++);

    ordered.forEach((g, li) => {
      const lineId = prefix + '-l' + li;
      // Indentation mirrors the page; a rotated line gets its indent once its length is known (below).
      const indent = g.bbox && !g.rotated ? Math.max(0, Math.round((g.dir === 'rtl' ? right - g.bbox[2] : g.bbox[0] - left) / pitch)) : 0;
      // A paragraph break after a large gap or when a line starts well above the previous one;
      // a block of rotated lines (a stamp) is always a paragraph of its own.
      const paraBefore = !!prevGroup && (g.rotated || prevGroup.rotated
        ? !!g.blockStart || !g.rotated
        : !!(prevBox && g.bbox && (g.bbox[1] - prevBox[1] > linePitch * 1.65 || prevBox[1] - g.bbox[1] > linePitch)));
      if (g.bbox && !g.rotated) prevBox = g.bbox;
      prevGroup = g;
      const line = { id: lineId, dir: g.dir, indent, paraBefore, bbox: g.bbox };
      lines.push(line);
      const firstChar = chars.length;

      let order = 0;
      let prev = null;
      for (const r of g.items) {
        const blank = isBlank(r);
        if (!hasExplicitSpaces && !blank && !r.joined && prev && prev.bbox && r.bbox) {
          const count = inferredSpaces(prev, r, g);
          for (let s = 0; s < count; s++) chars.push(spaceToken(nextId(), lineId, order++, true, null));
        }
        chars.push(blank ? spaceToken(nextId(), lineId, order++, false, r.bbox) : toChar(r, nextId(), lineId, order++));
        if (!blank) prev = r;
      }
      if (g.rotated) line.indent = straightIndent(g, chars.length - firstChar, left, pitch);
    });

    return { lines, chars, metrics: { charW, charH, pitch, linePitch } };
  }

  /**
   * Move each block of rotated lines (consecutive lines that are mostly rotated, e.g. one
   * stamp) to where it sits on the page: before the first upright line that starts below
   * the block's top. Inside a block, lines go from top to bottom by their centres.
   */
  function placeRotatedBlocks(groups) {
    const blocks = [];
    let cur = null;
    for (const g of groups) {
      if (g.rotated) { if (!cur) blocks.push(cur = []); cur.push(g); }
      else cur = null;
    }
    const out = groups.filter((g) => !g.rotated);
    const centreY = (g) => { const fs = g.items.filter((r) => r.bbox).map(frame); return fs.length ? fs.reduce((t, f) => t + f.cy, 0) / fs.length : Infinity; };
    for (const block of blocks) {
      block.sort((a, b) => centreY(a) - centreY(b));
      block[0].blockStart = true;
      const top = Math.min(...block.map((g) => (g.bbox ? g.bbox[1] : Infinity)));
      const at = out.findIndex((g) => !g.rotated && g.bbox && g.bbox[1] > top);
      out.splice(at < 0 ? out.length : at, 0, ...block);
    }
    return out;
  }

  /** Indent of a straightened rotated line: centred on the middle of its first and last characters. */
  function straightIndent(g, cells, left, pitch) {
    const placed = g.items.filter((r) => r.bbox && !isBlank(r));
    if (!placed.length) return 0;
    const centre = (frame(placed[0]).cx + frame(placed[placed.length - 1]).cx) / 2;
    return Math.max(0, Math.round((centre - left) / pitch - cells / 2));
  }

  /** A space shows up both as a visible gap and as a jump in centre distance; requiring both
   *  avoids splitting narrow glyphs such as "." from their word. Both are measured along
   *  the text, so they work for rotated lines and either reading direction. */
  function inferredSpaces(a, b, line) {
    const dist = distance(a, b);
    const gap = dist - (frame(a).w + frame(b).w) / 2;
    if (gap <= line.pitch * 0.25 || dist <= line.pitch * 1.45) return 0;
    return Math.min(60, Math.max(1, Math.round(dist / line.pitch) - 1));
  }

  function spaceToken(id, lineId, order, virtual, bbox) {
    return { id, lineId, order, value: ' ', bbox: bbox || null, poly: null, ocr: null, verified: false, space: true, virtual, src: null };
  }

  function toChar(r, id, lineId, order) {
    const ocr = r.added ? null : Object.freeze({
      value: r.ocrValue != null ? r.ocrValue : r.value,
      conf: r.conf,
      bbox: r.ocrBbox || r.bbox
    });
    const bbox = r.poly ? geometry.boundsOf(r.poly) : r.bbox;
    const c = { id, lineId, order, value: r.value, bbox, poly: r.poly || null, ocr, verified: !!r.verified, space: false, virtual: false, src: null };
    if (r.joined) c.joined = true; // see withoutChar()
    return c;
  }

  /* ---------- lines ---------- */

  /** Group by explicit line keys when the file has them, otherwise by vertical position. */
  function groupIntoLines(recs, charH) {
    const keyed = recs.filter((r) => r.line != null).length;
    if (recs.length && keyed >= recs.length * 0.8) {
      const map = new Map();
      for (const r of recs) {
        const key = r.line != null ? String(r.line) : nearestKey(map, r);
        if (!map.has(key)) map.set(key, { key, items: [], first: r.index });
        map.get(key).items.push(r);
      }
      return Array.from(map.values()).sort((a, b) => a.first - b.first);
    }

    const lines = [];
    for (const r of recs.filter((x) => x.bbox).sort((a, b) => cy(a.bbox) - cy(b.bbox))) {
      const y = cy(r.bbox);
      let best = null, bestD = Infinity;
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 4); i--) {
        const d = Math.abs(lines[i].cy - y);
        if (d < bestD) { bestD = d; best = lines[i]; }
      }
      if (best && bestD < charH * 0.6) {
        best.items.push(r);
        best.cy += (y - best.cy) / best.items.length;
      } else lines.push({ key: 'auto' + lines.length, items: [r], cy: y, first: r.index });
    }
    const unplaced = recs.filter((r) => !r.bbox);
    if (unplaced.length) lines.push({ key: 'unplaced', items: unplaced, cy: Infinity, first: unplaced[0].index });
    return lines.sort((a, b) => a.cy - b.cy);
  }

  function nearestKey(map, r) {
    if (!r.bbox || !map.size) return 'unassigned';
    let best = 'unassigned', bestD = Infinity;
    for (const g of map.values()) {
      const ref = g.items.find((x) => x.bbox);
      if (!ref) continue;
      const d = Math.abs(cy(ref.bbox) - cy(r.bbox));
      if (d < bestD) { bestD = d; best = g.key; }
    }
    return best;
  }

  /** Sort a line's characters and detect its reading direction. */
  function orderLine(g) {
    const letters = g.items.filter((r) => /\p{L}/u.test(r.value));
    const rtl = letters.filter((r) => isRtlChar(r.value)).length;
    g.dir = rtl > letters.length / 2 ? 'rtl' : 'ltr';
    const allOrdered = g.items.every((r) => r.order != null);
    const allBoxed = g.items.every((r) => r.bbox);
    // Without an explicit order, sort by position along the line's direction (its average character angle).
    let dx = 0, dy = 0;
    for (const r of g.items) if (r.poly) { const f = geometry.frameOf(r.poly); dx += Math.cos(f.angle); dy += Math.sin(f.angle); }
    if (!dx && !dy) dx = 1;
    const along = (r) => { const f = frame(r); return f.cx * dx + f.cy * dy; };
    g.items.sort((a, b) => {
      if (allOrdered) return a.order - b.order || a.index - b.index;
      if (allBoxed) return (g.dir === 'rtl' ? along(b) - along(a) : along(a) - along(b)) || a.index - b.index;
      return a.index - b.index;
    });
    const boxes = g.items.filter((r) => r.bbox).map((r) => r.bbox);
    g.bbox = boxes.length
      ? [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))]
      : null;
  }

  /** Typical centre-to-centre distance of neighbouring characters on the page. */
  function globalPitch(groups, charW) {
    const d = [];
    for (const g of groups) eachNeighbour(g, (a, b) => { const v = distance(a, b); if (v < charW * 2.2) d.push(v); });
    return median(d) || charW * 1.1;
  }

  /**
   * The same for one line, so headings in a larger font get their own spacing.
   * A letter-spaced line ("R E C E I V E D") has no neighbouring letters to measure,
   * so the page pitch is scaled by the line's character height instead.
   */
  function linePitchOf(g, charW, pagePitch, charH) {
    const d = [];
    eachNeighbour(g, (a, b) => {
      const w = Math.max(frame(a).w, frame(b).w, charW);
      const v = distance(a, b);
      if (v < w * 1.6) d.push(v);
    });
    if (d.length >= 3) return median(d);
    const heights = g.items.filter((r) => r.bbox && !isBlank(r)).map((r) => (r.poly ? geometry.frameOf(r.poly).h : r.bbox[3] - r.bbox[1]));
    const ratio = heights.length ? median(heights) / charH : 1;
    return pagePitch * Math.min(3, Math.max(0.5, ratio));
  }

  function eachNeighbour(g, fn) {
    for (let i = 1; i < g.items.length; i++) {
      const a = g.items[i - 1], b = g.items[i];
      if (a.bbox && b.bbox && !isBlank(a) && !isBlank(b)) fn(a, b);
    }
  }

  /* ---------- removing a character ---------- */

  /**
   * A page's characters and lines without one character. Pure: returns new arrays.
   *
   * The character goes and nothing takes its place: its neighbours close up.
   *   - Inside a word the two neighbours become adjacent. Their boxes are now a character
   *     apart, which a later import would read as a space, so the right-hand one is marked
   *     `joined` ("no space before me"); exports carry the mark and buildPage() honours it.
   *   - A character that stood alone between spaces leaves one gap, measured as on import.
   *   - Spaces that would start or end the line go with it.
   *   - A line left without characters is removed (its paragraph break passes to the next).
   * The rest of the line is renumbered (order 0, 1, 2, …), so every position after the
   * removed character moves up by one.
   *
   * @returns {{ chars, lines, lineRemoved: boolean } | null}  null when the id is unknown
   */
  function withoutChar(page, id) {
    const target = page.chars.find((c) => c.id === id);
    if (!target || target.space) return null;
    const line = page.chars.filter((c) => c.lineId === target.lineId).sort((a, b) => a.order - b.order);
    const at = line.indexOf(target);
    let l = at - 1, r = at + 1;
    while (l >= 0 && line[l].space) l--;
    while (r < line.length && line[r].space) r++;
    const left = line[l] || null, right = line[r] || null;

    if (!left && !right) {
      const i = page.lines.findIndex((x) => x.id === target.lineId);
      const lines = page.lines.filter((x) => x.id !== target.lineId);
      const gone = page.lines[i];
      if (gone && gone.paraBefore && lines[i] && !lines[i].paraBefore) lines[i] = Object.assign({}, lines[i], { paraBefore: true });
      return { chars: page.chars.filter((c) => c.lineId !== target.lineId), lines, lineRemoved: true };
    }

    // What sits between the two neighbours once the character is gone.
    const runBefore = line.slice(l + 1, at), runAfter = line.slice(at + 1, r);
    let gap = [], joinRight = false;
    if (left && right) {
      const m = page.metrics;
      const measurable = m && left.bbox && right.bbox && runBefore.concat(runAfter).every((c) => c.virtual);
      const rest = line.filter((c) => !c.space && c !== target);
      const inferred = measurable ? inferredSpaces(left, right, { pitch: linePitchOf({ items: rest }, m.charW, m.pitch, m.charH) }) : 0;
      if (!runBefore.length && !runAfter.length) joinRight = inferred > 0 || !!target.joined;
      else if (measurable) for (let k = 0; k < Math.max(1, inferred); k++) gap.push(spaceToken(makeId('sp'), target.lineId, 0, true, null));
      else gap = runBefore.length >= runAfter.length ? runBefore : runAfter;
    }
    const next = line.slice(0, l + 1).concat(gap, line.slice(r))
      .map((c) => (c === right && joinRight && !c.joined ? Object.assign({}, c, { joined: true }) : c))
      .map((c, i) => (c.order === i ? c : Object.assign({}, c, { order: i })));
    return { chars: page.chars.filter((c) => c.lineId !== target.lineId).concat(next), lines: page.lines, lineRemoved: false };
  }

  return { buildPage, withoutChar };
});
