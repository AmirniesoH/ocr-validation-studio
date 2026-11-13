/**
 * Writing annotations: the validated JSON format (nested pages → lines →
 * characters) and the flat one-row-per-character table used by CSV and Parquet.
 * Both keep the original OCR value and confidence next to the validated value,
 * and both import back into the app with review progress intact.
 */
OVS.define('io/annotation-format', (require) => {
  'use strict';

  const review = require('model/review');
  const index = require('model/page-index');

  const FORMAT = 'ocr-validation-studio/2';

  /** Characters of a page with their line number and index in the line (inferred spaces left out). */
  function charRows(page) {
    const out = [];
    const lines = index.linesOf(page);
    page.lines.forEach((line, li) => {
      let i = 0;
      for (const c of lines.get(line.id) || []) {
        if (c.virtual) continue;
        out.push({ line: li + 1, index: i++, c });
      }
    });
    return out;
  }

  /** Name of each review group in exported files (model/review.js reason()). */
  const REVIEW_NAME = { threshold: 'accepted_by_confidence', confirmed: 'accepted_by_user', corrected: 'corrected', added: 'manually_added', pending: 'pending' };

  /** Review fields shared by every format. */
  function reviewFields(c, threshold) {
    if (c.space) return { status: 'space', review: null, corrected: false, manually_added: false, verified: false };
    return {
      status: review.isAccepted(c, threshold) ? 'accepted' : 'pending',
      review: REVIEW_NAME[review.reason(c, threshold)],
      corrected: review.isCorrected(c),
      manually_added: review.isAdded(c),
      verified: !!c.verified
    };
  }

  const bboxSource = (c) => (c.ocr ? 'ocr' : c.bbox ? 'manual' : null);

  /* ---------- nested JSON ---------- */

  function pageJson(doc, page, threshold) {
    const byLine = page.lines.map(() => []);
    for (const r of charRows(page)) byLine[r.line - 1].push(r);
    return {
      page: page.pageNo,
      image: doc.kind === 'pdf' ? null : page.name,
      width: page.coord.w,
      height: page.coord.h,
      coordinate_unit: page.coord.unit || 'px',
      lines: page.lines.map((line, li) => ({
        id: li + 1,
        direction: line.dir,
        characters: byLine[li].map((r) => Object.assign({
          index: r.index,
          text: r.c.value,
          bbox: r.c.bbox,
          conf: review.conf(r.c)
        }, reviewFields(r.c, threshold), {
          ocr_text: r.c.ocr ? r.c.ocr.value : null,
          ocr_bbox: r.c.ocr ? r.c.ocr.bbox : null,
          bbox_source: bboxSource(r.c)
        }, r.c.poly ? { polygon: r.c.poly } : null, r.c.joined ? { joined: true } : null))
      }))
    };
  }

  /* The JSON text is written page by page, one character per line: readable, compact, and
     never one giant string (a book's JSON is larger than the longest string a browser allows). */

  /** `{"a":1,"b":2}` without its closing brace, to continue with more members. */
  const openObject = (fields) => JSON.stringify(fields).slice(0, -1);

  function pageText(doc, page, threshold) {
    const { lines, ...head } = pageJson(doc, page, threshold);
    const body = lines.map((line) => '    ' + openObject({ id: line.id, direction: line.direction }) + ',"characters":[\n' +
      line.characters.map((c) => '     ' + JSON.stringify(c)).join(',\n') + '\n    ]}');
    return '   ' + openObject(head) + ',"lines":[\n' + body.join(',\n') + '\n   ]}';
  }

  /** Text parts of one document's members: `"document":…,"pages":[…]`. */
  function documentParts(doc, pages, threshold) {
    const head = openObject({ document: doc.name, kind: doc.kind, annotation_source: doc.annotation ? doc.annotation.name : null }).slice(1);
    const parts = [head + ',"pages":[\n'];
    pages.forEach((p, i) => parts.push(pageText(doc, p, threshold) + (i < pages.length - 1 ? ',\n' : '\n')));
    parts.push('  ]');
    return parts;
  }

  /**
   * The validated annotations as JSON text, in parts for `new Blob(parts)`.
   * One document: its fields at the top level; several: a `documents` list.
   * @param {Array<{ doc, pages }>} groups
   */
  function toJson(groups, threshold) {
    const parts = [openObject({ format: FORMAT, exported_at: new Date().toISOString(), threshold }) + ',\n '];
    if (groups.length === 1) parts.push(...documentParts(groups[0].doc, groups[0].pages, threshold));
    else {
      parts.push('"documents":[\n');
      groups.forEach((g, i) => { parts.push('  {', ...documentParts(g.doc, g.pages, threshold), '}' + (i < groups.length - 1 ? ',\n' : '\n')); });
      parts.push(' ]');
    }
    parts.push('\n}\n');
    return parts;
  }

  /* ---------- flat table ---------- */

  const COLUMNS = [
    { name: 'document', type: 'STRING' }, { name: 'page', type: 'INT32' }, { name: 'image', type: 'STRING' },
    { name: 'line', type: 'INT32' }, { name: 'char_index', type: 'INT32' },
    { name: 'text', type: 'STRING' }, { name: 'ocr_text', type: 'STRING' }, { name: 'conf', type: 'DOUBLE' },
    { name: 'status', type: 'STRING' }, { name: 'review', type: 'STRING' }, { name: 'corrected', type: 'BOOLEAN' }, { name: 'manually_added', type: 'BOOLEAN' }, { name: 'verified', type: 'BOOLEAN' },
    { name: 'x0', type: 'DOUBLE' }, { name: 'y0', type: 'DOUBLE' }, { name: 'x1', type: 'DOUBLE' }, { name: 'y1', type: 'DOUBLE' },
    { name: 'rotated_box', type: 'STRING' }, // four corners of rotated text as JSON, empty otherwise
    { name: 'bbox_source', type: 'STRING' }, { name: 'coordinate_unit', type: 'STRING' },
    { name: 'joined', type: 'BOOLEAN' } // no space before this character whatever the gap (model/layout.js withoutChar)
  ];

  function flatRows(groups, threshold) {
    const rows = [];
    for (const g of groups) {
      for (const p of g.pages) {
        for (const r of charRows(p)) {
          if (r.c.space) continue;
          const b = r.c.bbox || [null, null, null, null];
          rows.push(Object.assign({
            document: g.doc.name, page: p.pageNo, image: g.doc.kind === 'pdf' ? '' : p.name, line: r.line, char_index: r.index,
            text: r.c.value, ocr_text: r.c.ocr ? r.c.ocr.value : '', conf: review.conf(r.c)
          }, reviewFields(r.c, threshold), {
            x0: b[0], y0: b[1], x1: b[2], y1: b[3], rotated_box: r.c.poly ? JSON.stringify(r.c.poly) : '',
            bbox_source: bboxSource(r.c) || '', coordinate_unit: p.coord.unit || 'px', joined: !!r.c.joined
          }));
        }
      }
    }
    return rows;
  }

  return { FORMAT, COLUMNS, toJson, flatRows };
});
