/**
 * Annotation and data exports: validated JSON, Parquet, SQLite, CSV, ALTO XML and hOCR.
 * In ALTO and hOCR, accepted characters carry confidence 1.0 and pending ones
 * keep their OCR confidence.
 */
OVS.define('io/export-data', (require) => {
  'use strict';

  const review = require('model/review');
  const index = require('model/page-index');
  const vendor = require('util/vendor');
  const { xmlEscape, csvEscape, stem, round } = require('util/format');
  const format = require('io/annotation-format');
  const sqlite = require('io/annotation-sqlite');

  /* ---------- table formats ---------- */

  /** CSV text in parts (one per page) for `new Blob(parts)`, so size is not limited by string length. */
  function csv(groups, threshold) {
    const cols = format.COLUMNS.map((c) => c.name);
    const BOM = '\uFEFF'; // lets Excel detect UTF-8
    const parts = [BOM + cols.join(',') + '\r\n'];
    for (const g of groups) {
      for (const page of g.pages) {
        const rows = format.flatRows([{ doc: g.doc, pages: [page] }], threshold);
        if (rows.length) parts.push(rows.map((r) => cols.map((k) => csvEscape(r[k])).join(',')).join('\r\n') + '\r\n');
      }
    }
    return parts;
  }

  async function parquet(groups, threshold) {
    const pq = await vendor.parquet();
    const rows = format.flatRows(groups, threshold);
    const columnData = format.COLUMNS.map((col) => ({ name: col.name, type: col.type, data: rows.map((r) => r[col.name]) }));
    return new Blob([pq.parquetWriteBuffer({ columnData })], { type: 'application/vnd.apache.parquet' });
  }

  /* ---------- layout formats ---------- */

  /** Confidence written to ALTO/hOCR: reviewed or accepted characters are certain. */
  const outConf = (c, threshold) => (review.isAccepted(c, threshold) ? 1 : (review.conf(c) == null ? 0 : review.conf(c)));

  const { words, unionBox: union } = index;

  const r1 = (v) => round(v, 1);
  const imageName = (doc, page) => (doc.kind === 'pdf' ? doc.name : page.name);

  function alto(doc, page, threshold) {
    const pos = (b) => (b ? ' HPOS="' + r1(b[0]) + '" VPOS="' + r1(b[1]) + '" WIDTH="' + r1(b[2] - b[0]) + '" HEIGHT="' + r1(b[3] - b[1]) + '"' : '');
    const lines = index.linesOf(page);
    let n = 0;
    const body = page.lines.map((line, li) => {
      const chars = lines.get(line.id) || [];
      const strings = words(chars).map((w) => {
        const wc = Math.min(...w.map((c) => outConf(c, threshold)));
        const glyphs = w.map((c) => '<Glyph ID="g' + (n++) + '" CONTENT="' + xmlEscape(c.value) + '" GC="' + outConf(c, threshold).toFixed(3) + '"' + pos(c.bbox) + '/>').join('');
        return '<String ID="s' + (n++) + '" CONTENT="' + xmlEscape(w.map((c) => c.value).join('')) + '" WC="' + wc.toFixed(3) + '"' + pos(union(w.map((c) => c.bbox))) + '>' + glyphs + '</String>';
      });
      return '<TextLine ID="l' + (li + 1) + '"' + pos(union(chars.map((c) => c.bbox))) + '>' + strings.join('<SP/>') + '</TextLine>';
    });
    const W = r1(page.coord.w), H = r1(page.coord.h);
    return '<?xml version="1.0" encoding="UTF-8"?>\n<alto xmlns="http://www.loc.gov/standards/alto/ns-v4#"><Description><MeasurementUnit>pixel</MeasurementUnit>' +
      '<sourceImageInformation><fileName>' + xmlEscape(imageName(doc, page)) + '</fileName></sourceImageInformation>' +
      '<Processing><processingSoftware><softwareName>OCR Validation Studio</softwareName></processingSoftware></Processing></Description>' +
      '<Layout><Page ID="p' + page.pageNo + '" PHYSICAL_IMG_NR="' + page.pageNo + '" WIDTH="' + W + '" HEIGHT="' + H + '">' +
      '<PrintSpace HPOS="0" VPOS="0" WIDTH="' + W + '" HEIGHT="' + H + '"><TextBlock ID="b1">' + body.join('\n') + '</TextBlock></PrintSpace></Page></Layout></alto>\n';
  }

  /** hOCR text in parts (one per page) for `new Blob(parts)`. */
  function hocr(groups, threshold) {
    const bb = (b) => 'bbox ' + (b ? b.map((v) => Math.round(v)).join(' ') : '0 0 0 0');
    const parts = ['<!DOCTYPE html>\n<html lang="und"><head><meta charset="utf-8"><title>OCR Validation Studio export</title>' +
      '<meta name="ocr-system" content="OCR Validation Studio ' + OVS.version + '"><meta name="ocr-capabilities" content="ocr_page ocr_line ocrx_word ocrx_cinfo"></head><body>\n'];
    for (const g of groups) {
      for (const page of g.pages) {
        const lines = index.linesOf(page);
        let body = '<div class="ocr_page" id="page_' + page.pageNo + '" title="image &quot;' + xmlEscape(imageName(g.doc, page)) + '&quot;; bbox 0 0 ' +
          Math.round(page.coord.w) + ' ' + Math.round(page.coord.h) + '; ppageno ' + (page.pageNo - 1) + '">\n';
        page.lines.forEach((line, li) => {
          const chars = lines.get(line.id) || [];
          body += ' <span class="ocr_line" id="line_' + page.pageNo + '_' + (li + 1) + '" dir="' + line.dir + '" title="' + bb(union(chars.map((c) => c.bbox))) + '">';
          body += words(chars).map((w) => {
            const wc = Math.round(100 * Math.min(...w.map((c) => outConf(c, threshold))));
            return '<span class="ocrx_word" title="' + bb(union(w.map((c) => c.bbox))) + '; x_wconf ' + wc + '">' +
              w.map((c) => '<span class="ocrx_cinfo" title="x_bboxes ' + (c.bbox ? c.bbox.map((v) => Math.round(v)).join(' ') : '0 0 0 0') + '; x_conf ' + (outConf(c, threshold) * 100).toFixed(1) + '">' + xmlEscape(c.value) + '</span>').join('') +
              '</span>';
          }).join(' ');
          body += '</span>\n';
        });
        parts.push(body + '</div>\n');
      }
    }
    parts.push('</body></html>\n');
    return parts;
  }

  async function altoFiles(ctx) {
    const pages = [];
    ctx.groups.forEach((g) => g.pages.forEach((p) => pages.push({ doc: g.doc, page: p })));
    if (pages.length === 1) return { blob: new Blob([alto(pages[0].doc, pages[0].page, ctx.threshold)], { type: 'application/xml' }), filename: ctx.name + '.alto.xml' };
    const JSZip = await vendor.jszip();
    const zip = new JSZip();
    for (const x of pages) zip.file(stem(x.doc.name) + '_p' + String(x.page.pageNo).padStart(3, '0') + '.alto.xml', alto(x.doc, x.page, ctx.threshold));
    return { blob: await zip.generateAsync({ type: 'blob' }), filename: ctx.name + '_alto.zip' };
  }

  /* ---------- descriptors ---------- */

  const FORMATS = [
    {
      id: 'json', group: 'data', badge: 'JSON', label: 'Validated annotations', description: 'Review status and original OCR values; re-importable',
      async build(ctx) { return { blob: new Blob(format.toJson(ctx.groups, ctx.threshold), { type: 'application/json' }), filename: ctx.name + '.validated.json' }; }
    },
    {
      id: 'parquet', group: 'data', badge: 'PQ', label: 'Parquet', description: 'Column table for data pipelines',
      async build(ctx) { return { blob: await parquet(ctx.groups, ctx.threshold), filename: ctx.name + '.validated.parquet' }; }
    },
    {
      id: 'sqlite', group: 'data', badge: 'SQL', label: 'SQLite database', description: 'Documents, pages and characters with indexes; suits whole books',
      async build(ctx) { return { blob: new Blob([await sqlite.write(ctx.groups, ctx.threshold)], { type: 'application/vnd.sqlite3' }), filename: ctx.name + '.validated.sqlite' }; }
    },
    {
      id: 'csv', group: 'data', badge: 'CSV', label: 'Character table', description: 'One row per character with box and status',
      async build(ctx) { return { blob: new Blob(csv(ctx.groups, ctx.threshold), { type: 'text/csv;charset=utf-8' }), filename: ctx.name + '.csv' }; }
    },
    {
      id: 'alto', group: 'data', badge: 'ALTO', label: 'ALTO XML', description: 'Library and archive standard (v4)',
      build: altoFiles
    },
    {
      id: 'hocr', group: 'data', badge: 'hOCR', label: 'hOCR', description: 'HTML with layout and confidence',
      async build(ctx) { return { blob: new Blob(hocr(ctx.groups, ctx.threshold), { type: 'text/html;charset=utf-8' }), filename: ctx.name + '.hocr.html' }; }
    }
  ];

  return { FORMATS, parquet };
});
