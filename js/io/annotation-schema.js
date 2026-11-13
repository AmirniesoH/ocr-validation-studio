/**
 * Reading annotation content: flatten any supported JSON/Parquet shape into one
 * row per character, guess which fields hold what, and normalize rows into
 * records for model/layout.js.
 *
 * Supported shapes (detected automatically):
 *   - a flat array of character objects, or { characters | chars | symbols | glyphs | items | data: [...] }
 *   - nested { pages: [{ page, width, height, image, lines: [{ id, characters: [...] }] }] }
 *   - words containing characters: { words: [{ text, chars: [...] }] }
 *   - this app's export: { documents: [{ pages: [...] }] }
 *   - Parquet tables with one row per character
 *
 * Boxes: [x0,y0,x1,y1], [x,y,w,h], polygons ([x,y,…] or [[x,y],…]),
 * objects ({x,y,w,h} / {x0,y0,x1,y1} / {left,top,right,bottom}) or separate columns.
 *
 * To recognise another field name, add it to ALIASES.
 */
OVS.define('io/annotation-schema', (require) => {
  'use strict';

  const { normKey, truthy } = require('util/format');
  const { toQuad, boundsOf } = require('model/geometry');

  const ALIASES = {
    value: ['text', 'char', 'character', 'value', 'symbol', 'glyph', 'label', 'ch', 'unicode', 'content', 'c'],
    conf: ['conf', 'confidence', 'score', 'prob', 'probability', 'certainty', 'ocr_conf', 'ocr_confidence', 'char_conf'],
    bbox: ['bbox', 'box', 'bounding_box', 'boundingbox', 'rect', 'bounds', 'polygon', 'poly', 'points', 'quad', 'coords', 'geometry'],
    // Four corners of rotated text; also read from the box field when that holds a polygon
    poly: ['polygon', 'rotated_box', 'poly', 'quad', 'points', 'vertices', 'corners'],
    line: ['line', 'line_id', 'lineid', 'line_index', 'line_idx', 'line_no', 'line_num', 'line_number', 'row', 'textline', '__line'],
    order: ['char_index', 'charindex', 'char_idx', 'index', 'order', 'position', 'pos', 'idx', 'seq', 'sequence', 'char_no', '__order'],
    page: ['page', 'page_no', 'page_num', 'page_number', 'pageindex', 'page_index', 'page_idx', 'pagenum', '__page'],
    image: ['image', 'image_name', 'imagename', 'image_path', 'file', 'filename', 'file_name', 'source', 'img', 'image_id', '__image'],
    pageW: ['__pagew', 'page_width', 'image_width', 'img_width'],
    pageH: ['__pageh', 'page_height', 'image_height', 'img_height'],
    // Review progress written by this app (and similar tools)
    status: ['status', 'validation_status', 'review_status'],
    verified: ['verified', 'confirmed', 'reviewed', 'is_verified'],
    added: ['manually_added', 'is_added', 'added', 'manual'],
    // No space before this character whatever the gap (a character between them was removed)
    joined: ['joined', 'no_space_before', 'joined_to_previous'],
    ocrValue: ['ocr_text', 'ocr_value', 'original_text', 'original_value', 'ocr_char'],
    ocrBbox: ['ocr_bbox', 'original_bbox']
  };

  /** Statuses that mean a person already reviewed the character (older files without a "verified" field). */
  const REVIEWED_STATUSES = new Set(['accepted', 'corrected', 'confirmed', 'verified', 'validated']);

  const COLUMN_BOXES = [
    { kind: 'xyxy', fields: ['x0', 'y0', 'x1', 'y1'] },
    { kind: 'xyxy', fields: ['xmin', 'ymin', 'xmax', 'ymax'] },
    { kind: 'xyxy', fields: ['left', 'top', 'right', 'bottom'] },
    { kind: 'xyxy', fields: ['x1', 'y1', 'x2', 'y2'] },
    { kind: 'xywh', fields: ['x', 'y', 'w', 'h'] },
    { kind: 'xywh', fields: ['x', 'y', 'width', 'height'] },
    { kind: 'xywh', fields: ['left', 'top', 'width', 'height'] }
  ];

  /** Container keys and what they hold. */
  const CONTAINERS = {
    documents: 'doc', docs: 'doc',
    pages: 'page', page_annotations: 'page',
    blocks: 'block', paragraphs: 'block', regions: 'block',
    lines: 'line', text_lines: 'line', textlines: 'line',
    words: 'word', tokens: 'word',
    characters: 'char', chars: 'char', symbols: 'char', glyphs: 'char', char_annotations: 'char',
    items: 'char', annotations: 'char', records: 'char', data: 'char', boxes: 'char', results: 'char', elements: 'char'
  };

  const lower = (k) => String(k).toLowerCase();
  const first = (obj, keys) => { for (const k of keys) if (obj[k] != null) return obj[k]; return undefined; };
  /** A coordinate as a number; NaN for missing values (Number(null) would be 0). */
  const num = (v) => (v == null || v === '' ? NaN : Number(v));
  const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v);

  /** Convert BigInt and typed arrays (from Parquet) into plain JS values. */
  function plain(v) {
    if (typeof v === 'bigint') return Number(v);
    if (ArrayBuffer.isView(v) && !(v instanceof DataView)) return Array.from(v, plain);
    if (Array.isArray(v)) return v.map(plain);
    if (isObject(v)) { const o = {}; for (const k of Object.keys(v)) o[k] = plain(v[k]); return o; }
    return v;
  }

  /* ---------- flattening ---------- */

  /** A record with a short text value plus a box or confidence (field names in any case). */
  function looksLikeChar(obj) {
    if (Object.keys(obj).some((k) => CONTAINERS[lower(k)] && Array.isArray(obj[k]))) return false;
    const byLower = {};
    for (const k of Object.keys(obj)) byLower[lower(k)] = obj[k];
    const val = first(byLower, ALIASES.value);
    if (typeof val !== 'string' || Array.from(val).length > 4) return false;
    return Object.keys(byLower).some((k) => ALIASES.bbox.includes(k) || ALIASES.conf.includes(k) || ['x', 'x0', 'xmin', 'left'].includes(k));
  }

  /**
   * One row per character. Context from parent containers is copied onto each
   * row as __page, __image, __pageW, __pageH, __line and __order.
   */
  function flatten(data) {
    const rows = [];
    function walk(node, ctx, kind, pos) {
      if (Array.isArray(node)) { node.forEach((n, i) => walk(n, ctx, kind, i)); return; }
      if (!isObject(node)) return;

      if (kind !== 'page' && kind !== 'line' && kind !== 'word' && kind !== 'doc' && looksLikeChar(node)) {
        const row = Object.assign({}, node);
        for (const k of Object.keys(ctx)) if (row[k] == null) row[k] = ctx[k];
        if (row.__order == null && pos != null && ctx.__line != null) row.__order = pos;
        rows.push(row);
        return;
      }

      const next = Object.assign({}, ctx);
      if (kind === 'page') {
        const p = first(node, ['page', 'page_number', 'page_no', 'number', 'index']);
        next.__page = p != null ? p : (pos != null ? pos + 1 : undefined);
        const img = first(node, ['image', 'file', 'filename', 'image_name', 'name']);
        if (img != null) next.__image = String(img);
        const w = first(node, ['width', 'image_width', 'page_width', 'w']);
        const hgt = first(node, ['height', 'image_height', 'page_height', 'h']);
        if (typeof w === 'number' && typeof hgt === 'number') { next.__pageW = w; next.__pageH = hgt; }
      } else if (kind === 'line') {
        const id = first(node, ['id', 'line_id', 'line', 'index']);
        next.__line = (next.__page != null ? next.__page + ':' : '') + (id != null ? id : pos);
      }
      for (const key of Object.keys(node)) {
        const containerKind = CONTAINERS[lower(key)];
        if (containerKind && Array.isArray(node[key])) walk(node[key], next, containerKind, null);
      }
    }
    walk(plain(data), {}, Array.isArray(data) ? 'char' : null, null);
    return rows;
  }

  /* ---------- field mapping ---------- */

  /** Every field name used by any record (optional fields may only appear late in a file). */
  function fieldsOf(rows) {
    const set = new Set();
    for (const r of rows) for (const k in r) set.add(k);
    return Array.from(set);
  }

  function pickField(fields, aliases) {
    const byLower = new Map(fields.map((f) => [lower(f), f]));
    for (const a of aliases) if (byLower.has(a)) return byLower.get(a);
    return null;
  }

  /**
   * Guess which field holds what. The import dialog lets the user override it.
   * @returns {{ value, conf, bbox, cols, bboxFormat, coords, line, order, page, image, pageW, pageH, status, verified, added, joined, ocrValue, ocrBbox }}
   */
  function detectMapping(rows) {
    const fields = fieldsOf(rows);
    const m = { coords: 'auto', bboxFormat: 'auto', cols: null };
    for (const key of Object.keys(ALIASES)) m[key] = pickField(fields, ALIASES[key]);
    // A box field must hold coordinates (arrays or objects); a polygon stored as text is only read as `poly`.
    if (m.bbox && !holdsShapes(rows, m.bbox)) m.bbox = null;
    if (!m.bbox) {
      const lowered = new Set(fields.map(lower));
      const hit = COLUMN_BOXES.find((c) => c.fields.every((f) => lowered.has(f)));
      if (hit) m.cols = { kind: hit.kind, fields: hit.fields.map((f) => fields.find((x) => lower(x) === f)) };
    }
    if (m.bbox) m.bboxFormat = guessBoxFormat(rows, m.bbox);
    return m;
  }

  function holdsShapes(rows, field) {
    for (const r of rows) {
      const v = r[field];
      if (v == null || v === '') continue;
      return Array.isArray(v) || isObject(v);
    }
    return false;
  }

  function guessBoxFormat(rows, field) {
    for (const r of rows.slice(0, 500)) {
      const b = r[field];
      if (Array.isArray(b) && b.length === 4 && typeof b[0] === 'number') { if (b[2] < b[0] || b[3] < b[1]) return 'xywh'; }
      else if (Array.isArray(b) && (b.length === 8 || Array.isArray(b[0]))) return 'polygon';
      else if (isObject(b)) return 'object';
    }
    return 'xyxy';
  }

  /** Options for the import dialog's field dropdowns. */
  function candidates(rows) {
    const fields = fieldsOf(rows).filter((f) => !f.startsWith('__') || ['__line', '__order', '__page', '__image'].includes(f));
    const lowered = new Set(fields.map(lower));
    const boxCols = COLUMN_BOXES.filter((c) => c.fields.every((f) => lowered.has(f)));
    const boxFields = fields.filter((f) => rows.slice(0, 50).some((r) => Array.isArray(r[f]) || isObject(r[f])));
    return { fields, boxCols, boxFields };
  }

  /* ---------- boxes ---------- */

  function toBox(raw, format) {
    if (raw == null) return null;
    let b = null;
    if (Array.isArray(raw)) {
      if (Array.isArray(raw[0])) {
        b = boundsOf(raw.map((p) => [num(p[0]), num(p[1])]));
      } else if (raw.length === 4) {
        const v = raw.map(num);
        b = format === 'xywh' ? [v[0], v[1], v[0] + v[2], v[1] + v[3]] : v;
      } else if (raw.length >= 6 && raw.length % 2 === 0) {
        const pts = [];
        for (let i = 0; i < raw.length; i += 2) pts.push([num(raw[i]), num(raw[i + 1])]);
        b = boundsOf(pts);
      }
    } else if (isObject(raw)) {
      const o = {};
      for (const k of Object.keys(raw)) o[lower(k)] = raw[k];
      if (o.x0 != null) b = [o.x0, o.y0, o.x1, o.y1];
      else if (o.xmin != null) b = [o.xmin, o.ymin, o.xmax, o.ymax];
      else if (o.left != null && o.right != null) b = [o.left, o.top, o.right, o.bottom];
      else if (o.x != null && (o.w != null || o.width != null)) { const w = o.w != null ? o.w : o.width, hh = o.h != null ? o.h : o.height; b = [o.x, o.y, o.x + w, o.y + hh]; }
      else if (o.left != null && o.width != null) b = [o.left, o.top, o.left + o.width, o.top + o.height];
      if (b) b = b.map(num);
    }
    if (!b || b.some((v) => !isFinite(v))) return null;
    return [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])];
  }

  function rowBox(row, m) {
    if (m.bbox) return toBox(row[m.bbox], m.bboxFormat === 'auto' ? 'xyxy' : m.bboxFormat);
    if (!m.cols) return null;
    const v = m.cols.fields.map((f) => num(row[f]));
    if (v.some((x) => !isFinite(x))) return null;
    return m.cols.kind === 'xywh'
      ? [v[0], v[1], v[0] + v[2], v[1] + v[3]]
      : [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])];
  }

  /* ---------- normalizing ---------- */

  /** Confidence may be 0–1 or 0–100; find the divisor. */
  function confidenceScale(rows, field) {
    if (!field) return 1;
    let max = 0;
    for (const r of rows) { const v = Number(r[field]); if (isFinite(v) && v > max) max = v; }
    return max > 1.0001 ? (max <= 100 ? 100 : max) : 1;
  }

  /**
   * Normalize rows into page groups:
   *   [{ key, page, image, width, height, records }]
   * A group is keyed by image name, else page number, else 'all'.
   */
  function normalize(rows, m) {
    const scale = confidenceScale(rows, m.conf);
    const groups = new Map();
    rows.forEach((row, index) => {
      if (!m.value || row[m.value] == null) return;
      const image = m.image && row[m.image] != null && row[m.image] !== '' ? String(row[m.image]) : null;
      const page = m.page && isFinite(num(row[m.page])) ? num(row[m.page]) : null;
      const key = image ? 'img:' + normKey(image) : page != null ? 'page:' + page : 'all';
      if (!groups.has(key)) groups.set(key, { key, page, image, width: null, height: null, records: [] });
      const g = groups.get(key);
      if (m.pageW && row[m.pageW] != null && g.width == null) { g.width = Number(row[m.pageW]); g.height = Number(row[m.pageH]); }

      const status = m.status && row[m.status] != null ? String(row[m.status]).toLowerCase() : '';
      const confRaw = m.conf ? num(row[m.conf]) : NaN;
      const line = m.line && row[m.line] != null ? row[m.line] : null;
      g.records.push({
        index,
        value: String(row[m.value]),
        conf: isFinite(confRaw) ? Math.min(1, Math.max(0, Math.round(confRaw / scale * 10000) / 10000)) : null, // always within 0–1
        bbox: rowBox(row, m),
        poly: toQuad(row[m.poly || m.bbox]),
        line: line != null && m.page && row[m.page] != null && !String(line).includes(':') ? row[m.page] + ':' + line : line,
        order: m.order && isFinite(num(row[m.order])) ? num(row[m.order]) : null,
        added: (m.added ? truthy(row[m.added]) : false) || status === 'added' || status === 'manually_added',
        verified: m.verified ? truthy(row[m.verified]) : REVIEWED_STATUSES.has(status),
        joined: m.joined ? truthy(row[m.joined]) : false,
        ocrValue: m.ocrValue && row[m.ocrValue] != null && row[m.ocrValue] !== '' ? String(row[m.ocrValue]) : null,
        ocrBbox: m.ocrBbox ? toBox(row[m.ocrBbox], 'xyxy') : null
      });
    });
    return Array.from(groups.values());
  }

  /**
   * Split flat rows by their `document` column (a file exported for several
   * documents), so each part pairs with its own document.
   * @returns {Array<{ name: string | null, rows }>}  name null when there is no document column
   */
  function splitByDocument(rows) {
    const field = rows.length ? Object.keys(rows[0]).find((k) => ['document', 'document_name'].includes(lower(k))) : null;
    if (!field) return [{ name: null, rows }];
    const parts = new Map();
    for (const r of rows) {
      const k = r[field] == null ? '' : String(r[field]);
      if (!parts.has(k)) parts.set(k, []);
      parts.get(k).push(r);
    }
    return Array.from(parts, ([name, part]) => ({ name: name || null, rows: part }));
  }

  return { flatten, detectMapping, candidates, normalize, plain, splitByDocument };
});
